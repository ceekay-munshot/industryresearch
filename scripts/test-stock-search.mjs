/**
 * scripts/test-stock-search.mjs — /api/stock-search: the pure result normalizer
 * and the full handler (mocked env.MUNS_TOKEN + global.fetch to birdnest). Proves
 * the company autocomplete is source-shaped, tolerant of junk, and never-fail.
 *   node scripts/test-stock-search.mjs
 */
import worker from '../worker/index.js';
import { normalizeStockResults } from '../worker/index.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

console.log('normalizeStockResults — documented shape { TICKER: [country, name, sector] }:');
const sample = normalizeStockResults({ results: {
  ASIANPAINT: ['India', 'Asian Paints Ltd', 'Paints'],
  BERGEPAINT: ['India', 'Berger Paints India Ltd', 'Paints'],
} });
ok('maps every row', sample.length === 2);
ok('ticker/name/sector/country in order', sample[0].ticker === 'ASIANPAINT' && sample[0].name === 'Asian Paints Ltd'
  && sample[0].sector === 'Paints' && sample[0].country === 'India');
ok('preserves object order', sample[1].ticker === 'BERGEPAINT');

console.log('normalizeStockResults — tolerant of junk:');
ok('null/undefined -> []', normalizeStockResults(null).length === 0 && normalizeStockResults(undefined).length === 0);
ok('no results key -> []', normalizeStockResults({}).length === 0);
ok('results is array (wrong shape) -> []', normalizeStockResults({ results: [1, 2] }).length === 0);
const partial = normalizeStockResults({ results: { FOO: ['India'], BAR: ['India', 'Bar Ltd'], BAZ: 'nope' } });
ok('short arrays fill blanks, non-array row skipped', partial.length === 2
  && partial[0].ticker === 'FOO' && partial[0].name === '' && partial[0].sector === ''
  && partial[1].name === 'Bar Ltd');
const trimmed = normalizeStockResults({ results: { '  T  ': ['  India  ', '  Co  ', '  Sec  '] } });
ok('trims ticker + fields', trimmed[0].ticker === 'T' && trimmed[0].name === 'Co' && trimmed[0].country === 'India' && trimmed[0].sector === 'Sec');
const many = {}; for (let i = 0; i < 30; i++) many['T' + i] = ['India', 'Co ' + i, 'Sec'];
ok('caps the dropdown list at 12', normalizeStockResults({ results: many }).length === 12);
const numeric = normalizeStockResults({ results: { N: [0, 0, 0] } });
ok('numeric zeros coerced to strings (not dropped as blanks)', numeric.length === 1 && numeric[0].name === '0');

// ---- integration: handler ----
function makeEnv({ token = 'muns-secret' } = {}) {
  return { MUNS_TOKEN: token, ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
}
let lastReq = null;
function mockBirdnest({ status = 200, results = {}, throwErr = false } = {}) {
  lastReq = null;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('birdnest.muns.io/stock/search')) {
      lastReq = { url: u, headers: opts.headers, body: JSON.parse(opts.body) };
      if (throwErr) throw new Error('network down');
      return new Response(status === 200 ? JSON.stringify({ data: null, results }) : 'err', { status });
    }
    throw new Error('unexpected fetch: ' + u);
  };
}
const post = (payload) => new Request('https://dash.example.com/api/stock-search', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});
const call = async (env, payload) => (await worker.fetch(post(payload), env)).json();

async function main() {
  console.log('\nhandler — happy path:');
  mockBirdnest({ results: { ASIANPAINT: ['India', 'Asian Paints Ltd', 'Paints'] } });
  let b = await call(makeEnv(), { query: 'asian' });
  ok('returns normalized results', b.results.length === 1 && b.results[0].ticker === 'ASIANPAINT');
  ok('sends { query, user_index: 124 }', lastReq.body.query === 'asian' && lastReq.body.user_index === 124);
  ok('sends Bearer MUNS_TOKEN', lastReq.headers.Authorization === 'Bearer muns-secret');

  console.log('handler — guards + never-fail:');
  mockBirdnest({ results: {} });
  b = await call(makeEnv(), { query: 'a' });
  ok('query < 2 chars -> [] without calling Muns', b.results.length === 0 && lastReq === null);

  mockBirdnest({ results: { X: ['India', 'X Ltd', 'Sec'] } });
  b = await call(makeEnv({ token: '' }), { query: 'asian' });
  ok('no MUNS_TOKEN -> [] without calling Muns', b.results.length === 0 && lastReq === null);

  mockBirdnest({ status: 500 });
  b = await call(makeEnv(), { query: 'asian' });
  ok('Muns HTTP 500 -> [] (never 500 ourselves)', Array.isArray(b.results) && b.results.length === 0);

  mockBirdnest({ throwErr: true });
  b = await call(makeEnv(), { query: 'asian' });
  ok('network error -> []', Array.isArray(b.results) && b.results.length === 0);

  const r405 = await worker.fetch(new Request('https://dash.example.com/api/stock-search', { method: 'GET' }), makeEnv());
  ok('GET -> 405', r405.status === 405);

  const empty = await call(makeEnv(), {});
  ok('missing query -> [] (no crash)', Array.isArray(empty.results) && empty.results.length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
