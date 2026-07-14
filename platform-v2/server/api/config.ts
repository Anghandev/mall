import { BSC_CHAIN_ID, CORE_ARTIFACT_VERSION, NPL_ADDRESS, USDT_ADDRESS } from './enums.ts';
import coordinatedManifest from '../../../packages/core-artifacts/coordinated-manifest.json' with { type: 'json' };
import contractManifest from '../../../packages/core-artifacts/contracts/contract-manifest.json' with { type: 'json' };
import { CoreError } from './errors.ts';

const decisionVariables = [
  'PLATFORM_SERVICE_FEE_BPS',
  'SECKILL_PRIZE_POOL_BPS',
  'MERCHANT_STORE_NPL_REWARD_BPS',
  'MERCHANT_GUARANTEE_MINIMUM_USDT',
  'PLATFORM_RISK_RESERVE_MINIMUM_USDT',
  'GUARANTEE_TOP_UP_LINE_USDT',
  'ORACLE_MAX_AGE_SECONDS',
  'ORACLE_MINIMUM_LIQUIDITY',
  'GENESIS_CREDENTIAL_ADDRESS',
  'GENESIS_CREDENTIAL_TOKEN_ID',
  'REQUIRED_CONFIRMATIONS',
] as const;

const unresolvedPublishedDecisions = [
  'FIXED_REMAINDER_ACCOUNTS',
  'PICKUP_TIMEOUT_AND_TAKEOVER_EVIDENCE',
  'EMPTY_SESSION_INJECTED_PRIZE_ALLOCATION',
] as const;

const externalVariables = [
  'DATABASE_URL',
  'AUDIT_DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'BSC_RPC_URL',
  'PLATFORM_SAFE_ADDRESS',
  'SECONDARY_SIGNER_ADDRESS',
  'QUOTE_SIGNER_ADDRESS',
  'FINALITY_SIGNER_ADDRESS',
  'TWAP_SOURCE_ADDRESS',
  'SIGNER_SERVICE_URL',
  'SIGNER_SERVICE_TOKEN',
  'SETTLEMENT_EXECUTOR_URL',
  'SETTLEMENT_EXECUTOR_TOKEN',
  'EXECUTOR_MAX_GAS_LIMIT',
  'BACKUP_STORAGE_ENCRYPTED',
] as const;

export type ProviderName = 'AMAP' | 'KUAIDI100' | 'FEIE' | 'ALIYUN_SMS' | 'ALIYUN_OSS' | 'SMTP' | 'JPUSH';

const providerVariables: Readonly<Record<ProviderName, readonly string[]>> = {
  AMAP: ['AMAP_WEB_SERVICE_KEY'],
  KUAIDI100: ['KUAIDI100_CUSTOMER', 'KUAIDI100_KEY', 'KUAIDI100_SECRET', 'KUAIDI100_CALLBACK_SECRET'],
  FEIE: ['FEIE_USER', 'FEIE_UKEY'],
  ALIYUN_SMS: ['ALIYUN_SMS_ACCESS_KEY_ID', 'ALIYUN_SMS_ACCESS_KEY_SECRET'],
  ALIYUN_OSS: ['ALIYUN_OSS_ACCESS_KEY_ID', 'ALIYUN_OSS_ACCESS_KEY_SECRET'],
  SMTP: ['SMTP_URL'],
  JPUSH: ['JPUSH_APP_KEY', 'JPUSH_MASTER_SECRET'],
};

export interface CoreConfig {
  chainId: 56;
  usdtAddress: string;
  nplAddress: string;
  databaseUrl: string | undefined;
  auditDatabaseUrl: string | undefined;
  redisUrl: string | undefined;
  jwtSecret: string | undefined;
  rpcUrl: string | undefined;
  safeAddress: string | undefined;
  secondarySignerAddress: string | undefined;
  quoteSignerAddress: string | undefined;
  finalitySignerAddress: string | undefined;
  twapSourceAddress: string | undefined;
  signerServiceUrl: string | undefined;
  signerServiceToken: string | undefined;
  executorUrl: string | undefined;
  executorToken: string | undefined;
  executorMaxGasLimit: bigint | undefined;
  requiredConfirmations: number | undefined;
  deploymentReady: boolean;
  decisionBlocked: readonly string[];
  externalBlocked: readonly string[];
  providerReadiness: Readonly<Record<ProviderName, 'READY' | 'CONFIGURATION_REQUIRED'>>;
}

export interface RuntimeReadinessSnapshot {
  artifactVersion: string;
  checkedAt: string;
  expiresAt: string;
  componentHashesVerified: boolean;
  deployedRuntimeCodeVerified: boolean;
  roleGrantsVerified: boolean;
  safeAdminVerified: boolean;
  signerBindingsVerified: boolean;
  httpsVerified: boolean;
  mutualTlsVerified: boolean;
  databaseHealthy: boolean;
  auditDatabaseHealthy: boolean;
  redisHealthy: boolean;
  rpcChain56Healthy: boolean;
  signerHealthy: boolean;
  executorHealthy: boolean;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): CoreConfig {
  const chainId = Number(env.CHAIN_ID ?? BSC_CHAIN_ID);
  const usdtAddress = (env.USDT_ADDRESS ?? USDT_ADDRESS).toLowerCase();
  const nplAddress = (env.NPL_ADDRESS ?? NPL_ADDRESS).toLowerCase();
  if (chainId !== BSC_CHAIN_ID || usdtAddress !== USDT_ADDRESS || nplAddress !== NPL_ADDRESS) {
    throw new CoreError('InvalidRequest', 'V2 runtime identity must use BSC 56 and fixed USDT/NPL', 500);
  }

  const missingDecisionVariables = decisionVariables.filter((name) => !env[name]);
  const decisionBlocked = [...missingDecisionVariables, ...unresolvedPublishedDecisions];
  const deploymentReady = coordinatedDeploymentReady();
  const externalBlocked = [
    ...externalVariables.filter((name) => !env[name]),
    ...(!deploymentReady ? ['COORDINATED_DEPLOYMENT_AUTHORIZATION'] : []),
  ];
  if (missingDecisionVariables.length === 0) validateDecisionValues(env);
  validateProductionEndpoints(env);
  validateDistinctAuthorities(env);
  if (env.JWT_SECRET && Buffer.byteLength(env.JWT_SECRET) < 32) {
    throw new CoreError('InvalidRequest', 'JWT_SECRET must be at least 32 bytes', 500);
  }
  const providerReadiness = Object.fromEntries(
    Object.entries(providerVariables).map(([provider, variables]) => [
      provider,
      variables.every((name) => Boolean(env[name])) ? 'READY' : 'CONFIGURATION_REQUIRED',
    ]),
  ) as Record<ProviderName, 'READY' | 'CONFIGURATION_REQUIRED'>;

  return Object.freeze({
    chainId: BSC_CHAIN_ID,
    usdtAddress,
    nplAddress,
    databaseUrl: env.DATABASE_URL,
    auditDatabaseUrl: env.AUDIT_DATABASE_URL,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET,
    rpcUrl: env.BSC_RPC_URL,
    safeAddress: normalizeOptionalAddress(env.PLATFORM_SAFE_ADDRESS),
    secondarySignerAddress: normalizeOptionalAddress(env.SECONDARY_SIGNER_ADDRESS),
    quoteSignerAddress: normalizeOptionalAddress(env.QUOTE_SIGNER_ADDRESS),
    finalitySignerAddress: normalizeOptionalAddress(env.FINALITY_SIGNER_ADDRESS),
    twapSourceAddress: normalizeOptionalAddress(env.TWAP_SOURCE_ADDRESS),
    signerServiceUrl: env.SIGNER_SERVICE_URL,
    signerServiceToken: env.SIGNER_SERVICE_TOKEN,
    executorUrl: env.SETTLEMENT_EXECUTOR_URL,
    executorToken: env.SETTLEMENT_EXECUTOR_TOKEN,
    executorMaxGasLimit: parseOptionalPositiveBigInt(env.EXECUTOR_MAX_GAS_LIMIT, 'EXECUTOR_MAX_GAS_LIMIT'),
    requiredConfirmations: parseOptionalPositiveUint32(env.REQUIRED_CONFIRMATIONS, 'REQUIRED_CONFIRMATIONS'),
    deploymentReady,
    decisionBlocked,
    externalBlocked,
    providerReadiness: Object.freeze(providerReadiness),
  });
}

export function publicReadiness(config: CoreConfig, runtime?: RuntimeReadinessSnapshot, now = new Date()) {
  const providersReady = Object.values(config.providerReadiness).every((status) => status === 'READY');
  return {
    chainId: config.chainId,
    assets: { usdt: config.usdtAddress, npl: config.nplAddress },
    decisionBlocked: config.decisionBlocked,
    externalBlocked: config.externalBlocked,
    providers: config.providerReadiness,
    writesEnabled:
      config.deploymentReady &&
      config.decisionBlocked.length === 0 &&
      config.externalBlocked.length === 0 &&
      providersReady &&
      runtimeReadinessValid(runtime, now),
  } as const;
}

function coordinatedDeploymentReady() {
  if (
    coordinatedManifest.artifactVersion !== CORE_ARTIFACT_VERSION ||
    coordinatedManifest.artifactVersion !== contractManifest.artifactVersion ||
    coordinatedManifest.chain.chainId !== BSC_CHAIN_ID ||
    contractManifest.chain.chainId !== BSC_CHAIN_ID
  ) {
    throw new CoreError('ArtifactVersionMismatch', 'Deployment manifests do not match the coordinated artifact', 503);
  }
  return (
    coordinatedManifest.deploymentAuthorized === true &&
    contractManifest.deploymentStatus === 'DEPLOYED' &&
    contractManifest.contracts.every(
      (contract) =>
        contract.status === 'DEPLOYED' &&
        typeof contract.address === 'string' &&
        /^0x[0-9a-fA-F]{40}$/.test(contract.address),
    )
  );
}

function runtimeReadinessValid(snapshot: RuntimeReadinessSnapshot | undefined, now: Date) {
  if (!snapshot || snapshot.artifactVersion !== CORE_ARTIFACT_VERSION) return false;
  const checkedAt = Date.parse(snapshot.checkedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (!Number.isFinite(checkedAt) || !Number.isFinite(expiresAt) || checkedAt > now.getTime() || expiresAt <= now.getTime()) {
    return false;
  }
  return [
    snapshot.componentHashesVerified,
    snapshot.deployedRuntimeCodeVerified,
    snapshot.roleGrantsVerified,
    snapshot.safeAdminVerified,
    snapshot.signerBindingsVerified,
    snapshot.httpsVerified,
    snapshot.mutualTlsVerified,
    snapshot.databaseHealthy,
    snapshot.auditDatabaseHealthy,
    snapshot.redisHealthy,
    snapshot.rpcChain56Healthy,
    snapshot.signerHealthy,
    snapshot.executorHealthy,
  ].every((value) => value === true);
}

function validateProductionEndpoints(env: Readonly<Record<string, string | undefined>>) {
  for (const name of ['SIGNER_SERVICE_URL', 'SETTLEMENT_EXECUTOR_URL']) {
    const value = env[name];
    if (value && protocol(value) !== 'https:') throw new CoreError('InvalidRequest', `${name} must use HTTPS`, 500);
  }
  if (env.BSC_RPC_URL && !['https:', 'wss:'].includes(protocol(env.BSC_RPC_URL))) {
    throw new CoreError('InvalidRequest', 'BSC_RPC_URL must use HTTPS or WSS', 500);
  }
}

function validateDistinctAuthorities(env: Readonly<Record<string, string | undefined>>) {
  const names = [
    'PLATFORM_SAFE_ADDRESS',
    'SECONDARY_SIGNER_ADDRESS',
    'QUOTE_SIGNER_ADDRESS',
    'FINALITY_SIGNER_ADDRESS',
  ];
  const configured = names.map((name) => env[name]?.toLowerCase()).filter((value): value is string => Boolean(value));
  if (new Set(configured).size !== configured.length) {
    throw new CoreError('InvalidRequest', 'Safe and signer authorities must use distinct addresses', 500);
  }
}

function protocol(value: string) {
  try {
    return new URL(value).protocol;
  } catch {
    throw new CoreError('InvalidRequest', 'Configured service URL is invalid', 500);
  }
}

export function requireProvider(config: CoreConfig, provider: ProviderName) {
  if (config.providerReadiness[provider] !== 'READY') {
    throw new CoreError('ConfigurationRequired', `${provider} is not configured`, 503, { provider });
  }
}

function normalizeOptionalAddress(value: string | undefined) {
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new CoreError('InvalidRequest', 'Invalid configured address', 500);
  return value.toLowerCase();
}

function validateDecisionValues(env: Readonly<Record<string, string | undefined>>) {
  for (const name of ['PLATFORM_SERVICE_FEE_BPS', 'SECKILL_PRIZE_POOL_BPS', 'MERCHANT_STORE_NPL_REWARD_BPS']) {
    const value = Number(env[name]);
    if (!Number.isInteger(value) || value < 0 || value > 10_000) {
      throw new CoreError('InvalidRequest', `${name} must be integer BPS`, 500);
    }
  }
  for (const name of [
    'MERCHANT_GUARANTEE_MINIMUM_USDT',
    'PLATFORM_RISK_RESERVE_MINIMUM_USDT',
    'GUARANTEE_TOP_UP_LINE_USDT',
    'ORACLE_MINIMUM_LIQUIDITY',
  ]) {
    try {
      if (BigInt(env[name]!) <= 0n) throw new Error('positive value required');
    } catch {
      throw new CoreError('InvalidRequest', `${name} must be a positive integer`, 500);
    }
  }
  const maxAge = Number(env.ORACLE_MAX_AGE_SECONDS);
  if (!Number.isSafeInteger(maxAge) || maxAge <= 0) {
    throw new CoreError('InvalidRequest', 'ORACLE_MAX_AGE_SECONDS must be a positive integer', 500);
  }
  normalizeOptionalAddress(env.GENESIS_CREDENTIAL_ADDRESS);
  try {
    if (BigInt(env.GENESIS_CREDENTIAL_TOKEN_ID!) < 0n) throw new Error('negative token id');
  } catch {
    throw new CoreError('InvalidRequest', 'GENESIS_CREDENTIAL_TOKEN_ID must be a non-negative integer', 500);
  }
  parseOptionalPositiveUint32(env.REQUIRED_CONFIRMATIONS, 'REQUIRED_CONFIRMATIONS');
}

function parseOptionalPositiveBigInt(value: string | undefined, name: string) {
  if (!value) return undefined;
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) throw new Error('positive value required');
    return parsed;
  } catch {
    throw new CoreError('InvalidRequest', `${name} must be a positive integer`, 500);
  }
}

function parseOptionalPositiveUint32(value: string | undefined, name: string) {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 0xffff_ffff) {
    throw new CoreError('InvalidRequest', `${name} must be a positive uint32`, 500);
  }
  return parsed;
}
