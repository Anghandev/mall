import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const forbidden = [
  'mockAdminRecords',
  'fixtureAdminRecords',
  'sampleOrderTxHash',
  '平台强行退款',
  '2.0.0-rc.2',
  'USDT Claim',
  'NPL/BNM Claim',
  'Escrow',
];

function files(path) {
  return readdirSync(path).flatMap((entry) => {
    const child = join(path, entry);
    return statSync(child).isDirectory() ? files(child) : [child];
  });
}

const violations = [];
for (const file of files(root)) {
  if (!/\.(?:js|css|html)$/.test(file)) continue;
  const content = readFileSync(file, 'utf8');
  for (const marker of forbidden) {
    if (content.includes(marker)) violations.push(`${file}: ${marker}`);
  }
}

if (violations.length > 0) {
  console.error(`Production bundle contains forbidden markers:\n${violations.join('\n')}`);
  process.exit(1);
}

console.log('Production bundle check passed: no production sample data or deprecated action markers.');
