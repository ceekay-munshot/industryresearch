/**
 * scripts/research-industry.mjs — the deep-research pipeline.
 *
 * Gathers real, source-backed data for an industry and writes it into the
 * exact Prompt-1 JSON schema at public/data/industries/<slug>.json.
 *
 * Scope: Deep Research / Overview data (size, growth, segments, value chain,
 * channels, players, margins, and — for manufacturing — capacity/imports) PLUS
 * the news, YouTube and reports source tabs.
 *
 * DESIGN — reliability first, maximum data, never fail:
 *  - Every external call (Muns, Firecrawl, Scrape.do, Mistral, Bedrock) is
 *    continue-on-error with retry+backoff inside its wrapper: a failure skips
 *    that one source and the run keeps going. The run only aborts if literally
 *    nothing at all was gathered — otherwise it always writes whatever it has.
 *  - No content caps / no trimming. Every report and page is read in FULL and,
 *    if large, chunked so nothing is skipped.
 *  - Two-stage map-reduce (to stay reliable, never to drop data):
 *      Stage A (map)    — one focused Claude call per source/chunk distils the
 *                         messy full text into a small list of clean checklist
 *                         facts (size, growth, segments, value chain, channels,
 *                         players, margins, market share, capacity, imports),
 *                         each with a short plain-text snippet + source url. A
 *                         failed source is skipped; the rest are kept.
 *      Stage B (reduce) — one call fills the full schema from the distilled
 *                         facts + search/news snippets. Because Stage A already
 *                         compacted everything, Stage B's input is always small
 *                         and clean regardless of how much raw text we read.
 *
 * INDUSTRY env selects the target (default "MDF boards, India").
 * No npm dependencies — global fetch + node stdlib only.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callClaudeJSON, llmConfig } from '../lib/llm.mjs';
import {
  webSearch, newsSearch, webReader, normalizeSearch, normalizeReader,
  stockSearch, combinedFinancials, streetEstimates, drhpByName, drhpSearch, normalizeStockSearch,
} from '../lib/muns.mjs';
import {
  BENCH_PROMPT_VERSION, FINANCIALS_SYSTEM, buildFinancialsUser, normalizeFinancials,
  hasFinancials, pickListedMatch, drhpDocFrom, drhpExists, drhpFinancialsText, mergeBenchmarking, normName as benchNormName,
} from '../lib/benchmark.mjs';
import { parseOverrides, applyOverrides } from '../lib/overrides.mjs';
import { firecrawlScrape, scrapedoScrape, mistralOCR, htmlToText, extractYouTubeFromHtml } from '../lib/scrape.mjs';
import {
  loadLedger, saveLedger, upsertFacts, decayAndSupersede, supportByCategory,
  buildLedgerDigest, mergeAssembly, mergeCoverage, factsFromAssembled, sourceQuality, sha256,
} from '../lib/store.mjs';
import {
  loadCache, saveCache, fetchCacheGet, fetchCachePut, extractKey, extractGet, extractPut,
} from '../lib/cache.mjs';
import {
  reportInputHash, REPORT_SYSTEM, buildReportUser, normalizeReport, deterministicReport,
} from '../lib/report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'public', 'data', 'industries');
const STORE_ROOT = join(ROOT, 'data', 'store');
const CACHE_ROOT = join(ROOT, 'data', 'cache');

const INDUSTRY = (process.env.INDUSTRY || 'MDF boards, India').trim();
const COUNTRY = process.env.INDUSTRY_COUNTRY || 'India';
/** Qualify an industry term with the country UNLESS it already names it, so the
 *  research is done through the country's (India's) lens without double-tagging
 *  "MDF boards, India, India". Used by the web / YouTube / report query builders. */
const withCountry = (industry) => new RegExp(`\\b${COUNTRY}\\b`, 'i').test(industry) ? industry : `${industry} ${COUNTRY}`;
// The current year drives recency everywhere: search queries hunt for it, and the
// analyst prompts are told to lead with it rather than an old base year.
const YEAR = new Date().getFullYear();

// Bump when the Stage-A extraction prompt changes — every cached extraction then
// misses and re-runs, so a prompt improvement propagates cleanly. The model id is
// also part of the cache key (see lib/cache.mjs), so a model change recomputes too.
const PROMPT_VERSION = 'stageA-v1';
// How long a fetched source is trusted without re-fetching (content-hash cache).
// Re-runs within this window on the same machine skip the fetch entirely; a fresh
// CI runner re-fetches but still skips the (dominant) LLM extraction via the
// committed extraction markers.
const FETCH_TTL_DAYS = Number(process.env.FETCH_TTL_DAYS || 30);

// Discovery breadth. These bound how many candidates we DISCOVER — they never
// trim the CONTENT of anything we read (sources are always read in full and
// chunked). Any drop past a bound is logged, never silent.
const MAX_URLS = 20;            // generic web pages to read
const READER_BATCH = 3;        // small reader batches — don't overwhelm the API
const REPORT_CAND_CAP = 30;    // report candidates to keep from discovery
const REPORT_READ_CAP = 24;    // report candidates to fully read
const CHUNK_CHARS = 36000;     // Stage-A chunk size (large sources are chunked)
const CHUNK_OVERLAP = 1200;    // overlap so a fact spanning a boundary isn't lost
const STAGE_A_MAX_TOKENS = 6000;
const STAGE_B_MAX_TOKENS = 24000;
const REPORT_MAX_TOKENS = 20000;
const MAX_YOUTUBE = 8;         // videos shown in the YouTube tab
const MAX_REPORTS = 12;        // reports shown in the Reports tab

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

/** Checklist-driven query set covering every schema section. Years are dynamic
 *  (current + neighbours) so the pipeline always hunts for the LATEST figures,
 *  never a hard-coded base year that silently ages every calendar year. */
function buildQueries(industry) {
  const Y = YEAR;
  const C = COUNTRY;
  const inC = withCountry(industry);   // e.g. "Paints & Coatings India"
  return [
    // --- India-primary: size, structure, players, margins (the analyst's home market) ---
    `${inC} market size ${Y}`,
    `${inC} market size ${Y} ${Y - 1} latest estimate`,
    `${inC} market size forecast ${Y}-${Y + 6}`,
    `${inC} ${Y} outlook trends latest`,
    `${inC} market growth rate CAGR forecast`,
    `${inC} market segments by application share`,
    `${inC} value chain analysis raw material to retail`,
    `${inC} distribution channels dealers modern trade`,
    `${inC} key players market share leaders`,          // critical
    `${inC} top companies revenue EBITDA margin ${Y}`,   // critical
    `${inC} listed companies stock manufacturers`,
    `${inC} manufacturer margin vs retailer margin profitability`,
    `${inC} demand drivers growth outlook ${Y}`,
    `${inC} production capacity additions expansion ${Y}`, // manufacturing
    // --- Trade & regulation through an Indian-analyst lens (KEPT, never dropped) ---
    `${industry} ${C} imports exports import dependence ${Y}`,
    `${industry} ${C} anti-dumping duty import tariff safeguard`,
    `${industry} ${C} export destinations global demand`,
    `${industry} regulations standards affecting ${C} producers exporters`,
    // --- Global context that MOVES the India market (still an analyst's job to know) ---
    `${industry} global market size ${Y} versus ${C}`,
    `${industry} global oversupply China price impact ${C}`,
    `${inC} industry report ${Y} analysis pdf`,
  ];
}

function newsQueries(industry) {
  const Y = YEAR;
  const C = COUNTRY;
  const inC = withCountry(industry);
  return [
    `${inC} news ${Y}`,
    `${inC} latest developments ${Y}`,
    `${inC} capacity expansion results ${Y}`,
    `${inC} prices demand ${Y}`,
    `${industry} ${C} import duty anti-dumping trade policy ${Y}`,   // trade / policy
    `${industry} ${C} government policy regulation ${Y}`,            // government
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
  console.log(`[research] collected ${rawCount} raw results, ${unique.length} unique URLs, reading top ${capped.length}, dropped ${unique.length - capped.length}.`);
  // Return both the pages to read and ALL snippets (snippets are cheap and help
  // Stage B even for pages we don't fully read).
  return { pages: capped, all: unique };
}

/* ---- News-domain heuristics + company-news helpers ---------------------- */

// Well-known business/news outlets (India-focused, plus global wires).
const NEWS_DOMAINS = /(?:economictimes\.indiatimes|business-standard|livemint|moneycontrol|thehindubusinessline|businessline\.|financialexpress|businesstoday\.in|zeebiz|cnbctv18|bqprime|bloombergquint|ndtv|hindustantimes|timesofindia\.indiatimes|indianexpress|reuters|bloomberg|forbes|equitymaster|trendlyne)\.[a-z]/i;

/** Does a search hit look like a news article (news-outlet domain or news-y path)? */
export function looksLikeNews(url, publisher = '') {
  const u = String(url || '');
  if (!u) return false;
  if (NEWS_DOMAINS.test(u)) return true;
  if (/\/(news|article|articleshow|markets|companies|story|press-release)s?[\/-]/i.test(u)) return true;
  const p = String(publisher || '').toLowerCase();
  if (/(times|news|mint|standard|express|wire|reuters|bloomberg|moneycontrol|cnbc)/.test(p)) return true;
  return false;
}

/** Turn general web-search hits into news items, keeping only news-looking ones. */
export function newsFromWeb(results) {
  const out = [];
  for (const r of (results || [])) {
    if (!r || !r.url || !looksLikeNews(r.url, r.publisher)) continue;
    out.push({ title: r.title || '', publisher: r.publisher || '', date: r.date || '', url: r.url, snippet: r.snippet || '' });
  }
  return out;
}

/** Strip parentheticals + corporate suffixes so a player name searches cleanly. */
export function cleanCompanyName(name) {
  return String(name || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(Ltd|Limited|Pvt|Private|Inc|LLP)\.?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function gatherNews(industry, webResults) {
  const from_date = daysAgo(550); // ~18 months
  const to_date = today();
  const seen = new Map();
  const add = (n) => {
    if (!n || (!n.url && !n.title)) return;
    const key = canonicalUrl(n.url) || n.title;
    if (!key || seen.has(key)) return;
    seen.set(key, {
      title: n.title || '',
      publisher: n.publisher || '',
      date: n.date || '',
      url: n.url || '',
      snippet: n.snippet || '',
    });
  };
  for (const q of newsQueries(industry)) {
    const results = normalizeSearch(await newsSearch(q, COUNTRY, from_date, to_date));
    for (const r of results) add(r);
    console.log(`[research] news "${q}" -> ${results.length} items (${seen.size} unique so far)`);
  }
  // Fallback / top-up: news-search is often sparse for niche industries. Synthesize
  // from the general web-search hits that point at news outlets (already gathered).
  if (seen.size < 8 && Array.isArray(webResults) && webResults.length) {
    const before = seen.size;
    const webNews = newsFromWeb(webResults);
    for (const n of webNews) add(n);
    console.log(`[research] news ${before ? 'thin — topping up' : 'empty — synthesizing'} from web hits: ${webNews.length} news-domain URLs, total now ${seen.size}.`);
  }
  const news = [...seen.values()].filter((n) => n.title || n.url).slice(0, 20);
  console.log(`[research] ${news.length} news items collected.`);
  return news;
}

/** Company-specific news, run AFTER we know the players. news-search first, then a
 *  news-domain-filtered web-search fallback (robust when news-search returns nothing). */
async function gatherCompanyNews(players, industry) {
  const from_date = daysAgo(550);
  const to_date = today();
  const names = [];
  const seenName = new Set();
  for (const p of (players || [])) {
    if (!p || !p.name) continue;
    const nm = cleanCompanyName(p.name);
    if (!nm || nm.length < 3 || seenName.has(nm.toLowerCase())) continue;
    seenName.add(nm.toLowerCase());
    names.push({ name: nm, listed: !!p.listed });
  }
  // Prioritise listed companies (they generate results/capacity news); cap calls.
  names.sort((a, b) => (b.listed ? 1 : 0) - (a.listed ? 1 : 0));
  const top = names.slice(0, 5);
  if (!top.length) return [];
  const seen = new Map();
  const add = (n) => {
    if (!n || (!n.url && !n.title)) return;
    const key = canonicalUrl(n.url) || n.title;
    if (!key || seen.has(key)) return;
    seen.set(key, { title: n.title || '', publisher: n.publisher || '', date: n.date || '', url: n.url || '', snippet: n.snippet || '' });
  };
  for (const { name } of top) {
    for (const q of [`${name} results`, `${name} capacity expansion`]) {
      const items = normalizeSearch(await newsSearch(q, COUNTRY, from_date, to_date));
      for (const r of items) add(r);
    }
    // Web fallback filtered to news outlets — catches news even if news-search is dead.
    const web = normalizeSearch(await webSearch(`${name} ${industry} news`, COUNTRY));
    for (const r of newsFromWeb(web)) add(r);
    console.log(`[research] company news "${name}" -> ${seen.size} total so far`);
  }
  const out = [...seen.values()].slice(0, 12);
  console.log(`[research] company news: ${out.length} items from ${top.length} companies.`);
  return out;
}

const READER_TASK = () => `Extract facts about ${INDUSTRY}: market size, growth, segments, value chain, channels, key players and their revenue/margin/market share, capacity, imports and duties.`;

/** Read one page's full text via the Muns reader. Returns text or null. */
async function fetchPageText(url) {
  const read = normalizeReader(await webReader([url], READER_TASK()));
  const hit = read.find((r) => r && r.text);
  return hit ? hit.text : null;
}

/** Read generic web pages in FULL through the content cache (per-URL so caching
 *  is precise). Returns [{url,text,content_hash,cached}]. */
async function readPages(urlObjs, cache, ctx) {
  const urls = urlObjs.map((u) => u.url).filter(Boolean);
  const results = await mapLimit(urls, READ_CONCURRENCY, async (url) => {
    const src = await cachedFetchText(cache, url, 'muns-reader', () => fetchPageText(url), ctx);
    return (src && src.text) ? { url, text: src.text, content_hash: src.content_hash, cached: src.cached } : null;
  });
  const out = results.filter(Boolean);
  const cachedN = out.filter((o) => o.cached).length;
  console.log(`[research] read ${out.length}/${urls.length} pages (${cachedN} from cache).`);
  return out;
}

/* ---- YouTube discovery --------------------------------------------------- */

async function findYouTube(industry) {
  // Bias toward videos that help UNDERSTAND the industry — overview, the key
  // players, the competitive/investment picture, and substitutes / "vs" videos —
  // with only a single "how it's made" angle. Stage B then curates from these.
  // India-analyst intent: what an analyst in India would actually watch — the
  // Indian market, Indian companies, India's outlook and its trade/global links —
  // not a generic US overview. COUNTRY is also passed to webSearch as a region hint.
  const inC = withCountry(industry);
  const C = COUNTRY;
  const bases = [
    `${inC} industry explained overview`,
    `${inC} market analysis ${YEAR} outlook`,
    `${inC} top companies key players`,
    `${industry} ${C} market opportunity investment thesis`,
    `${industry} ${C} versus global comparison`,
    `${industry} ${C} imports exports dependence`,
    `${industry} substitute products competition ${C}`,
    `${industry} how it is made process`,
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
    const scraped = await scrapedoScrape(`https://www.youtube.com/results?search_query=${encodeURIComponent(withCountry(industry) + ' industry')}`);
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
  // India-first, and bias hard toward REAL downloadable PDFs (not paywalled
  // market-research landing pages / tables-of-contents) — the client's ask was
  // "<industry> india filetype:pdf" and real Indian broker / association / govt reports.
  const inC = withCountry(industry);
  const C = COUNTRY;
  const queries = [
    `${inC} industry report filetype:pdf`,
    `${inC} market report filetype:pdf`,
    `${inC} initiating coverage brokerage report pdf`,   // Indian brokers (ICICI, Motilal, Nuvama…)
    `${inC} annual report pdf`,
    `${industry} ${C} association report pdf`,            // industry bodies (e.g. Indian Paint Association)
    `${industry} ${C} government ministry report pdf`,    // govt / policy
    `${industry} ${C} imports exports trade data pdf`,    // trade
    `${industry} global industry report pdf`,             // one global report for context
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
  const all = [...seen.values()];
  const cands = all.slice(0, REPORT_CAND_CAP);
  if (all.length > cands.length) console.log(`[research] ${all.length} report candidates found, keeping ${cands.length} (REPORT_CAND_CAP).`);
  console.log(`[research] report candidates: ${cands.length}.`);
  return cands;
}

/** Fetch one report candidate's full text (PDF -> OCR, else Firecrawl, then
 *  Scrape.do). Returns { text, method } or null. Never throws. */
async function fetchReportText(c) {
  try {
    if (isPdf(c.url)) {
      let src = await mistralOCR(c.url);
      if (src) return { text: src.text, method: 'pdf/ocr' };
      // OCR sometimes can't fetch/parse a PDF (e.g. 400 "file could not be
      // fetched") — let Firecrawl try the same PDF before giving up.
      src = await firecrawlScrape(c.url);
      if (src) return { text: src.text, method: 'pdf/firecrawl' };
      const s = await scrapedoScrape(c.url);
      if (s && s.html) return { text: htmlToText(s.html), method: 'pdf/scrapedo' };
    } else {
      const src = await firecrawlScrape(c.url);
      if (src) return { text: src.text, method: 'firecrawl' };
      const s = await scrapedoScrape(c.url);
      if (s && s.html) return { text: htmlToText(s.html), method: 'scrapedo' };
    }
  } catch (e) {
    console.warn(`[research] report read error ${c.url}: ${e.message}`);
  }
  return null;
}

/** Read every report candidate in FULL (no per-report char cap), through the
 *  content cache — a fresh fetch is skipped when the same URL was fetched within
 *  the TTL and its cached text is on hand. Returns [{url,text,content_hash,cached}]. */
async function readReports(reportCands, cache, ctx) {
  const ranked = [...reportCands].sort((a, b) => (isPdf(b.url) ? 1 : 0) - (isPdf(a.url) ? 1 : 0));
  const toRead = ranked.slice(0, REPORT_READ_CAP);
  if (ranked.length > toRead.length) {
    console.log(`[research] ${ranked.length} report candidates; reading ${toRead.length} (REPORT_READ_CAP), skipping ${ranked.length - toRead.length}.`);
  }
  const results = await mapLimit(toRead, READ_CONCURRENCY, async (c) => {
    const src = await cachedFetchText(cache, c.url, 'report', () => fetchReportText(c).then((r) => (r ? r.text : null)), ctx);
    if (src && src.text) {
      console.log(`[research] report read ${src.cached ? 'CACHE' : 'OK   '} ${c.url} (${src.text.length} chars)`);
      return { url: c.url, text: src.text, content_hash: src.content_hash, cached: src.cached };
    }
    console.log(`[research] report read FAIL ${c.url}`);
    return null;
  });
  const out = results.filter(Boolean);
  const cachedN = out.filter((o) => o.cached).length;
  console.log(`[research] read ${out.length}/${toRead.length} report sources (${cachedN} from cache).`);
  return out;
}

/** Fetch-or-cache a URL's cleaned text. Returns {text, content_hash, cached} or
 *  null. On a fresh cache record whose text blob is present, skips the fetch. */
async function cachedFetchText(cache, url, api, doFetch, ctx) {
  const hit = fetchCacheGet(cache, url, { ttlDays: ctx.ttlDays, now: ctx.now });
  if (hit && hit.text) return { text: hit.text, content_hash: hit.content_hash, cached: true };
  let text = null;
  try { text = await doFetch(); } catch (e) { console.warn(`[research] fetch error ${url}: ${e.message}`); }
  if (!text) return null;
  const { content_hash } = fetchCachePut(cache, url, text, { api, now: ctx.now });
  return { text, content_hash, cached: false };
}

/* ---- Full-text source prep ---------------------------------------------- */

/** Split text into <= size chunks with a small overlap so a fact that straddles
 *  a boundary still appears whole in at least one chunk. */
export function chunkText(text, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  const s = String(text || '');
  if (!s) return [];
  if (s.length <= size) return [s];
  const step = Math.max(1, size - overlap);
  const chunks = [];
  for (let i = 0; i < s.length; i += step) {
    chunks.push(s.slice(i, i + size));
    if (i + size >= s.length) break;
  }
  return chunks;
}

/** Merge report + web full-text sources and drop duplicate URLs so we never read
 *  (or pay to extract) the same page twice. */
export function dedupeSources(sources) {
  const seen = new Set();
  const out = [];
  for (const s of (sources || [])) {
    if (!s || !s.text) continue;
    const key = canonicalUrl(s.url) || s.url || '';
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(s);
  }
  return out;
}

/* ---- Stage A: per-source focused fact extraction (map) ------------------- */

const FACT_CATEGORIES = new Set([
  'size', 'growth', 'segments', 'value_chain', 'channels', 'players',
  'margins', 'market_share', 'capacity', 'imports', 'duty', 'other',
]);

const STAGE_A_SYSTEM = `You are a meticulous industry research analyst. You are given an industry name and ONE source document (which may be a chunk of a larger report). Extract EVERY fact in the SOURCE TEXT relevant to that industry — both quantified facts (numbers, %, years) AND named-company positioning statements (market leader, largest, #1, ranked, second-largest). Use ONLY the SOURCE TEXT — no outside knowledge, and never invent or round numbers.

Return ONLY a JSON object — your entire response must start with { and end with } — no prose, no markdown, no code fences:

{ "facts": [ { "category": "<one of: size, growth, segments, value_chain, channels, players, margins, market_share, capacity, imports, duty, other>", "text": "<one clear plain-English sentence stating the fact, including the specific number / name / % / year>", "snippet": "<a short ~10-25 word supporting quote from the SOURCE TEXT>" } ] }

CRITICAL — STRICTLY VALID JSON:
- Do NOT put any raw double-quote (") character inside a string value. If the source uses quotes, drop them or use single quotes.
- Keep every string on a single line — no raw line breaks inside a string value.
- One stray unescaped quote breaks the whole file, so be careful.

Capture (be exhaustive, one fact per data point): market size / value; growth, CAGR and forecasts; segment names and shares; value-chain stages and their margins; distribution channels and shares; named companies with market share / capacity / listed status / ticker (and revenue / EBITDA % ONLY if the source states that company's figure); market-leadership or ranking statements about named companies (largest / #1 / market leader / second-largest capacity), even when no exact percentage is given — categorize these as market_share or players; manufacturer vs retailer margins; production capacity and utilisation. Also capture, from a ${COUNTRY}-analyst viewpoint (do not skip these): imports / exports, volumes and key trading partners; import dependence on specific raw materials or inputs; anti-dumping / safeguard / countervailing or other duties imposed by or on ${COUNTRY}; foreign regulations, standards or trade barriers (e.g. BIS, REACH, EU rules) that affect ${COUNTRY} producers or exporters — categorize these as imports or duty; and global forces that materially move the ${COUNTRY} market such as China oversupply / dumping, global crude or raw-material price swings, and currency — categorize these as growth.

If the SOURCE TEXT contains no facts relevant to the industry, return exactly { "facts": [] }.`;

/** Normalize the model's Stage-A reply into clean fact records, tagging each with
 *  the known source url and enforcing plain-text snippets. */
export function normalizeFacts(raw, url) {
  const arr = raw && Array.isArray(raw.facts) ? raw.facts : (Array.isArray(raw) ? raw : []);
  const out = [];
  for (const f of arr) {
    if (!f || typeof f !== 'object') continue;
    const text = oneLine(f.text || f.fact || '', 400);
    if (!text) continue;
    let category = String(f.category || 'other').toLowerCase().replace(/[^a-z_]/g, '');
    if (!FACT_CATEGORIES.has(category)) category = 'other';
    // Snippets must be safe inside a JSON string later — strip double-quotes.
    const snippet = oneLine(f.snippet || '', 300).replace(/"/g, "'");
    out.push({ category, text, snippet, url: url || '' });
  }
  return out;
}

/** Drop facts that repeat (e.g. from overlapping chunks) by category+text. */
export function dedupeFacts(facts) {
  const seen = new Set();
  const out = [];
  for (const f of (facts || [])) {
    if (!f || !f.text) continue;
    const key = `${f.category}|${String(f.text).toLowerCase().replace(/\s+/g, ' ').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

async function extractFactsFromSource(source, idx, total, cache, ctx) {
  const chunks = chunkText(source.text);
  if (!chunks.length) return { facts: [], calls: 0, hits: 0 };
  const ch = source.content_hash || sha256(source.text);
  const facts = [];
  let calls = 0, hits = 0;
  for (let c = 0; c < chunks.length; c++) {
    const label = `${source.kind} ${idx + 1}/${total} chunk ${c + 1}/${chunks.length}`;
    const key = extractKey(ch, c, PROMPT_VERSION, ctx.modelId);
    if (extractGet(cache, key)) { hits++; continue; } // already extracted (facts are in the ledger)
    try {
      const user = `Industry: ${INDUSTRY}\nCountry focus: ${COUNTRY}\nSource URL: ${source.url}\n\nSOURCE TEXT (extract every relevant fact):\n${chunks[c]}`;
      const res = await callClaudeJSON({ system: STAGE_A_SYSTEM, user, max_tokens: STAGE_A_MAX_TOKENS, thinking: { type: 'disabled' } });
      const got = normalizeFacts(res, source.url).map((f) => ({
        category: f.category, text: f.text, snippet: f.snippet,
        source_url: f.url, source_quality: sourceQuality(f.url), content_hash: ch,
      }));
      facts.push(...got);
      extractPut(cache, key, got.length, ctx.now);
      calls++;
      console.log(`[research] stageA ${label} -> ${got.length} facts`);
    } catch (e) {
      // Isolate the failure: skip this chunk, keep everything else. Do NOT mark it
      // extracted, so a later run retries it.
      console.warn(`[research] stageA ${label} FAILED (skipped): ${e.message}`);
    }
  }
  return { facts, calls, hits };
}

/** Stage A over every full-text source: distil each into facts, using the
 *  extraction cache so unchanged chunks cost no LLM call. Returns the freshly
 *  extracted facts (to upsert into the ledger) and the set of content hashes seen
 *  this run (whose ledger facts get their last_seen bumped). */
/** Run `fn` over items with at most `limit` in flight. Order-preserving; a thrown
 *  item resolves to null so one bad source never sinks the batch. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

const STAGE_A_CONCURRENCY = Number(process.env.STAGE_A_CONCURRENCY) || 5;
const READ_CONCURRENCY = Number(process.env.READ_CONCURRENCY) || 4;

async function runStageA(fullTextSources, cache, ctx) {
  const seenHashes = new Set();
  for (const s of fullTextSources) if (s && s.content_hash) seenHashes.add(s.content_hash);
  // Each source is its own Claude call, so extract several at once — this turns a
  // long sequential grind into a short burst. Bedrock throttling (429) is handled
  // by the retry/backoff in lib/llm.mjs, and the per-source cache keys don't collide.
  const results = await mapLimit(fullTextSources, STAGE_A_CONCURRENCY,
    (s, i) => extractFactsFromSource(s, i, fullTextSources.length, cache, ctx));
  const all = [];
  let calls = 0, hits = 0;
  for (const r of results) { if (r && r.facts) { all.push(...r.facts); calls += r.calls || 0; hits += r.hits || 0; } }
  const deduped = dedupeFacts(all);
  console.log(`[research] Stage A: ${deduped.length} new facts from ${fullTextSources.length} sources (${calls} LLM calls, ${hits} chunks served from cache).`);
  return { facts: deduped, seenHashes };
}

/** Group facts by category into a compact, clean digest for Stage B. */
export function buildFactDigest(facts) {
  const order = ['size', 'growth', 'segments', 'value_chain', 'channels', 'players', 'margins', 'market_share', 'capacity', 'imports', 'duty', 'other'];
  const byCat = new Map(order.map((c) => [c, []]));
  for (const f of (facts || [])) {
    const cat = byCat.has(f.category) ? f.category : 'other';
    byCat.get(cat).push(f);
  }
  const parts = [];
  for (const cat of order) {
    const list = byCat.get(cat);
    if (!list || !list.length) continue;
    const lines = list.map((f) => `- ${f.text} (source: ${f.url || 'n/a'})${f.snippet ? ` [quote: ${f.snippet}]` : ''}`);
    parts.push(`## ${cat.toUpperCase().replace(/_/g, ' ')}\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

/* ---- Stage B: schema fill (reduce) --------------------------------------- */

const STAGE_B_SYSTEM = `You are an equity/industry research analyst. Produce a single JSON object describing an industry, filled ONLY from the EXTRACTED FACTS and SEARCH SNIPPETS the user provides.

Return ONLY the JSON object — no prose, no markdown, no code fences, no XML tags. Your entire response must start with { and end with }.

Output STRICTLY VALID JSON. Inside every string value: keep it on a single line (no raw line breaks) and do NOT include any raw double-quote (") character — if you need to quote something inside a string, remove the quotes or use single quotes instead. This is critical: one stray unescaped quote breaks the whole file.

Required JSON shape (OMIT any field, array item, or whole section you cannot support from the FACTS — never output an empty placeholder and never invent numbers):

{
  "meta": { "slug", "name", "aliases": [], "definition", "is_manufacturing": true|false, "generated_at", "mock": false },
  "summary": { "headline", "key_takeaways": ["3-5 short plain-English bullets"], "report_markdown": "## multi-section writeup using ## headings, **bold**, and - lists" },
  "highlights": [ { "label": "short KPI name", "value": "<number or short figure>", "unit": "optional", "year": <number>, "trend": "up|down|flat", "series": [ { "year": <number>, "value": <number> } ], "note": "optional one-liner", "source": {"label","url","snippet"} } ],
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
- INDIA-ANALYST LENS — read this whole brief as an equity/industry analyst sitting in ${COUNTRY}. ${COUNTRY} is the PRIMARY market: the "headline", "key_takeaways", "size", "segments", "channels", "players" and "margins" must lead with the ${COUNTRY} view and ${COUNTRY} figures. Crucially, do NOT discard global or cross-border context a ${COUNTRY} analyst needs — actively SURFACE it: ${COUNTRY}'s imports and exports and its import dependence for key raw materials/inputs, anti-dumping / safeguard / foreign duties and standards that affect ${COUNTRY} producers or exporters, and the global forces that move the ${COUNTRY} market (e.g. China oversupply / dumping, crude and raw-material price swings, currency). Route these into "highlights", "tailwinds" / "headwinds", "growth_drivers", "value_chain" margin notes, and "quant" (imports / duty). Only omit content with NO relevance to ${COUNTRY}.
- ONE GEOGRAPHY + ONE UNIT PER SERIES — "size.current" and EVERY point in "size.history" MUST be the SAME geography (${COUNTRY}) and the SAME unit / currency. NEVER put a global market-size series next to a ${COUNTRY} headline, and never mix currencies or units within one series (e.g. do not mix USD billion with ₹ crore). If the facts only offer history for a DIFFERENT geography or in a different unit than the current ${COUNTRY} figure, LEAVE "size.history" OUT rather than mixing them. Put any global market-size number in "highlights" (label it clearly, e.g. "Global market size") — not in "size". Prefer the ${COUNTRY} figure in ₹ (crore / lakh crore / billion) for the ${COUNTRY} headline when the facts provide it.
- RECENCY IS A PRIORITY IN EVERY SECTION. Today is in ${YEAR}. Whenever the facts offer the same data point for more than one year, use the MOST RECENT — a ${YEAR} or ${YEAR - 1} figure beats an older one EVEN IF the older year is cited by more sources. This applies to size, segment shares, player market shares / capacity, margins, utilisation, imports and duties alike. For "size.current" pick the latest year (put older years in "history"); when the facts give a forward estimate for ${YEAR} or ${YEAR + 1}, prefer it and set "year" accordingly. The "headline" and "key_takeaways" must reflect the CURRENT state (the latest size and where the market is heading) — never lead with a figure that is two or more years old when a newer one exists.
- MAXIMISE USEFUL VALUE — do not artificially limit output. There is no fixed amount to show per industry: capture EVERY well-sourced segment, driver, tailwind, headwind, channel, player and value-chain stage the facts support.
- "highlights" is a flexible strip of the STANDOUT, industry-SPECIFIC numbers a client would want at a glance that the fixed sections don't already carry — e.g. penetration / adoption %, per-capita or per-unit consumption, export or import share, a notable ratio (like the MDF:plywood mix), capacity utilisation, a price or realisation trend, replacement-cycle years. Include up to ~8, each with a short "label", a "value", and a "source". When the facts give the SAME metric across multiple years, add a "series" of {year,value} (oldest→newest) and set "trend" to up/down/flat so the trend can be drawn. Do NOT duplicate the headline market size here. Omit "highlights" entirely if the facts offer nothing beyond the fixed sections. Richer, sourced data is better; only omit what is unsourced or irrelevant.
- Fill ONLY from the provided EXTRACTED FACTS and SEARCH SNIPPETS. Do NOT use outside knowledge for numbers.
- The EXTRACTED FACTS are already grouped by category (SIZE, GROWTH, SEGMENTS, VALUE CHAIN, CHANNELS, PLAYERS, MARGINS, MARKET SHARE, CAPACITY, IMPORTS, DUTY) — use each group to fill the matching schema section.
- Every fact object MUST include "source": { "label": short publisher/source name, "url": the source url given with the fact, "snippet": the short supporting quote given with the fact, as PLAIN TEXT — no internal double-quotes or line breaks }. If a fact has no usable url, OMIT that fact rather than inventing a source.
- Numbers must come from the facts. Never estimate, round-trip, or invent figures. Prefer the most recent year available. When several facts agree or overlap, consolidate them into one entry.
- "players" is the most important section. Capture as many named companies as the facts support. For each company: set "listed" (true/false) and "ticker" when the facts give them; set "segment" when stated; set "market_share_pct" whenever a source states or clearly implies that company's share; and use "note" to record qualitative leader / ranking positioning a source states (e.g. largest MDF maker in India, market leader in South India, second-largest capacity, among the top three). Mine BOTH the PLAYERS and MARKET SHARE fact groups for this. Do NOT invent or infer per-company "revenue" or "ebitda_margin_pct" — leave those two fields out unless a source explicitly states that company's figure; per-company financial benchmarking is a separate later step, so omitting them is expected and fine.
- Include the "quant" section ONLY if the industry is manufacturing AND the facts give capacity / utilisation / imports / duty. Otherwise omit "quant" entirely.
- For "sources.youtube" and "sources.reports": use ONLY the provided YOUTUBE CANDIDATES and REPORT CANDIDATES lists — do NOT invent videos or reports. Keep each item's exact url. Add channel / publisher / date / type only when evident, and write a one-line plain-English "why_relevant" (video) or "summary" (report). Omit any candidate clearly irrelevant to this industry. Do NOT include a "news" key — news is added separately.
- CURATE the YouTube list for genuine UNDERSTANDING of the industry, not manufacturing trivia. Prefer videos that explain the industry, its market and outlook, its key players / companies, its competitive dynamics, and — importantly — its substitutes / alternatives / "X vs Y" comparisons (e.g. a rival product and why it competes). Keep AT MOST ONE "how it is made" / factory-tour video, and only if room remains. In each video's "why_relevant", say what a viewer will learn (e.g. "overview of the industry and its leaders", "why <substitute> competes with <product>"). Order the most insightful, understanding-first videos before the how-it's-made one.
- Set meta.mock = false and meta.generated_at to today. Use simple, plain-English labels a non-expert can read.
- Keep "report_markdown" grounded in the sourced facts; no filler.`;

async function runStageB(digest, snippetUrls, youtubeCands, reportCands) {
  const snippetLines = (snippetUrls || [])
    .filter((u) => u.snippet)
    .map((u) => `- ${u.title ? u.title + ' — ' : ''}${oneLine(u.snippet, 300)} [${u.url}]`);
  const ytList = youtubeCands.length
    ? youtubeCands.map((c, i) => `${i + 1}. ${c.title || '(untitled)'} — ${c.url}`).join('\n')
    : '(none)';
  const rpList = reportCands.length
    ? reportCands.map((c, i) => `${i + 1}. [${c.type}] ${c.title || '(untitled)'} — ${c.url}`).join('\n')
    : '(none)';

  const user = `Industry: ${INDUSTRY}\nCountry focus: ${COUNTRY}\n\nEXTRACTED FACTS (distilled from the full fact ledger, grouped by category; "sources: N" is how many distinct sources corroborate a claim — prefer better-corroborated values):\n${digest || '(none extracted)'}\n\nSEARCH SNIPPETS (supplementary short result snippets):\n${snippetLines.join('\n') || '(none)'}\n\nYOUTUBE CANDIDATES:\n${ytList}\n\nREPORT CANDIDATES:\n${rpList}`;

  console.log(`[research] Stage B: filling schema from ledger digest (${digest.length} chars) + ${snippetLines.length} snippets.`);
  // Disable thinking so the entire token budget goes to the JSON (on Sonnet 5,
  // adaptive thinking otherwise eats the budget and truncates the output).
  const obj = await callClaudeJSON({ system: STAGE_B_SYSTEM, user, max_tokens: STAGE_B_MAX_TOKENS, thinking: { type: 'disabled' } });
  return obj;
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

/* ----------------------------------------------------------------------- */

export function enforceMeta(obj, slug) {
  const meta = (obj.meta && typeof obj.meta === 'object') ? obj.meta : {};
  meta.slug = slug;
  meta.name = (meta.name && String(meta.name).trim()) || INDUSTRY;
  // The exact input that produced this slug (slugify(query) === slug). Stored so
  // a "Refresh" can re-run the pipeline against the SAME slug with a good search
  // query, rather than re-deriving one from the display name (which may drift).
  meta.query = INDUSTRY;
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
  // Most-recent first (dated items on top; undated sink to the bottom).
  const ts = (n) => { const t = Date.parse(n.published || n.date || ''); return isNaN(t) ? -Infinity : t; };
  obj.sources.news = [...merged.values()].sort((a, b) => ts(b) - ts(a)).slice(0, 30);
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

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return null; }
}

/** Bump last_seen for prior-run ledger facts whose source we re-observed this run
 *  via a cache hit (so recency stays accurate without re-extracting). Pure. */
function touchSeen(ledger, hashes, { runId, now }) {
  if (!hashes || !hashes.size) return ledger;
  return ledger.map((f) => {
    if (f.content_hash && hashes.has(f.content_hash) && f.last_run_id !== runId) {
      return { ...f, last_seen: now, last_run_id: runId, seen_count: (f.seen_count || 1) + 1, status: f.status === 'stale' ? 'active' : f.status };
    }
    return f;
  });
}

/** Sources tabs are additive too: keep this run's items, then add any prior ones
 *  not already present (dedup by url), capped. */
function unionSources(obj, incumbent) {
  obj.sources = obj.sources && typeof obj.sources === 'object' ? obj.sources : {};
  const inc = (incumbent && incumbent.sources) || {};
  const merge = (a, b, keyFn, cap) => {
    const out = []; const seen = new Set();
    for (const x of [...(a || []), ...(b || [])]) {
      if (!x) continue;
      const k = keyFn(x);
      if (!k || seen.has(k)) continue;
      seen.add(k); out.push(x);
    }
    return out.slice(0, cap);
  };
  obj.sources.news = merge(obj.sources.news, inc.news, (n) => canonicalUrl(n.url) || n.title, 30);
  obj.sources.reports = merge(obj.sources.reports, inc.reports, (r) => canonicalUrl(r.url), MAX_REPORTS);
  obj.sources.youtube = merge(obj.sources.youtube, inc.youtube, (y) => youtubeId(y.url) || y.url, MAX_YOUTUBE);
  return obj;
}

/** Best-effort "as of" year per section, from dated values in the assembled JSON. */
function sectionDatesFromLedger(ledger, obj) {
  const out = {};
  const set = (sec, v) => {
    const m = String(v || '').match(/(20\d\d|19\d\d)/);
    if (!m) return;
    if (!out[sec] || m[1] > out[sec].slice(0, 4)) out[sec] = `${m[1]}-01-01`;
  };
  if (obj.size && obj.size.current) set('size', obj.size.current.year);
  for (const h of ((obj.size && obj.size.history) || [])) set('size', h.year);
  for (const c of ((obj.quant && obj.quant.capacity) || [])) set('quant', c.year);
  for (const im of ((obj.quant && obj.quant.imports) || [])) set('quant', im.year);
  for (const n of ((obj.sources && obj.sources.news) || [])) set('news', n.date);
  for (const r of ((obj.sources && obj.sources.reports) || [])) set('reports', r.date);
  const gen = (obj.meta && obj.meta.generated_at) || '';
  for (const s of ['segments', 'growth_drivers', 'tailwinds', 'headwinds', 'value_chain', 'channels', 'players', 'margins']) set(s, gen);
  return out;
}

/** The consolidated written report — a derived artifact from the assembled JSON.
 *  Cached by a hash of the fields it depends on (warm runs don't re-pay), and
 *  never-fail: on error it keeps the previous report, or falls back to a
 *  deterministic one, so there is always a report. */
async function buildReport(obj, incumbent, now) {
  const hash = reportInputHash(obj);
  const prev = incumbent && incumbent.summary && incumbent.summary.report;
  if (prev && prev.hash === hash && prev.kind === 'llm' && Array.isArray(prev.sections) && prev.sections.length) {
    console.log('[research] report: data unchanged — reusing prior report (no Bedrock call).');
    return prev;
  }
  try {
    console.log('[research] report: generating narrative (one Bedrock call)...');
    const raw = await callClaudeJSON({ system: REPORT_SYSTEM, user: buildReportUser(obj), max_tokens: REPORT_MAX_TOKENS, thinking: { type: 'disabled' } });
    const sections = normalizeReport(raw, obj);
    if (sections.length) {
      console.log(`[research] report: generated ${sections.length} sections.`);
      return { kind: 'llm', generated_at: now, hash, sections };
    }
    console.warn('[research] report: model returned no usable sections.');
  } catch (e) {
    console.warn(`[research] report generation FAILED (keeping prior / fallback): ${e.message}`);
  }
  if (prev && Array.isArray(prev.sections) && prev.sections.length) { console.log('[research] report: kept previous report.'); return prev; }
  const det = deterministicReport(obj); det.generated_at = now;
  console.log(`[research] report: deterministic fallback (${det.sections.length} sections).`);
  return det;
}

/* ---- Peer benchmarking (Muns financials for listed, DRHP for unlisted) ---- */

const BENCH_MAX = Number(process.env.BENCH_MAX || 16);          // players to benchmark
const BENCH_CONCURRENCY = Number(process.env.BENCH_CONCURRENCY) || 4;
const BENCH_MAX_TOKENS = 2000;                                  // small structured JSON

/** Citeable source for a listed peer's financials (screener.in, via combined_financials). */
function screenerSource(ticker) {
  const t = String(ticker || '').trim();
  return t ? { label: 'screener.in (combined financials)', url: `https://www.screener.in/company/${encodeURIComponent(t)}/consolidated/`, snippet: '' } : null;
}

/** A clean "pending — fill later (Private Circle)" peer row (never a blank). */
function pendingPeer(player, reason, extra = {}) {
  return pruneEmpty({
    name: player.name,
    listed: extra.listed !== undefined ? extra.listed : (player.listed === true ? true : (player.listed === false ? false : undefined)),
    ticker: player.ticker || '',
    segment: player.segment || '',
    status: extra.status || 'pending',
    pending: true,
    pending_reason: reason || 'Private Circle',
    prospectus: extra.prospectus,
    source: extra.source,
    updated_at: extra.updated_at,
  });
}

/** Fetch combined_financials markdown for a ticker through the content cache.
 *  Returns {text, content_hash} (fresh or cached-with-blob), {content_hash,text:null}
 *  (fresh cache record but blob evicted — lets us reuse committed metrics by hash),
 *  or null. Mirrors the reader/report cache path so re-runs don't refetch. */
async function getFinancialsCached(cache, ticker, ctx) {
  const key = `muns://combined_financials/${encodeURIComponent(ticker)}?country=India&q=consolidated`;
  const hit = fetchCacheGet(cache, key, { ttlDays: ctx.ttlDays, now: ctx.now });
  if (hit && hit.text) return { text: hit.text, content_hash: hit.content_hash, cached: true };
  if (hit && hit.content_hash) return { text: null, content_hash: hit.content_hash, cached: true };
  const md = await combinedFinancials(ticker);
  if (!md || !String(md).trim()) return null;
  const { content_hash } = fetchCachePut(cache, key, md, { api: 'combined_financials', now: ctx.now });
  return { text: md, content_hash, cached: false };
}

/** For an UNLISTED company, get financials from its DRHP prospectus so we don't
 *  default to "pending (Private Circle)" when a filing exists. Prefers financial
 *  text straight from the DRHP API response; else OCRs the prospectus PDF (cached).
 *  Returns { text, content_hash, doc } (doc = the prospectus link, may lack text),
 *  or null when no DRHP is on file. Never throws. */
async function getDrhpFinancials(cache, name, ctx) {
  let drhp = null;
  try { drhp = await drhpByName(name); } catch (e) { drhp = null; }
  if (!drhpExists(drhp)) { try { drhp = await drhpSearch(name); } catch (e) { /* keep prior */ } }
  if (!drhpExists(drhp)) return null;
  const doc = drhpDocFrom(drhp);
  // 1) financial text embedded in the DRHP response.
  let text = drhpFinancialsText(drhp);
  let content_hash = null;
  if (text) {
    const put = fetchCachePut(cache, `muns://drhp/${encodeURIComponent(name)}#body`, text, { api: 'drhp', now: ctx.now });
    content_hash = put.content_hash;
  } else if (doc && doc.url && isPdf(doc.url)) {
    // 2) OCR the prospectus PDF (through the content cache, like a report).
    const src = await cachedFetchText(cache, doc.url, 'drhp-ocr', async () => { const r = await mistralOCR(doc.url); return r ? r.text : null; }, ctx);
    if (src && src.text) { text = src.text; content_hash = src.content_hash; }
  }
  return { text: text || null, content_hash, doc };
}

/** Benchmark ONE player: resolve ticker → listed financials (cached, one Claude
 *  extraction) OR unlisted DRHP prospectus OR a clean pending row. Never throws a
 *  useful case away — every branch returns a usable peer. */
async function benchmarkOnePlayer(player, incByName, incByHash, cache, ctx, counters) {
  const inc = incByName.get(benchNormName(player.name)) || null;
  if (inc && inc.added_by === 'analyst') return inc;             // never clobber an analyst peer

  // 1) Resolve a ticker: player's own, else a prior one, else birdnest search.
  let ticker = String(player.ticker || '').trim();
  let listed = player.listed === true || !!ticker;
  if (!ticker && inc && inc.ticker) { ticker = inc.ticker; listed = true; }
  if (!ticker && player.listed !== false) {
    const results = normalizeStockSearch(await stockSearch(cleanCompanyName(player.name) || player.name));
    const m = pickListedMatch(results, player.name);
    if (m) { ticker = m.ticker; listed = true; }
  }
  const keepInc = () => (inc && (hasFinancials(inc) || inc.prospectus))
    ? { ...inc, name: player.name, ticker: ticker || inc.ticker || '', segment: player.segment || inc.segment || '' } : null;

  // 2) Listed → combined financials → reuse-by-hash OR one extraction.
  if (listed && ticker) {
    const fin = await getFinancialsCached(cache, ticker, ctx);
    if (fin && fin.content_hash) {
      const reuse = incByHash.get(fin.content_hash);
      if (reuse && hasFinancials(reuse)) {
        counters.reused++;
        return pruneEmpty({ ...reuse, name: player.name, ticker, listed: true, segment: player.segment || reuse.segment || '', pending: false, status: 'listed', updated_at: ctx.now });
      }
      if (fin.text) {
        let metrics = {};
        try {
          const raw = await callClaudeJSON({ system: FINANCIALS_SYSTEM, user: buildFinancialsUser(player.name, ticker, fin.text), max_tokens: BENCH_MAX_TOKENS, thinking: { type: 'disabled' } });
          metrics = normalizeFinancials(raw);
          counters.calls++;
          extractPut(cache, extractKey(fin.content_hash, 0, BENCH_PROMPT_VERSION, ctx.modelId), Object.keys(metrics).length, ctx.now);
        } catch (e) {
          console.warn(`[bench] ${player.name}: extraction failed (${e.message})`);
        }
        if (hasFinancials(metrics)) {
          const peer = pruneEmpty({
            name: player.name, listed: true, ticker, segment: player.segment || '',
            status: 'listed', pending: false, ...metrics,
            fin_content_hash: fin.content_hash, source: screenerSource(ticker), updated_at: ctx.now,
          });
          try { const est = await streetEstimates(ticker); const note = est ? oneLine(String(est), 220) : ''; if (note) peer.forward_note = note; }
          catch (e) { /* optional forward note */ }
          return peer;
        }
      }
    }
    return keepInc() || pendingPeer({ ...player, ticker }, 'Financials pending (Private Circle)', { status: 'listed-pending', listed: true, updated_at: ctx.now });
  }

  // 3) Unlisted → pull financials from the DRHP prospectus if one exists (extract,
  //    don't just link). Only fall back to "pending (Private Circle)" when there is
  //    no DRHP, or none of its financials are extractable.
  const drName = cleanCompanyName(player.name) || player.name;
  let dr = null;
  try { dr = await getDrhpFinancials(cache, drName, ctx); } catch (e) { dr = null; }
  if (dr) {
    const prospectus = dr.doc && dr.doc.url ? { label: 'DRHP prospectus', url: dr.doc.url } : undefined;
    const drSource = prospectus ? { label: 'DRHP prospectus', url: dr.doc.url, snippet: '' } : undefined;
    if (dr.content_hash) {
      const reuse = incByHash.get(dr.content_hash);
      if (reuse && hasFinancials(reuse)) {
        counters.reused++;
        return pruneEmpty({ ...reuse, name: player.name, listed: false, segment: player.segment || reuse.segment || '', pending: false, status: 'unlisted-drhp', updated_at: ctx.now });
      }
      if (dr.text) {
        let metrics = {};
        try {
          const raw = await callClaudeJSON({ system: FINANCIALS_SYSTEM, user: buildFinancialsUser(player.name, '', dr.text), max_tokens: BENCH_MAX_TOKENS, thinking: { type: 'disabled' } });
          metrics = normalizeFinancials(raw);
          counters.calls++;
          extractPut(cache, extractKey(dr.content_hash, 0, BENCH_PROMPT_VERSION, ctx.modelId), Object.keys(metrics).length, ctx.now);
        } catch (e) { console.warn(`[bench] ${player.name}: DRHP extraction failed (${e.message})`); }
        if (hasFinancials(metrics)) {
          return pruneEmpty({
            name: player.name, listed: false, segment: player.segment || '',
            status: 'unlisted-drhp', pending: false, ...metrics,
            fin_content_hash: dr.content_hash, source: drSource, prospectus,
            note: 'Financials from DRHP prospectus', updated_at: ctx.now,
          });
        }
      }
    }
    // A DRHP exists but we couldn't extract numbers — link it + clean pending.
    return keepInc() || pruneEmpty({
      name: player.name, listed: false, segment: player.segment || '',
      status: 'unlisted-drhp', pending: true, pending_reason: 'From prospectus / Private Circle',
      prospectus, source: drSource, updated_at: ctx.now,
    });
  }
  return keepInc() || pendingPeer(player, 'Private Circle', { status: 'unlisted', listed: player.listed === false ? false : undefined, updated_at: ctx.now });
}

/** Benchmarking stage: run every player (bounded concurrency, never-fail per
 *  player), then merge write-if-better over the incumbent so a failed run can
 *  never regress a filled peer to pending. Returns { generated_at, peers } or null. */
async function runBenchmarking(players, incumbentBenchmarking, cache, ctx) {
  const list = (players || []).filter((p) => p && p.name);
  if (!list.length) return null;
  const capped = list.slice(0, BENCH_MAX);
  if (list.length > capped.length) console.log(`[bench] ${list.length} players; benchmarking top ${capped.length} (BENCH_MAX).`);
  const incPeers = (incumbentBenchmarking && Array.isArray(incumbentBenchmarking.peers)) ? incumbentBenchmarking.peers : [];
  const incByName = new Map(incPeers.map((p) => [benchNormName(p.name), p]));
  const incByHash = new Map(incPeers.filter((p) => p.fin_content_hash && hasFinancials(p)).map((p) => [p.fin_content_hash, p]));
  const counters = { calls: 0, reused: 0 };

  const raw = await mapLimit(capped, BENCH_CONCURRENCY, async (player) => {
    try { return await benchmarkOnePlayer(player, incByName, incByHash, cache, ctx, counters); }
    catch (e) { console.warn(`[bench] ${player.name}: failed (${e.message}) — pending`); return pendingPeer(player, 'Private Circle', { updated_at: ctx.now }); }
  });
  const peers = mergeBenchmarking(raw.filter(Boolean), incPeers);
  const filled = peers.filter(hasFinancials).length;
  console.log(`[bench] ${peers.length} peers: ${filled} with financials, ${peers.length - filled} pending; ${counters.calls} LLM calls, ${counters.reused} reused.`);
  return { generated_at: ctx.now, peers };
}

async function main() {
  const cfg = llmConfig();
  const runId = process.env.GITHUB_RUN_ID ? `gh-${process.env.GITHUB_RUN_ID}` : `local-${Date.now()}`;
  const now = today();
  const slug = slugify(INDUSTRY);
  const ctx = { now, runId, ttlDays: FETCH_TTL_DAYS, modelId: cfg.model_id };
  console.log(`[research] industry="${INDUSTRY}" country="${COUNTRY}" slug=${slug}`);
  console.log(`[research] model=${cfg.model_id} region=${cfg.region} run=${runId} prompt=${PROMPT_VERSION}`);

  // Load the additive store + caches. Auto-seed the ledger from the committed
  // dashboard on the first run with a store, so nothing already gathered is lost.
  const storeDir = join(STORE_ROOT, slug);
  const cacheDir = join(CACHE_ROOT, slug);
  const ledgerPath = join(storeDir, 'facts.jsonl');
  const coveragePath = join(storeDir, 'coverage.json');
  const overridesPath = join(storeDir, 'overrides.jsonl');
  const outPath = join(DATA_DIR, `${slug}.json`);
  const incumbent = readJson(outPath) || {};
  let ledger = loadLedger(ledgerPath);
  const cache = loadCache(cacheDir);
  if (!ledger.length && incumbent && incumbent.meta && !incumbent.meta.mock) {
    const seed = factsFromAssembled(incumbent);
    ledger = upsertFacts(ledger, seed, { runId: 'seed', now: incumbent.meta.generated_at || now });
    console.log(`[research] seeded ledger from committed ${slug}.json: ${ledger.length} facts.`);
  }
  console.log(`[research] ledger start: ${ledger.length} facts; cache: ${Object.keys(cache.fetch).length} fetch, ${Object.keys(cache.extracted).length} extract markers.`);

  // a/b) gather
  const { pages: searchPages, all: allSearch } = await gatherSearchUrls(INDUSTRY);
  const newsItems = await gatherNews(INDUSTRY, allSearch);
  const youtubeCands = await findYouTube(INDUSTRY);
  const reportCands = await findReports(INDUSTRY);

  // d) read full text (cache-aware)
  const reportSources = await readReports(reportCands, cache, ctx);
  const readerSources = await readPages(searchPages, cache, ctx);
  const fullTextSources = dedupeSources([
    ...reportSources.map((s) => ({ ...s, kind: 'report' })),
    ...readerSources.map((s) => ({ ...s, kind: 'web' })),
  ]);
  console.log(`[research] ${fullTextSources.length} unique full-text sources (${reportSources.length} reports + ${readerSources.length} web pages).`);

  // Abort ONLY if literally nothing at all was gathered AND there's no prior ledger.
  const gatheredAnything = allSearch.length || newsItems.length || youtubeCands.length || reportCands.length || fullTextSources.length || ledger.length;
  if (!gatheredAnything) {
    throw new Error('Nothing gathered at all and no prior ledger — check MUNS_TOKEN / connectivity. Aborting so no empty file is written.');
  }

  // e) Stage A (cache-aware) -> accumulate into the ledger
  const { facts: newFacts, seenHashes } = await runStageA(fullTextSources, cache, ctx);
  ledger = upsertFacts(ledger, newFacts, { runId, now });
  ledger = touchSeen(ledger, seenHashes, { runId, now });
  ledger = decayAndSupersede(ledger, { now });
  const support = supportByCategory(ledger);
  console.log(`[research] ledger now ${ledger.length} facts across ${Object.keys(support).length} sections.`);

  // f) Stage B from the accumulated LEDGER digest (not just this run's facts).
  const digest = buildLedgerDigest(ledger, { now });
  let candidate = {};
  try {
    console.log('[research] calling Claude for Stage B structured extraction...');
    candidate = await runStageB(digest, allSearch, youtubeCands, reportCands);
  } catch (e) {
    console.error(`[research] Stage B FAILED — prior analytical data is kept via write-if-better. ${e && e.stack ? e.stack : e}`);
    candidate = {};
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) candidate = {};

  // g) meta, company news, source tabs (on the candidate)
  candidate = enforceMeta(candidate, slug);
  let companyNews = [];
  try { companyNews = await gatherCompanyNews(candidate.players, INDUSTRY); }
  catch (e) { console.warn(`[research] company news step failed (skipped): ${e.message}`); }
  candidate = foldNews(candidate, [...newsItems, ...companyNews]);
  candidate = attachSources(candidate, youtubeCands, reportCands);

  // h) WRITE-IF-BETTER: never blank or regress a filled section vs the incumbent.
  const merged = mergeAssembly(candidate, incumbent);
  let obj = merged.obj;
  obj = unionSources(obj, incumbent);   // source tabs are additive too
  obj = enforceMeta(obj, slug);         // meta from this run (generated_at, mock:false)

  // i) freshness + coverage metadata (Phase 2 renders from this; additive)
  const coverage = mergeCoverage(readJson(coveragePath), support, sectionDatesFromLedger(ledger, obj));
  obj.meta.updated_at = now;
  obj.meta.coverage = coverage;
  console.log(merged.changed.length ? `[research] sections improved: ${merged.changed.join(', ')}` : '[research] no section improved this run (output held steady — monotonic).');

  // i2) peer benchmarking — real financials for listed players (Muns combined
  //     financials → one grounded extraction), DRHP prospectus for unlisted, and
  //     a clean "pending (Private Circle)" row otherwise. Never-fail, additive,
  //     cached, write-if-better per peer. Kept from the prior run when MUNS_TOKEN
  //     is absent or the step fails, so it can only hold or improve.
  try {
    if (process.env.MUNS_TOKEN && Array.isArray(obj.players) && obj.players.length) {
      const bench = await runBenchmarking(obj.players, incumbent.benchmarking, cache, ctx);
      if (bench && bench.peers && bench.peers.length) obj.benchmarking = bench;
      else if (incumbent.benchmarking) obj.benchmarking = incumbent.benchmarking;
    } else if (incumbent.benchmarking) {
      obj.benchmarking = incumbent.benchmarking;
    }
  } catch (e) {
    console.warn(`[research] benchmarking step failed (kept prior): ${e && e.message ? e.message : e}`);
    if (incumbent.benchmarking) obj.benchmarking = incumbent.benchmarking;
  }

  // k) consolidated written report (derived, cached, never-fail)
  obj.summary = (obj.summary && typeof obj.summary === 'object') ? obj.summary : {};
  obj.summary.report = await buildReport(obj, incumbent, now);

  // l) analyst overrides — applied LAST so an automated refresh can never clobber
  //    a manual correction. Append-only + authoritative: every corrected field is
  //    re-applied on top of the freshly-assembled data. Never-fail.
  try {
    if (existsSync(overridesPath)) {
      const overrides = parseOverrides(readFileSync(overridesPath, 'utf8'));
      if (overrides.length) {
        applyOverrides(obj, overrides);
        console.log(`[research] applied ${overrides.length} analyst override(s) (authoritative, last).`);
      }
    }
  } catch (e) {
    console.warn(`[research] overrides step failed (skipped): ${e && e.message ? e.message : e}`);
  }

  // j) persist: dashboard JSON + ledger + coverage + caches
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n');
  saveLedger(ledgerPath, ledger);
  writeFileSync(coveragePath, JSON.stringify(coverage, null, 2) + '\n');
  saveCache(cache);
  upsertIndex(slug, obj.meta);
  reportFilled(obj);
  console.log(`[research] wrote ${outPath} + ledger (${ledger.length} facts) + coverage + caches. DONE`);
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
