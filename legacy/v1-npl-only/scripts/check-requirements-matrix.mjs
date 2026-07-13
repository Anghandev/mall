#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const file = process.env.REQUIREMENTS_MATRIX_FILE || 'docs/REQUIREMENTS_MATRIX.md';
const requireDone = process.argv.includes('--require-done');
const allowed = new Set(['Done', 'Partial', 'Missing', 'ExternalBlocked']);
const rows = readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .filter((line) => /^\| (?:MALL|MER|ADM)-\d+ \|/.test(line))
  .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));

const errors = [];
const ids = new Set();
for (const cells of rows) {
  if (cells.length !== 7) errors.push(`${cells[0] || '<unknown>'}: expected 7 columns, received ${cells.length}`);
  const [id, original, acceptance, codeEvidence, testEvidence, status, blocker] = cells;
  if (ids.has(id)) errors.push(`${id}: duplicate requirementId`);
  ids.add(id);
  if (!original || !acceptance || !codeEvidence || !testEvidence || !blocker) errors.push(`${id}: required matrix field is empty`);
  if (!allowed.has(status)) errors.push(`${id}: invalid status ${status}`);
}

if (rows.length === 0) errors.push('No requirement rows found.');
const counts = Object.fromEntries([...allowed].map((status) => [status, rows.filter((cells) => cells[5] === status).length]));
if (requireDone && counts.Done !== rows.length) errors.push(`Launch gate requires all ${rows.length} rows Done.`);

const result = { ok: errors.length === 0, requireDone, file, total: rows.length, counts, errors };
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exit(1);
