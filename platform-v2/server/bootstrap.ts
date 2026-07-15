import { fileURLToPath } from 'node:url';
import contractManifest from '../../packages/core-artifacts/contracts/contract-manifest.json' with { type: 'json' };
import { createApiServer } from './api/app.ts';
import type { OrderProjection } from './api/allowed-actions.ts';
import { loadConfig } from './api/config.ts';
import { CORE_ARTIFACT_VERSION, type BreakerScope, type UserRole } from './api/enums.ts';
import { CoreError } from './api/errors.ts';
import { AmapAdministrativeRegionResolver, AmapPostalAddressParser } from './api/providers.ts';
import {
  HttpNotificationProviderAdapter,
  HttpSecretReferenceResolver,
  type ExternalNotificationProvider,
} from './api/notification-providers.ts';
import {
  MiddlewareMonitoringSource,
  NodeHostMonitoringSource,
  RpcExplorerHeightSource,
} from './api/monitoring-sources.ts';
import {
  ResilientBscContractReader,
  RpcBeneficiarySnapshotSource,
  RpcPaymentOracleQuoteSource,
  RpcPaymentPolicyAttestationSource,
  RpcWalletMessageSignatureVerifier,
} from './chain/payment-sources.ts';
import { AbiEventDecoder } from './chain/abi-decoder.ts';
import { BnmAvailabilityWorker, HttpBnmAvailabilityAdapter } from './chain/bnm-availability-worker.ts';
import { FulfillmentSchedulerWorker } from './chain/fulfillment-scheduler-worker.ts';
import {
  GuaranteeDepositWorker,
  ResilientBscGuaranteeDepositSource,
} from './chain/guarantee-deposit-worker.ts';
import { CoverageWorker } from './chain/coverage-worker.ts';
import { ResilientBscCoverageSource } from './chain/coverage-source.ts';
import {
  CoverageBreakerGovernanceWorker,
  HttpCoverageBreakerSafeProposer,
  ResilientCoverageBreakerChainSource,
} from './chain/coverage-breaker-governance.ts';
import { ChainIndexer } from './chain/indexer.ts';
import {
  PollingPaymentIndexer,
  ResilientBscPaymentChainSource,
} from './chain/payment-indexer-worker.ts';
import {
  PaymentRuntimeReadinessMonitor,
  RpcPaymentRuntimeAttestor,
  verifyArtifactChecksums,
} from './chain/runtime-readiness.ts';
import { RemoteSignerClient } from './chain/signer.ts';
import {
  HttpSafeApprovalVerifier,
  HttpSafeSettlementBroadcaster,
  ResilientBscSafeSettlementChainSource,
} from './chain/safe-settlement-adapters.ts';
import { RpcSafeRuntimeAttestor } from './chain/safe-runtime-attestor.ts';
import { SettlementBatchScheduler, SettlementWorker } from './chain/settlement-worker.ts';
import { AuditOutboxWorker } from './chain/audit-outbox-worker.ts';
import { NotificationWorker } from './chain/notification-worker.ts';
import { OperationsMonitoringWorker, RuntimeMetricsRegistry } from './chain/monitoring-worker.ts';
import {
  HttpPolicySafeProposer,
  HttpRpcPolicyChainSource,
  PolicyFinalityWorker,
} from './chain/policy-publication-worker.ts';
import { HttpSystemConfigSafeApprover } from './chain/system-config-governance.ts';
import { HttpTakeoverFundingSafeApprover } from './chain/takeover-funding-governance.ts';
import { PostgresNonceStore, RedisNonceRateLimiter } from './data/auth-store.ts';
import { CatalogPaymentService } from './data/catalog-payment-service.ts';
import { CatalogManagementService } from './data/catalog-management-service.ts';
import { CoverageBreakerService } from './data/coverage-breaker-service.ts';
import { EvidenceService, HttpMediaStorageAdapter } from './data/evidence-service.ts';
import { FulfillmentService } from './data/fulfillment-service.ts';
import { FulfillmentTargetService } from './data/fulfillment-target-service.ts';
import { GuaranteeDepositService } from './data/guarantee-deposit-service.ts';
import {
  createPostgresPool,
  createRedisConnection,
  postgresTransactionRunner,
} from './data/connections.ts';
import type { SqlExecutor } from './data/migrations.ts';
import { PostgresIndexerStore } from './data/indexer-store.ts';
import { SettlementService } from './data/settlement-service.ts';
import { SeckillService } from './data/seckill-service.ts';
import { TakeoverFundingService } from './data/takeover-funding-service.ts';
import { AuditQueryService } from './data/audit-service.ts';
import { CmsService } from './data/cms-service.ts';
import { MonitoringService } from './data/monitoring-service.ts';
import { NotificationService } from './data/notification-service.ts';
import { PolicyService } from './data/policy-service.ts';
import { SystemConfigService } from './data/system-config-service.ts';
import { BusinessAnalyticsService } from './data/business-analytics-service.ts';
import { AccountService } from './data/account-service.ts';
import { RiskService } from './data/risk-service.ts';

const ARTIFACT_ROOT = fileURLToPath(new URL('../../packages/core-artifacts/', import.meta.url));
const ABI_BUNDLE_PATH = fileURLToPath(
  new URL('../../packages/core-artifacts/contracts/abi-bundle.json', import.meta.url),
);

export const coreBaseline = Object.freeze({
  artifactVersion: CORE_ARTIFACT_VERSION,
  status: 'settlement-runtime',
} as const);

export async function createCoreRuntime(env: Readonly<Record<string, string | undefined>>) {
  const config = loadConfig(env);
  const databaseUrl = required(config.databaseUrl, 'DATABASE_URL');
  const auditDatabaseUrl = required(config.auditDatabaseUrl, 'AUDIT_DATABASE_URL');
  const redisUrl = required(config.redisUrl, 'REDIS_URL');
  const authDomain = required(config.authDomain, 'AUTH_DOMAIN');
  const authUri = required(config.authUri, 'AUTH_URI');
  const pool = createPostgresPool(databaseUrl);
  const auditPool = createPostgresPool(auditDatabaseUrl);
  const redis = await createRedisConnection(redisUrl);
  const database = sqlExecutor(pool);
  const transactions = postgresTransactionRunner(pool);
  const auditDatabase = sqlExecutor(auditPool);
  const auditTransactions = postgresTransactionRunner(auditPool);
  const reader = new ResilientBscContractReader(config.rpcUrl, config.fallbackRpcUrl);
  const walletSignatureVerifier = new RpcWalletMessageSignatureVerifier(reader);
  const signer = new RemoteSignerClient({
    url: required(config.signerServiceUrl, 'SIGNER_SERVICE_URL'),
    token: required(config.signerServiceToken, 'SIGNER_SERVICE_TOKEN'),
    expectedSigner: required(config.quoteSignerAddress, 'QUOTE_SIGNER_ADDRESS'),
  });
  const paymentService = new CatalogPaymentService({
    transactions,
    signer,
    oracle: new RpcPaymentOracleQuoteSource({
      reader,
      sourceAddress: required(config.twapSourceAddress, 'TWAP_SOURCE_ADDRESS'),
    }),
    beneficiaries: new RpcBeneficiarySnapshotSource({
      reader,
      beneficiaryRegistryAddress: required(config.beneficiaryRegistryAddress, 'BENEFICIARY_REGISTRY_ADDRESS_MANIFEST'),
    }),
    policies: new RpcPaymentPolicyAttestationSource({
      reader,
      policyRegistryAddress: required(config.policyRegistryAddress, 'POLICY_REGISTRY_ADDRESS_MANIFEST'),
    }),
    paymentRouterAddress: required(config.paymentRouterAddress, 'PAYMENT_ROUTER_ADDRESS_MANIFEST'),
  });
  const catalogManagementService = new CatalogManagementService({ transactions, signer });
  const indexerStore = new PostgresIndexerStore(transactions);
  const seckillService = new SeckillService({ transactions });
  const fulfillmentService = new FulfillmentService({ transactions });
  const uploadLimits = mediaUploadLimits(env);
  const evidenceService = new EvidenceService({
    transactions,
    ...(env.TRACKING_HASH_KEY ? { trackingHashKey: env.TRACKING_HASH_KEY } : {}),
    ...(uploadLimits ? { uploadLimits } : {}),
    storage: new HttpMediaStorageAdapter({
      ...(env.MEDIA_STORAGE_SIGNER_URL ? { url: env.MEDIA_STORAGE_SIGNER_URL } : {}),
      ...(env.MEDIA_STORAGE_SIGNER_TOKEN ? { token: env.MEDIA_STORAGE_SIGNER_TOKEN } : {}),
    }),
  });
  const settlementService = new SettlementService({
    transactions,
    contractWalletVerifier: walletSignatureVerifier,
    secondarySignerAddress: required(config.secondarySignerAddress, 'SECONDARY_SIGNER_ADDRESS'),
    governanceVerifyingContract: required(config.safeAddress, 'PLATFORM_SAFE_ADDRESS'),
  });
  const auditReady = async () => {
    try {
      await auditPool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  };
  const takeoverFundingService = new TakeoverFundingService({
    transactions,
    approver: new HttpTakeoverFundingSafeApprover({
      ...(env.TAKEOVER_FUNDING_SAFE_APPROVER_URL ? { url: env.TAKEOVER_FUNDING_SAFE_APPROVER_URL } : {}),
      ...(env.TAKEOVER_FUNDING_SAFE_APPROVER_TOKEN ? { token: env.TAKEOVER_FUNDING_SAFE_APPROVER_TOKEN } : {}),
      mutualTls: config.safeMutualTls,
    }),
    secondarySigner: required(config.secondarySignerAddress, 'SECONDARY_SIGNER_ADDRESS'),
    governanceSafe: required(config.safeAddress, 'PLATFORM_SAFE_ADDRESS'),
    verifyingContract: required(config.safeAddress, 'PLATFORM_SAFE_ADDRESS'),
    auditReady,
  });
  const guaranteeDepositService = new GuaranteeDepositService({
    transactions,
    operationsSafeAddress: required(config.operationsTreasurySafeAddress, 'OPERATIONS_TREASURY_SAFE_ADDRESS'),
  });
  const guaranteeDepositWorker = new GuaranteeDepositWorker({
    service: guaranteeDepositService,
    source: new ResilientBscGuaranteeDepositSource({
      primaryRpcUrl: required(config.rpcUrl, 'BSC_RPC_URL'),
      fallbackRpcUrl: required(config.fallbackRpcUrl, 'BSC_FALLBACK_RPC_URL'),
    }),
  });
  const policyService = new PolicyService({
    transactions,
    proposer: new HttpPolicySafeProposer({
      ...(env.POLICY_SAFE_PROPOSER_URL ? { url: env.POLICY_SAFE_PROPOSER_URL } : {}),
      ...(env.POLICY_SAFE_PROPOSER_TOKEN ? { token: env.POLICY_SAFE_PROPOSER_TOKEN } : {}),
      mutualTls: config.safeMutualTls,
    }),
    policyRegistryAddress: required(config.policyRegistryAddress, 'POLICY_REGISTRY_ADDRESS_MANIFEST'),
    governanceSafe: required(config.safeAddress, 'PLATFORM_SAFE_ADDRESS'),
    secondarySigner: required(config.secondarySignerAddress, 'SECONDARY_SIGNER_ADDRESS'),
    decisionBlocked: config.paymentDecisionBlocked,
    auditReady,
  });
  const cmsService = new CmsService({ transactions });
  const notificationService = new NotificationService({ transactions });
  const secretResolver = new HttpSecretReferenceResolver({
    ...(env.SECRET_RESOLVER_URL ? { url: env.SECRET_RESOLVER_URL } : {}),
    ...(env.SECRET_RESOLVER_TOKEN ? { token: env.SECRET_RESOLVER_TOKEN } : {}),
  });
  const notificationAdapters = ([
    ['ALIYUN_SMS', 'ALIYUN_SMS_GATEWAY_URL', 'ALIYUN_SMS_CREDENTIAL_REF'],
    ['TENCENT_SMS', 'TENCENT_SMS_GATEWAY_URL', 'TENCENT_SMS_CREDENTIAL_REF'],
    ['SMTP', 'SMTP_GATEWAY_URL', 'SMTP_CREDENTIAL_REF'],
    ['FIREBASE', 'FIREBASE_GATEWAY_URL', 'FIREBASE_CREDENTIAL_REF'],
    ['JPUSH', 'JPUSH_GATEWAY_URL', 'JPUSH_CREDENTIAL_REF'],
  ] as const).map(([provider, gatewayName, credentialName]) => new HttpNotificationProviderAdapter({
    provider: provider as ExternalNotificationProvider,
    ...(env[gatewayName] ? { gatewayUrl: env[gatewayName] } : {}),
    ...(env[credentialName] ? { credentialReference: env[credentialName] } : {}),
    resolver: secretResolver,
  }));
  const notificationWorker = new NotificationWorker({
    transactions,
    service: notificationService,
    adapters: notificationAdapters,
  });
  const systemConfigService = new SystemConfigService({
    transactions,
    approver: new HttpSystemConfigSafeApprover({
      ...(env.SYSTEM_CONFIG_SAFE_APPROVER_URL ? { url: env.SYSTEM_CONFIG_SAFE_APPROVER_URL } : {}),
      ...(env.SYSTEM_CONFIG_SAFE_APPROVER_TOKEN ? { token: env.SYSTEM_CONFIG_SAFE_APPROVER_TOKEN } : {}),
      mutualTls: config.safeMutualTls,
    }),
    secondarySigner: required(config.secondarySignerAddress, 'SECONDARY_SIGNER_ADDRESS'),
    governanceSafe: required(config.safeAddress, 'PLATFORM_SAFE_ADDRESS'),
    verifyingContract: required(config.safeAddress, 'PLATFORM_SAFE_ADDRESS'),
    auditReady,
  });
  const auditWorker = new AuditOutboxWorker({ business: transactions, audit: auditTransactions });
  const runtimeMetrics = new RuntimeMetricsRegistry();
  const monitoringService = new MonitoringService({ transactions });
  const businessAnalyticsService = new BusinessAnalyticsService({ transactions });
  const monitoringWorker = new OperationsMonitoringWorker({
    transactions,
    sources: [
      new NodeHostMonitoringSource(),
      new MiddlewareMonitoringSource({
        database,
        redis,
        dbPool: () => ({ active: pool.totalCount - pool.idleCount, maximum: 20 }),
      }),
      new RpcExplorerHeightSource({
        ...(config.rpcUrl ? { primaryRpcUrl: config.rpcUrl } : {}),
        ...(config.fallbackRpcUrl ? { fallbackRpcUrl: config.fallbackRpcUrl } : {}),
        ...(env.BSC_EXPLORER_API_URL ? { explorerApiUrl: env.BSC_EXPLORER_API_URL } : {}),
        ...(env.EXPLORER_API_KEY ? { explorerApiKey: env.EXPLORER_API_KEY } : {}),
      }),
      runtimeMetrics,
    ],
  });
  const policyFinalityWorker = new PolicyFinalityWorker({
    service: policyService,
    source: new HttpRpcPolicyChainSource({
      ...(env.POLICY_EXECUTION_LOOKUP_URL ? { lookupUrl: env.POLICY_EXECUTION_LOOKUP_URL } : {}),
      ...(env.POLICY_EXECUTION_LOOKUP_TOKEN ? { lookupToken: env.POLICY_EXECUTION_LOOKUP_TOKEN } : {}),
      ...(config.rpcUrl ? { primaryRpcUrl: config.rpcUrl } : {}),
      ...(config.fallbackRpcUrl ? { fallbackRpcUrl: config.fallbackRpcUrl } : {}),
    }),
  });
  const usdtSafeExpectation = required(
    config.safeSettlementExpectations.USDT,
    'USDT_SAFE_RUNTIME_EXPECTATIONS',
  );
  const nplSafeExpectation = required(
    config.safeSettlementExpectations.NPL,
    'NPL_SAFE_RUNTIME_EXPECTATIONS',
  );
  const operationsSafeExpectation = required(
    config.safeSettlementExpectations.OPERATIONS_USDT,
    'OPERATIONS_SAFE_RUNTIME_EXPECTATIONS',
  );
  const usdtSafeAttestor = new RpcSafeRuntimeAttestor({ reader, expected: usdtSafeExpectation });
  const nplSafeAttestor = new RpcSafeRuntimeAttestor({ reader, expected: nplSafeExpectation });
  const operationsSafeAttestor = new RpcSafeRuntimeAttestor({ reader, expected: operationsSafeExpectation });
  const coverageAssets = [
    {
      safeAddress: usdtSafeExpectation.safeAddress,
      asset: 'USDT' as const,
      tokenAddress: usdtSafeExpectation.tokenAddress,
    },
    {
      safeAddress: nplSafeExpectation.safeAddress,
      asset: 'NPL' as const,
      tokenAddress: nplSafeExpectation.tokenAddress,
    },
    {
      safeAddress: operationsSafeExpectation.safeAddress,
      asset: 'USDT' as const,
      tokenAddress: operationsSafeExpectation.tokenAddress,
    },
  ];
  const coverageWorker = new CoverageWorker({
    transactions,
    source: new ResilientBscCoverageSource({
      primaryRpcUrl: required(config.rpcUrl, 'BSC_RPC_URL'),
      fallbackRpcUrl: required(config.fallbackRpcUrl, 'BSC_FALLBACK_RPC_URL'),
      assets: coverageAssets,
    }),
    expectedAssets: coverageAssets,
    paymentRouterAddress: required(config.paymentRouterAddress, 'PAYMENT_ROUTER_ADDRESS_MANIFEST'),
    governanceSafeAddress: required(config.safeAddress, 'PLATFORM_SAFE_ADDRESS'),
  });
  const coverageBreakerService = new CoverageBreakerService({
    transactions,
    paymentRouterAddress: required(config.paymentRouterAddress, 'PAYMENT_ROUTER_ADDRESS_MANIFEST'),
    governanceSafeAddress: required(config.safeAddress, 'PLATFORM_SAFE_ADDRESS'),
    secondarySignerAddress: required(config.secondarySignerAddress, 'SECONDARY_SIGNER_ADDRESS'),
  });
  const coverageBreakerGovernanceWorker = new CoverageBreakerGovernanceWorker({
    transactions,
    proposer: new HttpCoverageBreakerSafeProposer({
      ...(env.POLICY_SAFE_PROPOSER_URL ? { url: env.POLICY_SAFE_PROPOSER_URL } : {}),
      ...(env.POLICY_SAFE_PROPOSER_TOKEN ? { token: env.POLICY_SAFE_PROPOSER_TOKEN } : {}),
      mutualTls: config.safeMutualTls,
    }),
    chain: new ResilientCoverageBreakerChainSource({
      ...(env.POLICY_EXECUTION_LOOKUP_URL ? { lookupUrl: env.POLICY_EXECUTION_LOOKUP_URL } : {}),
      ...(env.POLICY_EXECUTION_LOOKUP_TOKEN ? { lookupToken: env.POLICY_EXECUTION_LOOKUP_TOKEN } : {}),
      ...(config.rpcUrl ? { primaryRpcUrl: config.rpcUrl } : {}),
      ...(config.fallbackRpcUrl ? { fallbackRpcUrl: config.fallbackRpcUrl } : {}),
    }),
  });
  const settlementBatchScheduler = new SettlementBatchScheduler({
    service: settlementService,
    platformWallet: required(config.safeAddress, 'PLATFORM_SAFE_ADDRESS'),
    targets: [
      { asset: 'USDT', attest: () => usdtSafeAttestor.attest() },
      { asset: 'NPL', attest: () => nplSafeAttestor.attest() },
      { asset: 'USDT', attest: () => operationsSafeAttestor.attest() },
    ],
  });
  const executorMaxGasLimit = required(config.executorMaxGasLimit, 'EXECUTOR_MAX_GAS_LIMIT');
  const settlementWorker = new SettlementWorker({
    transactions,
    approvals: new HttpSafeApprovalVerifier({
      url: required(config.safeApprovalVerifierUrl, 'SAFE_APPROVAL_VERIFIER_URL'),
      token: required(config.safeApprovalVerifierToken, 'SAFE_APPROVAL_VERIFIER_TOKEN'),
      mutualTls: config.safeMutualTls,
    }),
    broadcaster: new HttpSafeSettlementBroadcaster({
      url: required(config.executorUrl, 'SETTLEMENT_EXECUTOR_URL'),
      token: required(config.executorToken, 'SETTLEMENT_EXECUTOR_TOKEN'),
      mutualTls: config.safeMutualTls,
      maxOuterGasLimit: executorMaxGasLimit,
    }),
    chain: new ResilientBscSafeSettlementChainSource({
      primaryRpcUrl: required(config.rpcUrl, 'BSC_RPC_URL'),
      fallbackRpcUrl: required(config.fallbackRpcUrl, 'BSC_FALLBACK_RPC_URL'),
    }),
    runtimeAttest: (safeAddress) => {
      if (safeAddress === usdtSafeExpectation.safeAddress) return usdtSafeAttestor.attest();
      if (safeAddress === nplSafeExpectation.safeAddress) return nplSafeAttestor.attest();
      if (safeAddress === operationsSafeExpectation.safeAddress) return operationsSafeAttestor.attest();
      throw new CoreError('ExternalBlocked', 'Settlement Safe runtime attestor is unavailable', 503);
    },
    outerGasLimit: executorMaxGasLimit.toString(),
    replacementDelayMs: required(
      config.settlementReplacementDelayMs,
      'SETTLEMENT_REPLACEMENT_DELAY_MS',
    ),
  });
  const fulfillmentScheduler = new FulfillmentSchedulerWorker({
    service: fulfillmentService,
    platformWallet: required(config.safeAddress, 'PLATFORM_SAFE_ADDRESS'),
    transactions,
  });
  const regionResolver = new AmapAdministrativeRegionResolver({
    ...(env.AMAP_WEB_SERVICE_KEY ? { key: env.AMAP_WEB_SERVICE_KEY } : {}),
  });
  const fulfillmentTargetService = new FulfillmentTargetService({
    transactions,
    regions: regionResolver,
    ...(env.DELIVERY_DATA_ENCRYPTION_KEY ? { encryptionKey: env.DELIVERY_DATA_ENCRYPTION_KEY } : {}),
  });
  const accountService = new AccountService({
    transactions,
    regions: regionResolver,
    parser: new AmapPostalAddressParser({
      ...(env.AMAP_WEB_SERVICE_KEY ? { key: env.AMAP_WEB_SERVICE_KEY } : {}),
    }),
    ...(env.DELIVERY_DATA_ENCRYPTION_KEY ? { encryptionKey: env.DELIVERY_DATA_ENCRYPTION_KEY } : {}),
    ...(config.piiRetentionPolicyVersion
      ? { retentionPolicyVersion: config.piiRetentionPolicyVersion }
      : {}),
    createDeliveryTarget: (actor, input) => fulfillmentTargetService.createDeliveryTarget(actor, input),
  });
  const riskService = new RiskService({ transactions });
  const bnmWorker = new BnmAvailabilityWorker({
    transactions,
    adapter: new HttpBnmAvailabilityAdapter({
      ...(env.BNM_AVAILABILITY_URL ? { url: env.BNM_AVAILABILITY_URL } : {}),
      ...(env.BNM_API_TOKEN ? { token: env.BNM_API_TOKEN } : {}),
      ...(env.BNM_PROJECT_ID ? { projectId: env.BNM_PROJECT_ID } : {}),
      ...(config.bnmMonotonicConformanceEvidenceHash
        ? { conformanceEvidenceHash: config.bnmMonotonicConformanceEvidenceHash }
        : {}),
    }),
  });
  const decoder = await AbiEventDecoder.load(ABI_BUNDLE_PATH, {
    PaymentRouterV2: required(config.paymentRouterAddress, 'PAYMENT_ROUTER_ADDRESS_MANIFEST'),
  });
  const paymentIndexer = new PollingPaymentIndexer({
    source: new ResilientBscPaymentChainSource({
      primaryRpcUrl: required(config.rpcUrl, 'BSC_RPC_URL'),
      fallbackRpcUrl: required(config.fallbackRpcUrl, 'BSC_FALLBACK_RPC_URL'),
      routerAddress: required(config.paymentRouterAddress, 'PAYMENT_ROUTER_ADDRESS_MANIFEST'),
    }),
    indexer: new ChainIndexer(decoder, indexerStore),
    store: indexerStore,
    deploymentBlock: required(config.paymentRouterDeploymentBlock, 'PAYMENT_ROUTER_DEPLOYMENT_BLOCK_MANIFEST'),
  });
  await paymentIndexer.pollOnce().catch(() => undefined);
  paymentIndexer.start();
  if (config.providerReadiness.BNM === 'READY') {
    await bnmWorker.pollOnce().catch(() => undefined);
    bnmWorker.start();
  }
  await fulfillmentScheduler.pollOnce().catch(() => undefined);
  fulfillmentScheduler.start();
  await coverageWorker.pollOnce().catch(() => undefined);
  coverageWorker.start();
  await coverageBreakerGovernanceWorker.pollOnce().catch(() => undefined);
  coverageBreakerGovernanceWorker.start();
  await guaranteeDepositWorker.pollOnce().catch(() => undefined);
  guaranteeDepositWorker.start();
  await settlementBatchScheduler.pollOnce().catch(() => undefined);
  settlementBatchScheduler.start();
  await settlementWorker.pollOnce().catch(() => undefined);
  settlementWorker.start();
  await auditWorker.pollOnce().catch(() => undefined);
  auditWorker.start();
  await notificationWorker.pollOnce().catch(() => undefined);
  notificationWorker.start();
  await monitoringWorker.pollOnce().catch(() => undefined);
  monitoringWorker.start();
  await policyFinalityWorker.pollOnce().catch(() => undefined);
  policyFinalityWorker.start();

  const runtimeAttestor = new RpcPaymentRuntimeAttestor({
    reader,
    deployments: runtimeDeploymentExpectations(),
    router: required(config.paymentRouterAddress, 'PAYMENT_ROUTER_ADDRESS_MANIFEST'),
    policyRegistry: required(config.policyRegistryAddress, 'POLICY_REGISTRY_ADDRESS_MANIFEST'),
    beneficiaryRegistry: required(config.beneficiaryRegistryAddress, 'BENEFICIARY_REGISTRY_ADDRESS_MANIFEST'),
    oracle: required(config.twapOracleAddress, 'TWAP_ORACLE_ADDRESS_MANIFEST'),
    twapSource: required(config.twapSourceAddress, 'TWAP_SOURCE_ADDRESS'),
    twapSourceCodeHash: required(config.twapSourceCodeHash, 'TWAP_SOURCE_CODEHASH'),
    governanceSafe: required(config.safeAddress, 'PLATFORM_SAFE_ADDRESS'),
    usdtCustodySafe: required(config.usdtCustodySafeAddress, 'USDT_CUSTODY_SAFE_ADDRESS'),
    nplRewardSafe: required(config.nplRewardSafeAddress, 'NPL_REWARD_SAFE_ADDRESS'),
    operationsTreasurySafe: required(config.operationsTreasurySafeAddress, 'OPERATIONS_TREASURY_SAFE_ADDRESS'),
    secondarySigner: required(config.secondarySignerAddress, 'SECONDARY_SIGNER_ADDRESS'),
    quoteSigner: required(config.quoteSignerAddress, 'QUOTE_SIGNER_ADDRESS'),
  });
  const readinessMonitor = new PaymentRuntimeReadinessMonitor({
    attest: () => runtimeAttestor.attest(),
    componentHashesVerified: () => verifyArtifactChecksums(ARTIFACT_ROOT),
    databaseHealthy: async () => {
      await pool.query('SELECT 1');
      return true;
    },
    redisHealthy: async () => (await redis.ping()) === 'PONG',
    signerHealthy: () => signer.health(),
    indexerStatus: () => paymentIndexer.status(),
  });
  await readinessMonitor.pollOnce();
  readinessMonitor.start();
  const server = createApiServer({
    config,
    runtimeReadiness: () => readinessMonitor.snapshot(),
    nonceStore: new PostgresNonceStore(database),
    nonceRateLimiter: new RedisNonceRateLimiter(redis),
    walletSignatureVerifier,
    authDomain,
    authUri,
    resolveRoles: (walletAddress) => resolveRoles(database, walletAddress),
    getOrderProjection: (orderId) => getOrderProjection(database, orderId),
    getPausedScopes: () => getPausedScopes(database),
    paymentService,
    catalogManagementService,
    seckillService,
    fulfillmentService,
    fulfillmentTargetService,
    evidenceService,
    settlementService,
    policyService,
    coverageBreakerService,
    cmsService,
    notificationService,
    systemConfigService,
    auditService: new AuditQueryService(auditDatabase),
    monitoringService,
    businessAnalyticsService,
    accountService,
    riskService,
    ...(env.RISK_SIGNAL_TOKEN ? { riskSignalToken: env.RISK_SIGNAL_TOKEN } : {}),
    recordRuntimeMetric: (kind, durationMs, error, at) => runtimeMetrics.record(kind, durationMs, error, at),
    takeoverFundingService: {
      fundingApprovalChallenge: (actor, input) => takeoverFundingService.fundingApprovalChallenge(actor, {
        ...input,
        operationsSafeAddress: required(
          config.operationsTreasurySafeAddress,
          'OPERATIONS_TREASURY_SAFE_ADDRESS',
        ),
      }),
      fundTakeover: (actor, input) => takeoverFundingService.fundTakeover(actor, {
        ...input,
        operationsSafeAddress: required(
          config.operationsTreasurySafeAddress,
          'OPERATIONS_TREASURY_SAFE_ADDRESS',
        ),
      }),
      getMerchantFinance: (actor, merchantId) => takeoverFundingService.getMerchantFinance(actor, merchantId),
      getTakeoverFunding: (actor, caseId) => takeoverFundingService.getTakeoverFunding(actor, caseId),
    },
    guaranteeDepositService,
    logisticsWebhookSecrets: {
      ...(env.KUAIDI100_CALLBACK_SECRET ? { KUAIDI100: env.KUAIDI100_CALLBACK_SECRET } : {}),
      ...(env.CAINIAO_CALLBACK_SECRET ? { CAINIAO: env.CAINIAO_CALLBACK_SECRET } : {}),
    },
    clock: () => new Date(),
  });
  return {
    config,
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await readinessMonitor.stop();
      await policyFinalityWorker.stop();
      await monitoringWorker.stop();
      await notificationWorker.stop();
      await auditWorker.stop();
      await paymentIndexer.stop();
      await fulfillmentScheduler.stop();
      await settlementWorker.stop();
      await settlementBatchScheduler.stop();
      await coverageWorker.stop();
      await coverageBreakerGovernanceWorker.stop();
      await guaranteeDepositWorker.stop();
      await bnmWorker.stop();
      await redis.quit();
      await auditPool.end();
      await pool.end();
    },
  };
}

async function resolveRoles(database: SqlExecutor, walletAddress: string) {
  const result = await database.query<{ role: UserRole; merchant_id: string | null }>(
    `SELECT role, merchant_id FROM core.wallet_role_bindings
     WHERE wallet_address = $1 AND status = 'ACTIVE' ORDER BY role`,
    [walletAddress],
  );
  return {
    roles: result.rows.map((row) => row.role),
    ...(result.rows.find((row) => row.merchant_id)?.merchant_id
      ? { merchantId: result.rows.find((row) => row.merchant_id)!.merchant_id! }
      : {}),
  };
}

async function getPausedScopes(database: SqlExecutor) {
  const result = await database.query<{ scope: BreakerScope }>(
    'SELECT scope FROM core.circuit_breakers WHERE paused ORDER BY scope',
  );
  return new Set(result.rows.map((row) => row.scope));
}

async function getOrderProjection(database: SqlExecutor, orderId: string): Promise<OrderProjection | undefined> {
  const result = await database.query<{
    state: OrderProjection['state'];
    fulfillment_mode: OrderProjection['fulfillmentMode'];
    buyer_wallet: string;
    merchant_id: string;
    merchant_wallet: string;
    paid_at: Date | null;
    delivered_at: Date | null;
    finality_status: NonNullable<OrderProjection['paymentFinalityStatus']>;
    payment_finalized_at: Date | null;
    shipment_evidence: boolean;
    takeover_opened: boolean;
    open_request_types: Array<'EXCHANGE' | 'DELAY' | 'ARBITRATION' | 'FORCED_RECEIPT'>;
    active_pickup_credential: boolean;
    approved_exchange: boolean;
  }>(
    `SELECT orders.state, orders.fulfillment_mode, orders.buyer_wallet, orders.merchant_id, orders.merchant_wallet,
       orders.paid_at, orders.delivered_at, orders.finality_status,
       finality.finalized_at AS payment_finalized_at,
       EXISTS (
         SELECT 1 FROM core.fulfillment_evidence evidence
         WHERE evidence.order_id = orders.order_id AND evidence.evidence_type = 'SHIPMENT'
       ) AS shipment_evidence,
       EXISTS (SELECT 1 FROM core.takeover_cases takeover WHERE takeover.order_id = orders.order_id) AS takeover_opened,
       ARRAY(
         SELECT request.request_type FROM core.fulfillment_requests request
         WHERE request.order_id = orders.order_id AND request.state = 'OPEN'
         ORDER BY request.request_type
       ) AS open_request_types,
       EXISTS (
         SELECT 1 FROM core.pickup_credentials credential
         WHERE credential.order_id = orders.order_id AND credential.consumed_at IS NULL
           AND credential.invalidated_at IS NULL
           AND credential.expires_at > clock_timestamp()
       ) AS active_pickup_credential,
       EXISTS (
         SELECT 1 FROM core.fulfillment_requests request
         WHERE request.order_id = orders.order_id AND request.request_type = 'EXCHANGE'
           AND request.state = 'APPROVED'
       ) AS approved_exchange
     FROM core.orders
     LEFT JOIN core.transaction_finality finality
       ON finality.resource_type = 'ORDER_PAYMENT' AND finality.resource_id = orders.order_id
       AND finality.state = 'FINAL'
     WHERE orders.order_id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    state: row.state,
    fulfillmentMode: row.fulfillment_mode,
    buyerWallet: row.buyer_wallet,
    merchantId: row.merchant_id,
    merchantWallet: row.merchant_wallet,
    ...(row.payment_finalized_at ? { paidAt: new Date(row.payment_finalized_at) } : {}),
    ...(row.delivered_at ? { deliveredAt: new Date(row.delivered_at) } : {}),
    paymentFinalityStatus: row.finality_status,
    shipmentEvidence: row.shipment_evidence,
    takeoverOpened: row.takeover_opened,
    openRequestTypes: row.open_request_types,
    activePickupCredential: row.active_pickup_credential,
    approvedExchange: row.approved_exchange,
  };
}

function sqlExecutor(pool: ReturnType<typeof createPostgresPool>): SqlExecutor {
  return {
    exec: async (sql) => {
      await pool.query(sql);
    },
    query: async <Row extends object>(sql: string, params: unknown[] = []) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as Row[] };
    },
  };
}

function mediaUploadLimits(env: Readonly<Record<string, string | undefined>>) {
  const intents = env.MEDIA_UPLOAD_MAX_INTENTS_PER_WALLET_HOUR;
  const bytes = env.MEDIA_UPLOAD_MAX_BYTES_PER_WALLET_HOUR;
  if (!intents || !bytes) return undefined;
  if (!/^\d+$/.test(intents) || !/^\d+$/.test(bytes)) {
    throw new CoreError('InvalidRequest', 'Media upload quotas must be positive integers', 500);
  }
  const maxIntentsPerWalletHour = Number(intents);
  const maxBytesPerWalletHour = BigInt(bytes);
  if (!Number.isSafeInteger(maxIntentsPerWalletHour) || maxIntentsPerWalletHour < 1 || maxBytesPerWalletHour < 1n) {
    throw new CoreError('InvalidRequest', 'Media upload quotas must be positive integers', 500);
  }
  return { maxIntentsPerWalletHour, maxBytesPerWalletHour };
}

function required<Value>(value: Value | undefined, name: string): Value {
  if (value === undefined || value === null || value === '') {
    throw new CoreError('ExternalBlocked', `${name} is unavailable`, 503);
  }
  return value;
}

function runtimeDeploymentExpectations() {
  return contractManifest.contracts.map((contract) => {
    const deployment = contract as unknown as {
      name: string;
      status: string;
      address: unknown;
      deployedCodeHash: unknown;
    };
    if (
      deployment.status !== 'DEPLOYED'
        || typeof deployment.address !== 'string'
        || typeof deployment.deployedCodeHash !== 'string'
    ) throw new CoreError('ExternalBlocked', `${deployment.name} runtime deployment evidence is unavailable`, 503);
    return {
      name: deployment.name,
      address: deployment.address,
      deployedCodeHash: deployment.deployedCodeHash,
    };
  });
}
