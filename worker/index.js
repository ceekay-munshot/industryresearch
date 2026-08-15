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

// The override validate/apply logic is a PURE module (no top-level process / node
// builtins), so it bundles cleanly into the Worker — unlike lib/llm.mjs, which the
// Worker re-implements because it reads process.env at load. Sharing it keeps the
// Worker's immediate dashboard patch and the pipeline's replay byte-for-byte identical.
import { validateOverride, applyOne, serializeOverride } from '../lib/overrides.mjs';

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

    if (url.pathname === '/api/resolve') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
      try {
        return await handleResolve(request, env);
      } catch (err) {
        console.error('[resolve] unhandled error:', err && err.stack ? err.stack : err);
        // Never-fail: treat the raw query as a literal industry name.
        const q = await safeQuery(request);
        return json({ type: 'industry', industry_name: q, slug: slugify(q), matched: false, fallback: true });
      }
    }

    if (url.pathname === '/api/stock-search') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
      // Never-fail: the dropdown is an assist, so any error → an empty list and
      // plain industry search still works untouched.
      try {
        return await handleStockSearch(request, env);
      } catch (err) {
        console.error('[stock-search] unhandled error:', err && err.stack ? err.stack : err);
        return json({ results: [] });
      }
    }

    if (url.pathname === '/api/edit') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
      // Never-fail: any error becomes a friendly, non-200-crash response with
      // manual steps so an analyst edit never dead-ends.
      try {
        return await handleEdit(request, env);
      } catch (err) {
        console.error('[edit] unhandled error:', err && err.stack ? err.stack : err);
        return json({ ok: true, saved: false, configured: false, message: editManual() });
      }
    }

    if (url.pathname === '/api/research') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
      try {
        return await handleResearch(request, env);
      } catch (err) {
        console.error('[research] unhandled error:', err && err.stack ? err.stack : err);
        const q = await safeQuery(request, 'industry');
        return json({ ok: true, dispatched: false, configured: false, industry: q, slug: slugify(q),
          message: manualSteps(q) });
      }
    }

    if (url.pathname === '/api/research-cancel') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
      try {
        return await handleResearchCancel(request, env);
      } catch (err) {
        console.error('[cancel] unhandled error:', err && err.stack ? err.stack : err);
        return json({ ok: true, cancelled: false, configured: false, message: cancelManual() });
      }
    }

    if (url.pathname === '/api/research-status') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
      // Never-fail: on any error report a safe "running" (the frontend also
      // watches the file, and times out gracefully) — never a 500.
      try {
        return await handleResearchStatus(url, env, request);
      } catch (err) {
        console.error('[status] unhandled error:', err && err.stack ? err.stack : err);
        return json({ state: 'running' });
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
 * /api/resolve — turn a free-text query (industry OR company) into a target.
 *   1. Match the query against the committed index.json (exact + fuzzy).
 *   2. Otherwise classify with Claude: COMPANY or INDUSTRY, and for a company
 *      infer its primary industry as a short canonical name.
 *   3. Re-check the inferred industry against the index (a company may map to an
 *      industry we already have).
 *   4. Never-fail: any error → treat the raw query as a literal industry name.
 * ------------------------------------------------------------------ */
async function handleResolve(request, env) {
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const query = typeof (body && body.query) === 'string' ? body.query.trim() : '';
  const sector = typeof (body && body.sector) === 'string' ? body.sector.trim() : '';
  if (!query) return json({ type: 'industry', industry_name: '', slug: '', matched: false, empty: true });

  const index = await loadIndex(env, request);

  // 1) Direct match against what we already have.
  const direct = matchIndustry(index, query);
  if (direct) return json({ type: 'industry', slug: direct.slug, industry_name: direct.name || query, matched: true });

  // 2) Classify with Claude (company vs industry). A sector hint (from the
  //    autocomplete pick) sharpens the company→industry inference. If no key /
  //    any failure, the literal fallback below still gives a usable result.
  let cls = null;
  try {
    cls = await classifyQuery(env, query, sector);
  } catch (err) {
    console.warn('[resolve] classify failed:', err && err.message ? err.message : err);
  }

  if (cls && cls.industry_name) {
    // 3) The inferred industry might already be researched under another phrasing.
    const viaIndustry = matchIndustry(index, cls.industry_name);
    if (viaIndustry) {
      return json({ type: cls.type || 'company', company: cls.company || undefined,
        slug: viaIndustry.slug, industry_name: viaIndustry.name || cls.industry_name, matched: true });
    }
    return json({ type: cls.type || 'industry', company: cls.company || undefined,
      industry_name: cls.industry_name, slug: slugify(cls.industry_name), matched: false });
  }

  // 4) Literal fallback.
  return json({ type: 'industry', industry_name: query, slug: slugify(query), matched: false, fallback: true });
}

/** Ask Claude to classify the query and (for a company) infer its industry.
 *  An optional `sector` hint (from an autocomplete pick) is passed through to
 *  sharpen the company→industry inference. */
async function classifyQuery(env, query, sector) {
  const system = [
    'You classify a short search query as either a COMPANY or an INDUSTRY/sector.',
    'If it is a COMPANY, infer the single primary industry/sector it operates in, as a short canonical industry name suitable for a research dashboard (Title Case; include a country only if the query clearly implies one).',
    'If it is already an INDUSTRY or sector, return a cleaned-up canonical industry name.',
    'Return ONLY strict JSON, no prose or fences:',
    '{"type":"company"|"industry","company":"<company name if type=company, else empty>","industry_name":"<short canonical industry name>"}',
    'Keep industry_name concise (2-6 words). Never invent a company that is clearly an industry, or vice-versa.',
  ].join('\n');
  const userMsg = sector
    ? `Query: ${query}\nHint: this is a listed company classified under the "${sector}" sector — treat it as a COMPANY and infer the industry it operates in.`
    : `Query: ${query}`;
  const raw = await callBedrock(env, {
    system,
    messages: [{ role: 'user', content: userMsg }],
    max_tokens: 200,
  });
  const obj = sliceToObject(raw);
  if (!obj || typeof obj.industry_name !== 'string' || !obj.industry_name.trim()) return null;
  const type = obj.type === 'company' ? 'company' : 'industry';
  return {
    type,
    company: type === 'company' && typeof obj.company === 'string' ? obj.company.trim() : '',
    industry_name: obj.industry_name.trim(),
  };
}

/* ------------------------------------------------------------------ *
 * /api/stock-search — company autocomplete for the search bar.
 * Proxies Muns' birdnest stock/search with the Worker's MUNS_TOKEN and
 * normalizes the result map into a plain list the dropdown can render. The
 * dropdown is only an ASSIST — plain industry-name search must keep working —
 * so this route is never-fail: any error / missing token → { results: [] }.
 *
 * Needs MUNS_TOKEN as a Worker secret (separate from the Actions MUNS_TOKEN).
 * Country for all Muns stock endpoints is India; user_index is always 124.
 * ------------------------------------------------------------------ */
const MUNS_STOCK_SEARCH_URL = 'https://birdnest.muns.io/stock/search';
const MUNS_USER_INDEX = 124;
const STOCK_SEARCH_TIMEOUT_MS = 8000;   // autocomplete must feel instant

async function handleStockSearch(request, env) {
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const query = typeof (body && body.query) === 'string' ? body.query.trim() : '';
  if (query.length < 2) return json({ results: [] });          // too short to be useful

  const token = env.MUNS_TOKEN && String(env.MUNS_TOKEN).trim();
  if (!token) return json({ results: [] });                    // not configured → assist silently off

  let data = null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), STOCK_SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(MUNS_STOCK_SEARCH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, user_index: MUNS_USER_INDEX }),
      signal: ctl.signal,
    });
    if (!res.ok) { console.warn(`[stock-search] HTTP ${res.status}`); return json({ results: [] }); }
    data = await res.json();
  } catch (err) {
    console.warn('[stock-search] fetch error:', err && err.message ? err.message : err);
    return json({ results: [] });
  } finally {
    clearTimeout(timer);
  }
  return json({ results: normalizeStockResults(data) });
}

/** Normalize birdnest stock/search into [{ ticker, name, sector, country }].
 *  Documented shape: data.results = { TICKER: [country, name, sector], ... }.
 *  Tolerant: skips malformed rows, trims blanks, caps the list for the dropdown.
 *  Pure + testable (no env / network). */
function normalizeStockResults(data) {
  const results = data && data.results;
  if (!results || typeof results !== 'object' || Array.isArray(results)) return [];
  const out = [];
  for (const [ticker, arr] of Object.entries(results)) {
    if (!Array.isArray(arr)) continue;
    const country = String(arr[0] == null ? '' : arr[0]).trim();
    const name = String(arr[1] == null ? '' : arr[1]).trim();
    const sector = String(arr[2] == null ? '' : arr[2]).trim();
    const t = String(ticker || '').trim();
    if (!t && !name) continue;
    out.push({ ticker: t, name, sector, country });
    if (out.length >= 12) break;                               // keep the dropdown short
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * /api/research — optionally dispatch the existing GitHub research workflow.
 * Requires GITHUB_TOKEN (actions:write) + GITHUB_REPO (owner/name) on the Worker.
 * Without them, returns clear manual steps instead. Never crashes either way.
 * ------------------------------------------------------------------ */
async function handleResearch(request, env) {
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const industry = typeof (body && body.industry) === 'string' ? body.industry.trim() : '';
  if (!industry) return json({ ok: true, dispatched: false, configured: false, industry: '', slug: '', message: manualSteps('') });

  const slug = slugify(industry);
  const token = env.GITHUB_TOKEN && String(env.GITHUB_TOKEN).trim();
  const repo = env.GITHUB_REPO && String(env.GITHUB_REPO).trim();

  if (!token || !repo) {
    return json({ ok: true, dispatched: false, configured: false, industry, slug, message: manualSteps(industry) });
  }

  const ref = (env.GITHUB_REF && String(env.GITHUB_REF).trim()) || 'main';
  const wf = 'research-industry.yml';
  const api = `https://api.github.com/repos/${repo}/actions/workflows/${wf}/dispatches`;
  try {
    const res = await fetch(api, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'industry-research-dashboard',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref, inputs: { industry } }),
    });
    if (res.status === 204) {
      return json({ ok: true, dispatched: true, configured: true, industry, slug, ref });
    }
    const text = await res.text();
    console.error(`[research] dispatch HTTP ${res.status}: ${String(text).slice(0, 300)}`);
    return json({ ok: true, dispatched: false, configured: true, industry, slug,
      error: `GitHub API HTTP ${res.status}`, message: manualSteps(industry) });
  } catch (err) {
    console.error('[research] dispatch error:', err && err.message ? err.message : err);
    return json({ ok: true, dispatched: false, configured: true, industry, slug, message: manualSteps(industry) });
  }
}

function manualSteps(industry) {
  const name = industry || 'the industry';
  return `One-click research isn't configured on this deployment. To research "${name}" manually: open the repo's GitHub → Actions → "Research Industry (full rebuild)" → Run workflow, and enter "${name}" as the industry. It takes a few minutes; the dashboard shows it once the run commits and the site redeploys.`;
}

/* ------------------------------------------------------------------ *
 * /api/edit — persist an analyst add/edit as an authoritative override.
 *
 * Validates the edit, then (when GITHUB_TOKEN + GITHUB_REPO are set) commits it
 * two ways via the GitHub contents API:
 *   1. appends the record to data/store/<slug>/overrides.jsonl — the durable
 *      source of truth the pipeline REPLAYS LAST on every run, so an automated
 *      refresh can never clobber the correction;
 *   2. patches public/data/industries/<slug>.json in place (same applyOne the
 *      pipeline uses) so the change shows on the next redeploy without waiting
 *      for a research run.
 * Never-fail: without a token it returns clear manual steps; any GitHub error
 * still yields a friendly 200, never a 500.
 * ------------------------------------------------------------------ */
async function handleEdit(request, env) {
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const slug = sanitizeSlug(body && body.slug);
  if (!slug) return json({ ok: true, saved: false, error: 'bad slug', message: 'Reload the dashboard and try again.' });

  // Accept a single { edit } or a batch { edits: [...] } — a row correction can
  // touch several fields, committed together (one write per file, no sha races).
  const rawEdits = Array.isArray(body && body.edits) ? body.edits : (body && body.edit ? [body.edit] : []);
  if (!rawEdits.length) return json({ ok: true, saved: false, error: 'no edit', message: 'Nothing to save.' });
  const now = new Date().toISOString();
  const overrides = [];
  for (const e of rawEdits) { const v = validateOverride(e); if (v.ok) overrides.push({ ...v.override, added_at: now }); }
  if (!overrides.length) return json({ ok: true, saved: false, error: 'invalid', message: 'Could not save: the edit was invalid.' });

  const token = env.GITHUB_TOKEN && String(env.GITHUB_TOKEN).trim();
  const repo = env.GITHUB_REPO && String(env.GITHUB_REPO).trim();
  if (!token || !repo) return json({ ok: true, saved: false, configured: false, count: overrides.length, message: editManual(slug, overrides[0]) });

  const gh = ghClient(token, repo);
  const first = overrides[0];
  const commitMsg = `analyst override: ${first.section}${first.target ? '/' + first.target : ''}.${first.field}` + (overrides.length > 1 ? ` (+${overrides.length - 1} more)` : '');

  // 1) Append the durable override records (the pipeline replays these LAST).
  const oPath = `data/store/${slug}/overrides.jsonl`;
  const block = overrides.map(serializeOverride).join('\n');
  const appended = await ghAppendLine(gh, oPath, block, commitMsg);
  if (!appended.ok) {
    return json({ ok: true, saved: false, configured: true, count: overrides.length, error: appended.error, message: editManual(slug, first) });
  }

  // 2) Patch the deployed dashboard JSON for immediate display (best-effort).
  let patched = false;
  try {
    const dPath = `public/data/industries/${slug}.json`;
    const file = await ghGetFile(gh, dPath);
    if (file.exists && file.content) {
      const data = JSON.parse(file.content);
      for (const ov of overrides) applyOne(data, ov);
      const put = await ghPutFile(gh, dPath, JSON.stringify(data, null, 2) + '\n', file.sha, commitMsg + ' (display)');
      patched = put.ok;
    }
  } catch (err) {
    console.warn('[edit] dashboard patch failed (override still saved):', err && err.message ? err.message : err);
  }

  return json({ ok: true, saved: true, configured: true, patched, count: overrides.length });
}

function editManual(slug, override) {
  const line = override ? serializeOverride(override) : '{ "section": "...", "target": "...", "field": "...", "value": "...", "added_by": "analyst" }';
  return `Saving edits isn't configured on this deployment. To apply this correction, append this line to data/store/${slug || '<slug>'}/overrides.jsonl in the repo and commit — the next research run applies it automatically:\n${line}`;
}

/* ---- GitHub contents API (read → append/patch → commit) ------------------- */
function ghClient(token, repo) {
  return {
    base: `https://api.github.com/repos/${repo}/contents/`,
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'industry-research-dashboard',
    },
  };
}

async function ghGetFile(gh, path) {
  const res = await fetch(gh.base + encodeURI(path), { headers: gh.headers });
  if (res.status === 404) return { exists: false, content: '', sha: null };
  if (!res.ok) throw new Error(`GET ${path} HTTP ${res.status}`);
  const j = await res.json();
  return { exists: true, content: j && j.content ? b64decode(j.content) : '', sha: j && j.sha };
}

async function ghPutFile(gh, path, content, sha, message) {
  const payload = { message, content: b64encode(content) };
  if (sha) payload.sha = sha;
  const res = await fetch(gh.base + encodeURI(path), {
    method: 'PUT', headers: { ...gh.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (res.ok) return { ok: true };
  const t = await res.text();
  console.error(`[edit] PUT ${path} HTTP ${res.status}: ${String(t).slice(0, 200)}`);
  return { ok: false, error: `GitHub HTTP ${res.status}` };
}

async function ghAppendLine(gh, path, line, message) {
  try {
    const file = await ghGetFile(gh, path);
    const prev = file.exists ? file.content : '';
    const next = (prev && !prev.endsWith('\n') ? prev + '\n' : prev) + line + '\n';
    return await ghPutFile(gh, path, next, file.sha, message);
  } catch (err) {
    console.error('[edit] append failed:', err && err.message ? err.message : err);
    return { ok: false, error: (err && err.message) || 'append failed' };
  }
}

/* UTF-8-safe base64 (workerd has atob/btoa but they are latin1-only). */
function b64encode(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ------------------------------------------------------------------ *
 * /api/research-cancel — cancel the currently-running research workflow.
 * Needs GITHUB_TOKEN + GITHUB_REPO (same as dispatch). Returns only a simple
 * { cancelled } flag; never leaks run ids or GitHub internals. Never crashes.
 * ------------------------------------------------------------------ */
function cancelManual() {
  return "Couldn't stop the run automatically. You can cancel it from the repo's GitHub → Actions → the running \"Research Industry\" run → Cancel.";
}

async function handleResearchCancel(request, env) {
  const token = env.GITHUB_TOKEN && String(env.GITHUB_TOKEN).trim();
  const repo = env.GITHUB_REPO && String(env.GITHUB_REPO).trim();
  if (!token || !repo) return json({ ok: true, cancelled: false, configured: false, message: cancelManual() });

  const gh = (path, method) => fetch(`https://api.github.com/repos/${repo}${path}`, {
    method: method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'industry-research-dashboard',
    },
  });
  try {
    const res = await gh('/actions/workflows/research-industry.yml/runs?per_page=10');
    if (!res.ok) return json({ ok: true, cancelled: false, configured: true, message: cancelManual() });
    const data = await res.json();
    const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
    const active = runs.find((r) => r && ['in_progress', 'queued', 'requested', 'waiting', 'pending'].includes(r.status));
    if (!active) return json({ ok: true, cancelled: false, configured: true, message: 'No active run to cancel — it may have already finished.' });
    const c = await gh(`/actions/runs/${active.id}/cancel`, 'POST');
    if (c.status === 202) return json({ ok: true, cancelled: true, configured: true });
    console.error(`[cancel] GitHub cancel HTTP ${c.status}`);
    return json({ ok: true, cancelled: false, configured: true, message: cancelManual() });
  } catch (err) {
    console.error('[cancel] error:', err && err.message ? err.message : err);
    return json({ ok: true, cancelled: false, configured: true, message: cancelManual() });
  }
}

/* ------------------------------------------------------------------ *
 * /api/research-status — a SIMPLE, friendly progress signal for the UI.
 * Returns ONLY { state: "starting" | "running" | "done" | "failed" }. No run
 * ids, no GitHub internals. Completion is honest: "done" means the deployed
 * data the frontend can actually load is ready (or the run genuinely finished).
 *
 * Query: slug (required), since (baseline updated_at, '' for new), sig (baseline
 * body length, '' for new), t (client start ms — scopes the run lookup).
 * ------------------------------------------------------------------ */
async function handleResearchStatus(url, env, request) {
  const slug = sanitizeSlug(url.searchParams.get('slug'));
  const since = url.searchParams.get('since') || '';
  const sig = url.searchParams.get('sig') || '';
  const t = Number(url.searchParams.get('t') || 0) || 0;
  if (!slug) return json({ state: 'running' });

  // 1) Is the DEPLOYED file already showing the target data? That's the honest
  //    "the frontend can load it now" signal.
  const cur = await loadIndustryText(env, request, slug);
  if (cur != null) {
    if (!since && !sig) return json({ state: 'done' });          // new industry: it exists now
    const curLen = String(cur.length);
    let curUpd = '';
    try { curUpd = (JSON.parse(cur).meta || {}).updated_at || ''; } catch { /* ignore */ }
    if ((sig && curLen !== sig) || (since && curUpd && curUpd !== since)) return json({ state: 'done' });
  }

  // 2) Otherwise ask the GitHub run how it's going (failed / running / finished).
  const runState = await latestRunState(env, t);
  return json({ state: runState });
}

/** Fetch a committed industry file's raw text via ASSETS (deployed view), or null. */
async function loadIndustryText(env, request, slug) {
  try {
    const u = new URL(`/data/industries/${slug}.json`, request.url);
    const res = await env.ASSETS.fetch(new Request(u.toString(), { method: 'GET' }));
    if (!res || !res.ok) return null;
    return await res.text();
  } catch { return null; }
}

/** Map the latest research workflow run to a friendly state. Pure + testable. */
function mapRunState(runs, cutoffMs) {
  const list = Array.isArray(runs) ? runs : [];
  const relevant = cutoffMs ? list.filter((r) => r && Date.parse(r.created_at) >= cutoffMs) : list;
  const run = relevant[0] || (cutoffMs ? null : list[0]);
  if (!run) return 'starting';                          // dispatched but not registered yet
  if (run.status !== 'completed') {
    return (run.status === 'queued' || run.status === 'requested' || run.status === 'waiting') ? 'starting' : 'running';
  }
  return run.conclusion === 'success' ? 'done' : 'failed';
}

/** Look up the latest research-industry runs and reduce to a friendly state.
 *  Without a token we can't tell — report "running" (the frontend also watches
 *  the file and times out gracefully). */
async function latestRunState(env, tMs) {
  const token = env.GITHUB_TOKEN && String(env.GITHUB_TOKEN).trim();
  const repo = env.GITHUB_REPO && String(env.GITHUB_REPO).trim();
  if (!token || !repo) return 'running';
  try {
    const api = `https://api.github.com/repos/${repo}/actions/workflows/research-industry.yml/runs?per_page=5`;
    const res = await fetch(api, {
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'industry-research-dashboard',
      },
    });
    if (!res.ok) return 'running';
    const data = await res.json();
    const cutoff = tMs ? tMs - 120000 : 0;              // 2-min tolerance for clock skew / registration lag
    return mapRunState(data && data.workflow_runs, cutoff);
  } catch { return 'running'; }
}

/* ------------------------------------------------------------------ *
 * Index loading + industry matching (exact + fuzzy, prefers real over mock).
 * ------------------------------------------------------------------ */
async function loadIndex(env, request) {
  try {
    const u = new URL('/data/industries/index.json', request.url);
    const res = await env.ASSETS.fetch(new Request(u.toString(), { method: 'GET' }));
    if (!res || !res.ok) return { industries: [] };
    const idx = await res.json();
    return idx && Array.isArray(idx.industries) ? idx : { industries: [] };
  } catch (err) {
    console.error('[resolve] index load failed:', err && err.message ? err.message : err);
    return { industries: [] };
  }
}

/** Normalise for comparison: lowercase, punctuation→space, collapse whitespace. */
function normalizeText(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

/** Best index entry for a query, or null. Real (non-mock) entries are matched
 *  first, so leftover mock scaffolding never shadows real data; within a pass,
 *  an exact slug/name/alias match beats a fuzzy one. */
function matchIndustry(index, query) {
  const q = normalizeText(query);
  if (!q) return null;
  const list = (index.industries || []).filter(Boolean);
  return bestMatch(list.filter((it) => !it.mock), q) || bestMatch(list.filter((it) => it.mock), q);
}

function bestMatch(items, q) {
  let best = null, bestScore = 0;
  for (const it of items) {
    const fields = [it.slug, it.name, ...(Array.isArray(it.aliases) ? it.aliases : [])]
      .filter(Boolean).map(normalizeText);
    let score = 0;
    for (const f of fields) {
      if (!f) continue;
      if (f === q) { score = Math.max(score, 3); continue; }
      // fuzzy: one contains the other, guarded so tiny tokens don't over-match
      if (q.length >= 3 && (f.includes(q) || q.includes(f))) score = Math.max(score, 1);
    }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return best;
}

async function safeQuery(request, key) {
  try {
    const b = await request.json();
    const v = b && (b[key || 'query'] || b.query || b.industry);
    return typeof v === 'string' ? v.trim() : '';
  } catch { return ''; }
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

/** Mirror of the pipeline's slugify (scripts/research-industry.mjs) so a slug
 *  built here matches the file the workflow will write. */
function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'industry';
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

// Exposed for unit tests (scripts/test-chat.mjs, scripts/test-resolve.mjs).
// These are pure functions with no env/network dependency; they are not used by
// any other runtime module.
export { buildContext, collectSources, parseAnswer, sanitizeSlug, buildMessages, slugify, normalizeText, matchIndustry, manualSteps, mapRunState, normalizeStockResults };
