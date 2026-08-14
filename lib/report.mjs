/**
 * lib/report.mjs — the consolidated written report, a DERIVED artifact built from
 * the already-assembled industry JSON (no new scraping).
 *
 * The report is a structured, section-by-section narrative grounded ONLY in the
 * assembled facts + their sources. It is:
 *  - CACHED by a hash of the fields it depends on, so warm runs don't re-pay for a
 *    Bedrock call when the underlying data hasn't changed (news refreshes don't
 *    count — they're excluded from the hash);
 *  - NEVER-FAIL: on a generation failure the previous report is kept, and if there
 *    is none, a deterministic template report (pure restatement of the data, so it
 *    can't invent) is produced instead — there is always a report.
 *
 * This module is pure (no network). The single Bedrock call is made by the
 * pipeline, which passes callClaudeJSON in. No npm dependencies.
 */
import { createHash } from 'node:crypto';
import { factsFromAssembled } from './store.mjs';

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const oneLine = (s, max = 400) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
};

/** Deterministic, key-order-independent stringify so the hash tracks DATA, not
 *  incidental key ordering. */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** Hash of exactly the fields the report is written from. Excludes volatile bits
 *  (dates, coverage, the source tabs, the report itself) so a news refresh alone
 *  never forces a regenerate. */
export function reportInputHash(obj) {
  const m = obj.meta || {};
  const proj = {
    name: m.name, definition: m.definition, is_manufacturing: m.is_manufacturing,
    headline: obj.summary && obj.summary.headline,
    takeaways: obj.summary && obj.summary.key_takeaways,
    size: obj.size, segments: obj.segments, growth_drivers: obj.growth_drivers,
    tailwinds: obj.tailwinds, headwinds: obj.headwinds, value_chain: obj.value_chain,
    channels: obj.channels, players: obj.players, margins: obj.margins, quant: obj.quant,
  };
  return sha256(stableStringify(proj)).slice(0, 32);
}

/** Unique {label,url} sources across every fact-bearing section. */
export function collectSources(obj) {
  const seen = new Map();
  const add = (s) => { if (s && s.url && !seen.has(s.url)) seen.set(s.url, { label: s.label || 'Source', url: s.url }); };
  add((obj.size || {}).source);
  for (const arr of [obj.segments, obj.growth_drivers, obj.tailwinds, obj.headwinds, obj.value_chain, obj.channels, obj.players]) {
    for (const x of (arr || [])) add(x && x.source);
  }
  add((obj.margins || {}).source);
  add((obj.quant || {}).source);
  return [...seen.values()];
}

const dedupeRefs = (refs) => {
  const seen = new Set(); const out = [];
  for (const r of refs) { if (r && r.url && !seen.has(r.url)) { seen.add(r.url); out.push(r); } }
  return out;
};

/* ----------------------------------------------------------------------- *
 * Bedrock path — prompt + grounded input + strict normaliser
 * ----------------------------------------------------------------------- */

export const REPORT_SYSTEM = `You are a senior industry research analyst writing a clean, source-backed briefing. You are given an industry's assembled research data — each section with its facts and the sources behind them. Write a structured, section-by-section report GROUNDED ONLY in the provided DATA.

STRICT RULES:
- Every claim must trace to a fact in the DATA. NEVER introduce a number, company, or claim the DATA does not contain. If the DATA doesn't support something, don't write it.
- Plain English. No jargon, no hype, no filler. Short, clear sentences a non-expert can read.
- Length scales with the DATA: a data-rich section runs longer; a thin section stays short. Do not pad.

Return ONLY a JSON object — your whole reply starts with { and ends with } — no prose, no markdown, no code fences:
{ "sections": [ { "heading": "<section name>", "prose": ["<paragraph>", "<paragraph>"], "key_numbers": [ { "label": "<short label>", "value": "<figure exactly as in the data, e.g. USD 1.4B (2024)>" } ], "source_refs": [ { "label": "<source name>", "url": "<exact source url from the DATA>" } ] } ] }

Include these sections IN THIS ORDER, but ONLY when the DATA has content for them:
Executive summary, Market size & growth, Segments, Value chain, Distribution & channels, Key players & positioning, Margins, Supply & capacity, Tailwinds vs headwinds, Outlook, Sources.

- "prose" is an array of 1-4 short paragraphs (plain strings, no markdown).
- "key_numbers": 0-5 headline figures for the section, each pulled verbatim from the DATA.
- "source_refs": only sources you actually used, taken from the DATA's SOURCES list — use their exact url. Never invent a source or url.
- "Outlook" must be grounded: base it only on the growth rate, drivers, tailwinds and headwinds already in the DATA — no speculation beyond them.
- "Sources": a one-line prose note; put the key sources in source_refs.

CRITICAL — STRICTLY VALID JSON: no raw double-quote (") inside any string value (use single quotes); no raw line breaks inside a string. One stray quote breaks the whole file.`;

const REPORT_SECTIONS = [
  ['size', 'MARKET SIZE & GROWTH'], ['segments', 'SEGMENTS'], ['growth', 'GROWTH DRIVERS'],
  ['tailwinds', 'TAILWINDS'], ['headwinds', 'HEADWINDS'], ['value_chain', 'VALUE CHAIN'],
  ['channels', 'DISTRIBUTION & CHANNELS'], ['players', 'KEY PLAYERS'], ['market_share', 'MARKET SHARE'],
  ['margins', 'MARGINS'], ['capacity', 'SUPPLY & CAPACITY'], ['imports', 'IMPORTS'], ['duty', 'DUTIES'],
];

/** The grounded input: every populated section's facts (with their source urls) +
 *  the list of sources the model may cite. */
export function buildReportUser(obj) {
  const facts = factsFromAssembled(obj);
  const byCat = new Map();
  for (const f of facts) { if (!byCat.has(f.category)) byCat.set(f.category, []); byCat.get(f.category).push(f); }
  const lines = [];
  const m = obj.meta || {};
  lines.push(`INDUSTRY: ${m.name || 'Industry'}`);
  if (m.definition) lines.push(`DEFINITION: ${m.definition}`);
  lines.push(`MANUFACTURING: ${m.is_manufacturing ? 'yes' : 'no'}`);
  if (obj.summary && obj.summary.headline) lines.push(`HEADLINE: ${obj.summary.headline}`);
  for (const t of ((obj.summary && obj.summary.key_takeaways) || [])) lines.push(`TAKEAWAY: ${t}`);
  for (const [cat, head] of REPORT_SECTIONS) {
    const fs = byCat.get(cat);
    if (!fs || !fs.length) continue;
    lines.push(`\n== ${head} ==`);
    for (const f of fs) lines.push(`- ${f.text}${f.snippet ? ` (quote: ${f.snippet})` : ''} [src: ${f.source_url}]`);
  }
  const srcs = collectSources(obj);
  if (srcs.length) {
    lines.push('\n== SOURCES (cite only these exact urls) ==');
    for (const s of srcs) lines.push(`- ${s.label} — ${s.url}`);
  }
  return lines.join('\n');
}

/** Validate + clean the model's reply. Drops any source_ref whose url is not
 *  actually in the data (never-invent guard). */
export function normalizeReport(raw, obj) {
  const arr = raw && Array.isArray(raw.sections) ? raw.sections : [];
  const sources = collectSources(obj);
  const known = new Set(sources.map((s) => s.url));
  const labelOf = new Map(sources.map((s) => [s.url, s.label]));
  const out = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const heading = oneLine(s.heading, 80);
    const prose = (Array.isArray(s.prose) ? s.prose : (typeof s.prose === 'string' ? s.prose.split(/\n\n+/) : []))
      .map((p) => oneLine(p, 1200)).filter(Boolean);
    if (!heading || !prose.length) continue;
    const key_numbers = (Array.isArray(s.key_numbers) ? s.key_numbers : []).map((k) => (
      typeof k === 'string' ? { label: '', value: oneLine(k, 60) } : { label: oneLine(k && k.label, 40), value: oneLine(k && k.value, 60) }
    )).filter((k) => k.value).slice(0, 6);
    const source_refs = dedupeRefs((Array.isArray(s.source_refs) ? s.source_refs : []).map((r) => {
      const url = String((r && r.url) || '').trim();
      return url && known.has(url) ? { label: (r.label && oneLine(r.label, 60)) || labelOf.get(url) || 'Source', url } : null;
    }).filter(Boolean));
    out.push({ heading, prose, key_numbers, source_refs });
  }
  return out;
}

/* ----------------------------------------------------------------------- *
 * Deterministic fallback — pure restatement of the data (cannot invent).
 * ----------------------------------------------------------------------- */

const fmtSize = (c) => c && c.value != null ? `${c.value}${c.unit ? ' ' + c.unit : ''}${c.year ? ` (${c.year})` : ''}` : '';
const growthWord = (p) => p >= 12 ? 'growing rapidly' : p >= 6 ? 'growing steadily' : 'growing';

export function deterministicReport(obj) {
  const meta = obj.meta || {};
  const sections = [];
  const ref = (s) => (s && s.url ? { label: s.label || 'Source', url: s.url } : null);
  const add = (heading, paras, key_numbers, refs) => {
    const p = (paras || []).map((x) => oneLine(x, 700)).filter(Boolean);
    if (!p.length) return;
    sections.push({ heading, prose: p, key_numbers: (key_numbers || []).filter((k) => k && k.value).slice(0, 6), source_refs: dedupeRefs((refs || []).filter(Boolean)) });
  };

  // Executive summary
  {
    const paras = [];
    if (obj.summary && obj.summary.headline) paras.push(obj.summary.headline + '.');
    const tk = (obj.summary && obj.summary.key_takeaways) || [];
    if (tk.length) paras.push(tk.slice(0, 6).map((t) => t.replace(/\.?$/, '.')).join(' '));
    const kn = [];
    if (obj.size && obj.size.current) kn.push({ label: 'Market size', value: fmtSize(obj.size.current) });
    if (obj.size && obj.size.cagr_pct != null) kn.push({ label: 'Growth (CAGR)', value: obj.size.cagr_pct + '%' });
    if (Array.isArray(obj.players) && obj.players.length) kn.push({ label: 'Players tracked', value: String(obj.players.length) });
    add('Executive summary', paras, kn, [ref(obj.size && obj.size.source)]);
  }
  // Market size & growth
  {
    const S = obj.size;
    if (S && (S.current || (S.history || []).length)) {
      const paras = [];
      if (S.current) paras.push(`The market is estimated at ${fmtSize(S.current)}${S.cagr_pct != null ? `, ${growthWord(S.cagr_pct)} at about ${S.cagr_pct}% a year${S.cagr_note ? ` (${S.cagr_note})` : ''}` : ''}.`);
      const hist = (S.history || []).filter((h) => h && h.value != null);
      if (hist.length > 1) paras.push(`Reported values move from ${hist[0].value} in ${hist[0].year} to ${hist[hist.length - 1].value} in ${hist[hist.length - 1].year}.`);
      const kn = [];
      if (S.current) kn.push({ label: 'Current size', value: fmtSize(S.current) });
      if (S.cagr_pct != null) kn.push({ label: 'CAGR', value: S.cagr_pct + '%' });
      add('Market size & growth', paras, kn, [ref(S.source)]);
    }
  }
  // Segments
  {
    const seg = (obj.segments || []).filter((s) => s && s.name);
    if (seg.length) {
      const withPct = seg.filter((s) => s.share_pct != null);
      const paras = [`The market breaks down into ${seg.length} tracked segment${seg.length > 1 ? 's' : ''}: ${seg.map((s) => s.name + (s.share_pct != null ? ` (${s.share_pct}%)` : '')).join(', ')}.`];
      const notable = seg.find((s) => s.note);
      if (notable) paras.push(notable.name + ': ' + notable.note.replace(/\.?$/, '.'));
      add('Segments', paras, withPct.slice(0, 5).map((s) => ({ label: s.name, value: s.share_pct + '%' })), seg.map((s) => ref(s.source)));
    }
  }
  // Value chain
  {
    const vc = (obj.value_chain || []).filter((s) => s && s.stage);
    if (vc.length) {
      const paras = [`The value chain runs across ${vc.length} stage${vc.length > 1 ? 's' : ''}: ${vc.map((s) => s.stage).join(' → ')}.`];
      const marg = vc.filter((s) => s.margin_note);
      if (marg.length) paras.push('Margin notes by stage: ' + marg.map((s) => `${s.stage} — ${s.margin_note}`).join('; ') + '.');
      add('Value chain', paras, [], vc.map((s) => ref(s.source)));
    }
  }
  // Distribution & channels
  {
    const ch = (obj.channels || []).filter((c) => c && c.channel);
    if (ch.length) {
      const paras = [`The product reaches buyers through ${ch.map((c) => c.channel).join(', ')}.`];
      const noted = ch.filter((c) => c.note).slice(0, 3);
      if (noted.length) paras.push(noted.map((c) => `${c.channel}: ${c.note}`).join(' ').replace(/\.?$/, '.'));
      add('Distribution & channels', paras, ch.filter((c) => c.share_pct != null).map((c) => ({ label: c.channel, value: c.share_pct + '%' })), ch.map((c) => ref(c.source)));
    }
  }
  // Key players & positioning
  {
    const pl = (obj.players || []).filter((p) => p && p.name);
    if (pl.length) {
      const listed = pl.filter((p) => p.listed).length;
      const paras = [`${pl.length} companies are tracked${listed ? `, of which ${listed} are listed` : ''}. They include ${pl.slice(0, 6).map((p) => p.name).join(', ')}${pl.length > 6 ? ' and others' : ''}.`];
      const leaders = pl.filter((p) => p.note).slice(0, 4);
      if (leaders.length) paras.push(leaders.map((p) => `${p.name} — ${p.note}`).join(' ').replace(/\.?$/, '.'));
      const kn = pl.filter((p) => p.market_share_pct != null).slice(0, 5).map((p) => ({ label: p.name, value: p.market_share_pct + '%' }));
      add('Key players & positioning', paras, kn, pl.map((p) => ref(p.source)));
    }
  }
  // Margins
  {
    const m = obj.margins;
    if (m && (m.manufacturer_pct != null || m.retailer_pct != null)) {
      const bits = [];
      if (m.manufacturer_pct != null) bits.push(`manufacturers earn around ${m.manufacturer_pct}%`);
      if (m.retailer_pct != null) bits.push(`retailers/dealers around ${m.retailer_pct}%`);
      const paras = [`On margins, ${bits.join(' and ')}.` + (m.notes ? ' ' + m.notes.replace(/\.?$/, '.') : '')];
      const kn = [];
      if (m.manufacturer_pct != null) kn.push({ label: 'Manufacturer', value: m.manufacturer_pct + '%' });
      if (m.retailer_pct != null) kn.push({ label: 'Retailer', value: m.retailer_pct + '%' });
      add('Margins', paras, kn, [ref(m.source)]);
    }
  }
  // Supply & capacity
  if (meta.is_manufacturing) {
    const q = obj.quant || {};
    const cap = (q.capacity || []).filter((c) => c && c.capacity != null);
    if (cap.length || q.utilisation_pct != null || (q.imports || []).length || (q.duty || []).length) {
      const paras = [];
      if (cap.length) paras.push(`Installed capacity is led by ${cap.slice(0, 5).map((c) => `${c.player} (${c.capacity}${c.unit ? ' ' + c.unit : ''})`).join(', ')}.`);
      if (q.utilisation_pct != null) paras.push(`Capacity utilisation runs around ${q.utilisation_pct}%.`);
      const imp = (q.imports || []).filter((r) => r && r.volume != null);
      if (imp.length) paras.push(`Imports: ${imp.map((r) => `${r.volume}${r.unit ? ' ' + r.unit : ''} in ${r.year}`).join(', ')}.`);
      const duty = (q.duty || []).filter((d) => d && (d.country || d.note));
      if (duty.length) paras.push('Trade measures: ' + duty.map((d) => `${d.country ? d.country + ' — ' : ''}${d.note || ''}`).join('; ') + '.');
      const kn = [];
      if (q.utilisation_pct != null) kn.push({ label: 'Utilisation', value: q.utilisation_pct + '%' });
      add('Supply & capacity', paras, kn, [ref(q.source)]);
    }
  }
  // Tailwinds vs headwinds
  {
    const tw = (obj.tailwinds || []).filter((t) => t && t.point);
    const hw = (obj.headwinds || []).filter((t) => t && t.point);
    const dr = (obj.growth_drivers || []).filter((d) => d && (d.title || d.detail));
    if (tw.length || hw.length || dr.length) {
      const paras = [];
      if (dr.length) paras.push('Demand is pulled by ' + dr.slice(0, 5).map((d) => (d.title || '').toLowerCase()).filter(Boolean).join(', ') + '.');
      if (tw.length) paras.push('Tailwinds: ' + tw.slice(0, 5).map((t) => t.point).join(' ').replace(/\.?$/, '.'));
      if (hw.length) paras.push('Headwinds and key risks: ' + hw.slice(0, 5).map((t) => t.point).join(' ').replace(/\.?$/, '.'));
      const refs = [...tw, ...hw, ...dr].map((x) => ref(x.source));
      add('Tailwinds vs headwinds', paras, [], refs);
    }
  }
  // Outlook (grounded only in cagr + drivers + headwinds)
  {
    const S = obj.size || {};
    const dr = (obj.growth_drivers || []).filter((d) => d && d.title);
    const hw = (obj.headwinds || []).filter((t) => t && t.point);
    if (S.cagr_pct != null || dr.length) {
      const paras = [];
      if (S.cagr_pct != null) paras.push(`On the numbers in this data, the market is expected to keep ${growthWord(S.cagr_pct)} at about ${S.cagr_pct}% a year${S.cagr_note ? ` (${S.cagr_note})` : ''}.`);
      if (dr.length) paras.push('Growth is supported by ' + dr.slice(0, 4).map((d) => (d.title || '').toLowerCase()).join(', ') + (hw.length ? ', while the main constraints are the headwinds noted above' : '') + '.');
      add('Outlook', paras, S.cagr_pct != null ? [{ label: 'Expected CAGR', value: S.cagr_pct + '%' }] : [], [ref(S.source)]);
    }
  }
  // Sources appendix
  {
    const srcs = collectSources(obj);
    if (srcs.length) add('Sources', [`This report draws on ${srcs.length} source${srcs.length > 1 ? 's' : ''}, listed below. Every figure and claim above traces to one of them.`], [], srcs);
  }

  return { kind: 'fallback', generated_at: (meta.generated_at || meta.updated_at || ''), hash: reportInputHash(obj), sections };
}
