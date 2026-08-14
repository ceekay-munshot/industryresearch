/**
 * scripts/test-report.mjs — guarantees for the consolidated report.
 * No deps. Exits non-zero on failure:  node scripts/test-report.mjs
 */
import { reportInputHash, normalizeReport, deterministicReport, collectSources } from '../lib/report.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

const A = {
  meta: { name: 'X Industry', definition: 'stuff', is_manufacturing: true, generated_at: '2026-08-14' },
  summary: { headline: 'X is growing', key_takeaways: ['point one', 'point two'] },
  size: { current: { value: 1.4, unit: 'USD billion', year: 2024 }, cagr_pct: 8, history: [{ year: 2022, value: 1 }, { year: 2024, value: 1.4 }], source: { label: 'IMARC', url: 'https://a.com/x' } },
  segments: [{ name: 'Seg1', share_pct: 60, note: 'big', source: { url: 'https://a.com/x', label: 'IMARC' } }],
  players: [{ name: 'Acme Ltd', listed: true, note: 'leader', source: { url: 'https://b.com/y', label: 'BS' } }],
  margins: { manufacturer_pct: 30, retailer_pct: 20, source: { url: 'https://a.com/x', label: 'IMARC' } },
};

console.log('hash — cache correctness:');
ok('stable for identical data', reportInputHash(A) === reportInputHash(JSON.parse(JSON.stringify(A))));
ok('order-independent', reportInputHash(A) === reportInputHash({ players: A.players, margins: A.margins, size: A.size, segments: A.segments, summary: A.summary, meta: A.meta }));
ok('changes when a figure changes', reportInputHash(A) !== reportInputHash({ ...A, size: { ...A.size, current: { ...A.size.current, value: 2.0 } } }));
ok('ignores news / coverage / updated_at (news refresh must not regen)',
  reportInputHash(A) === reportInputHash({ ...A, sources: { news: [{ title: 'n' }] }, meta: { ...A.meta, updated_at: '2026-09-01', coverage: { sections: {} } } }));

console.log('normalize — never-invent + shape:');
const n = normalizeReport({ sections: [{ heading: 'H', prose: ['p1', 'p2'], key_numbers: [{ label: 'L', value: 'USD 1.4B' }], source_refs: [{ label: 'Real', url: 'https://a.com/x' }, { label: 'Fake', url: 'https://evil.com/z' }] }] }, A);
ok('keeps only sources present in the data', n.length === 1 && n[0].source_refs.length === 1 && n[0].source_refs[0].url === 'https://a.com/x');
ok('prose kept as array', Array.isArray(n[0].prose) && n[0].prose.length === 2);
ok('key_numbers kept', n[0].key_numbers[0].value === 'USD 1.4B');
ok('string prose is split into paragraphs', normalizeReport({ sections: [{ heading: 'H', prose: 'a\n\nb' }] }, A)[0].prose.length === 2);
ok('section with no prose is dropped', normalizeReport({ sections: [{ heading: 'H', prose: [] }] }, A).length === 0);

console.log('deterministic fallback — grounded + always present:');
const det = deterministicReport(A);
ok('kind=fallback, carries matching hash', det.kind === 'fallback' && det.hash === reportInputHash(A));
ok('produces sections', det.sections.length >= 4);
const known = new Set(collectSources(A).map((s) => s.url));
ok('never cites a source absent from the data', det.sections.every((s) => (s.source_refs || []).every((r) => known.has(r.url))));
ok('has an Executive summary + Sources', det.sections.some((s) => /executive/i.test(s.heading)) && det.sections.some((s) => /sources/i.test(s.heading)));
ok('empty object still yields a (possibly tiny) report object', typeof deterministicReport({}).sections === 'object');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
