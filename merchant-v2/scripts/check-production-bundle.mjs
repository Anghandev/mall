import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactVersion } from '@abu24k/core-artifacts';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const textExtensions = new Set(['.css', '.html', '.js', '.map']);
const forbidden = [
  'legacy/' + 'v1-npl-only',
  '__merchant_visual_review__',
  '2.0.0-rc.2',
  '2.0.0-payment.1',
  '2.0.0-fulfillment.1',
  'CLAIM_' + 'MERCHANT_USDT',
  'Payment' + 'Escrow',
  'Claim' + 'Vault',
  '5,000.00',
  '2,300.00',
  '0x7a...9b3c',
  '0x4f...1e2d',
  '2026-07-05 12:00',
  '2026-07-04 09:15',
];

let filesChecked = 0;
let sawCoreBoundary = false;
let sawArtifactVersion = false;

for (const path of walk(dist)) {
  if (!textExtensions.has(extname(path))) continue;
  filesChecked += 1;
  const contents = readFileSync(path, 'utf8');
  sawCoreBoundary ||= contents.includes('支付、履约与结算后台批次已发布');
  sawArtifactVersion ||= contents.includes(artifactVersion);
  for (const token of forbidden) {
    if (contents.includes(token)) throw new Error(`Production bundle contains forbidden token: ${token}`);
  }
}

if (!sawCoreBoundary) {
  throw new Error('Production bundle is missing the coordinated settlement-admin boundary');
}

if (!sawArtifactVersion) {
  throw new Error('Production bundle is missing the coordinated Core artifact version');
}

console.log(`OK merchant production bundle: ${filesChecked} text files, no review bypass or sample records`);

function* walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}
