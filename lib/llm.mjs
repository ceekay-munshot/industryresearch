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
  const doFetch = async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    const text = await res.text();
    return { res, text };
  };

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(1500);
    try {
      const { res, text } = await doFetch();
      if (res.ok) {
        return extractText(text, url);
      }
      // Retry only on 5xx; fail fast on 4xx (auth/model/region/validation).
      if (res.status >= 500 && attempt === 0) {
        lastErr = new Error(`Bedrock ${res.status} at ${url}\n${text}`);
        continue;
      }
      throw new Error(`Bedrock request failed: HTTP ${res.status} at ${url}\n${text}`);
    } catch (err) {
      // Network-level failure (no HTTP status) — retry once.
      if (attempt === 0 && !/^Bedrock request failed/.test(err.message)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('Bedrock request failed after retry.');
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
 * Strips ```json fences and any prose before the first `{` / after the last `}`.
 * Throws a clear error (with a snippet) if the result can't be parsed.
 */
export async function callClaudeJSON({ system, user, max_tokens = 8000, thinking }) {
  const raw = await callClaude({ system, user, max_tokens, thinking });
  const text = raw.trim();

  // Slice to the outermost object. This transparently ignores any surrounding
  // ```json fences or prose, and avoids the non-greedy-fence trap where a code
  // fence *inside* the JSON (e.g. in report_markdown) would truncate the match.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) {
    throw new Error(`callClaudeJSON: no JSON object found in reply.\n${raw.slice(0, 1000)}`);
  }
  const candidate = text.slice(first, last + 1);

  try {
    return JSON.parse(candidate);
  } catch (e) {
    throw new Error(`callClaudeJSON: JSON.parse failed (${e.message}).\nCandidate starts:\n${candidate.slice(0, 1000)}`);
  }
}

/** Exposed for logging / diagnostics. */
export function llmConfig() {
  return { region: REGION, model_id: MODEL_ID, endpoint: endpoint() };
}
