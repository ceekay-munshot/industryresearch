/**
 * Industry Research Dashboard — Cloudflare Worker
 *
 * Responsibilities:
 *   1. Serve the static site in ./public via the ASSETS binding.
 *   2. POST /api/chat — a grounded, source-backed chat over ONE industry's
 *      committed dashboard data. Answers come ONLY from that data; every claim
 *      is asked to cite a source URL; out-of-scope questions are answered
 *      "not in the data" rather than guessed.
 *
 * The chat route is generic: it works for any industry present in
 * public/data/industries/<slug>.json — nothing is MDF-specific.
 *
 * Bedrock config comes from the WORKER env (NOT process.env — Workers have no
 * process). These are Cloudflare Worker secrets/vars, separate from the GitHub
 * Actions secrets the pipeline uses:
 *   BEDROCK_API_KEY   (required — used as a bearer token)
 *   BEDROCK_REGION    (default "us-east-1")
 *   BEDROCK_MODEL_ID  (default "us.anthropic.claude-sonnet-5")
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const ANTHROPIC_VERSION = 'bedrock-2023-05-31';
// Keep the grounded context within a sane token budget. ~4 chars/token, so
// ~48k chars ≈ 12k tokens of context — generous but bounded.
const CONTEXT_CHAR_BUDGET = 48000;
const FRIENDLY_FAIL = "I couldn't answer that right now — please try again in a moment.";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
      }
      // Never-fail: any unexpected error becomes a friendly 200, never a 500.
      try {
        return await handleChat(request, env);
      } catch (err) {
        console.error('[chat] unhandled error:', err && err.stack ? err.stack : err);
        return json({ answer: FRIENDLY_FAIL, sources: [] });
      }
    }

    // Everything else: static assets.
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------------ *
 * Chat handler
 * ------------------------------------------------------------------ */
async function handleChat(request, env) {
  let body = {};
  try { body = await request.json(); } catch { body = {}; }

  const slug = sanitizeSlug(body && body.slug);
  const question = typeof (body && body.question) === 'string' ? body.question.trim() : '';
  const history = Array.isArray(body && body.history) ? body.history : [];

  if (!question) {
    return json({ answer: 'Ask me a question about this industry and I’ll answer from the dashboard data.', sources: [] });
  }
  if (!slug) {
    return json({ answer: "I couldn't tell which industry to look at. Reload the dashboard and try again.", sources: [] });
  }

  // Load the industry's committed data from static assets.
  const data = await loadIndustry(env, request, slug);
  if (!data) {
    return json({ answer: `I don't have any gathered data for "${slug}" yet, so I can't answer questions about it.`, sources: [] });
  }

  const industryName = (data.meta && (data.meta.name || data.meta.slug)) || 'this industry';
  const known = collectSources(data);                 // [{label,url}] present in the data
  const knownUrls = new Set(known.map((s) => s.url));
  const context = buildContext(data);

  const system = [
    `You are a research assistant for the "${industryName}" industry dashboard.`,
    `Answer the user's question using ONLY the DASHBOARD DATA provided below. Do not use outside knowledge.`,
    `Cite the source URL for each claim you make, drawing the URL from the data.`,
    `If the answer is not present in the data, say so plainly (e.g. "The dashboard data doesn't cover that.") — never guess or invent figures, names, or sources.`,
    `Write in plain English, concise and direct. Prefer specific numbers from the data over vague statements.`,
    ``,
    `Return ONLY a strict JSON object, no prose or markdown fences, of the form:`,
    `{"answer": "<your answer in plain English>", "sources": [{"label": "<source label>", "url": "<source url from the data>"}], "in_data": true|false}`,
    `"sources" must list only the sources you actually used, each url copied verbatim from the DASHBOARD DATA. If the answer isn't in the data, set "in_data" to false and "sources" to [].`,
    ``,
    `DASHBOARD DATA for ${industryName}:`,
    context,
  ].join('\n');

  const messages = buildMessages(history, question);

  let answer = '';
  let sources = [];
  try {
    const raw = await callBedrock(env, { system, messages, max_tokens: 1200 });
    const parsed = parseAnswer(raw, knownUrls, known);
    answer = parsed.answer;
    sources = parsed.sources;
  } catch (err) {
    console.error('[chat] bedrock/answer error:', err && err.message ? err.message : err);
    return json({ answer: FRIENDLY_FAIL, sources: [] });
  }

  if (!answer) answer = FRIENDLY_FAIL;
  return json({ answer, sources });
}

/** Load public/data/industries/<slug>.json via the ASSETS binding. */
async function loadIndustry(env, request, slug) {
  try {
    const assetUrl = new URL(`/data/industries/${slug}.json`, request.url);
    const res = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET' }));
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('[chat] asset load failed:', err && err.message ? err.message : err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Grounded context — a compact, cite-friendly rendering of the data.
 * Generic: reads the same section shapes the dashboard renders, and attaches
 * each fact's source URL inline so the model can cite it.
 * ------------------------------------------------------------------ */
function buildContext(d) {
  const out = [];
  const src = (s) => (s && s.url ? `  [source: ${s.label || 'Source'} ${s.url}]` : '');
  const push = (line) => { if (line) out.push(line); };

  if (d.meta && d.meta.definition) push(`DEFINITION: ${d.meta.definition}`);

  const sum = d.summary || {};
  if (sum.headline) push(`\nSUMMARY: ${sum.headline}`);
  if (Array.isArray(sum.key_takeaways) && sum.key_takeaways.length) {
    push('KEY TAKEAWAYS:');
    sum.key_takeaways.forEach((t) => push(`- ${t}`));
  }

  if (d.size && d.size.current && d.size.current.value != null) {
    const c = d.size.current;
    const hist = Array.isArray(d.size.history) && d.size.history.length
      ? ` History: ${d.size.history.map((p) => `${p.year}=${p.value}`).join(', ')}.` : '';
    const cagr = d.size.cagr_pct != null ? ` CAGR ${d.size.cagr_pct}%.` : '';
    const cnote = d.size.cagr_note ? ` (${d.size.cagr_note})` : '';
    push(`\nMARKET SIZE: ${c.value} ${c.unit || ''}${c.year ? ` (${c.year})` : ''}.${cagr}${hist}${cnote}${src(d.size.source)}`);
  }

  section(out, 'SEGMENTS', d.segments, (s) =>
    `- ${s.name || 'Segment'}${s.share_pct != null ? ` — ${s.share_pct}% share` : ''}${s.note ? `. ${s.note}` : ''}${src(s.source)}`);

  section(out, 'GROWTH DRIVERS', d.growth_drivers, (g) =>
    `- ${g.title || ''}${g.title && g.detail ? ': ' : ''}${g.detail || ''}${src(g.source)}`);

  section(out, 'TAILWINDS', d.tailwinds, (t) => `- ${t.point || t.note || ''}${src(t.source)}`);
  section(out, 'HEADWINDS / RISKS', d.headwinds, (t) => `- ${t.point || t.note || ''}${src(t.source)}`);

  section(out, 'VALUE CHAIN', d.value_chain, (v) =>
    `- ${v.stage || ''}${v.stage && v.description ? ': ' : ''}${v.description || ''}${src(v.source)}`);

  section(out, 'DISTRIBUTION CHANNELS', d.channels, (c) =>
    `- ${c.channel || ''}${c.channel && c.note ? ': ' : ''}${c.note || ''}${src(c.source)}`);

  section(out, 'KEY PLAYERS', d.players, (p) => {
    const share = p.market_share_pct != null ? ` — ${p.market_share_pct}% share` : '';
    const listed = p.listed === true ? ' (listed)' : p.listed === false ? ' (unlisted)' : '';
    return `- ${p.name || 'Player'}${listed}${share}${p.note ? `. ${p.note}` : ''}${src(p.source)}`;
  });

  if (d.margins && (d.margins.manufacturer_pct != null || d.margins.retailer_pct != null || d.margins.notes)) {
    const m = d.margins;
    const parts = [];
    if (m.manufacturer_pct != null) parts.push(`manufacturer ${m.manufacturer_pct}%`);
    if (m.retailer_pct != null) parts.push(`retailer ${m.retailer_pct}%`);
    push(`\nMARGINS: ${parts.join(', ')}${parts.length && m.notes ? '. ' : ''}${m.notes || ''}${src(m.source)}`);
  }

  if (d.quant && (has(d.quant.capacity) || d.quant.utilisation_pct != null || has(d.quant.imports) || has(d.quant.duty))) {
    const q = d.quant;
    const parts = [];
    if (has(q.capacity)) parts.push(`capacity: ${stringifyQuant(q.capacity)}`);
    if (q.utilisation_pct != null) parts.push(`utilisation: ${q.utilisation_pct}%`);
    if (has(q.imports)) parts.push(`imports: ${stringifyQuant(q.imports)}`);
    if (has(q.duty)) parts.push(`duty: ${stringifyQuant(q.duty)}`);
    push(`\nSUPPLY & CAPACITY: ${parts.join('; ')}${src(q.source)}`);
  }

  // Report / news source titles (so "what sources back this?" is answerable).
  const s = d.sources || {};
  const rep = Array.isArray(s.reports) ? s.reports.filter((r) => r && r.url) : [];
  if (rep.length) {
    push('\nRESEARCH REPORTS:');
    rep.slice(0, 25).forEach((r) => push(`- ${r.title || 'Report'}${r.publisher ? ` (${r.publisher})` : ''} — ${r.url}`));
  }

  let text = out.join('\n').trim();
  if (text.length > CONTEXT_CHAR_BUDGET) {
    text = text.slice(0, CONTEXT_CHAR_BUDGET) + '\n…[context truncated]';
  }
  return text || '(no structured data available)';
}

function section(out, title, arr, fmt) {
  if (!Array.isArray(arr) || !arr.length) return;
  out.push(`\n${title}:`);
  for (const item of arr) {
    if (!item) continue;
    const line = fmt(item);
    if (line && line.trim()) out.push(line);
  }
}

function stringifyQuant(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    // {value,unit,year,note} or freeform — render the informative bits.
    const bits = [];
    if (v.value != null) bits.push(`${v.value}${v.unit ? ' ' + v.unit : ''}${v.year ? ` (${v.year})` : ''}`);
    if (v.note) bits.push(v.note);
    if (!bits.length) return JSON.stringify(v);
    return bits.join(' — ');
  }
  return String(v);
}

/** Every distinct {label,url} that appears anywhere in the data (never-invent set). */
function collectSources(d) {
  const seen = new Map();
  const add = (s) => { if (s && s.url && !seen.has(s.url)) seen.set(s.url, { label: s.label || 'Source', url: s.url }); };
  const arr = (a) => Array.isArray(a) ? a : [];
  add(d.size && d.size.source);
  add(d.margins && d.margins.source);
  add(d.quant && d.quant.source);
  arr(d.segments).forEach((x) => add(x && x.source));
  arr(d.growth_drivers).forEach((x) => add(x && x.source));
  arr(d.tailwinds).forEach((x) => add(x && x.source));
  arr(d.headwinds).forEach((x) => add(x && x.source));
  arr(d.value_chain).forEach((x) => add(x && x.source));
  arr(d.channels).forEach((x) => add(x && x.source));
  arr(d.players).forEach((x) => add(x && x.source));
  const s = d.sources || {};
  arr(s.reports).forEach((r) => add(r));
  arr(s.news).forEach((n) => add(n));
  arr(s.youtube).forEach((y) => add(y));
  return [...seen.values()];
}

/* ------------------------------------------------------------------ *
 * History → Bedrock messages. Alternate user/assistant, ending on the new
 * user question. We keep only the last few turns to stay in budget.
 * ------------------------------------------------------------------ */
function buildMessages(history, question) {
  const turns = [];
  const recent = history.slice(-8); // last ~4 exchanges
  for (const m of recent) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
    const role = m.role === 'assistant' || m.role === 'bot' ? 'assistant' : 'user';
    turns.push({ role, content: m.content.trim().slice(0, 4000) });
  }
  // Bedrock requires the conversation to start with a user turn and alternate.
  const cleaned = [];
  for (const t of turns) {
    if (cleaned.length === 0 && t.role !== 'user') continue;      // must start with user
    if (cleaned.length && cleaned[cleaned.length - 1].role === t.role) {
      cleaned[cleaned.length - 1] = t;                            // collapse same-role repeats
    } else {
      cleaned.push(t);
    }
  }
  if (cleaned.length && cleaned[cleaned.length - 1].role === 'user') {
    // History ended on a user turn — bridge it so appending the new question
    // doesn't produce two user turns in a row.
    cleaned.push({ role: 'assistant', content: '(understood)' });
  }
  cleaned.push({ role: 'user', content: question.slice(0, 4000) });
  return cleaned;
}

/* ------------------------------------------------------------------ *
 * Parse the model reply into { answer, sources }. Robust + never-invent:
 * only sources whose URL exists in the data survive. If JSON parsing fails,
 * fall back to the raw text as the answer and scan it for known URLs.
 * ------------------------------------------------------------------ */
function parseAnswer(raw, knownUrls, known) {
  const obj = sliceToObject(raw);
  if (obj && typeof obj.answer === 'string' && obj.answer.trim()) {
    const answer = obj.answer.trim();
    const src = Array.isArray(obj.sources) ? obj.sources : [];
    const sources = dedupeSources(
      src
        .filter((s) => s && typeof s.url === 'string' && knownUrls.has(s.url))
        .map((s) => ({ label: labelFor(s, known), url: s.url }))
    );
    return { answer, sources };
  }
  // Fallback: treat the whole reply as prose; derive sources by scanning for
  // any known URL mentioned in the text.
  const text = String(raw || '').trim();
  const mentioned = dedupeSources(known.filter((s) => text.includes(s.url)));
  return { answer: text, sources: mentioned };
}

function labelFor(s, known) {
  if (s.label && String(s.label).trim()) return String(s.label).trim();
  const hit = known.find((k) => k.url === s.url);
  return (hit && hit.label) || 'Source';
}

function dedupeSources(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s || !s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}

/** Slice a reply to its outermost { … } object and parse it (ignores fences/prose). */
function sliceToObject(raw) {
  const text = String(raw || '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  const candidate = text.slice(first, last + 1);
  try { return JSON.parse(candidate); }
  catch {
    // one light repair: strip trailing commas, normalise control chars in strings
    try { return JSON.parse(candidate.replace(/[\u0000-\u001F]/g, ' ').replace(/,(\s*[}\]])/g, '$1')); }
    catch { return null; }
  }
}

/* ------------------------------------------------------------------ *
 * Bedrock call — Worker-native mirror of lib/llm.mjs (same InvokeModel HTTPS
 * endpoint, bearer-token auth and Anthropic message shape). Config from `env`
 * (Workers have no process.env). Retries transient failures a couple of times.
 * ------------------------------------------------------------------ */
async function callBedrock(env, { system, messages, max_tokens = 1200 }) {
  const apiKey = env.BEDROCK_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('BEDROCK_API_KEY is not set on the Worker.');
  }
  const region = (env.BEDROCK_REGION && String(env.BEDROCK_REGION).trim()) || 'us-east-1';
  const modelId = (env.BEDROCK_MODEL_ID && String(env.BEDROCK_MODEL_ID).trim()) || 'us.anthropic.claude-sonnet-5';
  const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;

  const payload = {
    anthropic_version: ANTHROPIC_VERSION,
    max_tokens,
    system: system || '',
    // Chat is a direct Q&A over grounded context — disable adaptive thinking so
    // the token budget goes to the answer, not hidden reasoning.
    thinking: { type: 'disabled' },
    messages,
  };
  const bodyStr = JSON.stringify(payload);

  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1)); // 0.4s, 0.8s
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: bodyStr,
      });
      const text = await res.text();
      if (res.ok) return extractText(text);
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
        lastErr = new Error(`Bedrock HTTP ${res.status}`);
        continue;
      }
      throw new Error(`Bedrock request failed: HTTP ${res.status} — ${String(text).slice(0, 300)}`);
    } catch (err) {
      if (/^Bedrock request failed/.test(err.message)) throw err;
      lastErr = err;
      if (attempt >= MAX_ATTEMPTS - 1) throw err;
    }
  }
  throw lastErr || new Error('Bedrock request failed after retries.');
}

function extractText(rawBody) {
  const data = JSON.parse(rawBody);
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  if (!text) throw new Error('Bedrock response had no text content.');
  return text;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
function sanitizeSlug(slug) {
  if (typeof slug !== 'string') return '';
  const s = slug.trim().toLowerCase();
  // Only lowercase letters, digits and hyphens — blocks path traversal and
  // keeps ASSETS.fetch pointed at the industries directory.
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(s) ? s : '';
}

function has(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function json(obj, status = 200, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS,
  });
}

// Exposed for unit tests (scripts/test-chat.mjs). These are pure functions with
// no env/network dependency; they are not used by any other runtime module.
export { buildContext, collectSources, parseAnswer, sanitizeSlug, buildMessages };
