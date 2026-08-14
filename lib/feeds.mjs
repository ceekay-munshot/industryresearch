/**
 * lib/feeds.mjs — tiny, dependency-free RSS/Atom + GDELT readers for the recency
 * refresh. Fetches with a browser UA and HTTP conditional GET (ETag /
 * If-Modified-Since) so a 304 costs nothing, parses defensively with regex (feeds
 * are small and well-formed enough for this), and never throws — a failed feed
 * returns [] so one bad source can't stop the refresh.
 *
 * node stdlib + global fetch only.
 */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Fetch a feed. Returns { status, text, etag, last_modified }.
 * status 304 => not modified (text ''); status 0 => network failure after retries.
 * Retries transient failures (429 / 5xx / network) with backoff.
 */
export async function fetchFeed(url, { ua, etag, lastModified, timeoutMs = 20000 } = {}) {
  const headers = { 'User-Agent': ua || 'Mozilla/5.0 (compatible; research-bot/1.0)', Accept: 'application/rss+xml, application/atom+xml, application/xml, application/json, text/xml;q=0.9, */*;q=0.8' };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;
  const MAX = 3;
  for (let attempt = 0; attempt < MAX; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    let ctrl, timer;
    try {
      ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (res.status === 304) return { status: 304, text: '', etag: res.headers.get('etag'), last_modified: res.headers.get('last-modified') };
      const text = await res.text();
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < MAX - 1) { console.warn(`[feeds] ${short(url)} HTTP ${res.status} (attempt ${attempt + 1}) — retrying...`); continue; }
        console.warn(`[feeds] ${short(url)} -> HTTP ${res.status}`);
        return { status: res.status, text: '', etag: null, last_modified: null };
      }
      return { status: 200, text, etag: res.headers.get('etag'), last_modified: res.headers.get('last-modified') };
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (attempt < MAX - 1) { console.warn(`[feeds] ${short(url)} error (attempt ${attempt + 1}): ${err.message} — retrying...`); continue; }
      console.warn(`[feeds] ${short(url)} -> error: ${err.message}`);
      return { status: 0, text: '', etag: null, last_modified: null };
    }
  }
  return { status: 0, text: '', etag: null, last_modified: null };
}

const short = (u) => String(u).replace(/\?.*$/, '').slice(0, 80);

/* ---- parsing helpers ---------------------------------------------------- */

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x2019;/gi, '’').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  // First <name ...>...</name> (namespaced tags like dc:date match by localname).
  const m = block.match(new RegExp(`<(?:[a-zA-Z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${name}>`, 'i'));
  return m ? m[1] : '';
}

function attr(block, name, a) {
  const m = block.match(new RegExp(`<(?:[a-zA-Z0-9]+:)?${name}\\b[^>]*\\b${a}=["']([^"']+)["']`, 'i'));
  return m ? m[1] : '';
}

/** Parse an RSS 2.0 or Atom feed into [{title, url, date, snippet, guid, source}]. */
export function parseRss(xml) {
  const s = String(xml || '');
  if (!s) return [];
  const out = [];
  const blocks = s.match(/<item\b[\s\S]*?<\/item>/gi) || s.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const title = decode(tag(b, 'title'));
    // RSS <link>text</link>; Atom <link href="..."/>.
    let url = decode(tag(b, 'link')) || attr(b, 'link', 'href');
    const guid = decode(tag(b, 'guid')) || url || title;
    const date = decode(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'date'));
    const snippet = decode(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 300);
    const source = decode(tag(b, 'source')) || '';
    if (!title && !url) continue;
    out.push({ title, url, date, snippet, guid, source });
  }
  return out;
}

/** Parse a GDELT DOC 2.0 artlist JSON reply into the same shape. */
export function parseGdelt(text) {
  let json;
  try { json = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return []; }
  const arts = Array.isArray(json && json.articles) ? json.articles : [];
  return arts.map((a) => ({
    title: decode(a.title),
    url: String(a.url || ''),
    date: gdeltDate(a.seendate),
    snippet: '',
    guid: String(a.url || a.title || ''),
    source: String(a.domain || ''),
  })).filter((x) => x.title || x.url);
}

/** GDELT seendate is like 20260814T101500Z -> ISO. */
function gdeltDate(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : String(s || '');
}

/** Parse a feed reply by declared type. */
export function parseFeed(type, text) {
  return type === 'gdelt' ? parseGdelt(text) : parseRss(text);
}

/** Normalise a feed item's date to a comparable epoch ms (or 0 if unknown). */
export function itemEpoch(date) {
  const t = Date.parse(date);
  return isNaN(t) ? 0 : t;
}

/** Publisher/domain of an item (for de-dup + the "N sources" count). */
export function itemDomain(item) {
  const u = item.url || '';
  try { return new URL(u).host.replace(/^www\./, '').toLowerCase(); }
  catch (e) { return String(item.source || '').toLowerCase(); }
}
