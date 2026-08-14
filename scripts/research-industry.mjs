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
import { webSearch, newsSearch, webReader, normalizeSearch, normalizeReader } from '../lib/muns.mjs';
import { firecrawlScrape, scrapedoScrape, mistralOCR, htmlToText, extractYouTubeFromHtml } from '../lib/scrape.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'public', 'data', 'industries');

const INDUSTRY = (process.env.INDUSTRY || 'MDF boards, India').trim();
const COUNTRY = process.env.INDUSTRY_COUNTRY || 'India';

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
  console.log(`[research] collected ${rawCount} raw results, ${unique.length} unique URLs, reading top ${capped.length}, dropped ${unique.length - capped.length}.`);
  // Return both the pages to read and ALL snippets (snippets are cheap and help
  // Stage B even for pages we don't fully read).
  return { pages: capped, all: unique };
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
  console.log(`[research] read ${sources.length}/${urls.length} pages successfully (full text).`);
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
    `${industry} broker research report`,
    `${industry} government report pdf`,
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

/** Read every report candidate in FULL (no per-report char cap). PDFs go through
 *  OCR; other pages through Firecrawl, then Scrape.do as a fallback. Reading is
 *  bounded by REPORT_READ_CAP with any skip logged, never silent. */
async function readReports(reportCands) {
  // Prioritise PDFs (they carry segments / margins / market share).
  const ranked = [...reportCands].sort((a, b) => (isPdf(b.url) ? 1 : 0) - (isPdf(a.url) ? 1 : 0));
  const toRead = ranked.slice(0, REPORT_READ_CAP);
  if (ranked.length > toRead.length) {
    console.log(`[research] ${ranked.length} report candidates; reading ${toRead.length} (REPORT_READ_CAP), skipping ${ranked.length - toRead.length}.`);
  }
  const out = [];
  for (const c of toRead) {
    let src = null;
    try {
      if (isPdf(c.url)) {
        src = await mistralOCR(c.url);
        if (!src) {
          const s = await scrapedoScrape(c.url);
          if (s && s.html) src = { url: c.url, text: htmlToText(s.html) };
        }
      } else {
        src = await firecrawlScrape(c.url);
        if (!src) {
          const s = await scrapedoScrape(c.url);
          if (s && s.html) src = { url: c.url, text: htmlToText(s.html) };
        }
      }
    } catch (e) {
      // Belt-and-suspenders: the fetchers never throw, but never let one crash us.
      console.warn(`[research] report read error ${c.url}: ${e.message}`);
      src = null;
    }
    if (src && src.text) {
      out.push({ url: c.url, text: src.text });
      console.log(`[research] report read OK  ${c.url} (${src.text.length} chars, ${isPdf(c.url) ? 'pdf/ocr' : 'scrape'})`);
    } else {
      console.log(`[research] report read FAIL ${c.url}`);
    }
  }
  console.log(`[research] read ${out.length}/${toRead.length} report sources (full text).`);
  return out;
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

const STAGE_A_SYSTEM = `You are a meticulous industry research analyst. You are given an industry name and ONE source document (which may be a chunk of a larger report). Extract EVERY specific, quantified fact in the SOURCE TEXT that is relevant to that industry. Use ONLY the SOURCE TEXT — no outside knowledge, and never invent or round numbers.

Return ONLY a JSON object — your entire response must start with { and end with } — no prose, no markdown, no code fences:

{ "facts": [ { "category": "<one of: size, growth, segments, value_chain, channels, players, margins, market_share, capacity, imports, duty, other>", "text": "<one clear plain-English sentence stating the fact, including the specific number / name / % / year>", "snippet": "<a short ~10-25 word supporting quote from the SOURCE TEXT>" } ] }

CRITICAL — STRICTLY VALID JSON:
- Do NOT put any raw double-quote (") character inside a string value. If the source uses quotes, drop them or use single quotes.
- Keep every string on a single line — no raw line breaks inside a string value.
- One stray unescaped quote breaks the whole file, so be careful.

Capture (be exhaustive, one fact per data point): market size / value; growth, CAGR and forecasts; segment names and shares; value-chain stages and their margins; distribution channels and shares; named companies with revenue / EBITDA % / market share / capacity / listed status / ticker; manufacturer vs retailer margins; production capacity and utilisation; imports / exports and volumes; anti-dumping or other duties.

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

async function extractFactsFromSource(source, idx, total) {
  const chunks = chunkText(source.text);
  if (!chunks.length) return [];
  const facts = [];
  for (let c = 0; c < chunks.length; c++) {
    const label = `${source.kind} ${idx + 1}/${total} chunk ${c + 1}/${chunks.length}`;
    try {
      const user = `Industry: ${INDUSTRY}\nCountry focus: ${COUNTRY}\nSource URL: ${source.url}\n\nSOURCE TEXT (extract every relevant fact):\n${chunks[c]}`;
      const res = await callClaudeJSON({ system: STAGE_A_SYSTEM, user, max_tokens: STAGE_A_MAX_TOKENS, thinking: { type: 'disabled' } });
      const got = normalizeFacts(res, source.url);
      facts.push(...got);
      console.log(`[research] stageA ${label} -> ${got.length} facts`);
    } catch (e) {
      // Isolate the failure: skip this chunk, keep everything else.
      console.warn(`[research] stageA ${label} FAILED (skipped): ${e.message}`);
    }
  }
  return facts;
}

async function runStageA(fullTextSources) {
  const all = [];
  for (let i = 0; i < fullTextSources.length; i++) {
    const facts = await extractFactsFromSource(fullTextSources[i], i, fullTextSources.length);
    all.push(...facts);
  }
  const deduped = dedupeFacts(all);
  console.log(`[research] Stage A: ${all.length} facts extracted -> ${deduped.length} after dedupe, from ${fullTextSources.length} sources.`);
  return deduped;
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
- Fill ONLY from the provided EXTRACTED FACTS and SEARCH SNIPPETS. Do NOT use outside knowledge for numbers.
- The EXTRACTED FACTS are already grouped by category (SIZE, GROWTH, SEGMENTS, VALUE CHAIN, CHANNELS, PLAYERS, MARGINS, MARKET SHARE, CAPACITY, IMPORTS, DUTY) — use each group to fill the matching schema section.
- Every fact object MUST include "source": { "label": short publisher/source name, "url": the source url given with the fact, "snippet": the short supporting quote given with the fact, as PLAIN TEXT — no internal double-quotes or line breaks }. If a fact has no usable url, OMIT that fact rather than inventing a source.
- Numbers must come from the facts. Never estimate, round-trip, or invent figures. Prefer the most recent year available. When several facts agree or overlap, consolidate them into one entry.
- "players" is the most important section — capture as many named companies as the facts support, with whatever of revenue / EBITDA % / market share / listed / ticker each one gives.
- Include the "quant" section ONLY if the industry is manufacturing AND the facts give capacity / utilisation / imports / duty. Otherwise omit "quant" entirely.
- For "sources.youtube" and "sources.reports": use ONLY the provided YOUTUBE CANDIDATES and REPORT CANDIDATES lists — do NOT invent videos or reports. Keep each item's exact url. Add channel / publisher / date / type only when evident, and write a one-line plain-English "why_relevant" (video) or "summary" (report). Omit any candidate clearly irrelevant to this industry. Do NOT include a "news" key — news is added separately.
- Set meta.mock = false and meta.generated_at to today. Use simple, plain-English labels a non-expert can read.
- Keep "report_markdown" grounded in the sourced facts; no filler.`;

async function runStageB(facts, snippetUrls, youtubeCands, reportCands) {
  const digest = buildFactDigest(facts);
  const snippetLines = (snippetUrls || [])
    .filter((u) => u.snippet)
    .map((u) => `- ${u.title ? u.title + ' — ' : ''}${oneLine(u.snippet, 300)} [${u.url}]`);
  const ytList = youtubeCands.length
    ? youtubeCands.map((c, i) => `${i + 1}. ${c.title || '(untitled)'} — ${c.url}`).join('\n')
    : '(none)';
  const rpList = reportCands.length
    ? reportCands.map((c, i) => `${i + 1}. [${c.type}] ${c.title || '(untitled)'} — ${c.url}`).join('\n')
    : '(none)';

  const user = `Industry: ${INDUSTRY}\nCountry focus: ${COUNTRY}\n\nEXTRACTED FACTS (distilled from full reading of every source; grouped by category):\n${digest || '(none extracted)'}\n\nSEARCH SNIPPETS (supplementary short result snippets):\n${snippetLines.join('\n') || '(none)'}\n\nYOUTUBE CANDIDATES:\n${ytList}\n\nREPORT CANDIDATES:\n${rpList}`;

  console.log(`[research] Stage B: filling schema from ${facts.length} facts + ${snippetLines.length} snippets (digest ${digest.length} chars).`);
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

  // a/b) queries -> web search + news (each call is retry+continue-on-error)
  const { pages: searchPages, all: allSearch } = await gatherSearchUrls(INDUSTRY);
  const newsItems = await gatherNews(INDUSTRY);

  // c) discover YouTube videos and report/PDF candidates
  const youtubeCands = await findYouTube(INDUSTRY);
  const reportCands = await findReports(INDUSTRY);

  // d) read rich report sources (PDF via OCR, else scrape) + the web pages — all
  //    in FULL, no truncation. Dedupe so we never extract the same URL twice.
  const reportSources = await readReports(reportCands);
  const readerSources = await readPages(searchPages);
  const fullTextSources = dedupeSources([
    ...reportSources.map((s) => ({ ...s, kind: 'report' })),
    ...readerSources.map((s) => ({ ...s, kind: 'web' })),
  ]);
  console.log(`[research] ${fullTextSources.length} unique full-text sources to distil (${reportSources.length} reports + ${readerSources.length} web pages).`);

  // Abort ONLY if literally nothing at all was gathered — otherwise always write.
  const gatheredAnything =
    allSearch.length || newsItems.length || youtubeCands.length || reportCands.length || fullTextSources.length;
  if (!gatheredAnything) {
    throw new Error('Nothing gathered at all (no search, news, youtube, reports or readable pages) — check MUNS_TOKEN / connectivity. Aborting so no empty file is written.');
  }

  // e) Stage A (map): per-source focused fact extraction. A failed source is
  //    skipped; the rest are kept.
  const facts = await runStageA(fullTextSources);

  // f) Stage B (reduce): fill the schema from the distilled facts + snippets.
  //    Wrapped so that even a total extraction failure still writes partial data
  //    (meta + news/youtube/reports tabs) rather than crashing the run.
  let obj = {};
  try {
    console.log('[research] calling Claude for Stage B structured extraction...');
    obj = await runStageB(facts, allSearch, youtubeCands, reportCands);
  } catch (e) {
    console.error(`[research] Stage B FAILED — writing partial data (sources only). ${e && e.stack ? e.stack : e}`);
    obj = {};
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    console.warn('[research] Stage B did not return an object — writing partial data (sources only).');
    obj = {};
  }

  // g) enforce meta, fold news, reconcile youtube/reports, write files, report.
  //    These always run so the file is written with whatever we have.
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
