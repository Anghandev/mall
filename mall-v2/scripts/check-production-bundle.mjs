import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const roots = ['src', 'dist'];
const forbidden = [
  { pattern: /legacy\/v1-npl-only/i, reason: 'V2 runtime references legacy source' },
  { pattern: /__MALL_TEST_FIXTURE__/i, reason: 'test fixture marker entered production' },
  { pattern: /2\.0\.0-rc\.2/i, reason: 'stale coordinated artifact entered production' },
  { pattern: /2\.0\.0-fulfillment\.1/i, reason: 'stale fulfillment checkpoint entered production' },
  { pattern: /2\.0\.0-settlement-admin\.[1-9]/i, reason: 'stale settlement checkpoint entered production' },
  { pattern: /maxSizeBytes/i, reason: 'retired media upload field entered production' },
  { pattern: /canonical evidence 生成\/上传契约尚未发布/i, reason: 'retired evidence placeholder entered production' },
  { pattern: /PaymentEscrowV2|ClaimVaultV2|BNMTokenV2|CLAIM_[A-Z_]+/i, reason: 'retired funds surface entered production' },
  { pattern: /申请退款|强制退款|无理由退款/i, reason: 'business-refund copy entered production' },
  { pattern: /\/v2\/admin\/global\/resources/i, reason: 'Admin global search entered Mall production' },
  { pattern: /\/v2\/admin\/global\/exports/i, reason: 'Admin resource export entered Mall production' },
  { pattern: /\/v2\/admin\/catalog\/products\/batch-tags/i, reason: 'Admin product batch tags entered Mall production' },
  { pattern: /adminGlobalResourceSearchHttp|adminResourceExportHttp|adminProductBatchTaggingHttp/i, reason: 'Admin-only capability metadata entered Mall production' },
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
