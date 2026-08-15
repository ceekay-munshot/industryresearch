/**
 * scripts/test-edit-worker.mjs — /api/edit through the real worker.fetch handler,
 * with a mocked GitHub contents API. Proves: edits validate, the override is
 * appended to overrides.jsonl (created if absent), the deployed dashboard JSON is
 * patched with the SAME applyOne the pipeline uses, and every failure path is
 * friendly (never a 500, always manual steps).
 *   node scripts/test-edit-worker.mjs
 */
import worker from '../worker/index.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(String(s), 'base64').toString('utf8');

/** Mock env + GitHub contents API. `files` maps repo path -> { content, sha }.
 *  `putStatus` lets a test force a PUT failure for a given path substring. */
function editEnv({ token = 'ghp', repo = 'o/r', files = {}, putFail = null } = {}) {
  const puts = [];
  const env = {
    GITHUB_TOKEN: token, GITHUB_REPO: repo,
    ASSETS: { fetch: async () => new Response('nf', { status: 404 }) },
    _puts: () => puts, _files: files,
  };
  global.fetch = async (url, opts) => {
    const u = String(url);
    const m = u.match(/\/contents\/(.+)$/);
    const path = m ? decodeURIComponent(m[1]) : '';
    const method = (opts && opts.method) || 'GET';
    if (!u.includes('api.github.com')) throw new Error('unexpected fetch: ' + u);
    if (method === 'GET') {
      const f = files[path];
      if (!f) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify({ content: b64(f.content), sha: f.sha }), { status: 200 });
    }
    if (method === 'PUT') {
      const body = JSON.parse(opts.body);
      const content = unb64(body.content);
      puts.push({ path, content, sha: body.sha, message: body.message });
      if (putFail && path.includes(putFail)) return new Response('boom', { status: 500 });
      files[path] = { content, sha: 'sha-' + puts.length };  // subsequent GET sees the write
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error('unexpected method ' + method);
  };
  return env;
}

const post = (payload) => new Request('https://d.example.com/api/edit', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});
const call = async (env, payload) => (await worker.fetch(post(payload), env)).json();

async function main() {
  console.log('/api/edit — happy path (append override + patch dashboard):');
  const dash = { meta: { slug: 'widgets' }, players: [{ name: 'A', revenue: 100 }] };
  let env = editEnv({ files: { 'public/data/industries/widgets.json': { content: JSON.stringify(dash), sha: 'd1' } } });
  let b = await call(env, { slug: 'widgets', edit: { section: 'players', target: 'A', field: 'revenue', value: '250' } });
  ok('saved:true, patched:true', b.saved === true && b.patched === true && b.configured === true);
  const puts = env._puts();
  const oPut = puts.find((p) => p.path === 'data/store/widgets/overrides.jsonl');
  const dPut = puts.find((p) => p.path === 'public/data/industries/widgets.json');
  ok('overrides.jsonl created + appended', !!oPut && /"section":"players"/.test(oPut.content) && oPut.content.endsWith('\n'));
  ok('override record carries added_by + added_at', /"added_by":"analyst"/.test(oPut.content) && /"added_at":/.test(oPut.content));
  ok('dashboard patched with applyOne (revenue=250, analyst badge)', (() => {
    const d = JSON.parse(dPut.content); return d.players[0].revenue === 250 && d.players[0].analyst === true;
  })());

  console.log('/api/edit — numeric coercion + scalar section:');
  env = editEnv({ files: { 'public/data/industries/widgets.json': { content: JSON.stringify({ size: { current: { value: 1 } } }), sha: 'd1' } } });
  b = await call(env, { slug: 'widgets', edit: { section: 'size', field: 'value', value: '12,500' } });
  const dPut2 = env._puts().find((p) => p.path.includes('industries'));
  ok('scalar size.value patched to a Number', JSON.parse(dPut2.content).size.current.value === 12500);

  console.log('/api/edit — batch (a row correction touching several fields):');
  env = editEnv({ files: { 'public/data/industries/widgets.json': { content: JSON.stringify({ benchmarking: { peers: [{ name: 'Z', pending: true, listed: false }] } }), sha: 'd1' } } });
  b = await call(env, { slug: 'widgets', edits: [
    { section: 'benchmarking', target: 'Z', field: 'revenue', value: '900' },
    { section: 'benchmarking', target: 'Z', field: 'ebitda_pct', value: '13.5' },
  ] });
  ok('batch saved, count=2', b.saved === true && b.count === 2);
  const oPutB = env._puts().find((p) => p.path.includes('overrides.jsonl'));
  ok('both records appended in ONE write', (oPutB.content.match(/"section":"benchmarking"/g) || []).length === 2);
  const dPutB = env._puts().find((p) => p.path.includes('industries'));
  ok('dashboard patched with both fields; pending cleared', (() => {
    const z = JSON.parse(dPutB.content).benchmarking.peers[0]; return z.revenue === 900 && z.ebitda_pct === 13.5 && z.pending === false;
  })());

  console.log('/api/edit — validation + never-fail:');
  env = editEnv({});
  b = await call(env, { slug: 'widgets', edit: { section: 'nope', field: 'x', value: '1' } });
  ok('invalid edit -> saved:false, no GitHub writes', b.saved === false && env._puts().length === 0);

  b = await call(editEnv({ token: '' }), { slug: 'widgets', edit: { section: 'size', field: 'value', value: '5' } });
  ok('no token -> configured:false + manual steps w/ the JSONL line', b.configured === false && b.saved === false && /overrides\.jsonl/.test(b.message));

  env = editEnv({ putFail: 'overrides.jsonl' });
  b = await call(env, { slug: 'widgets', edit: { section: 'size', field: 'value', value: '5' } });
  ok('append PUT fails -> saved:false + manual steps', b.saved === false && /overrides\.jsonl/.test(b.message));

  // Append succeeds but the dashboard file is missing -> saved:true, patched:false.
  env = editEnv({});   // no dashboard file present
  b = await call(env, { slug: 'widgets', edit: { section: 'size', field: 'value', value: '5' } });
  ok('override saved even if dashboard patch cannot apply', b.saved === true && b.patched === false);

  b = await call(editEnv({}), { slug: '../../etc', edit: { section: 'size', field: 'value', value: '5' } });
  ok('bad slug -> saved:false, friendly', b.saved === false);

  const r405 = await worker.fetch(new Request('https://d.example.com/api/edit', { method: 'GET' }), editEnv({}));
  ok('GET -> 405', r405.status === 405);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
