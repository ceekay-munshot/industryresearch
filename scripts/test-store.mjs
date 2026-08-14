/**
 * scripts/test-store.mjs — guarantees for the additive fact store.
 *
 * Proves the two properties the whole design rests on:
 *   IDEMPOTENT — re-running with the same input changes nothing.
 *   MONOTONIC  — a weaker run can never lower a section's confidence or blank a
 *                filled section; support only ever holds or rises.
 *
 * No framework, no npm deps. Exits non-zero on any failure:  node scripts/test-store.mjs
 */
import {
  factId, sourceQuality, noisyOr, upsertFacts, supportByCategory,
  mergeAssembly, mergeCoverage, sectionStrength, decayAndSupersede, factsFromAssembled,
} from '../lib/store.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b));
const F = (o) => ({ category: 'players', text: 'Acme is the largest maker', source_url: 'https://a.com/x', snippet: 'Acme largest', ...o });

console.log('identity + confidence');
ok('factId is source-distinct', factId('size', 'X', 'https://a.com') !== factId('size', 'X', 'https://b.com'));
ok('quality tiers ordered (gov > research > press > blog)',
  sourceQuality('https://ibef.org/x') > sourceQuality('https://mordorintelligence.com/x') &&
  sourceQuality('https://mordorintelligence.com/x') > sourceQuality('https://economictimes.indiatimes.com/x') &&
  sourceQuality('https://economictimes.indiatimes.com/x') > sourceQuality('https://someblog.com/x'));
eq('noisyOr(0.6,0.6)=0.84', noisyOr([0.6, 0.6]), 0.84);
ok('noisyOr rises with an extra distinct source', noisyOr([0.6, 0.6, 0.6]) > noisyOr([0.6, 0.6]));

console.log('IDEMPOTENT upsert');
const run1 = { runId: 'r1', now: '2026-01-01' };
const L = upsertFacts([], [F({}), F({ source_url: 'https://b.com/y' })], run1);
const Lagain = upsertFacts(L, [F({}), F({ source_url: 'https://b.com/y' })], run1); // same run, same facts
eq('re-upsert (same run) leaves seen_count unchanged', Lagain.map((f) => f.seen_count).sort(), L.map((f) => f.seen_count).sort());
ok('re-upsert does not duplicate', Lagain.length === 2);
ok('re-upsert leaves last_seen unchanged', Lagain.every((f) => f.last_seen === '2026-01-01'));

console.log('MONOTONIC support');
const sup0 = supportByCategory(L);
ok('support = distinct source domains', sup0.players.sources === 2);
const Ldup = upsertFacts(L, [F({ text: 'Acme leads again', source_url: 'https://a.com/z' })], { runId: 'r2', now: '2026-02-01' });
ok('same-domain fact does not raise source count', supportByCategory(Ldup).players.sources === 2);
const Lnew = upsertFacts(L, [F({ text: 'Beta is second', source_url: 'https://c.com/z' })], { runId: 'r3', now: '2026-02-01' });
ok('new domain raises source count', supportByCategory(Lnew).players.sources === 3);
ok('confidence never falls when a source is added', supportByCategory(Lnew).players.confidence >= sup0.players.confidence);

console.log('MONOTONIC write-if-better assembly (never blank a filled section)');
const rich = { players: [1, 2, 3, 4, 5], size: { current: { value: 2 }, cagr_pct: 8 }, summary: { headline: 'h', key_takeaways: [1, 2] } };
eq('idempotent: merge(x,x) = x', mergeAssembly(rich, rich).obj.players, rich.players);
eq('weak candidate keeps rich incumbent players', mergeAssembly({ players: [1] }, rich).obj.players, rich.players);
eq('weak candidate keeps rich incumbent size', mergeAssembly({ size: {} }, rich).obj.size, rich.size);
ok('empty candidate never blanks a filled section', mergeAssembly({ players: [] }, rich).obj.players.length === 5);
ok('stronger candidate improves', mergeAssembly({ players: [1, 2, 3, 4, 5, 6, 7] }, rich).obj.players.length === 7);
ok('sectionStrength: array length', sectionStrength('players', [1, 2, 3]) === 3);
ok('sectionStrength: empty = 0', sectionStrength('players', []) === 0);

console.log('MONOTONIC coverage + non-destructive decay');
const cov1 = mergeCoverage({}, { players: { sources: 7, confidence: 0.99 } }, { players: '2026-01-01' });
const cov2 = mergeCoverage(cov1, { players: { sources: 3, confidence: 0.5 } }, {}); // weaker run
ok('coverage sources never decrease', cov2.sections.players.sources === 7);
ok('coverage confidence never decreases', cov2.sections.players.confidence === 0.99);
const withDup = upsertFacts([], [F({ source_url: 'https://weak.blog/x' })], { runId: 'a', now: '2020-01-01' });
ok('decay soft-deletes only (never removes records)', decayAndSupersede(withDup, { now: '2026-08-01' }).length === withDup.length);

console.log('migration seed');
const seeded = factsFromAssembled({ size: { current: { value: 1.4, year: 2025 }, source: { url: 'https://imarc.com', snippet: 'q' } }, players: [{ name: 'Greenpanel', note: 'largest', source: { url: 'https://x.com', snippet: 's' } }] });
ok('factsFromAssembled reconstructs facts with sources', seeded.length >= 2 && seeded.every((f) => f.source_url));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
