/**
 * scripts/seed-report.mjs — write a deterministic consolidated report into a
 * committed industry JSON, so the Report tab renders immediately. The pipeline
 * upgrades this to the richer Bedrock narrative on the next full rebuild (a
 * 'fallback' report is always re-attempted; an 'llm' report is cached by hash).
 *   node scripts/seed-report.mjs <slug>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deterministicReport } from '../lib/report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'public', 'data', 'industries');
const slug = process.argv[2];
if (!slug) { console.error('usage: node scripts/seed-report.mjs <slug>'); process.exit(1); }
const file = join(DATA_DIR, `${slug}.json`);
if (!existsSync(file)) { console.error(`no ${file}`); process.exit(1); }
const obj = JSON.parse(readFileSync(file, 'utf8'));
obj.summary = (obj.summary && typeof obj.summary === 'object') ? obj.summary : {};
const rep = deterministicReport(obj);
rep.generated_at = (obj.meta && obj.meta.generated_at) || new Date().toISOString().slice(0, 10);
obj.summary.report = rep;
writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
console.log(`seeded ${slug}: ${rep.sections.length} sections (${rep.kind}), hash ${rep.hash}`);
console.log('headings:', rep.sections.map((s) => s.heading).join(' · '));
