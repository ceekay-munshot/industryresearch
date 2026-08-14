/**
 * lib/scrape.mjs — richer source fetchers: Firecrawl (markdown), Scrape.do
 * (rendered HTML fallback / JS-heavy pages), and Mistral OCR (PDF -> text).
 *
 * No npm dependencies — global fetch + node stdlib only.
 * Each fetcher logs the raw shape of its FIRST successful call, parses
 * defensively, and is continue-on-error: any failure logs and returns null,
 * so a single bad source can never crash the run. Secrets are never logged
 * (in particular the Scrape.do token lives in the request URL, so that URL is
 * never printed — only the target url is).
 */

const shapeLogged = { firecrawl: false, scrapedo: false, mistral: false };

function logShape(kind, data) {
  if (shapeLogged[kind]) return;
  shapeLogged[kind] = true;
  try {
    const describe = (v, depth = 0) => {
      if (v === null) return 'null';
      if (Array.isArray(v)) return `array(${v.length})` + (v.length && depth < 1 ? `<${describe(v[0], depth + 1)}>` : '');
      if (typeof v === 'string') return `string(${v.length})`;
      if (typeof v === 'object') return '{' + Object.keys(v).slice(0, 20).map((k) => `${k}:${describe(v[k], depth + 1)}`).join(', ') + '}';
      return typeof v;
    };
    console.log(`[scrape] first ${kind} response shape: ${describe(data)}`);
  } catch (e) {
    console.log(`[scrape] first ${kind} response shape: <unprintable: ${e.message}>`);
  }
}

/* ----------------------------------------------------------------------- *
 * Firecrawl — clean markdown for a normal web page.
 * ----------------------------------------------------------------------- */
export async function firecrawlScrape(url) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key || !key.trim()) {
    console.warn('[scrape] FIRECRAWL_API_KEY not set — skipping Firecrawl.');
    return null;
  }
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      console.warn(`[scrape] firecrawl ${url} -> HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      return null;
    }
    let json;
    try { json = JSON.parse(bodyText); } catch (e) { console.warn(`[scrape] firecrawl ${url} -> non-JSON`); return null; }
    logShape('firecrawl', json);
    // v1 wraps content in `data`; tolerate a flat body too.
    const d = (json && typeof json.data === 'object' && json.data) ? json.data : json;
    const text = (d && (d.markdown || d.content)) || '';
    const title = (d && d.metadata && (d.metadata.title || d.metadata.ogTitle)) || '';
    if (!text) return null;
    return { url, text, title };
  } catch (err) {
    console.warn(`[scrape] firecrawl ${url} -> error: ${err.message}`);
    return null;
  }
}

/* ----------------------------------------------------------------------- *
 * Scrape.do — rendered HTML (fallback for Firecrawl; JS-heavy pages).
 * ----------------------------------------------------------------------- */
export async function scrapedoScrape(url) {
  const key = process.env.SCRAPEDO_API_KEY;
  if (!key || !key.trim()) {
    console.warn('[scrape] SCRAPEDO_API_KEY not set — skipping Scrape.do.');
    return null;
  }
  try {
    // NOTE: token is in the query string — never log this URL.
    const api = `https://api.scrape.do/?token=${key}&url=${encodeURIComponent(url)}&render=true`;
    const res = await fetch(api);
    const html = await res.text();
    if (!res.ok) {
      // Print the body so a wrong token vs. a plan restriction (e.g. render=true
      // needs a paid plan) is distinguishable. The body is Scrape.do's error
      // message, not the request URL, so the token is never exposed here.
      console.warn(`[scrape] scrapedo ${url} -> HTTP ${res.status}: ${(html || '').slice(0, 300)}`);
      return null;
    }
    logShape('scrapedo', { html });
    if (!html) return null;
    return { url, html };
  } catch (err) {
    console.warn(`[scrape] scrapedo ${url} -> error: ${err.message}`);
    return null;
  }
}

/* ----------------------------------------------------------------------- *
 * Mistral OCR — PDF (by URL) -> concatenated page markdown.
 * ----------------------------------------------------------------------- */
export async function mistralOCR(pdfUrl) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key || !key.trim()) {
    console.warn('[scrape] MISTRAL_API_KEY not set — skipping Mistral OCR.');
    return null;
  }
  try {
    const res = await fetch('https://api.mistral.ai/v1/ocr', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mistral-ocr-latest', document: { type: 'document_url', document_url: pdfUrl } }),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      console.warn(`[scrape] mistral-ocr ${pdfUrl} -> HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      return null;
    }
    let json;
    try { json = JSON.parse(bodyText); } catch (e) { console.warn(`[scrape] mistral-ocr ${pdfUrl} -> non-JSON`); return null; }
    logShape('mistral', json);
    const pages = Array.isArray(json.pages) ? json.pages : [];
    const text = pages
      .map((p) => (p && (p.markdown || p.text || p.content)) || '')
      .join('\n\n')
      .trim();
    if (!text) return null;
    return { url: pdfUrl, text };
  } catch (err) {
    console.warn(`[scrape] mistral-ocr ${pdfUrl} -> error: ${err.message}`);
    return null;
  }
}

/* ----------------------------------------------------------------------- *
 * Helpers
 * ----------------------------------------------------------------------- */

/** Crude but robust HTML -> text (for scraped HTML with no markdown). */
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract {id,title} pairs from a YouTube results page HTML (ytInitialData). */
export function extractYouTubeFromHtml(html) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  const decode = (s) => String(s)
    .replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\\//g, '/')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // Standard videoRenderer shape carries id + title.runs[0].text.
  const re = /"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,500}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(html)) && out.length < 25) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: decode(m[2]) });
  }
  // Fallback: bare watch ids (no titles) if the structured parse found nothing.
  if (!out.length) {
    const re2 = /watch\?v=([A-Za-z0-9_-]{11})/g;
    let m2;
    while ((m2 = re2.exec(html)) && out.length < 25) {
      const id = m2[1];
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title: '' });
    }
  }
  return out;
}
