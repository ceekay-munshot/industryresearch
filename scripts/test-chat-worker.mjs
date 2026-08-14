/**
 * scripts/test-chat-worker.mjs — end-to-end test of the Worker's /api/chat
 * request path WITHOUT wrangler or a real Bedrock key. We mock:
 *   - env.ASSETS.fetch  -> serves the committed industry JSON
 *   - global.fetch      -> intercepts the Bedrock endpoint, returns a canned reply
 * and drive the real `worker.fetch(request, env)` handler.
 *
 * Proves: routing (405 on GET), grounded answers, the never-invent source
 * filter across the full path, out-of-scope handling, and never-fail (missing
 * key / unknown slug / bad method never 500).
 *   node scripts/test-chat-worker.mjs
 */
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

const MDF = readFileSync(new URL('../public/data/industries/mdf-boards-india.json', import.meta.url), 'utf8');
const DATA = JSON.parse(MDF);
const REAL_URL = DATA.size.source.url;

// A mock ASSETS binding: return the MDF json for its path, 404 otherwise.
function makeEnv(overrides = {}) {
  return {
    BEDROCK_API_KEY: 'test-key',
    ASSETS: {
      fetch: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === '/data/industries/mdf-boards-india.json') {
          return new Response(MDF, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('not found', { status: 404 });
      },
    },
    ...overrides,
  };
}

// Install a Bedrock mock. `reply` is the assistant text (what Claude "says").
let bedrockCalls = 0;
function mockBedrock(reply) {
  bedrockCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('bedrock-runtime')) {
      bedrockCalls++;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: reply }] }), { status: 200 });
    }
    throw new Error('unexpected fetch in test: ' + u);
  };
}

const post = (payload) => new Request('https://dash.example.com/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

async function main() {
  // 1) Grounded answer citing a real source AND a fabricated one.
  mockBedrock(JSON.stringify({
    answer: 'India’s MDF market was about USD 1.28 billion in 2024.',
    sources: [{ label: 'IMARC', url: REAL_URL }, { label: 'Made up', url: 'https://fabricated.example.com/x' }],
    in_data: true,
  }));
  let res = await worker.fetch(post({ slug: 'mdf-boards-india', question: 'How big is the market?' }), makeEnv());
  let body = await res.json();
  console.log('grounded answer + never-invent filter:');
  ok('responds 200', res.status === 200);
  ok('called bedrock once', bedrockCalls === 1);
  ok('answer text present', /1\.28 billion/.test(body.answer));
  ok('keeps the real cited source', body.sources.some((s) => s.url === REAL_URL));
  ok('drops the fabricated source', !body.sources.some((s) => /fabricated/.test(s.url)));

  // 2) Out-of-scope question — model admits the gap, no sources.
  mockBedrock(JSON.stringify({ answer: "The dashboard data doesn't cover CEO compensation.", sources: [], in_data: false }));
  res = await worker.fetch(post({ slug: 'mdf-boards-india', question: 'What is the CEO paid?' }), makeEnv());
  body = await res.json();
  console.log('out-of-scope:');
  ok('200 with honest answer', res.status === 200 && /doesn.t cover/.test(body.answer));
  ok('no invented sources', Array.isArray(body.sources) && body.sources.length === 0);

  // 3) Never-fail: no BEDROCK_API_KEY -> friendly answer, not a 500.
  mockBedrock('irrelevant');
  res = await worker.fetch(post({ slug: 'mdf-boards-india', question: 'How big is it?' }), makeEnv({ BEDROCK_API_KEY: '' }));
  body = await res.json();
  console.log('never-fail (missing key):');
  ok('still 200', res.status === 200);
  ok('friendly answer', /couldn.t answer/.test(body.answer));

  // 4) Unknown industry slug -> friendly "no data", no bedrock call.
  mockBedrock('irrelevant');
  res = await worker.fetch(post({ slug: 'no-such-industry', question: 'hi' }), makeEnv());
  body = await res.json();
  console.log('unknown slug:');
  ok('200 friendly', res.status === 200 && /don.t have any gathered data/.test(body.answer));
  ok('did not call bedrock', bedrockCalls === 0);

  // 5) Path-traversal slug -> rejected before any asset/bedrock work.
  mockBedrock('irrelevant');
  res = await worker.fetch(post({ slug: '../../secret', question: 'hi' }), makeEnv());
  body = await res.json();
  console.log('path-traversal slug:');
  ok('200 friendly, no bedrock', res.status === 200 && bedrockCalls === 0);

  // 6) Wrong method -> 405.
  res = await worker.fetch(new Request('https://dash.example.com/api/chat', { method: 'GET' }), makeEnv());
  console.log('method guard:');
  ok('GET is 405', res.status === 405);

  // 7) Empty question -> gentle prompt, no bedrock.
  mockBedrock('irrelevant');
  res = await worker.fetch(post({ slug: 'mdf-boards-india', question: '   ' }), makeEnv());
  body = await res.json();
  console.log('empty question:');
  ok('200 prompt, no bedrock', res.status === 200 && bedrockCalls === 0 && /Ask me a question/.test(body.answer));

  // 8) Model returns prose (not JSON) -> still answered (never-fail parse).
  mockBedrock(`The market is growing fast. See ${REAL_URL}`);
  res = await worker.fetch(post({ slug: 'mdf-boards-india', question: 'growth?' }), makeEnv());
  body = await res.json();
  console.log('non-JSON model reply:');
  ok('answer falls back to prose', /growing fast/.test(body.answer));
  ok('recovers the mentioned known source', body.sources.some((s) => s.url === REAL_URL));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
