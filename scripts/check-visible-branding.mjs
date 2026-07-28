import { readFileSync } from 'node:fs';

const visibleFiles = [
  'README.md',
  'package.json',
  'mall-v2/README.md',
  'mall-v2/index.html',
  'mall-v2/src/App.tsx',
  'mall-v2/src/screens.tsx',
  'merchant-v2/README.md',
  'merchant-v2/PRODUCT.md',
  'merchant-v2/index.html',
  'merchant-v2/src/components/WorkspaceShell.tsx',
  'merchant-v2/src/pages/LoginPage.tsx',
  'platform-v2/README.md',
  'platform-v2/package.json',
  'platform-v2/admin/README.md',
  'platform-v2/admin/index.html',
  'platform-v2/admin/src/components/AppShell.tsx',
  'platform-v2/docs/ARCHITECTURE.md',
  'platform-v2/scripts/generate-core-artifacts.mjs',
  'platform-v2/server/api/app.ts',
  'platform-v2/server/data/logistics-printing-service.ts',
  'platform-v2/server/operations/eoa-runtime-service.ts',
  'platform-v2/server/start.ts',
  'packages/core-artifacts/openapi/openapi.json',
  'docs/V2_API_SPEC.md',
  'docs/V2_CONTRACT_SPEC.md',
  'docs/V2_DATA_MODEL.md',
  'docs/V2_LEGACY_ISOLATION_REPORT.md',
  'docs/V2_PRELAUNCH_ACCEPTANCE_CHECKLIST.md',
  'docs/V2_PRELAUNCH_ACCEPTANCE_REPORT.md',
  'docs/V2_PRODUCTION_RELEASE_REPORT.md',
  'docs/V2_SYSTEM_CONTRACT.md',
  'docs/V2_WORKERS_SPEC.md',
];

const forbidden = [
  /阿步/u,
  /Abu\s+24K/iu,
  /ABU SELECT/u,
  /24K 商城/u,
  /24K (?:Mall|Merchant|Platform)/iu,
];

for (const path of visibleFiles) {
  const text = readFileSync(path, 'utf8');
  for (const pattern of forbidden) {
    if (pattern.test(text)) throw new Error(`${path}: visible legacy brand ${pattern}`);
  }
}

const required = new Map([
  ['mall-v2/src/App.tsx', '24K商城首页'],
  ['merchant-v2/src/pages/LoginPage.tsx', '24K商城 · 商家工作台'],
  ['platform-v2/admin/src/components/AppShell.tsx', '<strong>24K商城</strong>'],
  ['platform-v2/server/api/app.ts', 'Sign in to 24K商城 V2'],
  ['packages/core-artifacts/openapi/openapi.json', '24K商城 V2 Core API'],
]);

for (const [path, value] of required) {
  if (!readFileSync(path, 'utf8').includes(value)) throw new Error(`${path}: missing ${value}`);
}

console.log(`OK visible brand: 24K商城 across ${visibleFiles.length} public surfaces`);
console.log('OK internal Abu24K protocol and package identifiers remain outside the display-name rule');
