/**
 * scripts/research-industry.mjs — the deep-research pipeline.
 *
 * Gathers real, source-backed data for an industry and writes it into the
 * exact Prompt-1 JSON schema at public/data/industries/<slug>.json.
 *
 * Scope (this step): Deep Research / Overview data (size, growth, segments,
 * value chain, channels, players, margins, and — for manufacturing —
 * capacity/imports) PLUS the news list. YouTube + reports come later.
 *
 * INDUSTRY env selects the target (default "MDF boards, India").
 * No npm dependencies — global fetch + node stdlib only.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callClaudeJSON, llmConfig } from '../lib/llm.mjs';
import { webSearch, newsSearch, webReader, normalizeSearch, normalizeReader } from '../lib/muns.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'public', 'data', 'industries');

const INDUSTRY = (process.env.INDUSTRY || 'MDF boards, India').trim();
const COUNTRY = process.env.INDUSTRY_COUNTRY || 'India';

// Budgets — keep the model prompt to a sane size.
const MAX_URLS = 15;
const READER_BATCH = 4;
const MAX_SOURCE_CHARS = 8000;   // per read page
const MAX_TOTAL_CHARS = 140000;  // whole SOURCES block

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

/** Build the SOURCES block: read pages first, then search snippets, within budget. */
export function buildSourcesBlock(readerSources, searchUrls) {
  let total = 0;
  const parts = [];

  for (const s of readerSources) {
    if (!s.text) continue;
    const text = s.text.slice(0, MAX_SOURCE_CHARS);
    const block = `\n===== SOURCE: ${s.url || '(unknown url)'} =====\n${text}\n`;
    if (total + block.length > MAX_TOTAL_CHARS) break;
    parts.push(block);
    total += block.length;
  }

  // Always include compact search snippets (attributable) so the model has
  // source-backed material even if the reader returned little.
  const snippetLines = searchUrls
    .filter((u) => u.snippet)
    .map((u) => `- ${u.title ? u.title + ' — ' : ''}${u.snippet} [${u.url}]`);
  if (snippetLines.length) {
    const block = `\n===== SEARCH SNIPPETS =====\n${snippetLines.join('\n')}\n`;
    if (total + block.length <= MAX_TOTAL_CHARS) parts.push(block);
    else parts.push(block.slice(0, MAX_TOTAL_CHARS - total));
  }

  return parts.join('\n');
}

/* ----------------------------------------------------------------------- */

const SYSTEM_PROMPT = `You are an equity/industry research analyst. Produce a single JSON object describing an industry, filled ONLY from the SOURCES the user provides.

Return ONLY the JSON object — no prose, no markdown, no code fences, no XML tags. Your entire response must start with { and end with }.

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
  "quant": { "capacity": [ { "player", "region", "capacity": <number>, "unit", "year": <number> } ], "utilisation_pct": <number>, "imports": [ { "year": <number>, "volume": <number>, "unit" } ], "duty": [ { "country", "note" } ], "source": {"label","url","snippet"} }
}

Rules:
- Fill ONLY from the provided SOURCES. Do NOT use outside knowledge for numbers.
- Every fact object MUST include "source": { "label": short publisher/source name, "url": the source URL from the SOURCES, "snippet": a VERBATIM ~15-30 word quote copied from that source that supports the fact }. If you cannot attach a real source URL and verbatim snippet, OMIT the fact.
- Numbers must come from the sources. Never estimate, round-trip, or invent figures. Prefer the most recent year available.
- "players" is the most important section — capture as many named companies as the sources support, with whatever of revenue / EBITDA % / market share / listed / ticker each source gives.
- Include the "quant" section ONLY if the industry is manufacturing AND the sources give capacity / utilisation / imports / duty. Otherwise omit "quant" entirely.
- Do NOT fill "sources" (news / reports / youtube) — those are added separately. Do not include a "sources" key.
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

  // a/b) queries -> search + news
  const searchUrls = await gatherSearchUrls(INDUSTRY);
  const newsItems = await gatherNews(INDUSTRY);

  if (!searchUrls.length && !newsItems.length) {
    throw new Error('No search or news results — check MUNS_TOKEN and connectivity. Aborting so no empty file is written.');
  }

  // c) read the top pages
  const readerSources = await readPages(searchUrls);

  // d) extract into the schema
  const sourcesBlock = buildSourcesBlock(readerSources, searchUrls);
  console.log(`[research] SOURCES block: ${sourcesBlock.length} chars from ${readerSources.length} pages + ${searchUrls.filter((u) => u.snippet).length} snippets.`);

  const user = `Industry: ${INDUSTRY}\nCountry focus: ${COUNTRY}\n\nSOURCES:\n${sourcesBlock}`;
  console.log('[research] calling Claude for structured extraction...');
  // Disable thinking so the entire token budget goes to the JSON (on Sonnet 5,
  // adaptive thinking otherwise eats the budget and truncates the output), and
  // give a generous ceiling for a rich schema with a full report_markdown.
  let obj = await callClaudeJSON({ system: SYSTEM_PROMPT, user, max_tokens: 20000, thinking: { type: 'disabled' } });
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Model did not return a JSON object.');
  }

  // e) enforce meta, fold news, write files, report
  obj = enforceMeta(obj, slug);
  obj = foldNews(obj, newsItems);

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
