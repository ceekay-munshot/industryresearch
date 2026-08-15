/**
 * lib/llm.mjs — the ONLY place the pipeline talks to Claude.
 *
 * Calls Claude on AWS Bedrock via the raw InvokeModel HTTPS endpoint using
 * global `fetch` (no npm dependencies). Authentication is a Bedrock API key
 * passed as a bearer token.
 *
 * Env (empty/missing values fall back to the defaults):
 *   BEDROCK_API_KEY   (required — throws if missing)
 *   BEDROCK_REGION    default "us-east-1"
 *   BEDROCK_MODEL_ID  default "us.anthropic.claude-sonnet-5"
 */

const REGION = process.env.BEDROCK_REGION || 'us-east-1';
const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-5';
const ANTHROPIC_VERSION = 'bedrock-2023-05-31';

function endpoint() {
  return `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(MODEL_ID)}/invoke`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call Claude once and return the concatenated text of every `text` content
 * block. Retries a single time on a network error or a 5xx response.
 *
 * Throws with the HTTP status + response body on failure so a wrong region or
 * model id is debuggable from the logs.
 */
export async function callClaude({ system, user, max_tokens = 8000, thinking }) {
  const apiKey = process.env.BEDROCK_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error('BEDROCK_API_KEY is not set. Provide a Bedrock API key (used as a bearer token).');
  }

  const payload = {
    anthropic_version: ANTHROPIC_VERSION,
    max_tokens,
    system: system || '',
    messages: [{ role: 'user', content: String(user ?? '') }],
  };
  // Optional: pass a `thinking` config (e.g. { type: "disabled" }). Omitted by
  // default so the request body stays minimal. On Sonnet 5, thinking runs
  // adaptive by default and can consume the whole max_tokens budget — disable it
  // for large structured extractions so the tokens go to the actual output.
  if (thinking) payload.thinking = thinking;
  const body = JSON.stringify(payload);

  const url = endpoint();
  // Per-request timeout so a hung Bedrock connection can't stall the whole run
  // (Node fetch has no default timeout). Large extractions are slow but bounded.
  const TIMEOUT_MS = Number(process.env.BEDROCK_TIMEOUT_MS) || 180000;
  const doFetch = async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: ctl.signal,
      });
      const text = await res.text();
      return { res, text };
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error(`Bedrock request timed out after ${TIMEOUT_MS}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  // A few attempts with exponential backoff. Retry transient failures only:
  // throttling (429), server errors (5xx) and network-level errors. Fail fast on
  // other 4xx (auth / model / region / validation) — retrying can't fix those.
  const MAX_ATTEMPTS = 4;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1)); // 1s, 2s, 4s
    try {
      const { res, text } = await doFetch();
      if (res.ok) {
        return extractText(text, url);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
        lastErr = new Error(`Bedrock ${res.status} at ${url}\n${String(text).slice(0, 500)}`);
        console.warn(`[llm] Bedrock HTTP ${res.status} (attempt ${attempt + 1}/${MAX_ATTEMPTS}) — retrying...`);
        continue;
      }
      throw new Error(`Bedrock request failed: HTTP ${res.status} at ${url}\n${text}`);
    } catch (err) {
      // A thrown "Bedrock request failed" is a non-retryable HTTP error — rethrow.
      if (/^Bedrock request failed/.test(err.message)) throw err;
      // Network-level failure (no HTTP status) — retry until attempts exhausted.
      if (attempt < MAX_ATTEMPTS - 1) {
        lastErr = err;
        console.warn(`[llm] Bedrock network error (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${err.message} — retrying...`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('Bedrock request failed after retries.');
}

/** Pull and concatenate all `text` blocks from an Anthropic-format response body. */
function extractText(rawBody, url) {
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (e) {
    throw new Error(`Bedrock returned non-JSON body at ${url}\n${String(rawBody).slice(0, 800)}`);
  }
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  if (!text) {
    throw new Error(`Bedrock response had no text content at ${url}\n${JSON.stringify(data).slice(0, 800)}`);
  }
  return text;
}

/**
 * Call Claude and robustly parse a single JSON object from the reply.
 * Slices to the outermost { … } (ignoring ```json fences / prose). If that
 * doesn't parse, tries a light local repair, then one fallback Claude repair
 * call, before throwing a clear error.
 */
export async function callClaudeJSON({ system, user, max_tokens = 8000, thinking }) {
  const raw = await callClaude({ system, user, max_tokens, thinking });
  const candidate = sliceToObject(raw);
  if (candidate == null) {
    throw new Error(`callClaudeJSON: no JSON object found in reply.\n${raw.slice(0, 1000)}`);
  }

  // 1) Direct parse.
  const direct = tryParse(candidate);
  if (direct.ok) return direct.value;

  // 2) Light local repair (normalize control chars, strip trailing commas,
  //    close truncated strings/objects/arrays). Handles the common cases
  //    without a second API call.
  const repaired = tryParse(repairJson(candidate));
  if (repaired.ok) {
    console.warn('[llm] callClaudeJSON: recovered via local JSON repair.');
    return repaired.value;
  }

  // 3) Last resort: one fallback call asking Claude to fix the broken JSON
  //    (handles messy cases local repair can't, e.g. an unescaped quote from
  //    OCR/report text mid-string).
  console.warn(`[llm] callClaudeJSON: parse failed (${direct.error}); asking Claude to repair the JSON...`);
  try {
    const fixedRaw = await callClaude({
      system: 'You are a JSON repair tool. The user gives you text meant to be ONE JSON object but it fails to parse — usually an unescaped double-quote or a raw newline inside a string value. Return ONLY the corrected, strictly valid JSON object: keep all the data, change as little as possible to make it parse (escape or remove the offending characters). No prose, no markdown, no code fences.',
      user: candidate,
      max_tokens,
      thinking: { type: 'disabled' },
    });
    const fixedCandidate = sliceToObject(fixedRaw);
    if (fixedCandidate) {
      const fixed = tryParse(fixedCandidate);
      if (fixed.ok) {
        console.warn('[llm] callClaudeJSON: recovered via fallback repair call.');
        return fixed.value;
      }
    }
  } catch (e) {
    console.warn(`[llm] callClaudeJSON: repair call failed: ${e.message}`);
  }

  throw new Error(`callClaudeJSON: JSON.parse failed after local repair + fallback call (${direct.error}).\nCandidate starts:\n${candidate.slice(0, 1000)}`);
}

/** Slice a reply down to its outermost { … } object (ignores fences/prose).
 *  If there's an opening brace but no closing one (truncated output), keep
 *  everything from the first '{' so the repair path can close it. */
function sliceToObject(raw) {
  const text = String(raw).trim();
  const first = text.indexOf('{');
  if (first === -1) return null;
  const last = text.lastIndexOf('}');
  return last > first ? text.slice(first, last + 1) : text.slice(first);
}

function tryParse(s) {
  try { return { ok: true, value: JSON.parse(s) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/** Walk the string tracking JSON string-state + brace/bracket depth, then close
 *  anything still open (recovers truncated output). */
function balancedClose(s) {
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  while (stack.length) out += (stack.pop() === '{' ? '}' : ']');
  return out;
}

/** Best-effort local repair: control-char normalize, trailing commas, close-open. */
function repairJson(s) {
  // Raw control chars (incl. newlines/tabs) are illegal inside JSON strings and
  // harmless as whitespace elsewhere — normalize them all to a space.
  let t = String(s).replace(/[\u0000-\u001F]/g, ' ');
  t = t.replace(/,(\s*[}\]])/g, '$1');   // trailing commas
  t = balancedClose(t);                  // close truncated structures
  t = t.replace(/,(\s*[}\]])/g, '$1');   // and again after closing
  return t;
}

/** Exposed for logging / diagnostics. */
export function llmConfig() {
  return { region: REGION, model_id: MODEL_ID, endpoint: endpoint() };
}
