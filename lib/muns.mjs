/**
 * lib/muns.mjs — thin wrappers around the Muns fastapi tools.
 *
 * Base URL: https://fastapi.muns.io   Auth: Bearer ${MUNS_TOKEN}
 * No npm dependencies — global `fetch` + node stdlib only.
 *
 * Response shapes are undocumented, so:
 *  - the raw JSON shape is logged the first time each tool is called, and
 *  - small, tolerant normalizers pull {title,url,snippet} out of search results
 *    and {url,text} out of reader results, ignoring anything they don't find.
 *
 * Every call is continue-on-error: a failed request logs and returns a safe
 * empty value instead of throwing, so one bad call can never crash a run.
 */

const BASE = 'https://fastapi.muns.io';

// Muns hosts differ per endpoint — each wrapper targets its documented host.
const HOST = {
  fastapi: 'https://fastapi.muns.io',      // web/news/reader + street estimates
  birdnest: 'https://birdnest.muns.io',    // company (stock) search
  devde: 'https://devde.muns.io',          // combined financials + DRHP filings
};
// Every Muns stock endpoint is India-scoped and uses a fixed user index (per docs).
const USER_INDEX = 124;
const STOCK_COUNTRY = 'India';             // capital I, per the stock-endpoint docs

const shapeLogged = {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function token() {
  const t = process.env.MUNS_TOKEN;
  if (!t || !t.trim()) {
    console.warn('[muns] MUNS_TOKEN is not set — Muns calls will fail and return empty results.');
    return '';
  }
  return t;
}

/** Log a compact view of an unfamiliar response shape (keys + array lengths). */
function logShape(kind, data) {
  if (shapeLogged[kind]) return;
  shapeLogged[kind] = true;
  try {
    const describe = (v, depth = 0) => {
      if (v === null) return 'null';
      if (Array.isArray(v)) return `array(${v.length})` + (v.length && depth < 1 ? `<${describe(v[0], depth + 1)}>` : '');
      if (typeof v === 'object') {
        return '{' + Object.keys(v).slice(0, 20).map((k) => `${k}:${describe(v[k], depth + 1)}`).join(', ') + '}';
      }
      return typeof v;
    };
    console.log(`[muns] first ${kind} response shape: ${describe(data)}`);
  } catch (e) {
    console.log(`[muns] first ${kind} response shape: <unprintable: ${e.message}>`);
  }
}

// Per-request timeout. Without this a hanging Muns endpoint blocks the whole run
// (Node fetch has no default timeout) — the single biggest cause of a run that
// crawls when Muns is degraded. Reads may legitimately take longer than searches.
const TIMEOUT_MS = Number(process.env.MUNS_TIMEOUT_MS) || 45000;

/**
 * One Muns request against a FULL url (host varies per endpoint). GET or POST;
 * JSON body when `payload` is given. `raw:true` returns the response text as-is
 * (for markdown / text/plain endpoints); otherwise the JSON is parsed. Same
 * retry+backoff+timeout+continue-on-error contract as before: any failure logs
 * and returns null so one bad call can never crash the run.
 */
async function request(url, { method = 'POST', payload, kind, raw = false } = {}) {
  const t = token();
  if (!t) return null;
  const headers = { Authorization: `Bearer ${t}` };
  const init = { method, headers };
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(payload);
  }
  const label = kind || url;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1)); // 1s, 2s
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      init.signal = ctl.signal;
      const res = await fetch(url, init);
      const bodyText = await res.text();
      clearTimeout(timer);
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
          console.warn(`[muns] ${label} -> HTTP ${res.status} (attempt ${attempt + 1}/${MAX_ATTEMPTS}) — retrying...`);
          continue;
        }
        console.warn(`[muns] ${label} -> HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
        return null;
      }
      if (raw) return bodyText;                      // markdown / text/plain
      let data;
      try {
        data = JSON.parse(bodyText);
      } catch (e) {
        console.warn(`[muns] ${label} -> non-JSON response: ${bodyText.slice(0, 200)}`);
        return null;
      }
      if (kind) logShape(kind, data);
      return data;
    } catch (err) {
      clearTimeout(timer);
      const msg = err && err.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : (err && err.message) || String(err);
      if (attempt < MAX_ATTEMPTS - 1) {
        console.warn(`[muns] ${label} -> request error (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${msg} — retrying...`);
        continue;
      }
      console.warn(`[muns] ${label} -> request error: ${msg}`);
      return null;
    }
  }
  return null;
}

/** Back-compat wrapper: POST a JSON body to a fastapi path (web/news/reader). */
function post(path, payload, kind) {
  return request(`${BASE}${path}`, { method: 'POST', payload, kind });
}

/* ----------------------------------------------------------------------- *
 * Raw tool wrappers (each returns parsed JSON, or null on any failure).
 * ----------------------------------------------------------------------- */

export function webSearch(query, country = 'India') {
  return post('/tools/web-search', { query, country }, 'search');
}

export function newsSearch(query, country = 'India', from_date, to_date) {
  const payload = { query, country };
  if (from_date) payload.from_date = from_date;
  if (to_date) payload.to_date = to_date;
  return post('/tools/news-search', payload, 'news');
}

export function webReader(urls, task) {
  const payload = { urls: Array.isArray(urls) ? urls : [urls] };
  if (task) payload.task = task;
  return post('/tools/web-reader', payload, 'reader');
}

/* ----------------------------------------------------------------------- *
 * Stock / filings endpoints (used by peer benchmarking). Each is India-scoped
 * with user_index 124 per the endpoint docs. All continue-on-error (null on any
 * failure) so one bad company never sinks a run.
 * ----------------------------------------------------------------------- */

/** Company search (autocomplete + ticker resolution). Returns raw JSON whose
 *  data.results is { TICKER: [country, name, sector], ... }. */
export function stockSearch(query) {
  return request(`${HOST.birdnest}/stock/search`,
    { method: 'POST', payload: { query: String(query || ''), user_index: USER_INDEX }, kind: 'stock' });
}

/** Combined financials for a listed India ticker — the richest source (screener.in
 *  markdown). Returns the raw markdown TEXT (or null). */
export function combinedFinancials(ticker, { country = STOCK_COUNTRY, q = 'consolidated' } = {}) {
  return request(`${HOST.devde}/filings/combined_financials`,
    { method: 'POST', payload: { ticker: String(ticker || ''), country, q }, raw: true });
}

/** Optional forward/street estimates for a ticker (text/plain). Returns text or null. */
export function streetEstimates(ticker, { country = 'INDIA' } = {}) {
  const url = `${HOST.fastapi}/data/street_estimates?ticker=${encodeURIComponent(ticker)}&country=${encodeURIComponent(country)}`;
  return request(url, { method: 'GET', raw: true });
}

/** DRHP prospectus lookup for an unlisted company (by name or ticker). Returns JSON. */
export function drhpByName(tickerOrName) {
  return request(`${HOST.devde}/filings/drhp/${encodeURIComponent(String(tickerOrName || ''))}`,
    { method: 'GET', kind: 'drhp' });
}

/** Search the DRHP (unlisted / recently-filed) list for a name. Returns JSON. */
export function drhpSearch(name) {
  const url = `${HOST.devde}/filings/drhp?search=${encodeURIComponent(String(name || ''))}&source=IND`;
  return request(url, { method: 'GET', kind: 'drhp-list' });
}

/** Normalize a birdnest stock/search response into [{ ticker, name, sector, country }].
 *  Documented shape: data.results = { TICKER: [country, name, sector], ... }. Tolerant
 *  of junk rows; pure + testable. Mirrors the Worker's normalizer (Part A). */
export function normalizeStockSearch(data) {
  const results = data && data.results;
  if (!results || typeof results !== 'object' || Array.isArray(results)) return [];
  const out = [];
  for (const [ticker, arr] of Object.entries(results)) {
    if (!Array.isArray(arr)) continue;
    const country = String(arr[0] == null ? '' : arr[0]).trim();
    const name = String(arr[1] == null ? '' : arr[1]).trim();
    const sector = String(arr[2] == null ? '' : arr[2]).trim();
    const t = String(ticker || '').trim();
    if (!t && !name) continue;
    out.push({ ticker: t, name, sector, country });
  }
  return out;
}

/* ----------------------------------------------------------------------- *
 * Normalizers — tolerant of the many container shapes an API might use.
 * ----------------------------------------------------------------------- */

/** Find the first array-of-objects anywhere near the top of a response. */
function firstResultArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  // Common container keys first.
  for (const key of ['results', 'data', 'items', 'articles', 'news', 'documents', 'hits', 'output']) {
    if (Array.isArray(data[key])) return data[key];
    if (data[key] && typeof data[key] === 'object') {
      for (const k2 of ['results', 'data', 'items', 'articles']) {
        if (Array.isArray(data[key][k2])) return data[key][k2];
      }
    }
  }
  // Fallback: any array-valued property.
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return [];
}

const pick = (obj, keys) => {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]);
  }
  return '';
};

/** Remove HTML tags + decode common entities from scraped result text, so stored
 *  titles/snippets never carry raw "<strong>" / "&amp;" junk into the dashboard OR
 *  the grounded chat context. Decode entities FIRST, then strip tags. Guarded by a
 *  cheap test so plain text passes untouched. Mirrors the frontend cleaner. */
export function stripHtml(s) {
  if (s == null) return s;
  s = String(s);
  if (!/[<&]/.test(s)) return s;
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCharCode(+n); } catch (e) { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCharCode(parseInt(n, 16)); } catch (e) { return ''; } })
    .replace(/<\/?[a-z!][^>]*>/gi, '')
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim();
}

/** Normalize a web/news search response into [{title, url, snippet, publisher?, date?}]. */
export function normalizeSearch(data) {
  return firstResultArray(data)
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      const url = pick(r, ['url', 'link', 'href', 'source_url', 'page_url']);
      const title = stripHtml(pick(r, ['title', 'name', 'heading', 'headline']));
      const snippet = stripHtml(pick(r, ['snippet', 'description', 'summary', 'text', 'content', 'excerpt', 'abstract']));
      const publisher = stripHtml(pick(r, ['publisher', 'source', 'source_name', 'site', 'domain', 'provider']));
      const date = pick(r, ['date', 'published', 'published_at', 'published_date', 'age', 'pub_date']);
      const out = { url, title, snippet };
      if (publisher) out.publisher = publisher;
      if (date) out.date = date;
      return out;
    })
    .filter((r) => r && (r.url || r.title));
}

/** Normalize a web-reader response into [{url, text}]. */
export function normalizeReader(data) {
  // Reader responses vary: an array of {url,text}, or an object keyed by url,
  // or a {results:[...]} envelope. Handle all three.
  const out = [];
  const pushOne = (url, text) => {
    const u = (url || '').trim();
    const t = (text || '').trim();
    if (t) out.push({ url: u, text: t });
  };

  if (Array.isArray(data)) {
    for (const r of data) {
      if (r && typeof r === 'object') pushOne(pick(r, ['url', 'link', 'href']), pick(r, ['text', 'content', 'markdown', 'body', 'extracted_text', 'page_content']));
    }
    return out;
  }
  if (data && typeof data === 'object') {
    const arr = firstResultArray(data);
    if (arr.length) {
      for (const r of arr) {
        if (r && typeof r === 'object') pushOne(pick(r, ['url', 'link', 'href']), pick(r, ['text', 'content', 'markdown', 'body', 'extracted_text', 'page_content']));
      }
      if (out.length) return out;
    }
    // Object keyed by URL -> string or {text}.
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') pushOne(k, v);
      else if (v && typeof v === 'object') pushOne(pick(v, ['url', 'link']) || k, pick(v, ['text', 'content', 'markdown', 'body']));
    }
  }
  return out;
}
