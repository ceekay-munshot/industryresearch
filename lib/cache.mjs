/**
 * lib/cache.mjs — content-addressed cache in front of the expensive steps
 * (fetch / OCR, and per-source Stage-A extraction).
 *
 * Third-party fetchers (Firecrawl / Mistral OCR / Muns reader) are POST APIs, so
 * HTTP conditional GET on the origin isn't available for them; instead we use a
 * TTL + a content hash of the CLEANED text. Direct fetchers (RSS/JSON feeds in
 * the recency pass) do use ETag / If-Modified-Since — their validators are stored
 * here too.
 *
 * Two durable, git-committed maps per industry (small):
 *   data/cache/<slug>/fetch.json      normUrl -> { content_hash, etag,
 *                                     last_modified, fetched_at, api, status }
 *   data/cache/<slug>/extracted.json  extractKey -> { n_facts, created_at }
 * Content blobs (data/cache/<slug>/content/<hash>.md) are LARGE and NOT committed
 * (gitignored) — cross-run durability comes from the committed maps + the ledger.
 *
 * The dominant cost is the ~per-chunk Stage-A LLM call; `extracted.json` keyed on
 * content_hash · prompt_version · model_id is what collapses a re-run to near-zero
 * model calls. No npm dependencies. Deterministic: `now` is always passed in.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

/** Normalize a URL for use as a cache key (lowercase host, drop hash + trailing /). */
export function normUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch (e) { return String(u || '').trim(); }
}

export function loadCache(dir) {
  const read = (f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch (e) { return {}; } };
  return { dir, fetch: read('fetch.json'), extracted: read('extracted.json') };
}

export function saveCache(cache) {
  if (!existsSync(cache.dir)) mkdirSync(cache.dir, { recursive: true });
  writeFileSync(join(cache.dir, 'fetch.json'), JSON.stringify(sortObj(cache.fetch), null, 2) + '\n');
  writeFileSync(join(cache.dir, 'extracted.json'), JSON.stringify(sortObj(cache.extracted), null, 2) + '\n');
}

function sortObj(o) {
  const out = {};
  for (const k of Object.keys(o || {}).sort()) out[k] = o[k];
  return out;
}

/* ---- content blobs (local, uncommitted) --------------------------------- */

function contentPath(cache, hash) {
  return join(cache.dir, 'content', `${hash}.md`);
}
function putBlob(cache, hash, text) {
  const dir = join(cache.dir, 'content');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try { writeFileSync(contentPath(cache, hash), text); } catch (e) { /* best-effort */ }
}
function getBlob(cache, hash) {
  try { return readFileSync(contentPath(cache, hash), 'utf8'); } catch (e) { return null; }
}

/* ---- fetch cache -------------------------------------------------------- */

const daysBetween = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

/**
 * Fast path: if we fetched this URL within `ttlDays` and its content blob is on
 * disk, return { content_hash, text } WITHOUT calling the fetcher. If the record
 * is fresh but the blob is gone (fresh runner), return { content_hash } so the
 * caller can still hit the Stage-A cache by hash without re-extracting.
 */
export function fetchCacheGet(cache, url, { ttlDays = 30, now }) {
  const rec = cache.fetch[normUrl(url)];
  if (!rec || !rec.content_hash || !rec.fetched_at) return null;
  if (daysBetween(rec.fetched_at, now) > ttlDays) return null; // too old — re-fetch to catch changes
  const text = getBlob(cache, rec.content_hash);
  return { content_hash: rec.content_hash, text: text || null, hit: true };
}

/** Record a fetched source. Stores the blob locally, returns { content_hash, changed }. */
export function fetchCachePut(cache, url, text, { api = '', now, etag = null, last_modified = null, status = 200 }) {
  const key = normUrl(url);
  const content_hash = sha(text);
  const prev = cache.fetch[key];
  const changed = !prev || prev.content_hash !== content_hash;
  cache.fetch[key] = { content_hash, etag, last_modified, fetched_at: now, api, status };
  putBlob(cache, content_hash, String(text));
  return { content_hash, changed };
}

/** Conditional-GET validators for a URL (used by direct feed fetchers). */
export function conditionalHeaders(cache, url) {
  const rec = cache.fetch[normUrl(url)] || {};
  const h = {};
  if (rec.etag) h['If-None-Match'] = rec.etag;
  if (rec.last_modified) h['If-Modified-Since'] = rec.last_modified;
  return h;
}

/* ---- Stage-A extraction cache ------------------------------------------- */

/** Cache key for one chunk's extraction: source content hash · chunk index ·
 *  prompt · model. Keyed on content_hash (not the chunk text) so the marker can be
 *  checked even without the text on hand. Bumping PROMPT_VERSION or the model id
 *  misses every entry → a clean, controlled recompute. */
export function extractKey(contentHash, chunkIndex, promptVersion, modelId) {
  return sha(`${contentHash}|${chunkIndex}|${promptVersion}|${modelId}`).slice(0, 24);
}

export function extractGet(cache, key) {
  return cache.extracted[key] || null;
}

export function extractPut(cache, key, nFacts, now) {
  cache.extracted[key] = { n_facts: nFacts, created_at: now };
}
