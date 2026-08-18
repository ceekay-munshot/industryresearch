/**
 * lib/screener.mjs — direct screener.in client (free, public, no auth).
 *
 * Replaces Muns for listed-company benchmarking financials. Two things the peer
 * benchmark needs, both now sourced straight from screener.in:
 *   - screenerSearch(name)  → resolve a company's screener code (its NSE symbol
 *     for most listed names) from screener's own public autocomplete API.
 *   - screenerFinancials(code) → fetch the company page and render its headline
 *     ratios + Profit&Loss + Ratios tables into a compact markdown document —
 *     the exact shape lib/benchmark.mjs's FINANCIALS_SYSTEM prompt already
 *     expects ("a markdown financials document (sourced from screener.in)").
 *
 * No npm deps: global fetch + a few tolerant regex parsers. Every call is
 * continue-on-error (returns a safe empty value, never throws) so one bad
 * company can never sink a run. A browser User-Agent is sent because screener
 * serves anonymous requests fine but blocks obvious bot agents.
 */

const BASE = 'https://www.screener.in';

// Read env defensively — this module also bundles into the Cloudflare Worker,
// where `process` may be absent.
const ENV = (typeof process !== 'undefined' && process && process.env) ? process.env : {};

// A real browser UA — screener 200s anonymous browsers but 403s bare bots.
const UA = ENV.SCREENER_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TIMEOUT_MS = Number(ENV.SCREENER_TIMEOUT_MS) || 30000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * One GET against screener.in. `raw:true` returns the response text (HTML/JSON
 * text); otherwise parsed JSON. Retry + backoff + timeout + continue-on-error:
 * any failure logs and returns null so one bad call never crashes a run.
 */
async function get(url, { raw = false, kind } = {}) {
  const label = kind || url;
  const headers = {
    'User-Agent': UA,
    Accept: raw ? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' : 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: BASE + '/',
  };
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1)); // 1s, 2s
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: ctl.signal });
      const bodyText = await res.text();
      clearTimeout(timer);
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
          console.warn(`[screener] ${label} -> HTTP ${res.status} (attempt ${attempt + 1}/${MAX_ATTEMPTS}) — retrying...`);
          continue;
        }
        console.warn(`[screener] ${label} -> HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
        return null;
      }
      if (raw) return bodyText;
      try { return JSON.parse(bodyText); }
      catch (e) { console.warn(`[screener] ${label} -> non-JSON: ${bodyText.slice(0, 160)}`); return null; }
    } catch (err) {
      clearTimeout(timer);
      const msg = err && err.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : (err && err.message) || String(err);
      if (attempt < MAX_ATTEMPTS - 1) { console.warn(`[screener] ${label} -> ${msg} — retrying...`); continue; }
      console.warn(`[screener] ${label} -> ${msg}`);
      return null;
    }
  }
  return null;
}

/* ----------------------------------------------------------------------- *
 * Company search (ticker/code resolution).
 * ----------------------------------------------------------------------- */

/** A screener page url path ("/company/VADILALIND/consolidated/" or
 *  "/company/519451/") → { code, consolidated }. Rejects the "/company/id/<n>/"
 *  partly-paid / tracking-stock variants (their real code is the numeric part,
 *  not "id") and non-company paths like "/full-text-search/". */
export function parseCompanyPath(url) {
  const m = String(url || '').match(/\/company\/([^/]+)\/(consolidated\/?)?/i);
  if (!m) return null;
  const code = decodeURIComponent(m[1]);
  if (!code || code.toLowerCase() === 'id') return null;   // partly-paid variant → skip
  return { code, consolidated: !!m[2] };
}

/** Raw autocomplete search. Returns screener's JSON array [{id,name,url}] or []. */
export async function screenerSearchRaw(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const url = `${BASE}/api/company/search/?q=${encodeURIComponent(q)}&v=3&fts=1`;
  const data = await get(url, { kind: 'search' });
  return Array.isArray(data) ? data : [];
}

/**
 * Normalize screener search rows into [{ ticker, name, code, consolidated, country }],
 * where ticker === code so the existing pickListedMatch(results, name) works
 * unchanged. Rows without a resolvable company path are dropped.
 */
export function normalizeScreenerSearch(data) {
  const rows = Array.isArray(data) ? data : [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const path = parseCompanyPath(r.url);
    if (!path) continue;
    const name = String(r.name == null ? '' : r.name).trim();
    if (!name) continue;
    out.push({ ticker: path.code, code: path.code, name, consolidated: path.consolidated, country: 'India', url: String(r.url || '') });
  }
  return out;
}

/** Convenience: normalized search results for a query. */
export async function screenerSearch(query) {
  return normalizeScreenerSearch(await screenerSearchRaw(query));
}

/* ----------------------------------------------------------------------- *
 * Company financials page → markdown.
 * ----------------------------------------------------------------------- */

/** Decode the handful of HTML entities screener uses, then strip tags → plain text. */
function cellText(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** The company display name from the page <h1>. */
function parseName(html) {
  const m = String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? cellText(m[1]) : '';
}

/** The headline "top ratios" list (Market Cap / ROCE / ROE / P-E / …) as bullets. */
function parseTopRatios(html) {
  const m = String(html).match(/<ul[^>]*id=["']top-ratios["'][\s\S]*?<\/ul>/i);
  if (!m) return [];
  const out = [];
  for (const li of m[0].match(/<li[^>]*>[\s\S]*?<\/li>/gi) || []) {
    const t = cellText(li);
    if (t) out.push(t);
  }
  return out;
}

/** Extract the first data-table inside <section id="…"> → { heads:[], rows:[[label,…]] }. */
function parseSectionTable(html, sectionId) {
  const secRe = new RegExp(`<section[^>]*id=["']${sectionId}["'][\\s\\S]*?<table[^>]*class=["'][^"']*data-table[\\s\\S]*?<\\/table>`, 'i');
  const sec = String(html).match(secRe);
  if (!sec) return null;
  const tbl = sec[0].slice(sec[0].search(/<table/i));
  const heads = (tbl.match(/<th[^>]*>[\s\S]*?<\/th>/gi) || []).map((h) => cellText(h));
  const rows = [];
  for (const tr of tbl.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const tds = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map((c) => cellText(c));
    if (tds.length && tds.some((c) => c)) rows.push(tds);
  }
  return heads.length || rows.length ? { heads, rows } : null;
}

/** Render a parsed table as a compact markdown table (first col = row label). */
function tableToMarkdown(t) {
  if (!t) return '';
  const lines = [];
  if (t.heads && t.heads.length) {
    lines.push('| ' + t.heads.join(' | ') + ' |');
    lines.push('| ' + t.heads.map(() => '---').join(' | ') + ' |');
  }
  for (const r of t.rows) lines.push('| ' + r.join(' | ') + ' |');
  return lines.join('\n');
}

/**
 * Turn a screener company page's HTML into the compact markdown financials
 * document the extractor consumes: company name, headline ratios (ROCE/ROE/…),
 * the annual Profit & Loss table, and the Ratios table. Returns '' if nothing
 * financial could be parsed (so the caller can fall through to pending).
 */
export function financialsMarkdownFromHtml(html) {
  const h = String(html || '');
  const name = parseName(h);
  const top = parseTopRatios(h);
  const pl = parseSectionTable(h, 'profit-loss');
  const ratios = parseSectionTable(h, 'ratios');
  if (!pl && !ratios && !top.length) return '';
  const parts = [];
  if (name) parts.push(`# ${name} — financials (screener.in)`);
  if (top.length) parts.push('## Headline ratios\n' + top.map((t) => `- ${t}`).join('\n'));
  if (pl) parts.push('## Profit & Loss (annual, ₹ Crore unless the header says otherwise)\n' + tableToMarkdown(pl));
  if (ratios) parts.push('## Ratios\n' + tableToMarkdown(ratios));
  return parts.join('\n\n').trim();
}

/**
 * Fetch a listed company's financials page and return
 * { text (markdown), url, name } — or null on any failure / nothing parseable.
 * `code` is a screener code (NSE symbol like VADILALIND, or a numeric code);
 * consolidated defaults to true and falls back to the standalone page.
 */
export async function screenerFinancials(code, { consolidated = true } = {}) {
  const c = String(code || '').trim();
  if (!c) return null;
  const paths = consolidated
    ? [`/company/${encodeURIComponent(c)}/consolidated/`, `/company/${encodeURIComponent(c)}/`]
    : [`/company/${encodeURIComponent(c)}/`, `/company/${encodeURIComponent(c)}/consolidated/`];
  for (const p of paths) {
    const url = BASE + p;
    const html = await get(url, { raw: true, kind: `company ${c}` });
    if (!html) continue;
    const text = financialsMarkdownFromHtml(html);
    if (text) return { text, url, name: parseName(html) };
  }
  return null;
}

/** Citeable source for a screener-sourced peer. */
export function screenerSourceFor(code, { consolidated = true } = {}) {
  const c = String(code || '').trim();
  if (!c) return null;
  const seg = consolidated ? 'consolidated' : '';
  return { label: 'screener.in', url: `${BASE}/company/${encodeURIComponent(c)}/${seg ? seg + '/' : ''}`, snippet: '' };
}
