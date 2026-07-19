import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactVersion } from '@abu24k/core-artifacts';

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
  '/v2/merchant/stores',
  '/v2/merchant/orders/exports',
  'exportMerchantOrders',
  '/v2/merchant/waybills/batches',
  '/v2/merchant/print-jobs',
];
const required = [
  '/v2/admin/global/resources',
  '/v2/admin/global/exports',
  '/v2/admin/catalog/products/batch-tags',
  '/v2/admin/catalog/products/batch-lifecycle',
  '/v2/admin/payments/',
  '/v2/admin/settlement-requests',
  '/v2/admin/settlement-transfers',
];

function files(path) {
  return readdirSync(path).flatMap((entry) => {
    const child = join(path, entry);
    return statSync(child).isDirectory() ? files(child) : [child];
  });
}

const violations = [];
let containsArtifactVersion = false;
let containsProductionCoreOrigin = false;
const foundRequired = new Set();
for (const file of files(root)) {
  if (!/\.(?:js|css|html)$/.test(file)) continue;
  const content = readFileSync(file, 'utf8');
  if (content.includes(artifactVersion)) containsArtifactVersion = true;
  if (/["'`]\/core["'`]/.test(content)) containsProductionCoreOrigin = true;
  for (const marker of required) if (content.includes(marker)) foundRequired.add(marker);
  for (const marker of forbidden) {
    if (content.includes(marker)) violations.push(`${file}: ${marker}`);
  }
}

if (!containsArtifactVersion) violations.push(`production bundle does not contain coordinated artifact ${artifactVersion}`);
if (!containsProductionCoreOrigin) violations.push('production bundle does not contain the /core API origin');
for (const marker of required) if (!foundRequired.has(marker)) violations.push(`production bundle does not contain required Admin operation ${marker}`);

const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
const localAssetUrls = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
  .map((match) => match[1])
  .filter((url) => url.startsWith('/'));
if (localAssetUrls.length === 0) violations.push('production index does not contain local assets');
for (const url of localAssetUrls) {
  if (!url.startsWith('/platform/assets/')) violations.push(`production index asset is outside /platform/: ${url}`);
}

if (violations.length > 0) {
  console.error(`Production bundle contains forbidden markers:\n${violations.join('\n')}`);
  process.exit(1);
}

console.log(`Production bundle check passed for ${artifactVersion}: coordinated Admin operations are present with no samples, deprecated actions, Merchant store-management calls, Merchant order-export calls or Merchant logistics paths.`);
