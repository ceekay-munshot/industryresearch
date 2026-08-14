/**
 * scripts/refresh-recency.mjs — the fast, cheap "recency pass".
 *
 * Appends only NEWS / announcements that are newer than each source's watermark to
 * every non-mock industry's committed JSON. It never touches the analytical
 * sections (those are the slow full-rebuild's job) and never re-runs the LLM, so
 * it finishes in seconds and is safe to run every few hours.
 *
 * Reliability: every source is continue-on-error; a failed feed is skipped. The
 * script only writes a file when its news actually changed (true no-op otherwise),
 * so a quiet run produces no commit. Change-detection is feed pubDate + HTTP
 * conditional GET; per-industry watermarks live in data/store/<slug>/watermarks.json.
 *
 * node stdlib + global fetch only.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFeed, parseFeed, itemEpoch, itemDomain } from '../lib/feeds.mjs';
import { noisyOr, sourceQuality } from '../lib/store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'public', 'data', 'industries');
const STORE_ROOT = join(ROOT, 'data', 'store');
const NEWS_CAP = 30;

const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return null; } };
const enc = (s) => encodeURIComponent(String(s));

// Generic tokens that would over-match a broad business feed — never used alone.
const GENERIC = new Set(['india', 'indian', 'market', 'markets', 'industry', 'boards', 'board', 'panel', 'panels', 'sector', 'wood', 'medium', 'high', 'density', 'engineered', 'products', 'product', 'group', 'materials', 'material', 'solutions', 'global', 'company', 'limited', 'the', 'and', 'for']);

/** DISTINCTIVE, stemmed keywords for filtering broad feeds — the industry acronym
 *  (e.g. "MDF") plus long non-generic product tokens (stemmed so "widgets" also
 *  catches "widget"). Deliberately narrow to avoid false positives on shared feeds. */
function primaryKeywords(meta) {
  const kws = new Set();
  const name = String(meta.name || '');
  (name.match(/\b[A-Z]{2,6}\b/g) || []).forEach((a) => kws.add(a.toLowerCase())); // acronyms: MDF, HDF...
  const addTok = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).forEach((w) => {
    const stem = w.replace(/(es|s)$/, '');
    if (stem.length >= 5 && !GENERIC.has(w) && !GENERIC.has(stem)) kws.add(stem);
  });
  addTok(name);
  (meta.aliases || []).forEach(addTok);
  if ([...kws].some((w) => /fib(re|er)board/.test(w))) { kws.add('fibreboard'); kws.add('fiberboard'); }
  return [...kws];
}

function cleanCompanyName(name) {
  return String(name || '').replace(/\([^)]*\)/g, ' ').replace(/\b(Ltd|Limited|Pvt|Private|Inc|LLP)\.?\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

function topPlayers(obj, n) {
  const seen = new Set();
  const out = [];
  for (const p of (obj.players || [])) {
    if (!p || !p.name) continue;
    const nm = cleanCompanyName(p.name);
    if (!nm || nm.length < 3 || seen.has(nm.toLowerCase())) continue;
    // Prefer listed Indian companies (they generate results/capacity news).
    seen.add(nm.toLowerCase());
    out.push({ name: nm, listed: !!p.listed });
  }
  out.sort((a, b) => (b.listed ? 1 : 0) - (a.listed ? 1 : 0));
  return out.slice(0, n).map((x) => x.name);
}

/** Merge fresh news into the industry's list: new items first, dedup by url, capped. */
function mergeNews(existing, fresh) {
  const out = [];
  const seen = new Set();
  for (const n of [...fresh, ...(existing || [])]) {
    if (!n || (!n.url && !n.title)) continue;
    const key = (n.url || n.title).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out.slice(0, NEWS_CAP);
}

async function refreshIndustry(slug, registry, defaults) {
  const file = join(DATA_DIR, `${slug}.json`);
  const obj = readJson(file);
  if (!obj || !obj.meta || obj.meta.mock) { console.log(`[recency] ${slug}: no real data, skipping.`); return false; }

  const storeDir = join(STORE_ROOT, slug);
  const wmPath = join(storeDir, 'watermarks.json');
  const wm = readJson(wmPath) || { sources: {} };
  const keywords = primaryKeywords(obj.meta);
  const players = topPlayers(obj, 5);
  const now = Date.now();
  const collected = [];

  for (const src of registry) {
    if (src.enabled === false) continue;
    const st = wm.sources[src.id] || { last_fetched: null, last_epoch: 0, etag: null, last_modified: null, seen: [] };
    const dueMs = (src.interval_hours || 6) * 3600000;
    if (st.last_fetched && (now - Date.parse(st.last_fetched)) < dueMs) { continue; } // not due yet
    const seen = new Set(st.seen || []);
    let maxEpoch = st.last_epoch || 0;
    let touched = 0;

    // Resolve the queries this source runs (industry term, each player, or a broad
    // feed we filter by keyword).
    const queries = src.query_mode === 'players' ? players
      : src.query_mode === 'industry' ? [obj.meta.name]
        : [null]; // 'filter' — broad feed, no query

    for (const q of queries) {
      try {
        const url = q == null ? src.url : src.url.replace('{q}', enc(`"${q}"`));
        const r = await fetchFeed(url, { ua: defaults.user_agent, etag: st.etag, lastModified: st.last_modified, timeoutMs: defaults.timeout_ms });
        if (r.status === 304 || r.status === 0) continue;
        if (q == null) { st.etag = r.etag || st.etag; st.last_modified = r.last_modified || st.last_modified; } // only stable for single-URL feeds
        const items = parseFeed(src.type, r.text).slice(0, defaults.max_items_per_source || 40);
        for (const it of items) {
          const ep = itemEpoch(it.date);
          const guid = it.guid || it.url || it.title;
          if (seen.has(guid)) continue;
          if (ep && st.last_epoch && ep <= st.last_epoch) continue; // older than watermark
          if (src.query_mode === 'filter') {
            const hay = `${it.title} ${it.snippet}`.toLowerCase();
            const hitKw = keywords.some((k) => hay.includes(k));
            const hitCo = players.some((p) => hay.includes(p.toLowerCase()));
            if (!hitKw && !hitCo) continue;
          }
          seen.add(guid);
          if (ep > maxEpoch) maxEpoch = ep;
          collected.push({
            title: it.title || '(untitled)',
            publisher: it.source || itemDomain(it),
            date: it.date || today(),
            url: it.url,
            snippet: it.snippet || '',
          });
          touched++;
        }
      } catch (e) {
        console.warn(`[recency] ${slug}/${src.id} q="${q}" failed (skipped): ${e.message}`);
      }
    }

    st.last_fetched = nowIso();
    st.last_epoch = maxEpoch;
    st.seen = [...seen].slice(-300);
    wm.sources[src.id] = st;
    console.log(`[recency] ${slug}/${src.id}: +${touched} new items`);
  }

  if (!collected.length) {
    // Still persist watermarks so due-timers advance; but no data change -> caller
    // decides whether to commit. We write watermarks regardless (cheap, avoids
    // re-hitting feeds every run).
    if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
    writeFileSync(wmPath, JSON.stringify(wm, null, 2) + '\n');
    console.log(`[recency] ${slug}: no new news.`);
    return false;
  }

  obj.sources = obj.sources && typeof obj.sources === 'object' ? obj.sources : {};
  const before = (obj.sources.news || []).length;
  obj.sources.news = mergeNews(obj.sources.news, collected);
  // Freshness metadata for the News section.
  const domains = new Set(obj.sources.news.map((n) => itemDomain(n)).filter(Boolean));
  const latest = obj.sources.news.map((n) => n.date).filter(Boolean).sort().slice(-1)[0] || today();
  obj.meta.updated_at = today();
  obj.meta.coverage = obj.meta.coverage && typeof obj.meta.coverage === 'object' ? obj.meta.coverage : { sections: {} };
  obj.meta.coverage.sections = obj.meta.coverage.sections || {};
  obj.meta.coverage.sections.news = {
    sources: domains.size,
    confidence: noisyOr([...domains].map(() => 0.6)),
    as_of: /^\d{4}-\d{2}-\d{2}/.test(latest) ? latest.slice(0, 10) : today(),
  };

  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  writeFileSync(wmPath, JSON.stringify(wm, null, 2) + '\n');
  console.log(`[recency] ${slug}: news ${before} -> ${obj.sources.news.length} (+${obj.sources.news.length - before} net). Wrote ${file}`);
  return true;
}

async function main() {
  const registry = readJson(join(ROOT, 'sources.json'));
  if (!registry || !Array.isArray(registry.recency_sources)) { console.error('[recency] sources.json missing or invalid.'); process.exit(1); }
  const defaults = registry.defaults || {};
  const index = readJson(join(DATA_DIR, 'index.json'));
  const slugs = (index && Array.isArray(index.industries)) ? index.industries.filter((e) => e && e.slug && !e.mock).map((e) => e.slug) : [];
  if (!slugs.length) { console.log('[recency] no real industries in index.json — nothing to refresh.'); return; }
  console.log(`[recency] refreshing ${slugs.length} industr${slugs.length === 1 ? 'y' : 'ies'}: ${slugs.join(', ')}`);
  let changed = 0;
  for (const slug of slugs) {
    try { if (await refreshIndustry(slug, registry.recency_sources, defaults)) changed++; }
    catch (e) { console.error(`[recency] ${slug} failed (skipped): ${e && e.stack ? e.stack : e}`); }
  }
  console.log(`[recency] DONE — ${changed}/${slugs.length} industries updated.`);
}

main().catch((e) => { console.error('[recency] FAILED', e && e.stack ? e.stack : e); process.exit(1); });
