/**
 * scripts/test-chat.mjs — guarantees for the grounded chat Worker.
 * Exercises the PURE logic (no env, no network): context grounding, the
 * never-invent source filter, slug sanitisation and history shaping.
 * No deps. Exits non-zero on failure:  node scripts/test-chat.mjs
 */
import { readFileSync } from 'node:fs';
import { buildContext, collectSources, parseAnswer, sanitizeSlug, buildMessages } from '../worker/index.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

// Real committed data as the fixture, so grounding is tested against production shape.
const d = JSON.parse(readFileSync(new URL('../public/data/industries/mdf-boards-india.json', import.meta.url), 'utf8'));

console.log('sanitizeSlug — path safety:');
ok('accepts a normal slug', sanitizeSlug('mdf-boards-india') === 'mdf-boards-india');
ok('lowercases', sanitizeSlug('MDF-Boards') === 'mdf-boards');
ok('rejects path traversal', sanitizeSlug('../../etc/passwd') === '');
ok('rejects slashes', sanitizeSlug('a/b') === '');
ok('rejects empty / non-string', sanitizeSlug('') === '' && sanitizeSlug(null) === '' && sanitizeSlug(42) === '');

console.log('collectSources — the never-invent allow-list:');
const known = collectSources(d);
const knownUrls = new Set(known.map((s) => s.url));
ok('collects many distinct sources', known.length >= 10);
ok('every entry has label + url', known.every((s) => s.label && /^https?:\/\//.test(s.url)));
ok('includes the size source', knownUrls.has(d.size.source.url));
ok('includes a player source', knownUrls.has(d.players[0].source.url));
ok('de-duplicates urls', known.length === new Set(known.map((s) => s.url)).size);

console.log('buildContext — grounded + bounded:');
const ctx = buildContext(d);
ok('is a non-empty string', typeof ctx === 'string' && ctx.length > 200);
ok('carries the market size number', ctx.includes(String(d.size.current.value)));
ok('carries a player name', ctx.includes(d.players[0].name));
ok('carries a segment name', ctx.includes(d.segments[0].name));
ok('embeds source urls inline for citation', ctx.includes(d.size.source.url));
ok('stays within the char budget', ctx.length <= 48000 + 40);
ok('empty data still yields a string', typeof buildContext({}) === 'string');

console.log('parseAnswer — never-invent source filter:');
const realUrl = d.size.source.url;
const good = parseAnswer(JSON.stringify({
  answer: 'The market is about USD 1.28 billion in 2024.',
  sources: [{ label: 'IMARC', url: realUrl }, { label: 'Fake', url: 'https://evil.example.com/x' }],
  in_data: true,
}), knownUrls, known);
ok('keeps a cited source that exists in the data', good.sources.some((s) => s.url === realUrl));
ok('drops a cited source absent from the data', !good.sources.some((s) => s.url === 'https://evil.example.com/x'));
ok('answer text preserved', /1\.28 billion/.test(good.answer));

const none = parseAnswer(JSON.stringify({ answer: "The dashboard data doesn't cover that.", sources: [], in_data: false }), knownUrls, known);
ok('out-of-scope answer keeps empty sources', none.sources.length === 0 && /doesn.t cover/.test(none.answer));

const rawFallback = parseAnswer(`Here is my answer. See ${realUrl} for detail.`, knownUrls, known);
ok('non-JSON reply falls back to raw text as the answer', /Here is my answer/.test(rawFallback.answer));
ok('non-JSON reply still recovers a known url mentioned in text', rawFallback.sources.some((s) => s.url === realUrl));

const proseWithFence = parseAnswer('```json\n{"answer":"Hi","sources":[]}\n```', knownUrls, known);
ok('parses JSON wrapped in prose / fences', proseWithFence.answer === 'Hi');

console.log('buildMessages — valid Bedrock turn sequence:');
const m1 = buildMessages([], 'What are the segments?');
ok('empty history -> single user turn', m1.length === 1 && m1[0].role === 'user' && /segments/.test(m1[0].content));

const m2 = buildMessages([
  { role: 'user', content: 'Who leads?' },
  { role: 'assistant', content: 'Greenpanel.' },
], 'And their capacity?');
ok('starts with a user turn', m2[0].role === 'user');
ok('ends with the new user question', m2[m2.length - 1].role === 'user' && /capacity/.test(m2[m2.length - 1].content));
ok('roles strictly alternate', m2.every((t, i) => i === 0 || t.role !== m2[i - 1].role));

const m3 = buildMessages([{ role: 'assistant', content: 'leading answer' }], 'follow up');
ok('leading assistant turn is dropped (must start with user)', m3[0].role === 'user');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
