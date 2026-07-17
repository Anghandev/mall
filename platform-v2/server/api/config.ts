import {
  BSC_CHAIN_ID,
  CORE_ARTIFACT_VERSION,
  NPL_ADDRESS,
  NPL_USDT_PAIR_ADDRESS,
  REQUIRED_CONFIRMATIONS,
  USDT_ADDRESS,
} from './enums.ts';
import coordinatedManifest from '../../../packages/core-artifacts/coordinated-manifest.json' with { type: 'json' };
import contractManifest from '../../../packages/core-artifacts/contracts/contract-manifest.json' with { type: 'json' };
import { CoreError } from './errors.ts';

const decisionVariables = [
  'PLATFORM_SERVICE_FEE_BPS',
  'SECKILL_PRIZE_POOL_BPS',
  'MERCHANT_STORE_REWARD_BPS',
  'MERCHANT_CONCESSION_DESTINATIONS_JSON',
  'CIRCULATION_REWARD_POOL_ADDRESS',
  'GENESIS_CREDENTIAL_ADDRESS',
  'GENESIS_CREDENTIAL_TOKEN_ID',
] as const;

const unresolvedPublishedDecisions = [
  'FIXED_REMAINDER_ACCOUNTS',
  'PICKUP_TIMEOUT_AND_TAKEOVER_EVIDENCE',
  'EMPTY_SESSION_INJECTED_PRIZE_ALLOCATION',
] as const;

const paymentUnresolvedPublishedDecisions = [
  'FIXED_REMAINDER_ACCOUNTS',
  'EMPTY_SESSION_INJECTED_PRIZE_ALLOCATION',
] as const;

const accountDecisionVariables = ['PII_RETENTION_POLICY_VERSION'] as const;

const externalVariables = [
  'DATABASE_URL',
  'AUDIT_DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'AUTH_DOMAIN',
  'AUTH_URI',
  'DELIVERY_DATA_ENCRYPTION_KEY',
  'TRACKING_HASH_KEY',
  'AMAP_WEB_SERVICE_KEY',
  'BSC_RPC_URL',
  'BSC_FALLBACK_RPC_URL',
  'PLATFORM_SAFE_ADDRESS',
  'PLATFORM_SERVICE_FEE_SAFE_ADDRESS',
  'USDT_CUSTODY_SAFE_ADDRESS',
  'NPL_REWARD_SAFE_ADDRESS',
  'OPERATIONS_TREASURY_SAFE_ADDRESS',
  'SECONDARY_SIGNER_ADDRESS',
  'QUOTE_SIGNER_ADDRESS',
  'FINALITY_SIGNER_ADDRESS',
  'TWAP_SOURCE_ADDRESS',
  'TWAP_SOURCE_CODEHASH',
  'SIGNER_SERVICE_URL',
  'SIGNER_SERVICE_TOKEN',
  'SETTLEMENT_EXECUTOR_URL',
  'SETTLEMENT_EXECUTOR_TOKEN',
  'SAFE_APPROVAL_VERIFIER_URL',
  'SAFE_APPROVAL_VERIFIER_TOKEN',
  'SAFE_INTERNAL_MTLS_ENABLED',
  'EXECUTOR_MAX_GAS_LIMIT',
  'SETTLEMENT_REPLACEMENT_DELAY_MS',
  'USDT_SAFE_PROXY_CODE_HASH',
  'USDT_SAFE_OWNER_SET_HASH',
  'USDT_SAFE_THRESHOLD',
  'USDT_SAFE_GUARD_ADDRESS',
  'USDT_SAFE_FALLBACK_HANDLER_ADDRESS',
  'USDT_SAFE_MODULES_HASH',
  'USDT_TOKEN_CODE_HASH',
  'USDT_TRANSFER_CONFORMANCE_EVIDENCE_HASH',
  'NPL_SAFE_PROXY_CODE_HASH',
  'NPL_SAFE_OWNER_SET_HASH',
  'NPL_SAFE_THRESHOLD',
  'NPL_SAFE_GUARD_ADDRESS',
  'NPL_SAFE_FALLBACK_HANDLER_ADDRESS',
  'NPL_SAFE_MODULES_HASH',
  'NPL_TOKEN_CODE_HASH',
  'NPL_TRANSFER_CONFORMANCE_EVIDENCE_HASH',
  'OPERATIONS_SAFE_PROXY_CODE_HASH',
  'OPERATIONS_SAFE_OWNER_SET_HASH',
  'OPERATIONS_SAFE_THRESHOLD',
  'OPERATIONS_SAFE_GUARD_ADDRESS',
  'OPERATIONS_SAFE_FALLBACK_HANDLER_ADDRESS',
  'OPERATIONS_SAFE_MODULES_HASH',
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
  'POLICY_SAFE_PROPOSER_URL',
  'POLICY_SAFE_PROPOSER_TOKEN',
  'POLICY_EXECUTION_LOOKUP_URL',
  'POLICY_EXECUTION_LOOKUP_TOKEN',
  'SYSTEM_CONFIG_SAFE_APPROVER_URL',
  'SYSTEM_CONFIG_SAFE_APPROVER_TOKEN',
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
  'DELIVERY_DATA_ENCRYPTION_KEY',
  'AMAP_WEB_SERVICE_KEY',
  'BSC_RPC_URL',
  'BSC_FALLBACK_RPC_URL',
  'PLATFORM_SAFE_ADDRESS',
  'PLATFORM_SERVICE_FEE_SAFE_ADDRESS',
  'USDT_CUSTODY_SAFE_ADDRESS',
  'NPL_REWARD_SAFE_ADDRESS',
  'OPERATIONS_TREASURY_SAFE_ADDRESS',
  'SECONDARY_SIGNER_ADDRESS',
  'QUOTE_SIGNER_ADDRESS',
  'TWAP_SOURCE_ADDRESS',
  'TWAP_SOURCE_CODEHASH',
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
  policyRegistryAddress: string | undefined;
  beneficiaryRegistryAddress: string | undefined;
  twapOracleAddress: string | undefined;
  safeAddress: string | undefined;
  platformServiceFeeSafeAddress: string | undefined;
  usdtCustodySafeAddress: string | undefined;
  nplRewardSafeAddress: string | undefined;
  operationsTreasurySafeAddress: string | undefined;
  secondarySignerAddress: string | undefined;
  quoteSignerAddress: string | undefined;
  finalitySignerAddress: string | undefined;
  twapSourceAddress: string | undefined;
  twapSourceCodeHash: string | undefined;
  signerServiceUrl: string | undefined;
  signerServiceToken: string | undefined;
  executorUrl: string | undefined;
  executorToken: string | undefined;
  executorMaxGasLimit: bigint | undefined;
  settlementReplacementDelayMs: number | undefined;
  safeApprovalVerifierUrl: string | undefined;
  safeApprovalVerifierToken: string | undefined;
  safeMutualTls: boolean;
  safeSettlementExpectations: Readonly<Partial<Record<'USDT' | 'NPL' | 'OPERATIONS_USDT', {
    safeAddress: string;
    safeProxyCodeHash: string;
    ownerSetHash: string;
    threshold: number;
    guardAddress: string;
    fallbackHandlerAddress: string;
    modulesHash: string;
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
  oracleDeploymentVerified: boolean;
  indexerHealthy: boolean;
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

  const missingDecisionVariables = decisionVariables.filter((name) => !env[name]);
  const missingAccountDecisionVariables = accountDecisionVariables.filter((name) => !env[name]);
  const decisionBlocked = [
    ...missingDecisionVariables,
    ...missingAccountDecisionVariables,
    ...unresolvedPublishedDecisions,
  ];
  const paymentDecisionBlocked = [...missingDecisionVariables, ...paymentUnresolvedPublishedDecisions];
  const deploymentReady = coordinatedDeploymentReady();
  const paymentRouterDeployment = manifestContractDeployment('PaymentRouterV2');
  const paymentRouterAddress = paymentRouterDeployment?.address;
  const paymentRouterDeploymentBlock = paymentRouterDeployment?.deploymentBlock;
  const policyRegistryAddress = manifestContractAddress('PolicyRegistryV2');
  const beneficiaryRegistryAddress = manifestContractAddress('BeneficiaryRegistryV2');
  const twapOracleAddress = manifestContractAddress('TwapOracleAdapterV2');
  const externalBlocked = [
    ...externalVariables.filter((name) => !env[name]),
    ...(!deploymentReady ? ['COORDINATED_DEPLOYMENT_AUTHORIZATION'] : []),
    ...(!paymentRouterAddress ? ['PAYMENT_ROUTER_ADDRESS_MANIFEST'] : []),
    ...(paymentRouterDeploymentBlock === undefined ? ['PAYMENT_ROUTER_DEPLOYMENT_BLOCK_MANIFEST'] : []),
    ...(!policyRegistryAddress ? ['POLICY_REGISTRY_ADDRESS_MANIFEST'] : []),
    ...(!beneficiaryRegistryAddress ? ['BENEFICIARY_REGISTRY_ADDRESS_MANIFEST'] : []),
    ...(!twapOracleAddress ? ['TWAP_ORACLE_ADDRESS_MANIFEST'] : []),
  ];
  const paymentExternalBlocked = [
    ...paymentExternalVariables.filter((name) => !env[name]),
    ...(!deploymentReady ? ['COORDINATED_DEPLOYMENT_AUTHORIZATION'] : []),
    ...(!paymentRouterAddress ? ['PAYMENT_ROUTER_ADDRESS_MANIFEST'] : []),
    ...(paymentRouterDeploymentBlock === undefined ? ['PAYMENT_ROUTER_DEPLOYMENT_BLOCK_MANIFEST'] : []),
    ...(!policyRegistryAddress ? ['POLICY_REGISTRY_ADDRESS_MANIFEST'] : []),
    ...(!beneficiaryRegistryAddress ? ['BENEFICIARY_REGISTRY_ADDRESS_MANIFEST'] : []),
    ...(!twapOracleAddress ? ['TWAP_ORACLE_ADDRESS_MANIFEST'] : []),
  ];
  if (missingDecisionVariables.length === 0) validateDecisionValues(env);
  validateProductionEndpoints(env);
  if (env.SAFE_INTERNAL_MTLS_ENABLED && env.SAFE_INTERNAL_MTLS_ENABLED !== 'true') {
    throw new CoreError('InvalidRequest', 'SAFE_INTERNAL_MTLS_ENABLED must be true', 500);
  }
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
    policyRegistryAddress,
    beneficiaryRegistryAddress,
    twapOracleAddress,
    safeAddress: normalizeOptionalAddress(env.PLATFORM_SAFE_ADDRESS),
    platformServiceFeeSafeAddress: normalizeOptionalAddress(env.PLATFORM_SERVICE_FEE_SAFE_ADDRESS),
    usdtCustodySafeAddress: normalizeOptionalAddress(env.USDT_CUSTODY_SAFE_ADDRESS),
    nplRewardSafeAddress: normalizeOptionalAddress(env.NPL_REWARD_SAFE_ADDRESS),
    operationsTreasurySafeAddress: normalizeOptionalAddress(env.OPERATIONS_TREASURY_SAFE_ADDRESS),
    secondarySignerAddress: normalizeOptionalAddress(env.SECONDARY_SIGNER_ADDRESS),
    quoteSignerAddress: normalizeOptionalAddress(env.QUOTE_SIGNER_ADDRESS),
    finalitySignerAddress: normalizeOptionalAddress(env.FINALITY_SIGNER_ADDRESS),
    twapSourceAddress: normalizeOptionalAddress(env.TWAP_SOURCE_ADDRESS),
    twapSourceCodeHash: normalizeOptionalHash(env.TWAP_SOURCE_CODEHASH, 'TWAP_SOURCE_CODEHASH'),
    signerServiceUrl: env.SIGNER_SERVICE_URL,
    signerServiceToken: env.SIGNER_SERVICE_TOKEN,
    executorUrl: env.SETTLEMENT_EXECUTOR_URL,
    executorToken: env.SETTLEMENT_EXECUTOR_TOKEN,
    executorMaxGasLimit: parseOptionalPositiveBigInt(env.EXECUTOR_MAX_GAS_LIMIT, 'EXECUTOR_MAX_GAS_LIMIT'),
    settlementReplacementDelayMs: parseOptionalPositiveInteger(
      env.SETTLEMENT_REPLACEMENT_DELAY_MS,
      'SETTLEMENT_REPLACEMENT_DELAY_MS',
    ),
    safeApprovalVerifierUrl: env.SAFE_APPROVAL_VERIFIER_URL,
    safeApprovalVerifierToken: env.SAFE_APPROVAL_VERIFIER_TOKEN,
    safeMutualTls: env.SAFE_INTERNAL_MTLS_ENABLED === 'true',
    safeSettlementExpectations: Object.freeze({
      ...(safeExpectation(env, 'USDT', normalizeOptionalAddress(env.USDT_CUSTODY_SAFE_ADDRESS), USDT_ADDRESS)
        ? { USDT: safeExpectation(env, 'USDT', normalizeOptionalAddress(env.USDT_CUSTODY_SAFE_ADDRESS), USDT_ADDRESS)! }
        : {}),
      ...(safeExpectation(env, 'NPL', normalizeOptionalAddress(env.NPL_REWARD_SAFE_ADDRESS), NPL_ADDRESS)
        ? { NPL: safeExpectation(env, 'NPL', normalizeOptionalAddress(env.NPL_REWARD_SAFE_ADDRESS), NPL_ADDRESS)! }
        : {}),
      ...(safeExpectation(
        env,
        'OPERATIONS',
        normalizeOptionalAddress(env.OPERATIONS_TREASURY_SAFE_ADDRESS),
        USDT_ADDRESS,
      )
        ? {
          OPERATIONS_USDT: safeExpectation(
            env,
            'OPERATIONS',
            normalizeOptionalAddress(env.OPERATIONS_TREASURY_SAFE_ADDRESS),
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
  });
}

export function publicReadiness(config: CoreConfig, runtime?: RuntimeReadinessSnapshot, now = new Date()) {
  return {
    chainId: config.chainId,
    assets: { usdt: config.usdtAddress, npl: config.nplAddress, nplUsdtPair: config.nplUsdtPairAddress },
    decisionBlocked: config.decisionBlocked,
    externalBlocked: config.externalBlocked,
    paymentDecisionBlocked: config.paymentDecisionBlocked,
    paymentExternalBlocked: config.paymentExternalBlocked,
    providers: config.providerReadiness,
    writesEnabled:
      config.deploymentReady &&
      config.paymentDecisionBlocked.length === 0 &&
      config.paymentExternalBlocked.length === 0 &&
      runtimeReadinessValid(runtime, now),
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
    snapshot.safeAdminVerified,
    snapshot.signerBindingsVerified,
    snapshot.oracleDeploymentVerified,
    snapshot.indexerHealthy,
    snapshot.databaseHealthy,
    snapshot.redisHealthy,
    snapshot.rpcChain56Healthy,
    snapshot.signerHealthy,
  ].every((value) => value === true);
}

function validateProductionEndpoints(env: Readonly<Record<string, string | undefined>>) {
  for (const name of [
    'SIGNER_SERVICE_URL',
    'SETTLEMENT_EXECUTOR_URL',
    'SAFE_APPROVAL_VERIFIER_URL',
    'BNM_AVAILABILITY_URL',
    'MEDIA_STORAGE_SIGNER_URL',
    'POLICY_SAFE_PROPOSER_URL',
    'POLICY_EXECUTION_LOOKUP_URL',
    'SYSTEM_CONFIG_SAFE_APPROVER_URL',
    'SECRET_RESOLVER_URL',
    'BSC_EXPLORER_API_URL',
    'ALIYUN_SMS_GATEWAY_URL',
    'TENCENT_SMS_GATEWAY_URL',
    'SMTP_GATEWAY_URL',
    'FIREBASE_GATEWAY_URL',
    'JPUSH_GATEWAY_URL',
  ]) {
    const value = env[name];
    if (value && protocol(value) !== 'https:') throw new CoreError('InvalidRequest', `${name} must use HTTPS`, 500);
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
  const custodySafes = [
    env.PLATFORM_SAFE_ADDRESS,
    env.PLATFORM_SERVICE_FEE_SAFE_ADDRESS,
    env.USDT_CUSTODY_SAFE_ADDRESS,
    env.NPL_REWARD_SAFE_ADDRESS,
    env.OPERATIONS_TREASURY_SAFE_ADDRESS,
  ].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  if (new Set(custodySafes).size !== custodySafes.length) {
    throw new CoreError('InvalidRequest', 'Governance, fee, custody, reward and operations Safes must be distinct', 500);
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

function safeExpectation(
  env: Readonly<Record<string, string | undefined>>,
  prefix: 'USDT' | 'NPL' | 'OPERATIONS',
  safeAddress: string | undefined,
  tokenAddress: string,
) {
  const names = {
    safeProxyCodeHash: `${prefix}_SAFE_PROXY_CODE_HASH`,
    ownerSetHash: `${prefix}_SAFE_OWNER_SET_HASH`,
    threshold: `${prefix}_SAFE_THRESHOLD`,
    guardAddress: `${prefix}_SAFE_GUARD_ADDRESS`,
    fallbackHandlerAddress: `${prefix}_SAFE_FALLBACK_HANDLER_ADDRESS`,
    modulesHash: `${prefix}_SAFE_MODULES_HASH`,
    tokenCodeHash: `${prefix}_TOKEN_CODE_HASH`,
    tokenTransferConformanceEvidenceHash: `${prefix}_TRANSFER_CONFORMANCE_EVIDENCE_HASH`,
  } as const;
  if (!safeAddress || Object.values(names).some((name) => !env[name])) return undefined;
  const threshold = Number(env[names.threshold]);
  if (!Number.isSafeInteger(threshold) || threshold <= 0) {
    throw new CoreError('InvalidRequest', `${names.threshold} must be a positive integer`, 500);
  }
  return {
    safeAddress,
    safeProxyCodeHash: normalizeOptionalHash(env[names.safeProxyCodeHash], names.safeProxyCodeHash)!,
    ownerSetHash: normalizeOptionalHash(env[names.ownerSetHash], names.ownerSetHash)!,
    threshold,
    guardAddress: normalizeOptionalAddress(env[names.guardAddress])!,
    fallbackHandlerAddress: normalizeOptionalAddress(env[names.fallbackHandlerAddress])!,
    modulesHash: normalizeOptionalHash(env[names.modulesHash], names.modulesHash)!,
    tokenAddress,
    tokenCodeHash: normalizeOptionalHash(env[names.tokenCodeHash], names.tokenCodeHash)!,
    tokenTransferConformanceEvidenceHash: normalizeOptionalHash(
      env[names.tokenTransferConformanceEvidenceHash],
      names.tokenTransferConformanceEvidenceHash,
    )!,
  };
}

function validateDecisionValues(env: Readonly<Record<string, string | undefined>>) {
  for (const name of ['PLATFORM_SERVICE_FEE_BPS', 'SECKILL_PRIZE_POOL_BPS', 'MERCHANT_STORE_REWARD_BPS']) {
    const value = Number(env[name]);
    if (!Number.isInteger(value) || value < 0 || value > 10_000) {
      throw new CoreError('InvalidRequest', `${name} must be integer BPS`, 500);
    }
  }
  normalizeOptionalAddress(env.CIRCULATION_REWARD_POOL_ADDRESS);
  validateConcessionDestinations(env.MERCHANT_CONCESSION_DESTINATIONS_JSON!);
  normalizeOptionalAddress(env.GENESIS_CREDENTIAL_ADDRESS);
  try {
    if (BigInt(env.GENESIS_CREDENTIAL_TOKEN_ID!) < 0n) throw new Error('negative token id');
  } catch {
    throw new CoreError('InvalidRequest', 'GENESIS_CREDENTIAL_TOKEN_ID must be a non-negative integer', 500);
  }
}

function validateFrozenOverrides(env: Readonly<Record<string, string | undefined>>) {
  const exact = [
    ['REQUIRED_CONFIRMATIONS', '15'],
    ['ORACLE_MAX_AGE_SECONDS', '600'],
    ['ORACLE_MINIMUM_LIQUIDITY', String(50_000n * 10n ** 18n)],
    ['MERCHANT_GUARANTEE_MINIMUM_USDT', String(1_000n * 10n ** 18n)],
  ] as const;
  for (const [name, expected] of exact) {
    if (env[name] !== undefined && env[name] !== expected) {
      throw new CoreError('InvalidRequest', `${name} is frozen at ${expected}`, 500);
    }
  }
}

function validateConcessionDestinations(value: string) {
  let destinations: unknown;
  try {
    destinations = JSON.parse(value);
  } catch {
    throw new CoreError('InvalidRequest', 'MERCHANT_CONCESSION_DESTINATIONS_JSON must be valid JSON', 500);
  }
  if (!Array.isArray(destinations) || destinations.length === 0) {
    throw new CoreError('InvalidRequest', 'Merchant concession destinations are required', 500);
  }
  let total = 0;
  let previous = '';
  for (const item of destinations) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new CoreError('InvalidRequest', 'Invalid merchant concession destination', 500);
    }
    const { account, weightBps } = item as { account?: unknown; weightBps?: unknown };
    const normalized = typeof account === 'string' ? account.toLowerCase() : '';
    if (!/^0x[0-9a-f]{40}$/.test(normalized) || normalized <= previous || !Number.isInteger(weightBps) || (weightBps as number) <= 0) {
      throw new CoreError('InvalidRequest', 'Merchant concession destinations must be sorted and positive', 500);
    }
    total += weightBps as number;
    previous = normalized;
  }
  if (total !== 10_000) throw new CoreError('InvalidRequest', 'Merchant concession destination weights must sum to 100%', 500);
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
