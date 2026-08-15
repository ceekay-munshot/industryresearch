/**
 * lib/benchmark.mjs — peer financial benchmarking (pure helpers).
 *
 * The impure orchestration (resolve ticker → fetch financials → ONE Claude
 * extraction → DRHP fallback) lives in scripts/research-industry.mjs so it can
 * reuse the run's cache + LLM plumbing. Everything HERE is pure and deterministic
 * so it can be unit-tested with no network:
 *
 *  - FINANCIALS_SYSTEM / buildFinancialsUser — the grounded extraction prompt.
 *  - normalizeFinancials — clamp the model's reply to the metric schema, OMIT
 *    anything not present (never invent).
 *  - pickListedMatch — choose the best India-listed match for a player name from
 *    a normalized stock-search list, with a name guard so a coincidental ticker
 *    isn't taken.
 *  - drhpDocFrom — pull a prospectus document link out of an (undocumented) DRHP
 *    response, tolerantly.
 *  - peerStrength / mergeBenchmarking — per-peer WRITE-IF-BETTER: a peer with real
 *    financials is never regressed to "pending" by a later failed run, and an
 *    analyst-added peer is never clobbered. Designed so a later data source
 *    (Private Circle) can fill a "pending" peer in place with no rework.
 *
 * No npm dependencies — node stdlib only.
 */

// Bump when FINANCIALS_SYSTEM changes so cached extractions cleanly recompute.
export const BENCH_PROMPT_VERSION = 'benchmark-v1';

// The eight headline metrics we benchmark peers on.
export const METRIC_FIELDS = [
  'revenue', 'revenue_unit', 'revenue_year',
  'revenue_cagr_3y_pct', 'ebitda_pct', 'pat_pct', 'roce_pct', 'roe_pct',
];

export const FINANCIALS_SYSTEM = `You are a financial-data extraction analyst. You are given a company name and a markdown financials document (sourced from screener.in). Extract ONLY the headline metrics below for THAT company, using ONLY the DOCUMENT — no outside knowledge, never invent or round beyond what the document supports. If the document does not state (or let you directly compute) a metric, OMIT that field entirely — do not guess, and never output 0 or null as a placeholder.

Return ONLY a JSON object — your entire response must start with { and end with } — no prose, no markdown, no code fences:

{
  "revenue": <most recent FULL-YEAR revenue / sales, a plain number>,
  "revenue_unit": "<the unit the document uses, e.g. Rs Cr or ₹ crore>",
  "revenue_year": <the fiscal year of that revenue, e.g. 2025>,
  "revenue_cagr_3y_pct": <3-year revenue/sales CAGR, in percent>,
  "ebitda_pct": <most recent EBITDA / operating margin (OPM), in percent>,
  "pat_pct": <most recent net-profit margin (net profit / sales x 100), in percent>,
  "roce_pct": <most recent Return on Capital Employed, in percent>,
  "roe_pct": <most recent Return on Equity, in percent>
}

Rules:
- Use the MOST RECENT full financial year the document reports for each metric (a yearly figure, never a single quarter).
- revenue: prefer the annual "Sales" / "Revenue" row; set revenue_unit to the document's unit and revenue_year to that year.
- ebitda_pct: use the document's OPM % / operating margin if given; otherwise EBITDA / Sales for the same year if both are present.
- pat_pct: net-profit margin. Only if net profit and sales for the SAME year are both in the document.
- roce_pct / roe_pct: use the document's stated ratios if present.
- revenue_cagr_3y_pct: if the document states a 3-year sales CAGR, use it; else, if it lists sales for at least three consecutive years, compute CAGR = ((latest / earliest) ^ (1 / years) - 1) x 100 over the most recent ~3-year span; else OMIT.
- Every numeric value must be a PLAIN number — no % sign, no commas, no units (units go only in revenue_unit).
- OMIT any field you cannot ground in the document. Returning {} is correct when the document has nothing usable.`;

export function buildFinancialsUser(name, ticker, markdown) {
  return `Company: ${name}${ticker ? ` (ticker: ${ticker})` : ''}\nCountry: India\n\nFINANCIALS DOCUMENT (extract only what is present):\n${markdown || ''}`;
}

/* ----------------------------------------------------------------------- *
 * Normalizers
 * ----------------------------------------------------------------------- */

/** Parse a numeric metric: strip commas / % / spaces / stray units, keep a finite
 *  number, drop absurd magnitudes (likely mis-parsed). Returns null when unusable. */
function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').replace(/%/g, '').replace(/[a-z₹$]/gi, '').trim();
  if (!s || s === '-' || /^n\.?a\.?$/i.test(String(v).trim())) return null;
  const n = Number(s);
  if (!isFinite(n)) return null;
  return n;
}

/** Round to at most `dp` decimals without trailing-zero noise. */
function round(n, dp = 2) {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

/**
 * Clamp an extracted-financials object to the metric schema. Omits any field not
 * present / not a usable number. A stray value with an absurd magnitude is dropped
 * (never invented). Pure.
 */
export function normalizeFinancials(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;

  const rev = toNum(raw.revenue);
  if (rev != null && Math.abs(rev) < 1e13) {
    out.revenue = round(rev, 2);
    const unit = String(raw.revenue_unit == null ? '' : raw.revenue_unit).trim();
    if (unit) out.revenue_unit = unit.slice(0, 24);
    const yr = toNum(raw.revenue_year);
    if (yr != null && yr >= 1990 && yr <= 2100) out.revenue_year = Math.round(yr);
  }

  // Percent metrics: keep any finite, sane value (losses/negatives allowed).
  for (const key of ['revenue_cagr_3y_pct', 'ebitda_pct', 'pat_pct', 'roce_pct', 'roe_pct']) {
    const n = toNum(raw[key]);
    if (n != null && Math.abs(n) <= 100000) out[key] = round(n, 2);
  }
  return out;
}

/** Does a peer object carry at least one real financial metric? */
export function hasFinancials(peer) {
  if (!peer) return false;
  return ['revenue', 'revenue_cagr_3y_pct', 'ebitda_pct', 'pat_pct', 'roce_pct', 'roe_pct']
    .some((k) => peer[k] != null);
}

/* ----------------------------------------------------------------------- *
 * Name normalization + ticker matching
 * ----------------------------------------------------------------------- */

/** Normalize a company name for matching/identity: lowercase, drop corp suffixes
 *  and punctuation, collapse whitespace. */
export function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(ltd|limited|pvt|private|inc|llp|plc|co|corp|corporation|company|industries|india)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Similarity of two names in [0,1]: fraction of the query's meaningful tokens
 *  present in the candidate (exact normalized equality scores 1). */
export function nameMatchScore(query, candidate) {
  const q = normName(query), c = normName(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  const qt = q.split(' ').filter((w) => w.length >= 3);
  const ct = new Set(c.split(' ').filter(Boolean));
  if (!qt.length) return c.includes(q) || q.includes(c) ? 0.8 : 0;
  let hit = 0;
  for (const w of qt) if (ct.has(w)) hit++;
  return hit / qt.length;
}

/**
 * Best India-listed match for a player name from a normalized stock-search list
 * ([{ ticker, name, sector, country }]). Requires a name-match above `minScore`
 * so a coincidental ticker for a different company is not taken. Returns the
 * matched row (or null).
 */
export function pickListedMatch(results, name, minScore = 0.6) {
  const list = Array.isArray(results) ? results.filter((r) => r && r.ticker) : [];
  if (!list.length) return null;
  const india = list.filter((r) => /india/i.test(r.country || ''));
  const pool = india.length ? india : list;
  let best = null, bestScore = 0;
  for (const r of pool) {
    const score = nameMatchScore(name, r.name || r.ticker);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return bestScore >= minScore ? best : null;
}

/* ----------------------------------------------------------------------- *
 * DRHP prospectus link extraction (undocumented response — be tolerant)
 * ----------------------------------------------------------------------- */

/** Deep-scan an (undocumented) DRHP response for the first prospectus document
 *  link. Returns { url, title } or null. Pure. */
export function drhpDocFrom(data) {
  if (!data) return null;
  let found = null;
  const urlKeys = ['url', 'doc_url', 'document_url', 'pdf', 'pdf_url', 'link', 'href', 'file', 'file_url', 'drhp_url', 'prospectus_url'];
  const titleKeys = ['title', 'name', 'company', 'company_name', 'document', 'heading'];
  const isDoc = (u) => /^https?:\/\//i.test(u);
  const walk = (node, ctxTitle) => {
    if (found || node == null) return;
    if (typeof node === 'string') return;
    if (Array.isArray(node)) { for (const x of node) { walk(x, ctxTitle); if (found) return; } return; }
    if (typeof node !== 'object') return;
    let title = ctxTitle;
    for (const tk of titleKeys) { if (typeof node[tk] === 'string' && node[tk].trim()) { title = node[tk].trim(); break; } }
    for (const uk of urlKeys) {
      const v = node[uk];
      if (typeof v === 'string' && isDoc(v.trim())) { found = { url: v.trim(), title: title || '' }; return; }
    }
    for (const v of Object.values(node)) { walk(v, title); if (found) return; }
  };
  walk(data, '');
  return found;
}

/** Does a DRHP response indicate a real filing exists (even without a link)? */
export function drhpExists(data) {
  if (!data) return false;
  if (drhpDocFrom(data)) return true;
  // A non-empty results/data array, or an object with company-ish fields, counts.
  const arrs = ['results', 'data', 'filings', 'documents', 'items'];
  for (const k of arrs) if (Array.isArray(data[k]) && data[k].length) return true;
  if (Array.isArray(data) && data.length) return true;
  return false;
}

/* ----------------------------------------------------------------------- *
 * Per-peer write-if-better merge (the monotonicity guarantee for benchmarking)
 * ----------------------------------------------------------------------- */

/** How "strong" a benchmarking peer is. Analyst-added peers are authoritative and
 *  must never be clobbered. Otherwise: real financials dominate a "pending" row;
 *  a prospectus link and a source add a little. Pure. */
export function peerStrength(peer) {
  if (!peer || typeof peer !== 'object') return 0;
  if (peer.added_by === 'analyst') return Number.POSITIVE_INFINITY;
  let s = 0;
  if (peer.revenue != null) s += 2;
  for (const k of ['revenue_cagr_3y_pct', 'ebitda_pct', 'pat_pct', 'roce_pct', 'roe_pct']) if (peer[k] != null) s += 1;
  if (peer.source && peer.source.url) s += 1;
  if (peer.prospectus && peer.prospectus.url) s += 1;
  if (peer.forward_note) s += 0.5;
  if (peer.pending) s -= 0.5;                 // a filled row beats a pending one at a tie
  return s;
}

/**
 * Merge freshly-computed peers over the committed incumbents, per peer, by name,
 * keeping whichever is STRONGER (ties → the fresh candidate). The result follows
 * the CANDIDATE order (aligned to the current player set); an incumbent that is
 * stronger contributes its richer financials in place. Never regresses a filled
 * peer to pending, and never clobbers an analyst-added peer. Pure.
 */
export function mergeBenchmarking(candidatePeers, incumbentPeers) {
  const cand = Array.isArray(candidatePeers) ? candidatePeers.filter(Boolean) : [];
  const inc = Array.isArray(incumbentPeers) ? incumbentPeers.filter(Boolean) : [];
  const incByName = new Map();
  for (const p of inc) { const k = normName(p.name); if (k && !incByName.has(k)) incByName.set(k, p); }

  const out = [];
  const used = new Set();
  for (const c of cand) {
    const k = normName(c.name);
    const i = k ? incByName.get(k) : null;
    if (i) used.add(k);
    if (i && peerStrength(i) > peerStrength(c)) out.push(i);   // incumbent richer → keep it
    else out.push(c);                                          // candidate at least as strong (ties → fresh)
  }
  // Preserve analyst-added incumbent peers even if the current player set dropped
  // them — an analyst curation must never silently vanish.
  for (const i of inc) {
    const k = normName(i.name);
    if (!used.has(k) && i.added_by === 'analyst') out.push(i);
  }
  return out;
}

/* ----------------------------------------------------------------------- *
 * Small stats
 * ----------------------------------------------------------------------- */

/** Median of a list of numbers (ignores non-finite). Returns null when empty. */
export function median(nums) {
  const xs = (nums || []).map(Number).filter((n) => isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
