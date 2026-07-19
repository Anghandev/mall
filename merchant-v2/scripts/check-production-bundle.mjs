import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactVersion } from '@abu24k/core-artifacts';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const textExtensions = new Set(['.css', '.html', '.js', '.map']);
const coreBoundary = '支付、履约、替代商家接管、结算、商品、媒体、商家资料、审计与订单导出能力已发布；平台全局运营与清算读取保持 Admin-only';
const publicBasePath = '/merchant/';
const routerBasename = '/merchant';
const coreApiBaseUrl = '/core';
const forbidden = [
  'legacy/' + 'v1-npl-only',
  '__merchant_visual_review__',
  '2.0.0-rc.2',
  '2.0.0-payment.1',
  '2.0.0-fulfillment.1',
  '2.0.0-settlement-admin.2',
  '2.0.0-settlement-admin.3',
  '2.0.0-settlement-admin.6',
  '2.0.0-logistics.1',
  '2.0.0-merchant-lifecycle.1',
  '2.0.0-logistics-admin.1',
  '2.0.0-merchant-stores.1',
  '2.0.0-merchant-fulfillment.1',
  '/v2/admin/logistics/',
  '/v2/admin/global/resources',
  '/v2/admin/global/exports',
  '/v2/admin/catalog/products/batch-tags',
  '/v2/admin/settlement-intents',
  '/v2/admin/settlement-requests',
  '/v2/admin/settlement-batches',
  '/v2/admin/coverage-breaker/',
  'CLAIM_' + 'MERCHANT_USDT',
  'Payment' + 'Escrow',
  'Claim' + 'Vault',
  '5,000.00',
  '2,300.00',
  '0x7a...9b3c',
  '0x4f...1e2d',
  '2026-07-05 12:00',
  '2026-07-04 09:15',
  'merchant-orders-2026-07-01-2026-07-15.xls',
  'PFdvcmtib29rPjxSb3c+b3JkZXI8L1Jvdz48L1dvcmtib29rPg==',
  'takeover-case-assigned-1',
  'SF-REPLACEMENT-001',
  'replacement-shipment-result',
];

let filesChecked = 0;
let sawCoreBoundary = false;
let sawArtifactVersion = false;
let sawCoreApiBaseUrl = false;
let sawRouterBasename = false;

for (const path of walk(dist)) {
  if (!textExtensions.has(extname(path))) continue;
  filesChecked += 1;
  const contents = readFileSync(path, 'utf8');
  sawCoreBoundary ||= contents.includes(coreBoundary);
  sawArtifactVersion ||= contents.includes(artifactVersion);
  if (extname(path) === '.js') {
    sawCoreApiBaseUrl ||= /function\s+\w+\(\w+=[`'"]\/core[`'"]\)/.test(contents);
    sawRouterBasename ||= /basename:[A-Za-z_$][\w$]*\.routerBasename/.test(contents);
  }
  for (const token of forbidden) {
    if (contents.includes(token)) throw new Error(`Production bundle contains forbidden token: ${token}`);
  }
}

if (!sawCoreBoundary) {
  throw new Error('Production bundle is missing the coordinated Core boundary');
}

if (!sawArtifactVersion) {
  throw new Error('Production bundle is missing the coordinated Core artifact version');
}

const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');
const assetReferences = [...indexHtml.matchAll(/(?:src|href)="(\/merchant\/assets\/[^"?#]+)(?:[?#][^"]*)?"/g)]
  .map((match) => match[1]);
if (assetReferences.length === 0 || /(?:src|href)="\/assets\//.test(indexHtml)) {
  throw new Error('Production HTML must reference static assets under /merchant/assets/');
}
for (const reference of assetReferences) {
  const assetPath = join(dist, reference.slice(publicBasePath.length));
  if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
    throw new Error(`Production HTML references a missing static asset: ${reference}`);
  }
}

if (!sawRouterBasename) {
  throw new Error(`Production bundle is missing the BrowserRouter basename: ${routerBasename}`);
}
if (!sawCoreApiBaseUrl) {
  throw new Error(`Production bundle is missing the fixed Core API base URL: ${coreApiBaseUrl}`);
}

console.log(`OK merchant production bundle: ${filesChecked} text files, ${assetReferences.length} /merchant/ assets, /core API base, no review bypass or sample records`);

function* walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}
