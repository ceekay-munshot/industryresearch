/**
 * scripts/test-status-worker.mjs — /api/research-status: the pure run-state
 * mapping and the full handler (mocked ASSETS + GitHub runs API). Proves the
 * progress signal is honest and never leaks internals.
 *   node scripts/test-status-worker.mjs
 */
import worker from '../worker/index.js';
import { mapRunState } from '../worker/index.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

const T = '2026-08-14T10:00:00Z';
const run = (status, conclusion, created = T) => ({ status, conclusion, created_at: created });

console.log('mapRunState — pure mapping:');
ok('no runs -> starting', mapRunState([], 0) === 'starting');
ok('queued -> starting', mapRunState([run('queued', null)], 0) === 'starting');
ok('in_progress -> running', mapRunState([run('in_progress', null)], 0) === 'running');
ok('completed+success -> done', mapRunState([run('completed', 'success')], 0) === 'done');
ok('completed+failure -> failed', mapRunState([run('completed', 'failure')], 0) === 'failed');
ok('completed+cancelled -> failed', mapRunState([run('completed', 'cancelled')], 0) === 'failed');
ok('cutoff hides an older run (older than cutoff -> starting)',
  mapRunState([run('completed', 'failure', '2020-01-01T00:00:00Z')], Date.parse('2026-01-01T00:00:00Z')) === 'starting');
ok('cutoff keeps a fresh run', mapRunState([run('in_progress', null, '2026-08-14T09:59:00Z')], Date.parse('2026-08-14T09:00:00Z')) === 'running');

// ---- integration ----
function makeEnv({ file = null, runs = [], token = 'ghp', repo = 'o/r' } = {}) {
  let ghCalls = 0;
  const env = {
    GITHUB_TOKEN: token, GITHUB_REPO: repo,
    ASSETS: { fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === '/data/industries/widgets.json' && file != null) {
        return new Response(file, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('nf', { status: 404 });
    } },
    _ghCalls: () => ghCalls,
  };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.github.com')) { ghCalls++; return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 }); }
    throw new Error('unexpected fetch: ' + u);
  };
  return env;
}
const get = (qs) => new Request('https://d.example.com/api/research-status?' + qs, { method: 'GET' });
const state = async (env, qs) => (await (await worker.fetch(get(qs), env)).json()).state;

console.log('\nhandler — new industry:');
ok('file exists -> done', await state(makeEnv({ file: '{"meta":{}}' }), 'slug=widgets') === 'done');
ok('file missing + in_progress -> running', await state(makeEnv({ runs: [run('in_progress', null)] }), 'slug=widgets') === 'running');
ok('file missing + no runs yet -> starting', await state(makeEnv({ runs: [] }), 'slug=widgets') === 'starting');

console.log('handler — refresh (baseline passed):');
const base = JSON.stringify({ meta: { updated_at: '2026-08-13' }, x: 1 });
ok('body length changed -> done', await state(makeEnv({ file: base + '   extra' }), 'slug=widgets&sig=' + base.length) === 'done');
ok('unchanged body + run success -> done (run finished)',
  await state(makeEnv({ file: base, runs: [run('completed', 'success')] }), 'slug=widgets&sig=' + base.length) === 'done');
ok('unchanged body + run in_progress -> running',
  await state(makeEnv({ file: base, runs: [run('in_progress', null)] }), 'slug=widgets&sig=' + base.length) === 'running');
ok('unchanged body + run failed -> failed',
  await state(makeEnv({ file: base, runs: [run('completed', 'failure')] }), 'slug=widgets&sig=' + base.length) === 'failed');

console.log('handler — never-fail + safety:');
ok('no token -> running (cannot tell)', await state(makeEnv({ file: null, runs: [], token: '' }), 'slug=widgets&sig=50') === 'running');
ok('bad slug -> running', await state(makeEnv({}), 'slug=../../etc') === 'running');
const res405 = await worker.fetch(new Request('https://d.example.com/api/research-status?slug=widgets', { method: 'POST' }), makeEnv({}));
ok('POST -> 405', res405.status === 405);
const body = await (await worker.fetch(get('slug=widgets'), makeEnv({ file: '{}' }))).json();
ok('response exposes ONLY { state } (no internals)', Object.keys(body).length === 1 && 'state' in body);

// ---- /api/research-cancel ----
function cancelEnv({ runs = [], cancelStatus = 202, token = 'ghp', repo = 'o/r' } = {}) {
  let cancelCalls = 0, lastCancelId = null;
  const env = { GITHUB_TOKEN: token, GITHUB_REPO: repo, ASSETS: { fetch: async () => new Response('nf', { status: 404 }) },
    _cancelCalls: () => cancelCalls, _lastCancelId: () => lastCancelId };
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/actions/workflows/research-industry.yml/runs')) return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 });
    const m = u.match(/\/actions\/runs\/(\d+)\/cancel/);
    if (m && (opts && opts.method) === 'POST') { cancelCalls++; lastCancelId = m[1]; return new Response(cancelStatus === 202 ? null : 'err', { status: cancelStatus }); }
    throw new Error('unexpected fetch: ' + u);
  };
  return env;
}
const postCancel = (env) => worker.fetch(new Request('https://d.example.com/api/research-cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env);

console.log('\n/api/research-cancel:');
let e = cancelEnv({ runs: [{ id: 555, status: 'in_progress' }] });
let cb = await (await postCancel(e)).json();
ok('cancels the active run', cb.cancelled === true && e._cancelCalls() === 1 && e._lastCancelId() === '555');

e = cancelEnv({ runs: [{ id: 9, status: 'completed', conclusion: 'success' }] });
cb = await (await postCancel(e)).json();
ok('no active run -> cancelled:false, no cancel call', cb.cancelled === false && e._cancelCalls() === 0);

e = cancelEnv({ runs: [{ id: 7, status: 'in_progress' }], cancelStatus: 409 });
cb = await (await postCancel(e)).json();
ok('GitHub cancel fails -> cancelled:false + message', cb.cancelled === false && /Actions/.test(cb.message || ''));

cb = await (await postCancel(cancelEnv({ token: '' }))).json();
ok('no token -> configured:false, friendly', cb.cancelled === false && cb.configured === false && /Actions/.test(cb.message || ''));

const c405 = await worker.fetch(new Request('https://d.example.com/api/research-cancel', { method: 'GET' }), cancelEnv({}));
ok('GET -> 405', c405.status === 405);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
