import {
  BSC_CHAIN_ID,
  CORE_ARTIFACT_VERSION,
  NPL_ADDRESS,
  NPL_USDT_PAIR_ADDRESS,
  REQUIRED_CONFIRMATIONS,
  USDT_ADDRESS,
  type RuntimeBlocker,
} from './enums.ts';
import coordinatedManifest from '../../../packages/core-artifacts/coordinated-manifest.json' with { type: 'json' };
import contractManifest from '../../../packages/core-artifacts/contracts/contract-manifest.json' with { type: 'json' };
import { CoreError } from './errors.ts';
import {
  loadMainnetMicrotestEntitlement,
  type MainnetMicrotestEntitlement,
} from '../data/mainnet-microtest-entitlement.ts';

const externalVariables = [
  'DATABASE_URL',
  'AUDIT_DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'AUTH_DOMAIN',
  'AUTH_URI',
  'PII_RETENTION_POLICY_VERSION',
  'DELIVERY_DATA_ENCRYPTION_KEY',
  'MERCHANT_PII_ENCRYPTION_KEY',
  'TRACKING_HASH_KEY',
  'AMAP_WEB_SERVICE_KEY',
  'BSC_RPC_URL',
  'BSC_FALLBACK_RPC_URL',
  'PLATFORM_GOVERNANCE_WALLET_ADDRESS',
  'PLATFORM_SERVICE_FEE_WALLET_ADDRESS',
  'USDT_SETTLEMENT_WALLET_ADDRESS',
  'NPL_REWARD_WALLET_ADDRESS',
  'OPERATIONS_GUARANTEE_WALLET_ADDRESS',
  'SIGNER_SERVICE_URL',
  'SIGNER_SERVICE_TOKEN',
  'SETTLEMENT_EXECUTOR_URL',
  'SETTLEMENT_EXECUTOR_TOKEN',
  'EXECUTOR_MAX_GAS_LIMIT',
  'SETTLEMENT_REPLACEMENT_DELAY_MS',
  'USDT_TOKEN_CODE_HASH',
  'USDT_TRANSFER_CONFORMANCE_EVIDENCE_HASH',
  'NPL_TOKEN_CODE_HASH',
  'NPL_TRANSFER_CONFORMANCE_EVIDENCE_HASH',
  'OPERATIONS_TOKEN_CODE_HASH',
  'OPERATIONS_TRANSFER_CONFORMANCE_EVIDENCE_HASH',
  'BACKUP_STORAGE_ENCRYPTED',
  'BNM_AVAILABILITY_URL',
  'BNM_API_TOKEN',
  'BNM_PROJECT_ID',
  'BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH',
  'MEDIA_STORAGE_SIGNER_URL',
  'MEDIA_STORAGE_SIGNER_TOKEN',
  'MEDIA_UPLOAD_MAX_INTENTS_PER_WALLET_HOUR',
  'MEDIA_UPLOAD_MAX_BYTES_PER_WALLET_HOUR',
  'GOVERNANCE_EXECUTOR_URL',
  'GOVERNANCE_EXECUTOR_TOKEN',
  'SECRET_RESOLVER_URL',
  'SECRET_RESOLVER_TOKEN',
  'BSC_EXPLORER_API_URL',
  'EXPLORER_API_KEY',
] as const;

const paymentExternalVariables = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'AUTH_DOMAIN',
  'AUTH_URI',
  'BSC_RPC_URL',
  'BSC_FALLBACK_RPC_URL',
  'PLATFORM_GOVERNANCE_WALLET_ADDRESS',
  'PLATFORM_SERVICE_FEE_WALLET_ADDRESS',
  'USDT_SETTLEMENT_WALLET_ADDRESS',
  'NPL_REWARD_WALLET_ADDRESS',
  'OPERATIONS_GUARANTEE_WALLET_ADDRESS',
  'SIGNER_SERVICE_URL',
  'SIGNER_SERVICE_TOKEN',
] as const;

export type ProviderName =
  | 'AMAP'
  | 'KUAIDI100'
  | 'CAINIAO'
  | 'FEIE'
  | 'YILIANYUN'
  | 'BNM'
  | 'ALIYUN_SMS'
  | 'TENCENT_SMS'
  | 'ALIYUN_OSS'
  | 'SMTP'
  | 'FIREBASE'
  | 'JPUSH';

const providerVariables: Readonly<Record<ProviderName, readonly string[]>> = {
  AMAP: ['AMAP_WEB_SERVICE_KEY'],
  KUAIDI100: [
    'KUAIDI100_CUSTOMER',
    'KUAIDI100_KEY',
    'KUAIDI100_SECRET',
    'KUAIDI100_SIID',
    'KUAIDI100_CALLBACK_SECRET',
  ],
  CAINIAO: [
    'CAINIAO_LOGISTIC_PROVIDER_ID',
    'CAINIAO_DATA_DIGEST_SIGNER_URL',
    'CAINIAO_DATA_DIGEST_SIGNER_TOKEN',
    'CAINIAO_CALLBACK_SECRET',
  ],
  FEIE: ['FEIE_USER', 'FEIE_UKEY'],
  YILIANYUN: ['YILIANYUN_CLIENT_ID', 'YILIANYUN_CLIENT_SECRET', 'YILIANYUN_ACCESS_TOKEN'],
  BNM: [
    'BNM_AVAILABILITY_URL',
    'BNM_API_TOKEN',
    'BNM_PROJECT_ID',
    'BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH',
  ],
  ALIYUN_SMS: ['SECRET_RESOLVER_URL', 'SECRET_RESOLVER_TOKEN', 'ALIYUN_SMS_GATEWAY_URL', 'ALIYUN_SMS_CREDENTIAL_REF'],
  TENCENT_SMS: ['SECRET_RESOLVER_URL', 'SECRET_RESOLVER_TOKEN', 'TENCENT_SMS_GATEWAY_URL', 'TENCENT_SMS_CREDENTIAL_REF'],
  ALIYUN_OSS: ['MEDIA_STORAGE_SIGNER_URL', 'MEDIA_STORAGE_SIGNER_TOKEN'],
  SMTP: ['SECRET_RESOLVER_URL', 'SECRET_RESOLVER_TOKEN', 'SMTP_GATEWAY_URL', 'SMTP_CREDENTIAL_REF'],
  FIREBASE: ['SECRET_RESOLVER_URL', 'SECRET_RESOLVER_TOKEN', 'FIREBASE_GATEWAY_URL', 'FIREBASE_CREDENTIAL_REF'],
  JPUSH: ['SECRET_RESOLVER_URL', 'SECRET_RESOLVER_TOKEN', 'JPUSH_GATEWAY_URL', 'JPUSH_CREDENTIAL_REF'],
};

export interface CoreConfig {
  chainId: 56;
  usdtAddress: string;
  nplAddress: string;
  nplUsdtPairAddress: string;
  databaseUrl: string | undefined;
  auditDatabaseUrl: string | undefined;
  redisUrl: string | undefined;
  jwtSecret: string | undefined;
  authDomain: string | undefined;
  authUri: string | undefined;
  piiRetentionPolicyVersion: string | undefined;
  rpcUrl: string | undefined;
  fallbackRpcUrl: string | undefined;
  paymentRouterAddress: string | undefined;
  paymentRouterDeploymentBlock: number | undefined;
  paymentIndexerStartBlock: number | undefined;
  policyRegistryAddress: string | undefined;
  beneficiaryRegistryAddress: string | undefined;
  governanceWalletAddress: string | undefined;
  platformServiceFeeWalletAddress: string | undefined;
  usdtSettlementWalletAddress: string | undefined;
  nplRewardWalletAddress: string | undefined;
  operationsWalletAddress: string | undefined;
  secondarySignerAddress: string | undefined;
  quoteSignerAddress: string | undefined;
  finalitySignerAddress: string | undefined;
  signerServiceUrl: string | undefined;
  signerServiceToken: string | undefined;
  executorUrl: string | undefined;
  executorToken: string | undefined;
  executorMaxGasLimit: bigint | undefined;
  settlementReplacementDelayMs: number | undefined;
  settlementWalletExpectations: Readonly<Partial<Record<'USDT' | 'NPL' | 'OPERATIONS_USDT', {
    walletAddress: string;
    tokenAddress: string;
    tokenCodeHash: string;
    tokenTransferConformanceEvidenceHash: string;
  }>>>;
  bnmMonotonicConformanceEvidenceHash: string | undefined;
  requiredConfirmations: 15;
  deploymentReady: boolean;
  decisionBlocked: readonly string[];
  externalBlocked: readonly string[];
  paymentDecisionBlocked: readonly string[];
  paymentExternalBlocked: readonly string[];
  providerReadiness: Readonly<Record<ProviderName, 'READY' | 'CONFIGURATION_REQUIRED'>>;
  mainnetMicrotestEntitlement: MainnetMicrotestEntitlement | undefined;
}

export interface RuntimeReadinessSnapshot {
  artifactVersion: string;
  checkedAt: string;
  expiresAt: string;
  componentHashesVerified: boolean;
  deployedRuntimeCodeVerified: boolean;
  roleGrantsVerified: boolean;
  walletRolesVerified: boolean;
  signerBindingsVerified: boolean;
  nplQuoteSourceHealthy: boolean;
  indexerHealthy: boolean;
  indexerCaughtUp: boolean;
  indexerErrorCode?: string;
  databaseHealthy: boolean;
  redisHealthy: boolean;
  rpcChain56Healthy: boolean;
  signerHealthy: boolean;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): CoreConfig {
  const chainId = Number(env.CHAIN_ID ?? BSC_CHAIN_ID);
  const usdtAddress = (env.USDT_ADDRESS ?? USDT_ADDRESS).toLowerCase();
  const nplAddress = (env.NPL_ADDRESS ?? NPL_ADDRESS).toLowerCase();
  if (chainId !== BSC_CHAIN_ID || usdtAddress !== USDT_ADDRESS || nplAddress !== NPL_ADDRESS) {
    throw new CoreError('InvalidRequest', 'V2 runtime identity must use BSC 56 and fixed USDT/NPL', 500);
  }
  validateFrozenOverrides(env);
  const mainnetMicrotestEntitlement = loadMainnetMicrotestEntitlement(env);

  const manifestDecisionBlocked: readonly string[] = coordinatedManifest.decisionBlocked;
  const decisionBlocked = [...manifestDecisionBlocked];
  const paymentDecisionBlocked = [...manifestDecisionBlocked];
  const deploymentReady = coordinatedDeploymentReady();
  const paymentRouterDeployment = manifestContractDeployment('PaymentRouterV2');
  const paymentRouterAddress = paymentRouterDeployment?.address;
  const paymentRouterDeploymentBlock = paymentRouterDeployment?.deploymentBlock;
  const paymentIndexerStartBlock = parseOptionalPositiveInteger(
    env.PAYMENT_INDEXER_START_BLOCK,
    'PAYMENT_INDEXER_START_BLOCK',
  );
  if (
    paymentIndexerStartBlock !== undefined
    && paymentRouterDeploymentBlock !== undefined
    && paymentIndexerStartBlock < paymentRouterDeploymentBlock
  ) throw new CoreError('InvalidRequest', 'PAYMENT_INDEXER_START_BLOCK predates the Router deployment', 500);
  const policyRegistryAddress = manifestContractAddress('PolicyRegistryV2');
  const beneficiaryRegistryAddress = manifestContractAddress('BeneficiaryRegistryV2');
  const externalBlocked = [
    ...externalVariables.filter((name) => !env[name]),
    ...(!deploymentReady ? ['COORDINATED_DEPLOYMENT_AUTHORIZATION'] : []),
    ...(!paymentRouterAddress ? ['PAYMENT_ROUTER_ADDRESS_MANIFEST'] : []),
    ...(paymentRouterDeploymentBlock === undefined ? ['PAYMENT_ROUTER_DEPLOYMENT_BLOCK_MANIFEST'] : []),
    ...(!policyRegistryAddress ? ['POLICY_REGISTRY_ADDRESS_MANIFEST'] : []),
    ...(!beneficiaryRegistryAddress ? ['BENEFICIARY_REGISTRY_ADDRESS_MANIFEST'] : []),
  ];
  const paymentExternalBlocked = [
    ...paymentExternalVariables.filter((name) => !env[name]),
    ...(!deploymentReady ? ['COORDINATED_DEPLOYMENT_AUTHORIZATION'] : []),
    ...(!paymentRouterAddress ? ['PAYMENT_ROUTER_ADDRESS_MANIFEST'] : []),
    ...(paymentRouterDeploymentBlock === undefined ? ['PAYMENT_ROUTER_DEPLOYMENT_BLOCK_MANIFEST'] : []),
    ...(!policyRegistryAddress ? ['POLICY_REGISTRY_ADDRESS_MANIFEST'] : []),
    ...(!beneficiaryRegistryAddress ? ['BENEFICIARY_REGISTRY_ADDRESS_MANIFEST'] : []),
  ];
  validateProductionEndpoints(env);
  validateDistinctAuthorities(env);
  const bnmMonotonicConformanceEvidenceHash = normalizeOptionalHash(
    env.BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH,
    'BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH',
  );
  if (env.JWT_SECRET && Buffer.byteLength(env.JWT_SECRET) < 32) {
    throw new CoreError('InvalidRequest', 'JWT_SECRET must be at least 32 bytes', 500);
  }
  if (env.TRACKING_HASH_KEY && !/^[0-9a-fA-F]{64}$/.test(env.TRACKING_HASH_KEY)) {
    throw new CoreError('InvalidRequest', 'TRACKING_HASH_KEY must be 32-byte hex', 500);
  }
  for (const name of ['MEDIA_UPLOAD_MAX_INTENTS_PER_WALLET_HOUR', 'MEDIA_UPLOAD_MAX_BYTES_PER_WALLET_HOUR']) {
    if (env[name] && !/^[1-9]\d*$/.test(env[name]!)) {
      throw new CoreError('InvalidRequest', `${name} must be a positive integer`, 500);
    }
  }
  validateAuthOrigin(env);
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
    nplUsdtPairAddress: NPL_USDT_PAIR_ADDRESS,
    databaseUrl: env.DATABASE_URL,
    auditDatabaseUrl: env.AUDIT_DATABASE_URL,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET,
    authDomain: env.AUTH_DOMAIN,
    authUri: env.AUTH_URI,
    piiRetentionPolicyVersion: env.PII_RETENTION_POLICY_VERSION,
    rpcUrl: env.BSC_RPC_URL,
    fallbackRpcUrl: env.BSC_FALLBACK_RPC_URL,
    paymentRouterAddress,
    paymentRouterDeploymentBlock,
    paymentIndexerStartBlock,
    policyRegistryAddress,
    beneficiaryRegistryAddress,
    governanceWalletAddress: normalizeOptionalAddress(env.PLATFORM_GOVERNANCE_WALLET_ADDRESS),
    platformServiceFeeWalletAddress: normalizeOptionalAddress(env.PLATFORM_SERVICE_FEE_WALLET_ADDRESS),
    usdtSettlementWalletAddress: normalizeOptionalAddress(env.USDT_SETTLEMENT_WALLET_ADDRESS),
    nplRewardWalletAddress: normalizeOptionalAddress(env.NPL_REWARD_WALLET_ADDRESS),
    operationsWalletAddress: normalizeOptionalAddress(env.OPERATIONS_GUARANTEE_WALLET_ADDRESS),
    secondarySignerAddress: normalizeOptionalAddress(env.PLATFORM_GOVERNANCE_WALLET_ADDRESS),
    quoteSignerAddress: normalizeOptionalAddress(env.PLATFORM_GOVERNANCE_WALLET_ADDRESS),
    finalitySignerAddress: normalizeOptionalAddress(env.PLATFORM_GOVERNANCE_WALLET_ADDRESS),
    signerServiceUrl: env.SIGNER_SERVICE_URL,
    signerServiceToken: env.SIGNER_SERVICE_TOKEN,
    executorUrl: env.SETTLEMENT_EXECUTOR_URL,
    executorToken: env.SETTLEMENT_EXECUTOR_TOKEN,
    executorMaxGasLimit: parseOptionalPositiveBigInt(env.EXECUTOR_MAX_GAS_LIMIT, 'EXECUTOR_MAX_GAS_LIMIT'),
    settlementReplacementDelayMs: parseOptionalPositiveInteger(
      env.SETTLEMENT_REPLACEMENT_DELAY_MS,
      'SETTLEMENT_REPLACEMENT_DELAY_MS',
    ),
    settlementWalletExpectations: Object.freeze({
      ...(walletExpectation(env, 'USDT', normalizeOptionalAddress(env.USDT_SETTLEMENT_WALLET_ADDRESS), USDT_ADDRESS)
        ? { USDT: walletExpectation(env, 'USDT', normalizeOptionalAddress(env.USDT_SETTLEMENT_WALLET_ADDRESS), USDT_ADDRESS)! }
        : {}),
      ...(walletExpectation(env, 'NPL', normalizeOptionalAddress(env.NPL_REWARD_WALLET_ADDRESS), NPL_ADDRESS)
        ? { NPL: walletExpectation(env, 'NPL', normalizeOptionalAddress(env.NPL_REWARD_WALLET_ADDRESS), NPL_ADDRESS)! }
        : {}),
      ...(walletExpectation(
        env,
        'OPERATIONS',
        normalizeOptionalAddress(env.OPERATIONS_GUARANTEE_WALLET_ADDRESS),
        USDT_ADDRESS,
      )
        ? {
          OPERATIONS_USDT: walletExpectation(
            env,
            'OPERATIONS',
            normalizeOptionalAddress(env.OPERATIONS_GUARANTEE_WALLET_ADDRESS),
            USDT_ADDRESS,
          )!,
        }
        : {}),
    }),
    bnmMonotonicConformanceEvidenceHash,
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
    deploymentReady,
    decisionBlocked,
    externalBlocked,
    paymentDecisionBlocked,
    paymentExternalBlocked,
    providerReadiness: Object.freeze(providerReadiness),
    mainnetMicrotestEntitlement,
  });
}

export function publicReadiness(config: CoreConfig, runtime?: RuntimeReadinessSnapshot, now = new Date()) {
  const runtimeBlockers = runtimeReadinessBlockers(config, runtime, now);
  return {
    chainId: config.chainId,
    assets: { usdt: config.usdtAddress, npl: config.nplAddress, nplUsdtPair: config.nplUsdtPairAddress },
    decisionBlocked: config.decisionBlocked,
    externalBlocked: config.externalBlocked,
    paymentDecisionBlocked: config.paymentDecisionBlocked,
    paymentExternalBlocked: config.paymentExternalBlocked,
    runtimeBlockers,
    providers: config.providerReadiness,
    writesEnabled: runtimeBlockers.length === 0,
  } as const;
}

function coordinatedDeploymentReady() {
  const coordinatedDeployment = coordinatedManifest as unknown as {
    deploymentAuthorized: boolean;
    deploymentAuthorizationEvidenceHash: unknown;
  };
  const contractDeployment = contractManifest as unknown as {
    deploymentAuthorized: boolean;
    deploymentAuthorizationEvidenceHash: unknown;
  };
  if (
    coordinatedManifest.artifactVersion !== CORE_ARTIFACT_VERSION ||
    coordinatedManifest.artifactVersion !== contractManifest.artifactVersion ||
    coordinatedManifest.chain.chainId !== BSC_CHAIN_ID ||
    contractManifest.chain.chainId !== BSC_CHAIN_ID
  ) {
    throw new CoreError('ArtifactVersionMismatch', 'Deployment manifests do not match the coordinated artifact', 503);
  }
  return (
    coordinatedDeployment.deploymentAuthorized === true &&
    contractDeployment.deploymentAuthorized === true &&
    typeof coordinatedDeployment.deploymentAuthorizationEvidenceHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(coordinatedDeployment.deploymentAuthorizationEvidenceHash) &&
    coordinatedDeployment.deploymentAuthorizationEvidenceHash ===
      contractDeployment.deploymentAuthorizationEvidenceHash &&
    contractManifest.deploymentStatus === 'DEPLOYED' &&
    contractManifest.contracts.every((contract) => {
      const deployment = contract as unknown as {
        status: string;
        address: unknown;
        deploymentBlock: unknown;
        deployedCodeHash: unknown;
      };
      return deployment.status === 'DEPLOYED'
        && typeof deployment.address === 'string'
        && /^0x[0-9a-fA-F]{40}$/.test(deployment.address)
        && Number.isSafeInteger(deployment.deploymentBlock)
        && typeof deployment.deployedCodeHash === 'string'
        && /^0x[0-9a-fA-F]{64}$/.test(deployment.deployedCodeHash);
    })
  );
}

function manifestContractAddress(name: string) {
  const entry = contractManifest.contracts.find((contract) => contract.name === name);
  return entry?.status === 'DEPLOYED' && typeof entry.address === 'string'
    ? normalizeOptionalAddress(entry.address)
    : undefined;
}

function manifestContractDeployment(name: string) {
  const entry = contractManifest.contracts.find((contract) => contract.name === name) as
    | { status: string; address: unknown; deploymentBlock: unknown }
    | undefined;
  if (
    entry?.status !== 'DEPLOYED'
      || typeof entry.address !== 'string'
      || !/^0x[0-9a-fA-F]{40}$/.test(entry.address)
      || !Number.isSafeInteger(entry.deploymentBlock)
      || Number(entry.deploymentBlock) < 0
  ) return undefined;
  return {
    address: entry.address.toLowerCase(),
    deploymentBlock: Number(entry.deploymentBlock),
  };
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
    snapshot.walletRolesVerified,
    snapshot.signerBindingsVerified,
    snapshot.nplQuoteSourceHealthy,
    snapshot.indexerHealthy,
    snapshot.indexerCaughtUp,
    snapshot.databaseHealthy,
    snapshot.redisHealthy,
    snapshot.rpcChain56Healthy,
    snapshot.signerHealthy,
  ].every((value) => value === true);
}

function runtimeReadinessBlockers(
  config: CoreConfig,
  snapshot: RuntimeReadinessSnapshot | undefined,
  now: Date,
): RuntimeBlocker[] {
  const blockers = new Set<RuntimeBlocker>();
  if (config.paymentDecisionBlocked.length > 0) blockers.add('PAYMENT_DECISION_BLOCKED');
  if (!config.deploymentReady || config.paymentExternalBlocked.length > 0) blockers.add('PAYMENT_CONFIGURATION_REQUIRED');
  if (!snapshot || snapshot.artifactVersion !== CORE_ARTIFACT_VERSION) {
    blockers.add('RUNTIME_SNAPSHOT_EXPIRED');
    return [...blockers];
  }
  const checkedAt = Date.parse(snapshot.checkedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (!Number.isFinite(checkedAt) || !Number.isFinite(expiresAt) || checkedAt > now.getTime() || expiresAt <= now.getTime()) {
    blockers.add('RUNTIME_SNAPSHOT_EXPIRED');
  }
  if (!snapshot.databaseHealthy) blockers.add('DATABASE_UNAVAILABLE');
  if (!snapshot.redisHealthy) blockers.add('REDIS_UNAVAILABLE');
  if (!snapshot.signerHealthy) blockers.add('SIGNER_UNAVAILABLE');
  if (!snapshot.indexerHealthy) blockers.add('INDEXER_UNHEALTHY');
  if (snapshot.indexerHealthy && !snapshot.indexerCaughtUp) blockers.add('INDEXER_LAGGING');
  if (snapshot.indexerErrorCode === 'InvalidFinality' || snapshot.indexerErrorCode === 'ReorgPending' || !snapshot.rpcChain56Healthy) {
    blockers.add('RPC_DIVERGENCE');
  }
  if (!snapshot.nplQuoteSourceHealthy) blockers.add('QUOTE_SOURCE_UNHEALTHY');
  if (
    !snapshot.componentHashesVerified
    || !snapshot.deployedRuntimeCodeVerified
    || !snapshot.roleGrantsVerified
    || !snapshot.walletRolesVerified
    || !snapshot.signerBindingsVerified
  ) blockers.add('CONTRACT_EVIDENCE_UNVERIFIED');
  return [...blockers];
}

function validateProductionEndpoints(env: Readonly<Record<string, string | undefined>>) {
  for (const name of [
    'SIGNER_SERVICE_URL',
    'SETTLEMENT_EXECUTOR_URL',
    'BNM_AVAILABILITY_URL',
    'MEDIA_STORAGE_SIGNER_URL',
    'GOVERNANCE_EXECUTOR_URL',
    'SECRET_RESOLVER_URL',
    'BSC_EXPLORER_API_URL',
    'ALIYUN_SMS_GATEWAY_URL',
    'TENCENT_SMS_GATEWAY_URL',
    'SMTP_GATEWAY_URL',
    'FIREBASE_GATEWAY_URL',
    'JPUSH_GATEWAY_URL',
  ]) {
    const value = env[name];
    if (value && protocol(value) !== 'https:' && !isLoopbackHttp(value)) {
      throw new CoreError('InvalidRequest', `${name} must use HTTPS outside loopback`, 500);
    }
  }
  for (const name of ['BSC_RPC_URL', 'BSC_FALLBACK_RPC_URL']) {
    if (env[name] && protocol(env[name]) !== 'https:') {
      throw new CoreError('InvalidRequest', `${name} must use HTTPS`, 500);
    }
  }
  if (
    env.BSC_RPC_URL
    && env.BSC_FALLBACK_RPC_URL
    && normalizedEndpoint(env.BSC_RPC_URL) === normalizedEndpoint(env.BSC_FALLBACK_RPC_URL)
  ) throw new CoreError('InvalidRequest', 'BSC primary and fallback RPC URLs must be distinct', 500);
}

function isLoopbackHttp(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function validateAuthOrigin(env: Readonly<Record<string, string | undefined>>) {
  if (env.AUTH_URI && protocol(env.AUTH_URI) !== 'https:') {
    throw new CoreError('InvalidRequest', 'AUTH_URI must use HTTPS', 500);
  }
  if (env.AUTH_DOMAIN && (!/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(env.AUTH_DOMAIN) || env.AUTH_DOMAIN.includes('..'))) {
    throw new CoreError('InvalidRequest', 'AUTH_DOMAIN is invalid', 500);
  }
  if (env.AUTH_URI && env.AUTH_DOMAIN && new URL(env.AUTH_URI).host !== env.AUTH_DOMAIN) {
    throw new CoreError('InvalidRequest', 'AUTH_URI host must match AUTH_DOMAIN', 500);
  }
}

function validateDistinctAuthorities(env: Readonly<Record<string, string | undefined>>) {
  const wallets = [
    env.PLATFORM_GOVERNANCE_WALLET_ADDRESS,
    env.PLATFORM_SERVICE_FEE_WALLET_ADDRESS,
    env.USDT_SETTLEMENT_WALLET_ADDRESS,
    env.NPL_REWARD_WALLET_ADDRESS,
    env.OPERATIONS_GUARANTEE_WALLET_ADDRESS,
  ].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  if (new Set(wallets).size !== wallets.length) {
    throw new CoreError('InvalidRequest', 'Governance, fee, settlement, reward and operations wallets must be distinct', 500);
  }
}

function protocol(value: string) {
  try {
    return new URL(value).protocol;
  } catch {
    throw new CoreError('InvalidRequest', 'Configured service URL is invalid', 500);
  }
}

function normalizedEndpoint(value: string) {
  const url = new URL(value);
  url.hash = '';
  return url.href.replace(/\/$/, '');
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

function normalizeOptionalHash(value: string | undefined, name: string) {
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new CoreError('InvalidRequest', `${name} must be bytes32`, 500);
  return value.toLowerCase();
}

function walletExpectation(
  env: Readonly<Record<string, string | undefined>>,
  prefix: 'USDT' | 'NPL' | 'OPERATIONS',
  walletAddress: string | undefined,
  tokenAddress: string,
) {
  const names = {
    tokenCodeHash: `${prefix}_TOKEN_CODE_HASH`,
    tokenTransferConformanceEvidenceHash: `${prefix}_TRANSFER_CONFORMANCE_EVIDENCE_HASH`,
  } as const;
  if (!walletAddress || Object.values(names).some((name) => !env[name])) return undefined;
  return {
    walletAddress,
    tokenAddress,
    tokenCodeHash: normalizeOptionalHash(env[names.tokenCodeHash], names.tokenCodeHash)!,
    tokenTransferConformanceEvidenceHash: normalizeOptionalHash(
      env[names.tokenTransferConformanceEvidenceHash],
      names.tokenTransferConformanceEvidenceHash,
    )!,
  };
}

function validateFrozenOverrides(env: Readonly<Record<string, string | undefined>>) {
  const exact = [
    ['REQUIRED_CONFIRMATIONS', '15'],
    ['MERCHANT_GUARANTEE_MINIMUM_USDT', String(1_000n * 10n ** 18n)],
  ] as const;
  for (const [name, expected] of exact) {
    if (env[name] !== undefined && env[name] !== expected) {
      throw new CoreError('InvalidRequest', `${name} is frozen at ${expected}`, 500);
    }
  }
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

function parseOptionalPositiveInteger(value: string | undefined, name: string) {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CoreError('InvalidRequest', `${name} must be a positive safe integer`, 500);
  }
  return parsed;
}
