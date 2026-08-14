/**
 * scripts/research-industry.mjs — the deep-research pipeline.
 *
 * Gathers real, source-backed data for an industry and writes it into the
 * exact Prompt-1 JSON schema at public/data/industries/<slug>.json.
 *
 * Scope: Deep Research / Overview data (size, growth, segments, value chain,
 * channels, players, margins, and — for manufacturing — capacity/imports) PLUS
 * the news, YouTube and reports source tabs. Segments / value chain / channels /
 * margins / market share come from richer sources (broker & industry report
 * PDFs read via OCR, plus scraped report pages), not just generic web search.
 *
 * INDUSTRY env selects the target (default "MDF boards, India").
 * No npm dependencies — global fetch + node stdlib only.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callClaudeJSON, llmConfig } from '../lib/llm.mjs';
import { webSearch, newsSearch, webReader, normalizeSearch, normalizeReader } from '../lib/muns.mjs';
import { firecrawlScrape, scrapedoScrape, mistralOCR, htmlToText, extractYouTubeFromHtml } from '../lib/scrape.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'public', 'data', 'industries');

const INDUSTRY = (process.env.INDUSTRY || 'MDF boards, India').trim();
const COUNTRY = process.env.INDUSTRY_COUNTRY || 'India';

// Budgets — keep the model prompt to a sane size.
const MAX_URLS = 15;
const READER_BATCH = 4;
const MAX_SOURCE_CHARS = 8000;    // per generic web page
const MAX_REPORT_CHARS = 25000;   // per rich report / PDF (they carry the numbers)
const MAX_TOTAL_CHARS = 150000;   // whole SOURCES block (smaller = cleaner, more reliable output)
const MAX_YOUTUBE = 8;
const MAX_REPORTS = 8;
const READ_REPORTS = 3;           // how many report URLs to fully read (top 2-3 cleanest)

/* ----------------------------------------------------------------------- */

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'industry';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

export function canonicalUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    let s = `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`.replace(/\/+$/, '');
    return s + (url.search || '');
  } catch (e) {
    return String(u || '').trim();
  }
}

/** Extract an 11-char YouTube video id from a watch / youtu.be / embed URL. */
export function youtubeId(u) {
  if (!u) return null;
  const m = String(u).match(/(?:youtube\.com\/(?:watch\?[^ ]*v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

const isPdf = (u) => /\.pdf(\?|#|$)/i.test(String(u || ''));

/** Rough report type from the domain + title. */
export function reportType(url, title) {
  const s = `${url} ${title}`.toLowerCase();
  if (/\.gov|gov\.in|ministry|\bniti\b|\bibef\b|commerce\.gov|\bpib\b|\bmsme\b/.test(s)) return 'government';
  if (/broker|securities|equ-?ity research|initiating coverage|motilal|icici|hdfc sec|kotak|axis cap|nirmal bang|antique|emkay|sharekhan|prabhudas/.test(s)) return 'broker';
  if (/market report|research and markets|grandview|grand view|mordor|imarc|expertmarketresearch|expert market|technavio|statista|marketsandmarkets|market\.us|industryarc|credence|maximize/.test(s)) return 'industry';
  return 'other';
}

const oneLine = (s, max = 200) => {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
};

/** Drop empty-string / null / undefined values so the JSON stays clean. */
function pruneEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out;
}

/** Checklist-driven query set covering every schema section. */
function buildQueries(industry) {
  return [
    `${industry} market size 2024 2025`,
    `${industry} market growth rate CAGR forecast`,
    `${industry} market segments by application share`,
    `${industry} value chain analysis raw material to retail`,
    `${industry} distribution channels dealers modern trade`,
    `${industry} key players market share leaders`,          // critical
    `${industry} top companies revenue EBITDA margin`,        // critical
    `${industry} listed companies stock manufacturers`,
    `${industry} manufacturer margin vs retailer margin profitability`,
    `${industry} demand drivers growth outlook`,
    `${industry} production capacity additions expansion`,    // manufacturing
    `${industry} imports exports anti-dumping duty`,          // manufacturing
    `${industry} industry report analysis`,
  ];
}

function newsQueries(industry) {
  return [
    `${industry} news`,
    `${industry} capacity expansion results`,
    `${industry} prices demand`,
  ];
}

/* ----------------------------------------------------------------------- */

async function gatherSearchUrls(industry) {
  const queries = buildQueries(industry);
  const seen = new Map(); // canonicalUrl -> {title,url,snippet}
  let rawCount = 0;

  for (const q of queries) {
    const results = normalizeSearch(await webSearch(q, COUNTRY));
    rawCount += results.length;
    for (const r of results) {
      if (!r.url) continue;
      const key = canonicalUrl(r.url);
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, { title: r.title || '', url: r.url, snippet: r.snippet || '' });
    }
    console.log(`[research] search "${q}" -> ${results.length} results (${seen.size} unique so far)`);
  }

  const unique = [...seen.values()];
  const capped = unique.slice(0, MAX_URLS);
  console.log(`[research] collected ${rawCount} raw results, ${unique.length} unique URLs, using top ${capped.length}, dropped ${unique.length - capped.length}.`);
  return capped;
}

async function gatherNews(industry) {
  const from_date = daysAgo(550); // ~18 months
  const to_date = today();
  const seen = new Map();
  for (const q of newsQueries(industry)) {
    const results = normalizeSearch(await newsSearch(q, COUNTRY, from_date, to_date));
    for (const r of results) {
      const key = canonicalUrl(r.url) || r.title;
      if (!key || seen.has(key)) continue;
      seen.set(key, {
        title: r.title || '',
        publisher: r.publisher || '',
        date: r.date || '',
        url: r.url || '',
        snippet: r.snippet || '',
      });
    }
    console.log(`[research] news "${q}" -> ${results.length} items (${seen.size} unique so far)`);
  }
  const news = [...seen.values()].filter((n) => n.title || n.url).slice(0, 20);
  console.log(`[research] ${news.length} news items collected.`);
  return news;
}

async function readPages(urlObjs) {
  const urls = urlObjs.map((u) => u.url).filter(Boolean);
  const sources = [];
  for (let i = 0; i < urls.length; i += READER_BATCH) {
    const batch = urls.slice(i, i + READER_BATCH);
    const read = normalizeReader(await webReader(batch, `Extract facts about ${INDUSTRY}: market size, growth, segments, value chain, channels, key players and their revenue/margin/market share, capacity, imports and duties.`));
    for (const r of read) sources.push(r);
    console.log(`[research] read batch ${i / READER_BATCH + 1} (${batch.length} urls) -> ${read.length} pages`);
  }
  console.log(`[research] read ${sources.length}/${urls.length} pages successfully.`);
  return sources;
}

/* ---- YouTube discovery --------------------------------------------------- */

async function findYouTube(industry) {
  const bases = [
    `${industry} industry analysis`,
    `${industry} SOIC`,
    `${industry} value chain`,
    `${industry} factory tour`,
  ];
  const byId = new Map();
  const add = (id, title, url, snippet) => {
    if (!id || byId.has(id)) return;
    byId.set(id, {
      id,
      title: title || '',
      channel: '',
      url: `https://www.youtube.com/watch?v=${id}`,
      thumbnail: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
      snippet: snippet || '',
    });
  };

  // PRIMARY: Muns web search with a site:youtube.com filter — needs no Scrape.do.
  for (const base of bases) {
    for (const q of [`${base} site:youtube.com`, `${base} youtube`]) {
      const results = normalizeSearch(await webSearch(q, COUNTRY));
      let found = 0;
      for (const r of results) {
        const id = youtubeId(r.url);
        if (id) { add(id, r.title, r.url, r.snippet); found++; }
      }
      console.log(`[research] youtube search "${q}" -> ${found} video links (${byId.size} unique so far)`);
    }
  }

  // OPTIONAL enrichment only: scrape the (JS-heavy) YouTube results page for more
  // ids. Never load-bearing — if Scrape.do is unavailable it just adds nothing.
  try {
    const scraped = await scrapedoScrape(`https://www.youtube.com/results?search_query=${encodeURIComponent(industry + ' industry')}`);
    if (scraped && scraped.html) {
      for (const v of extractYouTubeFromHtml(scraped.html)) add(v.id, v.title, null, '');
    }
  } catch (e) { /* continue-on-error */ }

  // Prefer titled candidates, then cap.
  const cands = [...byId.values()].sort((a, b) => (b.title ? 1 : 0) - (a.title ? 1 : 0)).slice(0, MAX_YOUTUBE);
  console.log(`[research] youtube candidates: ${cands.length} (from ${byId.size} unique video ids).`);
  return cands;
}

/* ---- Report discovery + reading ----------------------------------------- */

async function findReports(industry) {
  const queries = [
    `${industry} industry report pdf`,
    `${industry} initiating coverage pdf`,
    `${industry} market report`,
    `${industry} annual report`,
  ];
  const seen = new Map();
  for (const q of queries) {
    const results = normalizeSearch(await webSearch(q, COUNTRY));
    for (const r of results) {
      if (!r.url) continue;
      if (/youtube\.com|youtu\.be|facebook\.com|twitter\.com|[/.]x\.com|instagram\.com|linkedin\.com/i.test(r.url)) continue;
      const key = canonicalUrl(r.url);
      if (!key || seen.has(key)) continue;
      seen.set(key, {
        title: r.title || '',
        url: r.url,
        publisher: r.publisher || '',
        snippet: r.snippet || '',
        type: reportType(r.url, r.title || ''),
      });
    }
    console.log(`[research] reports "${q}" -> ${results.length} results (${seen.size} unique so far)`);
  }
  const cands = [...seen.values()].slice(0, MAX_REPORTS);
  console.log(`[research] report candidates: ${cands.length}.`);
  return cands;
}

async function readReports(reportCands) {
  // Prioritise PDFs (they carry segments / margins / market share), read a few.
  const ranked = [...reportCands].sort((a, b) => (isPdf(b.url) ? 1 : 0) - (isPdf(a.url) ? 1 : 0));
  const top = ranked.slice(0, READ_REPORTS);
  const out = [];
  for (const c of top) {
    let src = null;
    if (isPdf(c.url)) {
      src = await mistralOCR(c.url);
    } else {
      src = await firecrawlScrape(c.url);
      if (!src) {
        const s = await scrapedoScrape(c.url);
        if (s && s.html) src = { url: c.url, text: htmlToText(s.html) };
      }
    }
    if (src && src.text) {
      out.push({ url: c.url, text: src.text });
      console.log(`[research] report read OK  ${c.url} (${src.text.length} chars, ${isPdf(c.url) ? 'pdf/ocr' : 'scrape'})`);
    } else {
      console.log(`[research] report read FAIL ${c.url}`);
    }
  }
  console.log(`[research] read ${out.length}/${top.length} report sources.`);
  return out;
}

/* ---- Source-tab reconciliation (candidates + model annotations) ---------- */

export function mergeYouTube(candidates, claudeItems) {
  const ann = new Map();
  for (const c of (claudeItems || [])) {
    const id = youtubeId(c && c.url);
    if (id) ann.set(id, c);
  }
  const out = [];
  const seen = new Set();
  for (const c of (candidates || [])) {
    if (!c || !c.id || seen.has(c.id)) continue;
    const a = ann.get(c.id) || {};
    const item = pruneEmpty({
      title: a.title || c.title || '',
      channel: a.channel || c.channel || '',
      url: c.url,
      published: a.published || '',
      why_relevant: oneLine(a.why_relevant) || oneLine(c.snippet) || '',
      thumbnail: c.thumbnail,
    });
    if (!item.title || !item.url) continue; // need at least a title + url
    seen.add(c.id);
    out.push(item);
  }
  return out.slice(0, MAX_YOUTUBE);
}

export function mergeReports(candidates, claudeItems) {
  const ann = new Map();
  for (const c of (claudeItems || [])) {
    const k = canonicalUrl((c && c.url) || '');
    if (k) ann.set(k, c);
  }
  const out = [];
  const seen = new Set();
  for (const c of (candidates || [])) {
    const key = canonicalUrl(c.url);
    if (!key || seen.has(key)) continue;
    const a = ann.get(key) || {};
    const item = pruneEmpty({
      title: a.title || c.title || '',
      publisher: a.publisher || c.publisher || '',
      date: a.date || '',
      url: c.url,
      type: a.type || c.type || 'other',
      summary: oneLine(a.summary) || oneLine(c.snippet) || '',
    });
    if (!item.title || !item.url) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, MAX_REPORTS);
}

export function attachSources(obj, youtubeCands, reportCands) {
  obj.sources = (obj.sources && typeof obj.sources === 'object') ? obj.sources : {};
  const claudeYt = Array.isArray(obj.sources.youtube) ? obj.sources.youtube : [];
  const claudeRp = Array.isArray(obj.sources.reports) ? obj.sources.reports : [];
  obj.sources.youtube = mergeYouTube(youtubeCands, claudeYt);
  obj.sources.reports = mergeReports(reportCands, claudeRp);
  return obj;
}

/** Build the SOURCES block: rich report/PDF text first (prioritised), then web
 *  pages, then compact search snippets — capped, with the trimmed amount logged. */
export function buildSourcesBlock(reportSources, readerSources, searchUrls) {
  let total = 0;
  let trimmed = 0;
  const parts = [];

  const push = (label, url, text, cap) => {
    if (!text) return;
    const clipped = text.length > cap ? text.slice(0, cap) : text;
    if (text.length > cap) trimmed += text.length - cap;
    const block = `\n===== ${label}: ${url || '(unknown url)'} =====\n${clipped}\n`;
    if (total + block.length > MAX_TOTAL_CHARS) { trimmed += clipped.length; return; }
    parts.push(block);
    total += block.length;
  };

  for (const s of (reportSources || [])) push('REPORT SOURCE', s.url, s.text, MAX_REPORT_CHARS);
  for (const s of (readerSources || [])) push('WEB SOURCE', s.url, s.text, MAX_SOURCE_CHARS);

  const snippetLines = (searchUrls || [])
    .filter((u) => u.snippet)
    .map((u) => `- ${u.title ? u.title + ' — ' : ''}${u.snippet} [${u.url}]`);
  if (snippetLines.length) {
    const block = `\n===== SEARCH SNIPPETS =====\n${snippetLines.join('\n')}\n`;
    if (total + block.length <= MAX_TOTAL_CHARS) { parts.push(block); total += block.length; }
    else {
      const room = MAX_TOTAL_CHARS - total;
      if (room > 200) { parts.push(block.slice(0, room)); total += room; trimmed += block.length - room; }
      else trimmed += block.length;
    }
  }

  console.log(`[research] SOURCES block: ${total} chars (${(reportSources || []).length} reports + ${(readerSources || []).length} web + snippets); ~${trimmed} chars trimmed.`);
  return parts.join('\n');
}

/* ----------------------------------------------------------------------- */

const SYSTEM_PROMPT = `You are an equity/industry research analyst. Produce a single JSON object describing an industry, filled ONLY from the SOURCES the user provides.

Return ONLY the JSON object — no prose, no markdown, no code fences, no XML tags. Your entire response must start with { and end with }.

Output STRICTLY VALID JSON. Inside every string value: keep it on a single line (no raw line breaks) and do NOT include any raw double-quote (") character — if you need to quote something inside a string, remove the quotes or use single quotes instead. This is critical: one stray unescaped quote breaks the whole file.

Required JSON shape (OMIT any field, array item, or whole section you cannot support from the SOURCES — never output an empty placeholder and never invent numbers):

{
  "meta": { "slug", "name", "aliases": [], "definition", "is_manufacturing": true|false, "generated_at", "mock": false },
  "summary": { "headline", "key_takeaways": ["3-5 short plain-English bullets"], "report_markdown": "## multi-section writeup using ## headings, **bold**, and - lists" },
  "size": { "current": { "value": <number>, "unit": "e.g. USD billion / ₹ crore", "year": <number> }, "cagr_pct": <number>, "cagr_note": "short window note", "history": [ { "year": <number>, "value": <number> } ], "source": { "label", "url", "snippet" } },
  "segments": [ { "name", "share_pct": <number>, "note", "source": {"label","url","snippet"} } ],
  "growth_drivers": [ { "title", "detail", "source": {"label","url","snippet"} } ],
  "tailwinds": [ { "point", "source": {"label","url","snippet"} } ],
  "headwinds": [ { "point", "source": {"label","url","snippet"} } ],
  "value_chain": [ { "stage", "description", "margin_note", "source": {"label","url","snippet"} } ],
  "channels": [ { "channel", "share_pct": <number>, "source": {"label","url","snippet"} } ],
  "players": [ { "name", "listed": true|false, "ticker", "segment", "revenue": <number>, "revenue_unit", "revenue_year": <number>, "ebitda_margin_pct": <number>, "market_share_pct": <number>, "note", "source": {"label","url","snippet"} } ],
  "margins": { "manufacturer_pct": <number>, "retailer_pct": <number>, "notes", "source": {"label","url","snippet"} },
  "quant": { "capacity": [ { "player", "region", "capacity": <number>, "unit", "year": <number> } ], "utilisation_pct": <number>, "imports": [ { "year": <number>, "volume": <number>, "unit" } ], "duty": [ { "country", "note" } ], "source": {"label","url","snippet"} },
  "sources": {
    "youtube": [ { "title", "channel", "url", "published", "why_relevant" } ],
    "reports": [ { "title", "publisher", "date", "url", "type", "summary" } ]
  }
}

Rules:
- Fill ONLY from the provided SOURCES. Do NOT use outside knowledge for numbers.
- Every fact object MUST include "source": { "label": short publisher/source name, "url": the source URL from the SOURCES, "snippet": a short ~15-30 word supporting quote from that source, written as PLAIN TEXT — strip any internal double-quotes and line breaks (paraphrase lightly or use single quotes if needed) so it is safe inside a JSON string }. If you cannot attach a real source URL and a supporting snippet, OMIT the fact.
- Numbers must come from the sources. Never estimate, round-trip, or invent figures. Prefer the most recent year available.
- The REPORT SOURCE blocks (broker / industry / government reports and PDFs) are the best place to find segments, value chain, distribution channels, margins and player market share — mine them carefully for those sections.
- "players" is the most important section — capture as many named companies as the sources support, with whatever of revenue / EBITDA % / market share / listed / ticker each source gives.
- Include the "quant" section ONLY if the industry is manufacturing AND the sources give capacity / utilisation / imports / duty. Otherwise omit "quant" entirely.
- For "sources.youtube" and "sources.reports": use ONLY the provided YOUTUBE CANDIDATES and REPORT CANDIDATES lists — do NOT invent videos or reports. Keep each item's exact url. Add channel / publisher / date / type only when evident, and write a one-line plain-English "why_relevant" (video) or "summary" (report). Omit any candidate that is clearly irrelevant to this industry. Do NOT include a "news" key — news is added separately.
- Set meta.mock = false and meta.generated_at to today. Use simple, plain-English labels a non-expert can read.
- Keep "report_markdown" grounded in the sourced facts; no filler.`;

export function enforceMeta(obj, slug) {
  const meta = (obj.meta && typeof obj.meta === 'object') ? obj.meta : {};
  meta.slug = slug;
  meta.name = (meta.name && String(meta.name).trim()) || INDUSTRY;
  if (!Array.isArray(meta.aliases)) meta.aliases = [];
  meta.mock = false;
  meta.generated_at = today();
  if (typeof meta.is_manufacturing !== 'boolean') meta.is_manufacturing = undefined;
  obj.meta = meta;
  return obj;
}

export function foldNews(obj, newsItems) {
  obj.sources = (obj.sources && typeof obj.sources === 'object') ? obj.sources : {};
  const existing = Array.isArray(obj.sources.news) ? obj.sources.news : [];
  const merged = new Map();
  for (const n of [...existing, ...newsItems]) {
    if (!n || (!n.url && !n.title)) continue;
    const key = canonicalUrl(n.url) || n.title;
    if (!merged.has(key)) merged.set(key, n);
  }
  obj.sources.news = [...merged.values()];
  // Reports + YouTube are populated in a later step.
  if (!Array.isArray(obj.sources.reports)) obj.sources.reports = [];
  if (!Array.isArray(obj.sources.youtube)) obj.sources.youtube = [];
  return obj;
}

function reportFilled(obj) {
  const status = {};
  const has = (v) => v != null && (Array.isArray(v) ? v.length > 0 : (typeof v === 'object' ? Object.keys(v).length > 0 : String(v).trim() !== ''));
  status.summary = has(obj.summary && obj.summary.headline);
  status.size = has(obj.size && (obj.size.current || obj.size.history));
  status.segments = has(obj.segments);
  status.growth_drivers = has(obj.growth_drivers);
  status.tailwinds = has(obj.tailwinds);
  status.headwinds = has(obj.headwinds);
  status.value_chain = has(obj.value_chain);
  status.channels = has(obj.channels);
  status.players = has(obj.players);
  status.margins = has(obj.margins);
  status.quant = has(obj.quant);
  status['sources.news'] = has(obj.sources && obj.sources.news);
  status['sources.youtube'] = has(obj.sources && obj.sources.youtube);
  status['sources.reports'] = has(obj.sources && obj.sources.reports);
  const filled = Object.entries(status).filter(([, v]) => v).map(([k]) => k);
  const empty = Object.entries(status).filter(([, v]) => !v).map(([k]) => k);
  console.log(`[research] FILLED: ${filled.join(', ') || '(none)'}`);
  console.log(`[research] EMPTY : ${empty.join(', ') || '(none)'}`);
}

function upsertIndex(slug, meta) {
  const indexPath = join(DATA_DIR, 'index.json');
  let index = { default: slug, industries: [] };
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch (e) {
      console.warn(`[research] index.json unreadable (${e.message}); recreating.`);
    }
  }
  if (!Array.isArray(index.industries)) index.industries = [];
  const entry = {
    slug,
    name: meta.name || INDUSTRY,
    aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
    is_manufacturing: !!meta.is_manufacturing,
    mock: false,
  };
  const i = index.industries.findIndex((e) => e && e.slug === slug);
  if (i >= 0) index.industries[i] = entry;
  else index.industries.push(entry);
  index.default = slug; // freshly researched industry becomes the default view
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  console.log(`[research] index.json updated (default=${slug}, ${index.industries.length} industries).`);
}

/* ----------------------------------------------------------------------- */

async function main() {
  const cfg = llmConfig();
  console.log(`[research] industry="${INDUSTRY}" country="${COUNTRY}"`);
  console.log(`[research] model=${cfg.model_id} region=${cfg.region}`);
  const slug = slugify(INDUSTRY);
  console.log(`[research] slug=${slug}`);

  // a/b) queries -> web search + news
  const searchUrls = await gatherSearchUrls(INDUSTRY);
  const newsItems = await gatherNews(INDUSTRY);

  if (!searchUrls.length && !newsItems.length) {
    throw new Error('No search or news results — check MUNS_TOKEN and connectivity. Aborting so no empty file is written.');
  }

  // c) discover YouTube videos and report/PDF candidates
  const youtubeCands = await findYouTube(INDUSTRY);
  const reportCands = await findReports(INDUSTRY);

  // d) read rich report sources (PDF via OCR, else scrape) + the top web pages
  const reportSources = await readReports(reportCands);
  const readerSources = await readPages(searchUrls);

  // e) extract into the schema — reports prioritised in the source budget
  const sourcesBlock = buildSourcesBlock(reportSources, readerSources, searchUrls);
  const ytList = youtubeCands.length
    ? youtubeCands.map((c, i) => `${i + 1}. ${c.title || '(untitled)'} — ${c.url}`).join('\n')
    : '(none)';
  const rpList = reportCands.length
    ? reportCands.map((c, i) => `${i + 1}. [${c.type}] ${c.title || '(untitled)'} — ${c.url}`).join('\n')
    : '(none)';

  const user = `Industry: ${INDUSTRY}\nCountry focus: ${COUNTRY}\n\nSOURCES:\n${sourcesBlock}\n\nYOUTUBE CANDIDATES:\n${ytList}\n\nREPORT CANDIDATES:\n${rpList}`;
  console.log('[research] calling Claude for structured extraction...');
  // Disable thinking so the entire token budget goes to the JSON (on Sonnet 5,
  // adaptive thinking otherwise eats the budget and truncates the output), and
  // give a generous ceiling for a rich schema with a full report_markdown.
  let obj = await callClaudeJSON({ system: SYSTEM_PROMPT, user, max_tokens: 20000, thinking: { type: 'disabled' } });
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Model did not return a JSON object.');
  }

  // f) enforce meta, fold news, reconcile youtube/reports, write files, report
  obj = enforceMeta(obj, slug);
  obj = foldNews(obj, newsItems);
  obj = attachSources(obj, youtubeCands, reportCands);

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const outPath = join(DATA_DIR, `${slug}.json`);
  writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n');
  console.log(`[research] wrote ${outPath}`);

  upsertIndex(slug, obj.meta);
  reportFilled(obj);
  console.log('[research] DONE');
}

// Run only when invoked directly (not when imported by tests).
const isEntry = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch (e) {
    return false;
  }
})();

if (isEntry) {
  main().catch((err) => {
    console.error('[research] FAILED');
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
