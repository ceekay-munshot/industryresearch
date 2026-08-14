/**
 * lib/store.mjs — the additive fact store (the pipeline's memory).
 *
 * The committed dashboard JSON (public/data/industries/<slug>.json) is a DERIVED
 * artifact. The source of truth is an append-only fact ledger that accumulates
 * every fact ever extracted, with provenance, first/last-seen and a corroboration
 * count. Two properties make the dashboard only-ever-improve:
 *
 *  1. The ledger is UPSERTING, never deleting — a fact is added or its last_seen /
 *     seen_count is bumped, never removed. So per-category "support" (the number of
 *     DISTINCT sources backing a category) is monotonic non-decreasing.
 *  2. Assembly is WRITE-IF-BETTER — a newly assembled section replaces the
 *     committed one only if it is at least as strong (more items / more sources).
 *     A weaker run can never blank a filled section or lower its recorded support.
 *
 * Confidence is noisy-OR over DISTINCT source qualities: 1 − Π(1 − quality_i).
 * Adding an independent source can only raise it; repetition of one source cannot.
 *
 * No npm dependencies — node stdlib only. Deterministic: every function that needs
 * "now" or a run id takes it as an argument, so tests are reproducible.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/* ----------------------------------------------------------------------- *
 * Hashing / text helpers
 * ----------------------------------------------------------------------- */

export function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

/** Normalize free text for stable identity: lowercase, alnum+space, collapsed. */
export function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9%.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Domain of a URL (host without leading www.), or '' if unparseable. */
export function domainOf(url) {
  try { return new URL(url).host.replace(/^www\./, '').toLowerCase(); }
  catch (e) { return String(url || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, ''); }
}

/* ----------------------------------------------------------------------- *
 * Source quality — a documented domain-tier heuristic feeding the noisy-OR.
 * Higher = more authoritative. Tuned for Indian industry/market data.
 * ----------------------------------------------------------------------- */

const QUALITY_TIERS = [
  // Government, standards bodies, official statistics — most authoritative.
  { w: 0.9, re: /(\.gov(\.in)?|gov\.in|law\.resource\.org|\bbis\b|\bpib\b|niti\.|ibef\.org|commerce\.gov|dgft|rbi\.org|sebi\.gov|comtrade|data\.gov)/i },
  // Broker / equity research notes — company-level numbers with methodology.
  { w: 0.85, re: /(motilal|icicidirect|icicisecurities|hdfcsec|kotaksecurities|axiscap|nirmalbang|antiquestockbroking|emkayglobal|sharekhan|prabhudas|baroda.?etrade|initiating.?coverage)/i },
  // Established industry-research houses — sized markets, forecasts.
  { w: 0.8, re: /(mordorintelligence|imarcgroup|grandviewresearch|expertmarketresearch|market\.us|marketsandmarkets|fortunebusinessinsights|straitsresearch|indexbox|dataintelo|futuremarketinsights|technavio|statista|credenceresearch|maximizemarketresearch|precedenceresearch|researchandmarkets|industryarc)/i },
  // Reputable business press.
  { w: 0.6, re: /(economictimes|business-standard|livemint|moneycontrol|thehindubusinessline|businessline|financialexpress|reuters|bloomberg|cnbc|forbes|businesstoday)/i },
  // Investor blogs / aggregators — useful but secondary.
  { w: 0.5, re: /(niveshaay|screener\.in|trendlyne|tickertape|equitymaster|smart-?investing|valueresearch)/i },
];

/**
 * Quality weight for a source URL (0..1). Falls back to a mid-low weight for the
 * general open web (company sites, marketplaces, doc shares, blogs, forums).
 */
export function sourceQuality(url) {
  const s = String(url || '');
  if (!s) return 0.4;
  for (const t of QUALITY_TIERS) if (t.re.test(s)) return t.w;
  return 0.35; // general web / ecommerce / directory / blog
}

/* ----------------------------------------------------------------------- *
 * Fact identity + claim grouping
 * ----------------------------------------------------------------------- */

// Stage-A categories → schema section the fact supports.
const SECTION_OF = {
  size: 'size', growth: 'growth_drivers', segments: 'segments',
  value_chain: 'value_chain', channels: 'channels', players: 'players',
  market_share: 'players', margins: 'margins',
  capacity: 'quant', imports: 'quant', duty: 'quant',
  tailwinds: 'tailwinds', headwinds: 'headwinds', other: 'other',
};

export function sectionOf(category) {
  return SECTION_OF[String(category || 'other')] || 'other';
}

/** Stable identity for a (claim, source) pair. Same claim from two sources → two
 *  records, which is exactly how corroboration is counted. */
export function factId(category, text, sourceUrl) {
  return sha256(`${category}|${normText(text)}|${domainOf(sourceUrl)}`).slice(0, 16);
}

/** Best-effort grouping key for competing values (deterministic). `entity`
 *  (a company / segment / stage name) makes it precise; otherwise a short text
 *  fingerprint groups near-identical claims. */
export function claimSlot(fact) {
  const cat = String(fact.category || 'other');
  const ent = fact.entity ? normText(fact.entity).split(' ').slice(0, 3).join(' ') : '';
  if (ent) return `${cat}|${ent}`;
  const fp = normText(fact.text).split(' ').filter((w) => w.length > 2).slice(0, 6).join(' ');
  return `${cat}|${fp}`;
}

/* ----------------------------------------------------------------------- *
 * Ledger IO (JSONL, one fact per line, sorted by fact_id for clean diffs)
 * ----------------------------------------------------------------------- */

export function loadLedger(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (e) { /* skip a corrupt line, never crash */ }
  }
  return out;
}

export function saveLedger(path, facts) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sorted = [...facts].sort((a, b) => (a.fact_id < b.fact_id ? -1 : a.fact_id > b.fact_id ? 1 : 0));
  writeFileSync(path, sorted.map((f) => JSON.stringify(f)).join('\n') + (sorted.length ? '\n' : ''));
}

/**
 * Upsert facts into a ledger (pure — returns a new array, never mutates input).
 * New fact → inserted with first_seen. Seen-again fact → last_seen / last_run_id
 * bumped and seen_count incremented. Nothing is ever removed. IDEMPOTENT within a
 * single run: re-upserting the same facts with the same runId changes nothing
 * (seen_count counts distinct runs, not repeats).
 */
export function upsertFacts(ledger, incoming, { runId, now }) {
  const byId = new Map(ledger.map((f) => [f.fact_id, { ...f }]));
  for (const raw of (incoming || [])) {
    const f = normalizeIncoming(raw);
    if (!f) continue;
    const existing = byId.get(f.fact_id);
    if (!existing) {
      byId.set(f.fact_id, {
        ...f,
        first_seen: now, last_seen: now,
        first_run_id: runId, last_run_id: runId,
        seen_count: 1, status: 'active',
      });
    } else {
      // Only a NEW run bumps corroboration/recency — repeats within a run are no-ops.
      if (existing.last_run_id !== runId) {
        existing.last_seen = now;
        existing.last_run_id = runId;
        existing.seen_count = (existing.seen_count || 1) + 1;
      }
      if (existing.status === 'stale') existing.status = 'active';
      // Prefer a longer snippet / filled value if the new sighting has one.
      if (f.snippet && f.snippet.length > (existing.snippet || '').length) existing.snippet = f.snippet;
      if (f.value && !existing.value) existing.value = f.value;
      byId.set(f.fact_id, existing);
    }
  }
  return [...byId.values()];
}

function normalizeIncoming(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const category = String(raw.category || 'other');
  const text = String(raw.text || '').trim();
  const source_url = String(raw.source_url || raw.url || '').trim();
  if (!text || !source_url) return null;
  const f = {
    fact_id: factId(category, text, source_url),
    category,
    section: sectionOf(category),
    text,
    snippet: String(raw.snippet || '').replace(/"/g, "'").slice(0, 400),
    source_url,
    source_domain: domainOf(source_url),
    source_quality: typeof raw.source_quality === 'number' ? raw.source_quality : sourceQuality(source_url),
  };
  f.claim_slot = claimSlot(f);
  if (raw.entity) f.entity = String(raw.entity).slice(0, 120);
  if (raw.value && typeof raw.value === 'object') f.value = raw.value;
  if (raw.date) f.date = String(raw.date).slice(0, 40);
  return f;
}

/* ----------------------------------------------------------------------- *
 * Confidence, decay, support
 * ----------------------------------------------------------------------- */

/** Noisy-OR over independent source qualities: 1 − Π(1 − q). Monotonic in the
 *  set of DISTINCT sources — repetition of one domain contributes at most once. */
export function noisyOr(qualities) {
  let prod = 1;
  for (const q of qualities) prod *= (1 - Math.max(0, Math.min(1, q)));
  return +(1 - prod).toFixed(4);
}

/** Recency weight (0..1) for ranking competing values. Time-based only — it never
 *  lowers stored support, so a run finding nothing new can't reduce confidence. */
export function decayWeight(lastSeen, now, halfLifeDays = 365) {
  const t = Date.parse(now) - Date.parse(lastSeen);
  if (!isFinite(t) || t <= 0) return 1;
  const days = t / 86400000;
  return +Math.pow(0.5, days / halfLifeDays).toFixed(4);
}

const isActive = (f) => f && f.status !== 'retired' && f.status !== 'superseded';

/**
 * Per-section support computed from the ledger: distinct source domains and the
 * noisy-OR confidence over them. Because the ledger only grows, both are monotonic
 * non-decreasing across runs.
 */
export function supportByCategory(ledger) {
  const bySec = new Map();
  for (const f of (ledger || [])) {
    if (!isActive(f)) continue;
    const sec = f.section || sectionOf(f.category);
    if (!bySec.has(sec)) bySec.set(sec, new Map());
    const domains = bySec.get(sec);
    // Keep the best quality seen for each distinct domain.
    const q = typeof f.source_quality === 'number' ? f.source_quality : sourceQuality(f.source_url);
    domains.set(f.source_domain, Math.max(domains.get(f.source_domain) || 0, q));
  }
  const out = {};
  for (const [sec, domains] of bySec) {
    out[sec] = {
      sources: domains.size,
      confidence: noisyOr([...domains.values()]),
      facts: (ledger || []).filter((f) => isActive(f) && (f.section || sectionOf(f.category)) === sec).length,
    };
  }
  return out;
}

/**
 * Mark facts superseded when a stronger, more recent fact exists in the same
 * claim_slot (soft-delete — status only, never removed). Returns a new array.
 * "Stronger" = higher (quality × recency); ties keep both active.
 */
export function decayAndSupersede(ledger, { now, staleDays = 540, halfLifeDays = 365 }) {
  const bySlot = new Map();
  for (const f of ledger) {
    if (!isActive(f)) continue;
    if (!bySlot.has(f.claim_slot)) bySlot.set(f.claim_slot, []);
    bySlot.get(f.claim_slot).push(f);
  }
  const out = ledger.map((f) => ({ ...f }));
  const byId = new Map(out.map((f) => [f.fact_id, f]));
  for (const [, group] of bySlot) {
    if (group.length < 2) continue;
    // Only supersede when values actually differ AND one clearly dominates.
    const scored = group.map((f) => ({
      f, score: (f.source_quality || 0.4) * decayWeight(f.last_seen, now, halfLifeDays),
    })).sort((a, b) => b.score - a.score);
    const best = scored[0];
    for (const { f, score } of scored.slice(1)) {
      const rec = byId.get(f.fact_id);
      // Age out very old, uncorroborated, clearly-dominated facts.
      const ageDays = (Date.parse(now) - Date.parse(f.last_seen)) / 86400000;
      if (ageDays > staleDays && score < best.score * 0.5 && (f.seen_count || 1) <= 1) {
        rec.status = 'superseded';
        rec.superseded_by = best.f.fact_id;
      }
    }
  }
  return out;
}

/* ----------------------------------------------------------------------- *
 * Ledger → Stage-B digest (grouped by category, with corroboration hints)
 * ----------------------------------------------------------------------- */

/** Build the compact, clean digest the schema-fill (Stage B) reads — active facts
 *  grouped by category, most-corroborated first, each with sources + a quote. */
export function buildLedgerDigest(ledger, { now } = {}) {
  const order = ['size', 'growth', 'segments', 'value_chain', 'channels', 'players', 'market_share', 'margins', 'capacity', 'imports', 'duty', 'tailwinds', 'headwinds', 'other'];
  // Collapse to one line per claim_slot, aggregating distinct sources.
  const slots = new Map();
  for (const f of ledger) {
    if (!isActive(f)) continue;
    if (!slots.has(f.claim_slot)) slots.set(f.claim_slot, { category: f.category, texts: new Map(), domains: new Set(), url: f.source_url, snippet: f.snippet, quality: [] });
    const s = slots.get(f.claim_slot);
    s.texts.set(normText(f.text), f.text);
    if (!s.domains.has(f.source_domain)) { s.domains.add(f.source_domain); s.quality.push(f.source_quality || 0.4); }
    if ((f.snippet || '').length > (s.snippet || '').length) { s.snippet = f.snippet; s.url = f.source_url; }
  }
  const byCat = new Map(order.map((c) => [c, []]));
  for (const [, s] of slots) {
    const cat = byCat.has(s.category) ? s.category : 'other';
    const text = [...s.texts.values()][0];
    byCat.get(cat).push({ text, url: s.url, snippet: s.snippet, sources: s.domains.size, confidence: noisyOr(s.quality) });
  }
  const parts = [];
  for (const cat of order) {
    const list = (byCat.get(cat) || []).sort((a, b) => b.sources - a.sources || b.confidence - a.confidence);
    if (!list.length) continue;
    const lines = list.map((x) => `- ${x.text} (sources: ${x.sources}, url: ${x.url || 'n/a'})${x.snippet ? ` [quote: ${x.snippet}]` : ''}`);
    parts.push(`## ${cat.toUpperCase().replace(/_/g, ' ')}\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

/* ----------------------------------------------------------------------- *
 * Write-if-better assembly merge (the monotonicity guarantee)
 * ----------------------------------------------------------------------- */

const SECTIONS = ['summary', 'size', 'segments', 'growth_drivers', 'tailwinds', 'headwinds', 'value_chain', 'channels', 'players', 'margins', 'quant'];

/** How "strong" a rendered section is — used to decide write-if-better. Higher =
 *  richer. Array sections: item count. Object sections: populated leaf fields. */
export function sectionStrength(section, value) {
  if (value == null) return 0;
  if (Array.isArray(value)) return value.length;
  if (section === 'summary') {
    if (!value || typeof value !== 'object') return 0;
    const takeaways = Array.isArray(value.key_takeaways) ? value.key_takeaways.length : 0;
    const report = (value.report_markdown || '').length;
    return (value.headline ? 1 : 0) + takeaways + (report > 200 ? 1 : 0);
  }
  if (typeof value === 'object') {
    let n = 0;
    for (const v of Object.values(value)) {
      if (v == null) continue;
      if (Array.isArray(v)) n += v.length ? 1 : 0;
      else if (typeof v === 'object') n += Object.keys(v).length ? 1 : 0;
      else if (String(v).trim() !== '') n += 1;
    }
    return n;
  }
  return String(value).trim() ? 1 : 0;
}

/**
 * Merge a freshly-assembled candidate over the committed incumbent, section by
 * section, keeping whichever is STRONGER. Never replaces a filled section with a
 * weaker or empty one — so the committed dashboard is monotonic: it can only hold
 * or improve. Idempotent: mergeAssembly(x, x) deep-equals x. Returns { obj, changed }.
 * `sources` (except the analytical sections) is passed through from the candidate.
 */
export function mergeAssembly(candidate, incumbent) {
  candidate = candidate && typeof candidate === 'object' ? candidate : {};
  incumbent = incumbent && typeof incumbent === 'object' ? incumbent : {};
  const out = { ...candidate };
  const changed = [];
  for (const sec of SECTIONS) {
    const cs = sectionStrength(sec, candidate[sec]);
    const is = sectionStrength(sec, incumbent[sec]);
    if (cs >= is) {
      if (candidate[sec] !== undefined) out[sec] = candidate[sec];
      else if (incumbent[sec] !== undefined) out[sec] = incumbent[sec];
      if (JSON.stringify(candidate[sec]) !== JSON.stringify(incumbent[sec])) changed.push(sec);
    } else {
      out[sec] = incumbent[sec]; // keep the richer incumbent — never blank/regress
    }
  }
  return { obj: out, changed };
}

/* ----------------------------------------------------------------------- *
 * Reverse: derive facts from an already-assembled dashboard JSON. Used to seed
 * the ledger from the existing committed file so nothing already gathered is lost
 * and the first assembly reproduces (at least) today's dashboard.
 * ----------------------------------------------------------------------- */
export function factsFromAssembled(obj) {
  const facts = [];
  const push = (category, text, source, extra = {}) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    const url = source && source.url;
    if (!t || !url) return;
    facts.push({ category, text: t, snippet: (source && source.snippet) || '', source_url: url, ...extra });
  };
  if (!obj || typeof obj !== 'object') return facts;
  const S = obj.size || {};
  if (S.current && S.current.value != null) push('size', `India market size ${S.current.value} ${S.current.unit || ''} in ${S.current.year || ''}`, S.source, { entity: 'market size', value: { amount: S.current.value, unit: S.current.unit, year: S.current.year } });
  if (S.cagr_pct != null) push('size', `Market CAGR about ${S.cagr_pct}% ${S.cagr_note || ''}`, S.source, { entity: 'cagr' });
  for (const h of (S.history || [])) if (h && h.value != null) push('size', `Market size ${h.value} in ${h.year}`, S.source, { entity: `size ${h.year}`, value: { amount: h.value, year: h.year } });
  for (const s of (obj.segments || [])) push('segments', `${s.name}${s.share_pct != null ? ` — ${s.share_pct}% share` : ''}${s.note ? `. ${s.note}` : ''}`, s.source, { entity: s.name });
  for (const g of (obj.growth_drivers || [])) push('growth', `${g.title}: ${g.detail || ''}`, g.source, { entity: g.title });
  for (const t of (obj.tailwinds || [])) push('tailwinds', t.point, t.source);
  for (const h of (obj.headwinds || [])) push('headwinds', h.point, h.source);
  for (const v of (obj.value_chain || [])) push('value_chain', `${v.stage}: ${v.description || ''}${v.margin_note ? `. ${v.margin_note}` : ''}`, v.source, { entity: v.stage });
  for (const c of (obj.channels || [])) push('channels', `${c.channel}${c.share_pct != null ? ` — ${c.share_pct}%` : ''}${c.note ? `. ${c.note}` : ''}`, c.source, { entity: c.channel });
  for (const p of (obj.players || [])) {
    push('players', `${p.name}${p.listed ? ' (listed)' : ''}${p.segment ? ` — ${p.segment}` : ''}. ${p.note || ''}`, p.source, { entity: p.name });
    if (p.market_share_pct != null) push('market_share', `${p.name} holds about ${p.market_share_pct}% market share`, p.source, { entity: p.name });
  }
  const M = obj.margins || {};
  if (M.manufacturer_pct != null || M.retailer_pct != null) push('margins', `Manufacturer margin about ${M.manufacturer_pct}%, retailer margin about ${M.retailer_pct}%. ${M.notes || ''}`, M.source, { entity: 'margins' });
  const Q = obj.quant || {};
  for (const c of (Q.capacity || [])) push('capacity', `${c.player} capacity ${c.capacity} ${c.unit || ''} (${c.region || ''}, ${c.year || ''})`, Q.source, { entity: c.player, value: { amount: c.capacity, unit: c.unit, year: c.year } });
  if (Q.utilisation_pct != null) push('capacity', `Capacity utilisation about ${Q.utilisation_pct}%`, Q.source, { entity: 'utilisation' });
  for (const im of (Q.imports || [])) push('imports', `Imports ${im.volume} ${im.unit || ''} in ${im.year}`, Q.source, { entity: `imports ${im.year}` });
  for (const d of (Q.duty || [])) push('duty', `${d.country}: ${d.note}`, Q.source, { entity: d.country });
  return facts;
}

/** Coverage snapshot for a run: per-section support that never decreases vs the
 *  previous snapshot (max), plus a freshness "as of" date per section. */
export function mergeCoverage(prev, ledgerSupport, sectionDates) {
  prev = prev && typeof prev === 'object' ? prev : {};
  const out = {};
  const keys = new Set([...Object.keys(prev.sections || {}), ...Object.keys(ledgerSupport || {})]);
  out.sections = {};
  for (const k of keys) {
    const p = (prev.sections || {})[k] || {};
    const n = (ledgerSupport || {})[k] || {};
    out.sections[k] = {
      sources: Math.max(p.sources || 0, n.sources || 0),          // monotonic
      confidence: Math.max(p.confidence || 0, n.confidence || 0), // monotonic
      as_of: (sectionDates || {})[k] || p.as_of || null,
    };
  }
  return out;
}
