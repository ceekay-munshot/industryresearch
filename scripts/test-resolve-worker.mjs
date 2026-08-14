/**
 * scripts/test-resolve-worker.mjs — end-to-end test of /api/resolve and
 * /api/research through the real worker.fetch handler, WITHOUT wrangler or a
 * real key. Mocks env.ASSETS (index.json), global.fetch (Bedrock + GitHub API).
 *   node scripts/test-resolve-worker.mjs
 */
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

const INDEX = readFileSync(new URL('../public/data/industries/index.json', import.meta.url), 'utf8');

function makeEnv(overrides = {}) {
  return {
    BEDROCK_API_KEY: 'test-key',
    ASSETS: {
      fetch: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === '/data/industries/index.json') {
          return new Response(INDEX, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('not found', { status: 404 });
      },
    },
    ...overrides,
  };
}

// Mock Bedrock (classification) + GitHub dispatch. `classify` is what Claude
// "returns"; `ghStatus` is the GitHub dispatch HTTP status.
let bedrockCalls = 0, ghCalls = 0, lastGh = null;
function mockNet({ classify, ghStatus = 204 } = {}) {
  bedrockCalls = 0; ghCalls = 0; lastGh = null;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('bedrock-runtime')) {
      bedrockCalls++;
      if (classify == null) return new Response('nope', { status: 400 }); // simulate no/failed classify
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(classify) }] }), { status: 200 });
    }
    if (u.includes('api.github.com')) {
      ghCalls++; lastGh = { url: u, body: JSON.parse(opts.body) };
      // 204 is a null-body status — Response throws if given any body.
      return new Response(ghStatus === 204 ? null : 'err', { status: ghStatus });
    }
    throw new Error('unexpected fetch: ' + u);
  };
}

const post = (path, payload) => new Request('https://dash.example.com' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

async function main() {
  console.log('/api/resolve — existing industry:');
  mockNet({ classify: null });
  let r = await worker.fetch(post('/api/resolve', { query: 'MDF Boards Industry (India)' }), makeEnv());
  let b = await r.json();
  ok('matched=true with real slug', b.matched === true && b.slug === 'mdf-boards-india');
  ok('no Bedrock call needed for a known industry', bedrockCalls === 0);

  console.log('/api/resolve — company inference:');
  mockNet({ classify: { type: 'company', company: 'Greenlam Industries', industry_name: 'Laminates, India' } });
  r = await worker.fetch(post('/api/resolve', { query: 'Greenlam' }), makeEnv());
  b = await r.json();
  ok('type=company', b.type === 'company');
  ok('carries the company name', b.company === 'Greenlam Industries');
  ok('matched=false (new industry)', b.matched === false);
  ok('slug = slugify(industry_name)', b.slug === 'laminates-india' && b.industry_name === 'Laminates, India');
  ok('called Bedrock once', bedrockCalls === 1);

  console.log('/api/resolve — company whose industry already exists:');
  mockNet({ classify: { type: 'company', company: 'Greenpanel', industry_name: 'MDF Boards Industry (India)' } });
  r = await worker.fetch(post('/api/resolve', { query: 'Greenpanel' }), makeEnv());
  b = await r.json();
  ok('re-check maps company -> existing industry (matched=true)', b.matched === true && b.slug === 'mdf-boards-india');

  console.log('/api/resolve — never-fail (no key, unknown):');
  mockNet({ classify: null });
  r = await worker.fetch(post('/api/resolve', { query: 'Some Novel Industry' }), makeEnv({ BEDROCK_API_KEY: '' }));
  b = await r.json();
  ok('literal fallback: matched=false, slug from query', b.matched === false && b.slug === 'some-novel-industry');
  ok('did not attempt Bedrock without a key', bedrockCalls === 0);

  console.log('/api/resolve — method + empty:');
  r = await worker.fetch(new Request('https://dash.example.com/api/resolve', { method: 'GET' }), makeEnv());
  ok('GET is 405', r.status === 405);
  mockNet({ classify: null });
  r = await worker.fetch(post('/api/resolve', { query: '   ' }), makeEnv());
  b = await r.json();
  ok('empty query -> empty flag, no Bedrock', b.empty === true && bedrockCalls === 0);

  console.log('/api/research — not configured:');
  mockNet({});
  r = await worker.fetch(post('/api/research', { industry: 'Ceramic Tiles, India' }), makeEnv());
  b = await r.json();
  ok('configured=false, dispatched=false', b.configured === false && b.dispatched === false);
  ok('slug present + manual message', b.slug === 'ceramic-tiles-india' && /Actions/.test(b.message));
  ok('no GitHub call', ghCalls === 0);

  console.log('/api/research — configured + dispatch OK:');
  mockNet({ ghStatus: 204 });
  r = await worker.fetch(post('/api/research', { industry: 'Ceramic Tiles, India' }),
    makeEnv({ GITHUB_TOKEN: 'ghp_x', GITHUB_REPO: 'ceekay-munshot/industryresearch' }));
  b = await r.json();
  ok('dispatched=true', b.dispatched === true && b.configured === true);
  ok('hit the workflow dispatch endpoint', ghCalls === 1 && /research-industry\.yml\/dispatches/.test(lastGh.url));
  ok('passed industry input + ref', lastGh.body.inputs.industry === 'Ceramic Tiles, India' && lastGh.body.ref === 'main');

  console.log('/api/research — configured but GitHub errors (never crash):');
  mockNet({ ghStatus: 404 });
  r = await worker.fetch(post('/api/research', { industry: 'X, India' }),
    makeEnv({ GITHUB_TOKEN: 'ghp_x', GITHUB_REPO: 'owner/repo' }));
  b = await r.json();
  ok('200 with dispatched=false + manual steps', r.status === 200 && b.dispatched === false && /Actions/.test(b.message));

  console.log('/api/research — method + empty:');
  r = await worker.fetch(new Request('https://dash.example.com/api/research', { method: 'GET' }), makeEnv());
  ok('GET is 405', r.status === 405);
  mockNet({});
  r = await worker.fetch(post('/api/research', { industry: '' }), makeEnv({ GITHUB_TOKEN: 'x', GITHUB_REPO: 'o/r' }));
  b = await r.json();
  ok('empty industry -> friendly, no dispatch', b.dispatched === false && ghCalls === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
