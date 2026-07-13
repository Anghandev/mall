#!/usr/bin/env node
import fs from 'node:fs';

const file = 'DEVICE_UX_RESULTS.md';
if (!fs.existsSync(file)) fail(`${file} missing`);
const text = fs.readFileSync(file, 'utf8');

const requiredCases = [
  '四页渲染与底部栏',
  '钱包连接 / Account / 断开',
  '非 BSC 切链',
  '拒签 approve',
  'approve 成功但 fund 拒签',
  'pending / 重开恢复',
  '微额成功支付'
];
for (const item of requiredCases) {
  if (!text.includes(item)) fail(`missing case: ${item}`);
}

const forbiddenPatterns = [/PRIVATE_KEY\s*=/i, /ADMIN_SECRET\s*=/i, /INDEXER_SECRET\s*=/i, /mnemonic\s*[:=]/i, /seed phrase\s*[:=]/i, /私钥\s*[:=]/i, /助记词\s*[:=]/i];
for (const pattern of forbiddenPatterns) {
  if (pattern.test(text)) fail(`possible secret in ${file}: ${pattern}`);
}

const unresolved = (text.match(/TODO/g) || []).length;
if (process.argv.includes('--require-pass')) {
  if (unresolved > 0) fail(`${file} still has ${unresolved} TODO markers`);
  if (!/Overall:\s*PASS/i.test(text)) fail('Overall must be PASS');
  if (!/Device UX gate:\s*PASS/i.test(text)) fail('Device UX gate must be PASS');
  for (const row of text.split('\n').filter((line) => /^\|\s*\d+\s*\|/.test(line))) {
    const cells = row.split('|').map((cell) => cell.trim());
    if (cells[4] !== 'PASS') fail(`checklist row is not PASS: ${row}`);
  }
  console.log('device UX results: PASS');
} else {
  console.log(`device UX results template: PASS (${unresolved} TODO markers remain)`);
}

function fail(message) {
  console.error(`device UX results check failed: ${message}`);
  process.exit(1);
}
