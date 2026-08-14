/**
 * scripts/test-resolve.mjs — guarantees for the Smart Input resolver's pure
 * logic (no env, no network): slug parity, index matching (exact + fuzzy,
 * real-over-mock), and the manual-steps message.
 * No deps. Exits non-zero on failure:  node scripts/test-resolve.mjs
 */
import { readFileSync } from 'node:fs';
import { slugify, normalizeText, matchIndustry, manualSteps } from '../worker/index.js';
import { slugify as pipelineSlugify } from './research-industry.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

const index = JSON.parse(readFileSync(new URL('../public/data/industries/index.json', import.meta.url), 'utf8'));

console.log('slugify — matches the pipeline + is stable:');
for (const s of ['MDF boards, India', 'Two-wheeler tyres — India', '  Café  Chains  ', 'Solar rooftop EPC']) {
  ok(`parity: ${JSON.stringify(s)}`, slugify(s) === pipelineSlugify(s));
}
ok('empty -> "industry"', slugify('') === 'industry' && slugify('!!!') === 'industry');

console.log('normalizeText:');
ok('lowercases + strips punctuation', normalizeText('MDF Boards, Industry (India)!') === 'mdf boards industry india');

console.log('matchIndustry — existing industries resolve:');
ok('exact name', (matchIndustry(index, 'MDF Boards Industry (India)') || {}).slug === 'mdf-boards-india');
ok('exact slug', (matchIndustry(index, 'mdf-boards-india') || {}).slug === 'mdf-boards-india');
ok('alias match', (matchIndustry(index, 'MDF panel industry India') || {}).slug === 'mdf-boards-india');
ok('alias normalized (fiberboard spelling)', (matchIndustry(index, 'medium density fiberboard india') || {}).slug === 'mdf-boards-india');
ok('bare "mdf" prefers REAL over mock scaffold', (matchIndustry(index, 'mdf') || {}).slug === 'mdf-boards-india');
ok('unknown industry -> null', matchIndustry(index, 'quantum widgets') === null);
ok('empty query -> null', matchIndustry(index, '   ') === null);

console.log('matchIndustry — real-over-mock two-pass:');
const idx2 = { industries: [
  { slug: 'x', name: 'X', mock: true, aliases: ['widgets'] },
  { slug: 'x-india', name: 'X India', mock: false, aliases: ['widgets india'] },
] };
ok('fuzzy "widgets" picks the non-mock entry', (matchIndustry(idx2, 'widgets') || {}).slug === 'x-india');
const idxOnlyMock = { industries: [{ slug: 'm', name: 'M only', mock: true }] };
ok('mock is used only when it is the sole match', (matchIndustry(idxOnlyMock, 'M only') || {}).slug === 'm');

console.log('manualSteps:');
const ms = manualSteps('Ceramic Tiles, India');
ok('names the industry + the workflow', /Ceramic Tiles, India/.test(ms) && /Research Industry/.test(ms) && /Actions/.test(ms));
ok('empty industry still yields guidance', typeof manualSteps('') === 'string' && manualSteps('').length > 20);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
