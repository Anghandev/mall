#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

const ROOT_OUT_DIR = process.env.DAPP_FRONTEND_PACK_ROOT_DIR || 'test-artifacts';
const PACK_NAME = process.env.DAPP_FRONTEND_PACK_NAME || 'dapp-frontend-pack';
const rootOutDir = resolve(ROOT_OUT_DIR);
const packDir = resolve(rootOutDir, PACK_NAME);
const tarball = resolve(rootOutDir, `${PACK_NAME}.tar.gz`);
const manifestFile = resolve(packDir, 'pack-manifest.json');
const legacySettlementAsset = ['US', 'DT'].join('');

const requiredArtifacts = [
  'dapp-frontend-thread-prompt.md',
  'dapp-frontend.env',
  'dapp-sdk.ts',
  'dapp-types.d.ts',
  'dapp-frontend-handoff.bundle.json',
  'dapp-contracts.json',
  'dapp-openapi.json',
  'dapp-launch-kit.json',
  'dapp-launch-status.json',
  'dapp-launch-status.md',
  'dapp-status.md',
  'dapp-status.report.json',
  'dapp-wallet-launch.md',
  'dapp-wallet-launch.json',
  'dapp-wallet-launch.env',
  'dapp-deploy-readiness.md',
  'dapp-deploy-readiness.json',
  'dapp-deploy-public.todo.env',
  'dapp-strict-gate.md',
  'dapp-strict-gate.report.json',
  'dapp-frontend-consumption.report.json',
  'dapp-frontend-env-check.report.json',
  'dapp-frontend-env.report.json'
];

fs.mkdirSync(rootOutDir, { recursive: true });
runNode('scripts/check-dapp-frontend-consumption.mjs', [], {
  DAPP_FRONTEND_CHECK_OUT_DIR: rootOutDir,
  DAPP_FRONTEND_ENV_OUT_DIR: rootOutDir,
  DAPP_HANDOFF_OUT_DIR: rootOutDir
});
runNode('scripts/export-dapp-launch-status.mjs', [], {
  DAPP_LAUNCH_STATUS_OUT_DIR: rootOutDir
});
runNode('scripts/export-dapp-wallet-launch.mjs', [], {
  DAPP_WALLET_LAUNCH_OUT_DIR: rootOutDir,
  DAPP_FRONTEND_ENV_OUT_DIR: rootOutDir
});
runNode('scripts/export-dapp-deploy-readiness.mjs', [], {
  DAPP_DEPLOY_READINESS_OUT_DIR: rootOutDir
});
runNode('scripts/check-dapp-strict-gate.mjs', [], {
  DAPP_STRICT_GATE_OUT_DIR: rootOutDir,
  DAPP_DEPLOY_READINESS_OUT_DIR: rootOutDir,
  DAPP_WALLET_LAUNCH_OUT_DIR: rootOutDir,
  DAPP_FRONTEND_ENV_OUT_DIR: rootOutDir
});
runNode('scripts/report-dapp-status.mjs', [], {
  DAPP_STATUS_OUT_DIR: rootOutDir,
  DAPP_FRONTEND_ENV_FILE: resolve(rootOutDir, 'dapp-frontend.env'),
  DAPP_FRONTEND_ENV_CHECK_REPORT: resolve(rootOutDir, 'dapp-frontend-env-check.report.json')
});

fs.rmSync(packDir, { recursive: true, force: true });
fs.mkdirSync(packDir, { recursive: true });

const copied = [];
for (const name of requiredArtifacts) {
  const source = resolve(rootOutDir, name);
  assert(fs.existsSync(source), `Required frontend artifact missing: ${source}`);
  const target = resolve(packDir, name);
  fs.copyFileSync(source, target);
  copied.push(target);
}

fs.writeFileSync(resolve(packDir, 'README.md'), renderPackReadme());
copied.unshift(resolve(packDir, 'README.md'));

const secretScan = scanForSecrets(copied);
assert(secretScan.blockers.length === 0, `Frontend pack secret scan failed:\n${secretScan.blockers.join('\n')}`);
const settlementResidue = copied.filter((file) => fs.readFileSync(file, 'utf8').toLowerCase().includes(legacySettlementAsset.toLowerCase()));
assert(settlementResidue.length === 0, `Frontend pack contains legacy settlement fields:\n${settlementResidue.join('\n')}`);
const placeholderAddresses = ['0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555'];
const placeholderFiles = copied.filter((file) => placeholderAddresses.some((address) => fs.readFileSync(file, 'utf8').toLowerCase().includes(address)));
assert(placeholderFiles.length === 0, `Frontend pack contains fixture contract addresses:\n${placeholderFiles.join('\n')}`);

const files = copied.map((file) => fileInfo(file));
const manifest = {
  kind: '24k-dapp-frontend-pack',
  generatedAt: new Date().toISOString(),
  rootOutDir,
  packDir,
  tarball,
  fixedNpl: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2',
  privateKeyPrinted: false,
  serverSecretsIncluded: false,
  secretScan,
  files
};
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

createTarball();
const tarballInfo = fileInfo(tarball);

console.log('DApp frontend pack export: PASS');
console.log(`pack dir: ${packDir}`);
console.log(`tarball: ${tarball}`);
console.log(`tarball sha256: ${tarballInfo.sha256}`);
console.log('PRIVATE_KEY assignment included: false');
console.log('server secret assignment included: false');

function runNode(script, args = [], extraEnv = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function createTarball() {
  fs.rmSync(tarball, { force: true });
  const result = spawnSync('tar', ['-czf', tarball, '-C', rootOutDir, PACK_NAME], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`tar failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  assert(fs.existsSync(tarball), `Tarball was not created: ${tarball}`);
}

function renderPackReadme() {
  return `# 24K DApp Frontend Pack

这个目录是给另一个 DApp 前端项目 / 前端 Codex 对话框直接使用的公开交接包。它只包含公开接口、公开合约地址、SDK、类型和检查报告；不包含部署钱包、服务端密钥或链上花 gas 的材料。

## 先看这几个文件

1. \`dapp-frontend-thread-prompt.md\`：复制整份给另一个前端对话框作为任务提示词。
2. \`dapp-frontend.env\`：复制到前端项目的 env 文件，再把占位符换成真实 HTTPS 域名 / Reown project id / 已部署合约地址。
3. \`dapp-sdk.ts\`：前端可直接复制的 fetch + 钱包交易 helpers。
4. \`dapp-types.d.ts\`：接口类型。
5. \`dapp-frontend-handoff.bundle.json\`：一站式 JSON 包，含 launchKit、handoff、integration、readiness、bootstrap、OpenAPI、types、SDK 和前端 brief。
6. \`dapp-launch-status.json\` / \`dapp-launch-status.md\`：后端运行时 strict launch blockers + critical path。
7. \`dapp-status.md\`：当前后端 / 交接物 / env 缺口摘要。
8. \`dapp-wallet-launch.md\`：给“手机钱包/DEX 浏览器输入网址打开 DApp”的 HTTPS 上线检查清单。
9. \`dapp-deploy-readiness.md\`：无私钥、无交易的合约部署与生产配置准备清单。
10. \`dapp-strict-gate.md\`：最终上线总门禁，聚合部署、钱包入口、前端 env 和生产 env strict 检查。

## 前端实现硬规则

- 固定 BSC NPL：\`0x4e8277ab31e4956b2cd48449793a57656dfc03d2\`。
- 支付必须走后端 intent：\`POST /api/dapp/checkout-intent\` / \`POST /api/dapp/seckill-intent\`；前端不要自己拼业务 calldata。
- 首次支付按 intent 里的单笔 NPL 授权交易执行，额度为 MaxUint256；后续先查 allowance，够就跳过授权。
- 秒杀购买用 intent 返回的 \`recordPurchase(sessionId, orderId)\` 交易；合约层按 docs 限制合约地址调用。
- Claim 先钱包签名，再提交后端，链上 claim 可用时再发 \`RewardLedger.claim(entryId)\`。
- 不做用户无理由退款；只展示平台强制退款、7 天超时强退、emergency refund 的状态。

## 本包生成命令

\`\`\`bash
pnpm dapp:frontend-pack
\`\`\`

生成物：

- \`test-artifacts/dapp-frontend-pack/\`
- \`test-artifacts/dapp-frontend-pack.tar.gz\`

## 验收建议

前端项目接入后至少跑：

\`\`\`bash
pnpm typecheck
# 再按前端项目自己的 lint/build 命令跑一遍
\`\`\`
`;
}

function scanForSecrets(files) {
  const forbiddenAssignmentPatterns = [
    /(^|\n)\s*PRIVATE_KEY\s*=/,
    /(^|\n)\s*INDEXER_SECRET\s*=/,
    /(^|\n)\s*ADMIN_SECRET\s*=/,
    /(^|\n)\s*JWT_SECRET\s*=/,
    /(^|\n)\s*EXPLORER_API_KEY\s*=/,
    /(^|\n)\s*ETHERSCAN_API_KEY\s*=/,
    /(^|\n)\s*BSCSCAN_API_KEY\s*=/,
    /(^|\n)\s*BASESCAN_API_KEY\s*=/,
    /"(PRIVATE_KEY|INDEXER_SECRET|ADMIN_SECRET|JWT_SECRET|EXPLORER_API_KEY|ETHERSCAN_API_KEY|BSCSCAN_API_KEY|BASESCAN_API_KEY)"\s*:/
  ];
  const secretValues = localSecretValues();
  const blockers = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of forbiddenAssignmentPatterns) {
      if (pattern.test(content)) blockers.push(`${file}: forbidden secret key assignment ${pattern}`);
    }
    for (const value of secretValues) {
      if (content.includes(value)) blockers.push(`${file}: contains a local secret value`);
    }
  }
  return {
    checkedFiles: files.length,
    forbiddenAssignmentsFound: blockers.length,
    localSecretValuesFound: 0,
    blockers
  };
}

function localSecretValues() {
  const envFile = resolve('.env');
  if (!fs.existsSync(envFile)) return [];
  const keys = new Set(['PRIVATE_KEY', 'INDEXER_SECRET', 'ADMIN_SECRET', 'JWT_SECRET', 'EXPLORER_API_KEY', 'ETHERSCAN_API_KEY', 'BSCSCAN_API_KEY', 'BASESCAN_API_KEY']);
  const values = [];
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || !keys.has(match[1])) continue;
    const value = match[2].replace(/^['"]|['"]$/g, '').trim();
    if (value && !value.startsWith('<') && value.length >= 8) values.push(value);
  }
  return values;
}

function fileInfo(file) {
  const bytes = fs.readFileSync(file);
  return {
    name: basename(file),
    path: file,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
