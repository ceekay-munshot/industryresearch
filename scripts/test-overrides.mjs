/**
 * scripts/test-overrides.mjs — analyst override validation + authoritative apply.
 * Proves: edits are validated/sanitized, numeric fields coerced; corrections set a
 * field and badge it (analyst) without freezing the rest; adds mark added_by; a
 * benchmarking financial edit clears "pending"; scalar sections route correctly;
 * overrides win over auto values and survive replay order.
 *   node scripts/test-overrides.mjs
 */
import { validateOverride, parseOverrides, applyOne, applyOverrides, coerceValue } from '../lib/overrides.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

console.log('validateOverride:');
let v = validateOverride({ section: 'players', target: 'Greenpanel', field: 'market_share_pct', value: '23%' });
ok('valid array edit -> ok, numeric coerced', v.ok && v.override.value === 23 && v.override.target === 'Greenpanel' && v.override.added_by === 'analyst');
v = validateOverride({ section: 'size', field: 'value', value: '12,500' });
ok('valid scalar edit -> ok, commas stripped', v.ok && v.override.value === 12500 && v.override.target === '');
ok('unknown section rejected', validateOverride({ section: 'nope', field: 'x', value: '1' }).ok === false);
ok('missing field rejected', validateOverride({ section: 'players', target: 'X', value: '1' }).ok === false);
ok('array section needs a target', validateOverride({ section: 'players', field: 'revenue', value: '1' }).ok === false);
ok('missing value rejected', validateOverride({ section: 'size', field: 'value', value: '' }).ok === false);
ok('non-http source_url rejected', validateOverride({ section: 'size', field: 'value', value: '1', source_url: 'javascript:alert(1)' }).ok === false);
v = validateOverride({ section: 'players', target: 'X', field: 'note', value: '  hello  ', source_url: 'https://a.com', note: 'fix' });
ok('string field trimmed; source + note kept', v.ok && v.override.value === 'hello' && v.override.source_url === 'https://a.com' && v.override.note === 'fix');

console.log('coerceValue:');
ok('numeric field coerces', coerceValue('revenue', '1,650') === 1650 && coerceValue('ebitda_pct', '14.2%') === 14.2);
ok('non-numeric field stays string', coerceValue('note', ' hi ') === 'hi');
ok('unparseable numeric falls back to string', coerceValue('value', 'approx') === 'approx');

console.log('parseOverrides:');
const jsonl = '{"section":"size","field":"value","value":100}\n\nnot json\n{"section":"players","target":"A","field":"revenue","value":5}\n';
const parsed = parseOverrides(jsonl);
ok('parses valid lines, skips junk/blanks', parsed.length === 2 && parsed[1].target === 'A');

console.log('applyOne — array correction (badge field, do not freeze others):');
let obj = { players: [{ name: 'Greenpanel', listed: true, revenue: 1500, market_share_pct: 20 }] };
applyOne(obj, { section: 'players', target: 'greenpanel', field: 'market_share_pct', value: 23 });
let p = obj.players[0];
ok('sets the field (case-insensitive target match)', p.market_share_pct === 23);
ok('badges analyst + analyst_fields', p.analyst === true && p.analyst_fields.join() === 'market_share_pct');
ok('does NOT set added_by on a corrected existing item', p.added_by === undefined && p.revenue === 1500);

console.log('applyOne — array add (new item):');
obj = { players: [] };
applyOne(obj, { section: 'players', target: 'New Co', field: 'note', value: 'analyst added', source_url: 'https://s.com' });
ok('creates the item with the key + field', obj.players.length === 1 && obj.players[0].name === 'New Co' && obj.players[0].note === 'analyst added');
ok('added item is added_by:analyst', obj.players[0].added_by === 'analyst');
ok('source_url attaches an analyst source', obj.players[0].source && obj.players[0].source.url === 'https://s.com');

console.log('applyOne — benchmarking peer financial edit clears pending:');
obj = { benchmarking: { peers: [{ name: 'Merino', pending: true, listed: false }] } };
applyOne(obj, { section: 'benchmarking', target: 'Merino', field: 'revenue', value: 900 });
ok('creates/updates under benchmarking.peers', obj.benchmarking.peers[0].revenue === 900);
ok('financial edit clears pending; existing unlisted stays unlisted', obj.benchmarking.peers[0].pending === false && obj.benchmarking.peers[0].listed === false);
obj = { benchmarking: { peers: [] } };
applyOne(obj, { section: 'benchmarking', target: 'Brand New Co', field: 'ebitda_pct', value: 15 });
ok('a brand-new benchmarking peer defaults to listed', obj.benchmarking.peers[0].listed === true && obj.benchmarking.peers[0].added_by === 'analyst');

console.log('applyOne — scalar sections:');
obj = { size: { current: { value: 5000, unit: 'x', year: 2024 }, cagr_pct: 8 } };
applyOne(obj, { section: 'size', field: 'value', value: 6200 });
applyOne(obj, { section: 'size', field: 'cagr_pct', value: 11 });
ok('size.value routes to current.value; cagr_pct direct', obj.size.current.value === 6200 && obj.size.cagr_pct === 11);
ok('scalar section is badged analyst', obj.size.analyst === true && obj.size.analyst_fields.includes('value'));
obj = {};
applyOne(obj, { section: 'margins', target: '', field: 'manufacturer_pct', value: '18' });
ok('creates a missing scalar section', obj.margins.manufacturer_pct === 18);

console.log('applyOne — unknown section is a no-op (never-fail):');
obj = { players: [] };
const before = JSON.stringify(obj);
applyOne(obj, { section: 'meta', field: 'x', value: '1' });
ok('unknown section ignored', JSON.stringify(obj) === before);

console.log('applyOverrides — authoritative, last-write-wins:');
obj = { players: [{ name: 'A', revenue: 100 }] };   // auto value 100
applyOverrides(obj, [
  { section: 'players', target: 'A', field: 'revenue', value: 200 },   // analyst correction
  { section: 'players', target: 'A', field: 'revenue', value: 250 },   // later correction wins
]);
ok('analyst override wins over auto; last edit wins', obj.players[0].revenue === 250 && obj.players[0].analyst === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
