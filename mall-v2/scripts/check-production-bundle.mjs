import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const roots = ['src', 'dist'];
const forbidden = [
  { pattern: /legacy\/v1-npl-only/i, reason: 'V2 runtime references legacy source' },
  { pattern: /__MALL_TEST_FIXTURE__/i, reason: 'test fixture marker entered production' },
  { pattern: /申请退款|强制退款|无理由退款/i, reason: 'business-refund copy entered production' },
];

for (const root of roots) {
  for (const file of await walk(root)) {
    if (!['.js', '.css', '.html', '.ts', '.tsx'].includes(extname(file))) continue;
    const content = await readFile(file, 'utf8');
    for (const check of forbidden) {
      if (check.pattern.test(content)) {
        throw new Error(`${check.reason}: ${file}`);
      }
    }
  }
}

console.log('Mall production bundle check passed');

async function walk(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else output.push(path);
  }
  return output;
}
