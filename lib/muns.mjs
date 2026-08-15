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

const shapeLogged = { search: false, news: false, reader: false };

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

async function post(path, payload, kind) {
  const t = token();
  if (!t) return null;
  const body = JSON.stringify(payload);
  // A few attempts with exponential backoff for transient failures (throttling /
  // server errors / network / timeout). Every other failure returns null so one
  // bad call can never crash the run — the caller just proceeds with fewer sources.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1)); // 1s, 2s
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${t}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: ctl.signal,
      });
      const bodyText = await res.text();
      clearTimeout(timer);
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
          console.warn(`[muns] ${path} -> HTTP ${res.status} (attempt ${attempt + 1}/${MAX_ATTEMPTS}) — retrying...`);
          continue;
        }
        console.warn(`[muns] ${path} -> HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
        return null;
      }
      let data;
      try {
        data = JSON.parse(bodyText);
      } catch (e) {
        console.warn(`[muns] ${path} -> non-JSON response: ${bodyText.slice(0, 200)}`);
        return null;
      }
      logShape(kind, data);
      return data;
    } catch (err) {
      clearTimeout(timer);
      const msg = err && err.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : (err && err.message) || String(err);
      if (attempt < MAX_ATTEMPTS - 1) {
        console.warn(`[muns] ${path} -> request error (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${msg} — retrying...`);
        continue;
      }
      console.warn(`[muns] ${path} -> request error: ${msg}`);
      return null;
    }
  }
  return null;
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

/** Normalize a web/news search response into [{title, url, snippet, publisher?, date?}]. */
export function normalizeSearch(data) {
  return firstResultArray(data)
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      const url = pick(r, ['url', 'link', 'href', 'source_url', 'page_url']);
      const title = pick(r, ['title', 'name', 'heading', 'headline']);
      const snippet = pick(r, ['snippet', 'description', 'summary', 'text', 'content', 'excerpt', 'abstract']);
      const publisher = pick(r, ['publisher', 'source', 'source_name', 'site', 'domain', 'provider']);
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
