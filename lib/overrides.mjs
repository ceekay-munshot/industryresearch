/**
 * lib/overrides.mjs — analyst add/edit overrides (pure, dependency-free).
 *
 * Analysts can correct or add data from the dashboard. Each correction is one
 * append-only record in data/store/<slug>/overrides.jsonl:
 *
 *   { section, target, field, value, note?, source_url?, added_by:"analyst", added_at }
 *
 * These are AUTHORITATIVE: the pipeline replays them LAST (after every auto step,
 * including write-if-better and benchmarking), so an automated refresh can never
 * clobber an analyst's correction — the corrected field is always re-applied on
 * top. A correction badges just that field/item ("analyst"); auto fields it didn't
 * touch keep refreshing. A brand-new item the analyst ADDED is marked
 * added_by:"analyst" so the benchmarking merge never drops it either.
 *
 * No node builtins — plain JS only, so this same module runs in the pipeline and
 * mirrors the Worker's inline apply (kept byte-for-byte in behaviour, tested on
 * both sides).
 */

/* Array sections: items are identified by a human key (name / title / …). */
export const ARRAY_SECTIONS = {
  players: { key: 'name' },
  segments: { key: 'name' },
  benchmarking: { key: 'name', path: 'peers' },   // obj.benchmarking.peers
  growth_drivers: { key: 'title' },
  channels: { key: 'channel' },
  value_chain: { key: 'stage' },
  tailwinds: { key: 'point' },
  headwinds: { key: 'point' },
  highlights: { key: 'label' },
};

/* Scalar sections: a single object; `fieldMap` routes a friendly field to a path. */
export const SCALAR_SECTIONS = {
  size: { fieldMap: { value: 'current.value', unit: 'current.unit', year: 'current.year', cagr_pct: 'cagr_pct', cagr_note: 'cagr_note' } },
  margins: { fieldMap: { manufacturer_pct: 'manufacturer_pct', retailer_pct: 'retailer_pct', notes: 'notes' } },
};

/* Fields coerced to numbers when the analyst types "18.4" / "1,650" / "12%". */
export const NUMERIC_FIELDS = new Set([
  'value', 'year', 'cagr_pct', 'share_pct', 'market_share_pct',
  'revenue', 'revenue_year', 'revenue_cagr_3y_pct', 'ebitda_pct', 'ebitda_margin_pct',
  'pat_pct', 'roce_pct', 'roe_pct', 'manufacturer_pct', 'retailer_pct', 'utilisation_pct',
]);

const BENCH_METRIC_FIELDS = new Set(['revenue', 'revenue_cagr_3y_pct', 'ebitda_pct', 'pat_pct', 'roce_pct', 'roe_pct']);

/** Normalize a human key for matching (case/punct-insensitive). */
export function normKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Coerce a typed value: numeric fields → Number (tolerant of commas/%/₹), else trimmed string. */
export function coerceValue(field, value) {
  if (value == null) return value;
  if (NUMERIC_FIELDS.has(field)) {
    const n = Number(String(value).replace(/[,%\s₹$]/g, ''));
    if (isFinite(n)) return n;
  }
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Validate + sanitize one edit from the dashboard. Returns { ok:true, override }
 * (the record to append, minus added_at which the writer stamps) or
 * { ok:false, error }. Rejects unknown sections, missing field/value, a missing
 * target for array sections, and a non-http source_url.
 */
export function validateOverride(edit) {
  if (!edit || typeof edit !== 'object') return { ok: false, error: 'empty edit' };
  const section = String(edit.section || '').trim();
  const field = String(edit.field || '').trim().replace(/[^a-z0-9_]/gi, '');
  if (!ARRAY_SECTIONS[section] && !SCALAR_SECTIONS[section]) return { ok: false, error: 'unknown section' };
  if (!field) return { ok: false, error: 'missing field' };
  const isArray = !!ARRAY_SECTIONS[section];
  const target = String(edit.target || '').trim().slice(0, 160);
  if (isArray && !target) return { ok: false, error: 'missing target' };
  if (edit.value == null || String(edit.value).trim() === '') return { ok: false, error: 'missing value' };
  const source_url = String(edit.source_url || '').trim();
  if (source_url && !/^https?:\/\//i.test(source_url)) return { ok: false, error: 'invalid source_url' };
  const note = String(edit.note || '').trim().slice(0, 200);
  const override = { section, target: isArray ? target : '', field, value: coerceValue(field, edit.value), added_by: 'analyst' };
  if (note) override.note = note;
  if (source_url) override.source_url = source_url;
  return { ok: true, override };
}

/** Parse an overrides.jsonl blob into an array of records (tolerant — skips junk). */
export function parseOverrides(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (o && typeof o === 'object') out.push(o); } catch (e) { /* skip a corrupt line */ }
  }
  return out;
}

/** One override → a JSONL line. */
export function serializeOverride(o) { return JSON.stringify(o); }

function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!node[k] || typeof node[k] !== 'object') node[k] = {};
    node = node[k];
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * Apply ONE override to an assembled dashboard object, in place, returning it.
 * Array sections: find the item by key===target (case/punct-insensitive) and set
 * the field; create it if absent (a new analyst item is added_by:"analyst"). The
 * touched field is badged via item.analyst + item.analyst_fields. Scalar sections
 * set the mapped path and badge the section object the same way. A source_url
 * attaches an analyst source. Unknown sections are ignored (never-fail).
 */
export function applyOne(obj, ov) {
  if (!obj || typeof obj !== 'object' || !ov || typeof ov !== 'object') return obj;
  const section = ov.section;
  const field = String(ov.field || '').trim();
  if (!section || !field) return obj;
  const value = coerceValue(field, ov.value);
  const src = ov.source_url ? { label: (ov.note ? String(ov.note).slice(0, 80) : 'Analyst edit'), url: ov.source_url, snippet: '' } : null;

  if (ARRAY_SECTIONS[section]) {
    const spec = ARRAY_SECTIONS[section];
    let container;
    if (spec.path) {
      if (!obj[section] || typeof obj[section] !== 'object') obj[section] = {};
      if (!Array.isArray(obj[section][spec.path])) obj[section][spec.path] = [];
      container = obj[section][spec.path];
    } else {
      if (!Array.isArray(obj[section])) obj[section] = [];
      container = obj[section];
    }
    const target = String(ov.target || '').trim();
    if (!target) return obj;
    let item = container.find((x) => x && normKey(x[spec.key]) === normKey(target));
    const isNew = !item;
    if (!item) { item = { [spec.key]: target }; container.push(item); }
    if (value !== undefined) item[field] = value;
    item.analyst = true;
    if (!Array.isArray(item.analyst_fields)) item.analyst_fields = [];
    if (!item.analyst_fields.includes(field)) item.analyst_fields.push(field);
    if (isNew) item.added_by = 'analyst';
    if (src) item.source = src;
    // A financial correction on a benchmarking peer clears its "pending" flag.
    if (section === 'benchmarking' && BENCH_METRIC_FIELDS.has(field)) { item.pending = false; if (item.listed === undefined) item.listed = true; }
    return obj;
  }

  if (SCALAR_SECTIONS[section]) {
    const spec = SCALAR_SECTIONS[section];
    if (!obj[section] || typeof obj[section] !== 'object') obj[section] = {};
    const container = obj[section];
    setPath(container, (spec.fieldMap && spec.fieldMap[field]) || field, value);
    container.analyst = true;
    if (!Array.isArray(container.analyst_fields)) container.analyst_fields = [];
    if (!container.analyst_fields.includes(field)) container.analyst_fields.push(field);
    if (src) container.source = src;
    return obj;
  }
  return obj;   // unknown section → ignore
}

/** Apply many overrides in order (last write wins per field). Returns obj. */
export function applyOverrides(obj, overrides) {
  for (const ov of (overrides || [])) applyOne(obj, ov);
  return obj;
}
