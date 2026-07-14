import { fileURLToPath } from 'node:url';
import contractManifest from '../../packages/core-artifacts/contracts/contract-manifest.json' with { type: 'json' };
import { createApiServer } from './api/app.ts';
import type { OrderProjection } from './api/allowed-actions.ts';
import { loadConfig } from './api/config.ts';
import { CORE_ARTIFACT_VERSION, type BreakerScope, type UserRole } from './api/enums.ts';
import { CoreError } from './api/errors.ts';
import {
  ResilientBscContractReader,
  RpcBeneficiarySnapshotSource,
  RpcPaymentOracleQuoteSource,
  RpcPaymentPolicyAttestationSource,
  RpcWalletMessageSignatureVerifier,
} from './chain/payment-sources.ts';
import { AbiEventDecoder } from './chain/abi-decoder.ts';
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
import { PostgresNonceStore, RedisNonceRateLimiter } from './data/auth-store.ts';
import { CatalogPaymentService } from './data/catalog-payment-service.ts';
import {
  createPostgresPool,
  createRedisConnection,
  postgresTransactionRunner,
} from './data/connections.ts';
import type { SqlExecutor } from './data/migrations.ts';
import { PostgresIndexerStore } from './data/indexer-store.ts';

const ARTIFACT_ROOT = fileURLToPath(new URL('../../packages/core-artifacts/', import.meta.url));
const ABI_BUNDLE_PATH = fileURLToPath(
  new URL('../../packages/core-artifacts/contracts/abi-bundle.json', import.meta.url),
);

export const coreBaseline = Object.freeze({
  artifactVersion: CORE_ARTIFACT_VERSION,
  status: 'payment-runtime',
} as const);

export async function createCoreRuntime(env: Readonly<Record<string, string | undefined>>) {
  const config = loadConfig(env);
  const databaseUrl = required(config.databaseUrl, 'DATABASE_URL');
  const redisUrl = required(config.redisUrl, 'REDIS_URL');
  const authDomain = required(config.authDomain, 'AUTH_DOMAIN');
  const authUri = required(config.authUri, 'AUTH_URI');
  const pool = createPostgresPool(databaseUrl);
  const redis = await createRedisConnection(redisUrl);
  const database = sqlExecutor(pool);
  const transactions = postgresTransactionRunner(pool);
  const reader = new ResilientBscContractReader(config.rpcUrl, config.fallbackRpcUrl);
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
  const indexerStore = new PostgresIndexerStore(transactions);
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
    walletSignatureVerifier: new RpcWalletMessageSignatureVerifier(reader),
    authDomain,
    authUri,
    resolveRoles: (walletAddress) => resolveRoles(database, walletAddress),
    getOrderProjection: (orderId) => getOrderProjection(database, orderId),
    getPausedScopes: () => getPausedScopes(database),
    paymentService,
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
      await paymentIndexer.stop();
      await redis.quit();
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
    merchant_wallet: string;
    paid_at: Date | null;
    fulfilled_at: Date | null;
    shipment_evidence: boolean;
    takeover_opened: boolean;
  }>(
    `SELECT orders.state, orders.fulfillment_mode, orders.buyer_wallet, orders.merchant_wallet,
       orders.paid_at, orders.fulfilled_at,
       EXISTS (
         SELECT 1 FROM core.fulfillment_evidence evidence
         WHERE evidence.order_id = orders.order_id AND evidence.evidence_type = 'SHIPMENT'
       ) AS shipment_evidence,
       EXISTS (SELECT 1 FROM core.takeover_cases takeover WHERE takeover.order_id = orders.order_id) AS takeover_opened
     FROM core.orders WHERE orders.order_id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    state: row.state,
    fulfillmentMode: row.fulfillment_mode,
    buyerWallet: row.buyer_wallet,
    merchantWallet: row.merchant_wallet,
    ...(row.paid_at ? { paidAt: new Date(row.paid_at) } : {}),
    ...(row.fulfilled_at ? { deliveredAt: new Date(row.fulfilled_at) } : {}),
    shipmentEvidence: row.shipment_evidence,
    takeoverOpened: row.takeover_opened,
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
