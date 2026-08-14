/**
 * scripts/migrate-store.mjs — seed the fact ledger from an already-committed
 * dashboard JSON, so nothing already gathered is lost when the additive store
 * turns on. Idempotent: re-running reproduces the same ledger.
 *
 * Usage:  node scripts/migrate-store.mjs [slug]
 *         node scripts/migrate-store.mjs            # all industries in index.json
 *
 * The research pipeline also auto-seeds on its own if it finds a committed file
 * but an empty ledger — so this script is mainly for a one-time, explicit backfill.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factsFromAssembled, upsertFacts, saveLedger, supportByCategory, mergeCoverage } from '../lib/store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'public', 'data', 'industries');
const STORE_ROOT = join(ROOT, 'data', 'store');

function today() { return new Date().toISOString().slice(0, 10); }

/** Derive a per-section "as of" year from the facts we can date. */
function sectionDates(obj) {
  const out = {};
  const set = (sec, y) => { if (y && (!out[sec] || String(y) > String(out[sec]))) out[sec] = `${y}-01-01`; };
  if (obj.size && obj.size.current) set('size', obj.size.current.year);
  for (const h of ((obj.size && obj.size.history) || [])) set('size', h.year);
  for (const c of ((obj.quant && obj.quant.capacity) || [])) set('quant', c.year);
  for (const im of ((obj.quant && obj.quant.imports) || [])) set('quant', im.year);
  if (obj.meta && obj.meta.generated_at) for (const s of ['segments', 'growth_drivers', 'value_chain', 'channels', 'players', 'margins']) set(s, obj.meta.generated_at.slice(0, 4));
  return out;
}

function migrateOne(slug) {
  const file = join(DATA_DIR, `${slug}.json`);
  if (!existsSync(file)) { console.warn(`[migrate] ${slug}: no ${file}, skipping.`); return; }
  let obj;
  try { obj = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error(`[migrate] ${slug}: unreadable JSON (${e.message})`); return; }
  if (obj.meta && obj.meta.mock) { console.log(`[migrate] ${slug}: mock data, skipping.`); return; }

  const now = (obj.meta && obj.meta.generated_at) || today();
  const facts = factsFromAssembled(obj);
  const ledger = upsertFacts([], facts, { runId: 'migration', now });

  const storeDir = join(STORE_ROOT, slug);
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  saveLedger(join(storeDir, 'facts.jsonl'), ledger);
  const support = supportByCategory(ledger);
  const coverage = mergeCoverage({}, support, sectionDates(obj));
  writeFileSync(join(storeDir, 'coverage.json'), JSON.stringify(coverage, null, 2) + '\n');

  const bySec = {};
  for (const f of ledger) bySec[f.section] = (bySec[f.section] || 0) + 1;
  console.log(`[migrate] ${slug}: seeded ${ledger.length} facts -> ${storeDir}`);
  console.log(`[migrate] ${slug}: by section ${JSON.stringify(bySec)}`);
  console.log(`[migrate] ${slug}: support ${JSON.stringify(Object.fromEntries(Object.entries(support).map(([k, v]) => [k, v.sources])))}`);
}

function main() {
  const arg = process.argv[2];
  if (arg) { migrateOne(arg); return; }
  const indexPath = join(DATA_DIR, 'index.json');
  if (!existsSync(indexPath)) { console.error('[migrate] no index.json and no slug given.'); process.exit(1); }
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  for (const e of (index.industries || [])) if (e && e.slug && !e.mock) migrateOne(e.slug);
}

main();
