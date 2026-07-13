import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const projects = [
  {
    name: 'mall',
    prefix: 'MAL-',
    source: 'mall-v2/docs/requirements/PRD-7.5.01.txt',
    record: 'mall-v2/docs/requirements/SOURCE.md',
    matrix: 'mall-v2/docs/requirements/REQUIREMENTS_MATRIX.md',
    gaps: 'mall-v2/docs/contracts/UPSTREAM_GAPS.md',
  },
  {
    name: 'merchant',
    prefix: 'MER-',
    source: 'merchant-v2/docs/requirements/PRD-MERCHANT-WORKBENCH.txt',
    record: 'merchant-v2/docs/requirements/SOURCE.md',
    matrix: 'merchant-v2/docs/requirements/REQUIREMENTS_MATRIX.md',
    gaps: 'merchant-v2/docs/contracts/UPSTREAM_GAPS.md',
  },
  {
    name: 'platform-admin',
    prefix: 'ADM-',
    source: 'platform-v2/docs/requirements/PLATFORM_ADMIN_SPEC.txt',
    record: 'platform-v2/docs/requirements/SOURCE.md',
    matrix: 'platform-v2/admin/docs/requirements/REQUIREMENTS_MATRIX.md',
    gaps: 'platform-v2/admin/docs/contracts/UPSTREAM_GAPS.md',
  },
];

const allowedStatuses = new Set([
  'Frozen',
  'Overridden',
  'DecisionBlocked',
  'ExternalBlocked',
  'Verified',
]);
const allIds = new Set();
const decisionText = readFileSync('docs/V2_DECISIONS.md', 'utf8');
const decisionIds = new Set(decisionText.match(/D-V2-\d{3}/g) ?? []);

function isFormattingOnly(line) {
  const value = line.trim();
  return value === '' || value === '---' || value === 'Plaintext' ||
    /^\+[+-]+\+$/.test(value) || /^\|[\s|+-]*\|?$/.test(value);
}

function parseMatrixRows(text, prefix) {
  return text.split('\n').filter((line) => line.startsWith(`| ${prefix}`)).map((line) => {
    const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
    if (cells.length !== 7) {
      throw new Error(`Expected 7 matrix columns: ${line}`);
    }
    return {
      id: cells[0],
      source: cells[1],
      decision: cells[3],
      status: cells[5],
      gap: cells[6],
    };
  });
}

for (const project of projects) {
  const source = readFileSync(project.source, 'utf8');
  const record = readFileSync(project.record, 'utf8');
  const matrix = readFileSync(project.matrix, 'utf8');
  const gaps = readFileSync(project.gaps, 'utf8');
  const hash = createHash('sha256').update(source).digest('hex');
  if (!record.includes(hash)) {
    throw new Error(`${project.name}: SOURCE.md does not contain local SHA-256 ${hash}`);
  }

  const rows = parseMatrixRows(matrix, project.prefix);
  if (rows.length === 0) throw new Error(`${project.name}: no matrix rows found`);
  const covered = new Set();

  for (const row of rows) {
    if (allIds.has(row.id)) throw new Error(`Duplicate Requirement ID: ${row.id}`);
    allIds.add(row.id);
    if (!allowedStatuses.has(row.status)) {
      throw new Error(`${row.id}: invalid status ${row.status}`);
    }
    if (row.status === 'Overridden' && !/D-V2-\d{3}/.test(row.decision)) {
      throw new Error(`${row.id}: Overridden row has no Decision ID`);
    }
    for (const id of row.decision.match(/D-V2-\d{3}/g) ?? []) {
      if (!decisionIds.has(id)) throw new Error(`${row.id}: unknown Decision ID ${id}`);
    }
    for (const gap of row.gap.match(/GAP-[A-Z]+-\d{3}/g) ?? []) {
      if (!gaps.includes(gap)) throw new Error(`${row.id}: unknown Core gap ${gap}`);
    }
    for (const match of row.source.matchAll(/(\d+)(?:-(\d+))?/g)) {
      const start = Number(match[1]);
      const end = Number(match[2] ?? match[1]);
      if (start < 1 || end < start) throw new Error(`${row.id}: invalid line range`);
      for (let line = start; line <= end; line += 1) covered.add(line);
    }
  }

  const sourceLines = source.split('\n');
  const missing = [];
  sourceLines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!isFormattingOnly(line) && !covered.has(lineNumber)) missing.push(lineNumber);
  });
  if (missing.length > 0) {
    throw new Error(`${project.name}: unmapped source lines ${missing.join(', ')}`);
  }
  console.log(`OK ${project.name}: ${rows.length} requirements, SHA-256 ${hash}`);
}

const retiredInterfaces = [
  'docs/INTEGRATION_PROTOCOL.md',
  'mall-v2/docs/contracts/UPSTREAM_API.md',
  'mall-v2/docs/contracts/UPSTREAM_WEB3.md',
];
const bannedInterfaceTokens = [
  'refundPreview',
  'requestTimeoutRefund',
  'RefundReserve',
  'timeout-refund',
];
for (const path of retiredInterfaces) {
  const text = readFileSync(path, 'utf8');
  for (const token of bannedInterfaceTokens) {
    if (text.includes(token)) throw new Error(`${path}: stale interface token ${token}`);
  }
}

console.log(`OK decisions: ${decisionIds.size}`);
console.log(`OK requirements: ${allIds.size} unique Requirement IDs`);
console.log('OK retired refund interface tokens absent');
