/**
 * scripts/test-benchmark.mjs — pure benchmarking helpers: grounded-financials
 * normalization (omit-unknown, never-invent), India-listed ticker matching with a
 * name guard, DRHP prospectus extraction, per-peer write-if-better merge (never
 * regress a filled peer / never clobber analyst), and median.
 *   node scripts/test-benchmark.mjs
 */
import {
  normalizeFinancials, hasFinancials, normName, nameMatchScore, pickListedMatch,
  drhpDocFrom, drhpExists, peerStrength, mergeBenchmarking, median,
} from '../lib/benchmark.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

console.log('normalizeFinancials — omit unknown, never invent, coerce:');
let m = normalizeFinancials({ revenue: '1,234.5', revenue_unit: 'Rs Cr', revenue_year: '2025', ebitda_pct: '18.4%', roce_pct: 21, roe_pct: 17.2 });
ok('parses revenue with commas', m.revenue === 1234.5 && m.revenue_unit === 'Rs Cr' && m.revenue_year === 2025);
ok('strips % and keeps number', m.ebitda_pct === 18.4 && m.roce_pct === 21 && m.roe_pct === 17.2);
ok('omits fields not provided', !('pat_pct' in m) && !('revenue_cagr_3y_pct' in m));
m = normalizeFinancials({ revenue: 'n/a', ebitda_pct: 'NA', pat_pct: '', roce_pct: null });
ok('junk/blank values dropped entirely -> {}', Object.keys(m).length === 0);
m = normalizeFinancials({ revenue_unit: '₹ crore', revenue_year: 2024 });
ok('unit/year without a revenue number are dropped', Object.keys(m).length === 0);
m = normalizeFinancials({ pat_pct: -3.5, ebitda_pct: 0 });
ok('negative + zero margins are kept (losses are real)', m.pat_pct === -3.5 && m.ebitda_pct === 0);
m = normalizeFinancials({ revenue: 9.9e15 });
ok('absurd magnitude dropped (mis-parse guard)', !('revenue' in m));
ok('null/garbage input -> {}', Object.keys(normalizeFinancials(null)).length === 0 && Object.keys(normalizeFinancials('x')).length === 0);

console.log('hasFinancials:');
ok('true when any metric present', hasFinancials({ ebitda_pct: 12 }) === true);
ok('false for a pending row', hasFinancials({ name: 'X', pending: true }) === false);

console.log('normName + nameMatchScore:');
ok('drops corp suffixes', normName('Asian Paints Ltd') === 'asian paints' && normName('Greenpanel Industries Limited') === 'greenpanel');
ok('exact normalized name -> 1', nameMatchScore('Asian Paints Ltd', 'ASIAN PAINTS LIMITED') === 1);
ok('partial overlap scored', nameMatchScore('Berger Paints India', 'Berger Paints') === 1 && nameMatchScore('Action Tesa', 'Action Construction Equipment') <= 0.5);

console.log('pickListedMatch — India + name guard:');
const results = [
  { ticker: 'ASIANPAINT', name: 'Asian Paints Ltd', sector: 'Paints', country: 'India' },
  { ticker: 'APLL', name: 'Asian Paints Lanka', sector: 'Paints', country: 'Sri Lanka' },
];
ok('prefers the India row on a good name match', (pickListedMatch(results, 'Asian Paints') || {}).ticker === 'ASIANPAINT');
ok('returns null when the only matches are a different company', pickListedMatch(
  [{ ticker: 'ACE', name: 'Action Construction Equipment', country: 'India' }], 'Action Tesa') === null);
ok('empty list -> null', pickListedMatch([], 'Anything') === null);

console.log('drhpDocFrom / drhpExists — tolerant of shapes:');
ok('finds a nested pdf link', (drhpDocFrom({ data: { filing: { pdf_url: 'https://x.com/drhp.pdf' } } }) || {}).url === 'https://x.com/drhp.pdf');
ok('finds a link inside a results array', (drhpDocFrom({ results: [{ url: 'https://y.com/a.pdf', title: 'ABC DRHP' }] }) || {}).title === 'ABC DRHP');
ok('exists via non-empty results even without a link', drhpExists({ results: [{ company: 'Foo' }] }) === true);
ok('no filing -> not exists', drhpExists({ results: [] }) === false && drhpExists(null) === false);

console.log('peerStrength + mergeBenchmarking — write-if-better, never clobber analyst:');
const filled = { name: 'Greenpanel', ticker: 'GREENPANEL', revenue: 1600, ebitda_pct: 14, roce_pct: 18, source: { url: 'https://screener.in/x' } };
const pend = { name: 'Greenpanel', pending: true, pending_reason: 'Private Circle' };
ok('filled peer is stronger than pending', peerStrength(filled) > peerStrength(pend));
ok('analyst peer is unbeatable', peerStrength({ name: 'X', added_by: 'analyst' }) === Infinity);

// A failed run yields a pending candidate; the incumbent has real financials → keep incumbent.
let merged = mergeBenchmarking([pend], [filled]);
ok('never regress a filled peer to pending', merged.length === 1 && merged[0].revenue === 1600);
// A good run fills a previously-pending incumbent.
merged = mergeBenchmarking([filled], [pend]);
ok('fills a pending incumbent with fresh financials', merged[0].revenue === 1600 && !merged[0].pending);
// Analyst incumbent is never overwritten by an auto candidate.
merged = mergeBenchmarking([filled], [{ name: 'Greenpanel', added_by: 'analyst', revenue: 999 }]);
ok('analyst incumbent survives an auto candidate', merged[0].added_by === 'analyst' && merged[0].revenue === 999);
// Candidate order is followed; an analyst-only incumbent (player dropped) is preserved.
merged = mergeBenchmarking([{ name: 'A' }], [{ name: 'Z', added_by: 'analyst' }]);
ok('analyst-only incumbent preserved even if player set dropped it', merged.some((p) => p.name === 'Z'));

console.log('median:');
ok('odd length', median([3, 1, 2]) === 2);
ok('even length averages middles', median([1, 2, 3, 4]) === 2.5);
ok('ignores non-finite; empty -> null', median([5, NaN, 'x', 15]) === 10 && median([]) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
