/**
 * scripts/test-feeds.mjs — parser guarantees for the recency feeds.
 * No framework, no npm deps. Exits non-zero on failure:  node scripts/test-feeds.mjs
 */
import { parseRss, parseGdelt, parseFeed, itemEpoch, itemDomain } from '../lib/feeds.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

const rss = `<rss><channel>
<item><title>Greenpanel expands MDF capacity</title><link>https://economictimes.indiatimes.com/x</link><pubDate>Wed, 13 Aug 2026 06:00:00 GMT</pubDate><description><![CDATA[New line at <b>Srikalahasti</b>]]></description><guid>et-1</guid></item>
<item><title>MDF prices rise</title><link>https://livemint.com/y</link><pubDate>Tue, 12 Aug 2026 06:00:00 GMT</pubDate></item>
</channel></rss>`;
const items = parseRss(rss);
ok('RSS: 2 items', items.length === 2);
ok('RSS: title', items[0].title === 'Greenpanel expands MDF capacity');
ok('RSS: link', items[0].url === 'https://economictimes.indiatimes.com/x');
ok('RSS: CDATA + tags stripped in snippet', items[0].snippet === 'New line at Srikalahasti');
ok('RSS: guid', items[0].guid === 'et-1');

const atom = `<feed><entry><title>Rushil Decor Q1 results</title><link href="https://bs.com/r" rel="alternate"/><updated>2026-08-11T10:00:00Z</updated><summary>Profit up</summary></entry></feed>`;
const a = parseFeed('rss', atom);
ok('Atom: entry + link href', a.length === 1 && a[0].url === 'https://bs.com/r' && a[0].title === 'Rushil Decor Q1 results');

const g = parseGdelt(JSON.stringify({ articles: [{ title: 'MDF demand surges', url: 'https://reuters.com/z', seendate: '20260814T101500Z', domain: 'reuters.com' }] }));
ok('GDELT: article parsed', g.length === 1 && g[0].url === 'https://reuters.com/z');
ok('GDELT: seendate -> ISO', g[0].date === '2026-08-14T10:15:00Z');

ok('itemEpoch parses RFC-822', itemEpoch('Wed, 13 Aug 2026 06:00:00 GMT') > 0);
ok('itemEpoch unknown -> 0', itemEpoch('not a date') === 0);
ok('itemDomain strips www', itemDomain({ url: 'https://www.economictimes.indiatimes.com/x' }) === 'economictimes.indiatimes.com');
ok('empty input -> []', parseRss('').length === 0 && parseGdelt('nonjson').length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
