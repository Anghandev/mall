import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Interface, Wallet, id, keccak256, toUtf8Bytes, type InterfaceAbi, type Signer } from 'ethers';
import { sensitiveActionDomain, sensitiveActionTypes, type SensitiveActionIntent } from '../api/auth.ts';
import type { CanonicalPaymentIntent } from '../api/checkout.ts';
import { CORE_ARTIFACT_VERSION, USDT_ADDRESS } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { MiddlewareMonitoringSource, RpcExplorerHeightSource } from '../api/monitoring-sources.ts';
import { paymentAllocationSetHash, paymentBeneficiarySetHash } from '../api/payment-policy.ts';
import { paymentIntentHash } from '../api/payment-signing.ts';
import { AbiEventDecoder } from '../chain/abi-decoder.ts';
import { BnmAvailabilityWorker } from '../chain/bnm-availability-worker.ts';
import { FulfillmentSchedulerWorker } from '../chain/fulfillment-scheduler-worker.ts';
import { GuaranteeDepositWorker } from '../chain/guarantee-deposit-worker.ts';
import { CoverageWorker, type CoverageObservation } from '../chain/coverage-worker.ts';
import {
  CoverageBreakerGovernanceWorker,
  type CoverageBreakerObservation,
} from '../chain/coverage-breaker-governance.ts';
import {
  SeckillGovernanceWorker,
  type SeckillExecution,
  type SeckillFinalityCandidate,
  type SeckillObservation,
} from '../chain/seckill-governance.ts';
import { AuditOutboxWorker } from '../chain/audit-outbox-worker.ts';
import { NotificationWorker } from '../chain/notification-worker.ts';
import { OperationsMonitoringWorker, RuntimeMetricsRegistry } from '../chain/monitoring-worker.ts';
import { SettlementWorker, type EoaSettlementReceipt } from '../chain/settlement-worker.ts';
import { ChainIndexer, type IndexedChainBlock } from '../chain/indexer.ts';
import { appendAuditEntry, verifyAuditChain, type AuditRow } from './audit-chain.ts';
import { AuditQueryService, enqueueAudit } from './audit-service.ts';
import { PostgresNonceStore, RedisNonceRateLimiter } from './auth-store.ts';
import { CatalogPaymentService } from './catalog-payment-service.ts';
import { CatalogManagementService } from './catalog-management-service.ts';
import { AdminGlobalOperationsService } from './admin-global-operations-service.ts';
import { CoverageBreakerService } from './coverage-breaker-service.ts';
import { CmsService, sanitizeStructuredContent } from './cms-service.ts';
import { EvidenceService, HttpMediaStorageAdapter, type MediaStorageAdapter } from './evidence-service.ts';
import { FulfillmentService } from './fulfillment-service.ts';
import { FulfillmentTargetService, assertQuoteFulfillmentTarget } from './fulfillment-target-service.ts';
import {
  GuaranteeDepositService,
  type GuaranteeDepositChainObservation,
} from './guarantee-deposit-service.ts';
import { PostgresIndexerStore, recordSeckillRelayProjection } from './indexer-store.ts';
import { reserveInventory } from './inventory.ts';
import { applyMigrations, type SqlExecutor, type SqlTransactionRunner } from './migrations.ts';
import {
  advancePaymentFinality,
  paymentEventKey,
  PostgresPaymentStore,
  type RecordPaymentInput,
} from './payment-store.ts';
import { leaseDurableJobs } from './queue.ts';
import { SettlementService } from './settlement-service.ts';
import { SeckillService } from './seckill-service.ts';
import { SeckillOperationsService } from './seckill-operations-service.ts';
import { settleMaturedSeckillPrizes } from './seckill-prize-service.ts';
import { TakeoverFundingService, type TakeoverFundingApprovalInput } from './takeover-funding-service.ts';
import { TakeoverCaseService } from './takeover-case-service.ts';
import { OrderStatementService } from './order-statement-service.ts';
import { PolicyService } from './policy-service.ts';
import { NotificationService } from './notification-service.ts';
import { SystemConfigService } from './system-config-service.ts';
import { MonitoringService } from './monitoring-service.ts';
import { BusinessAnalyticsService } from './business-analytics-service.ts';
import { AccountService } from './account-service.ts';
import { assertWalletPaymentAllowed, RiskService } from './risk-service.ts';
import { MerchantLifecycleService } from './merchant-lifecycle-service.ts';
import { LogisticsAdminService } from './logistics-admin-service.ts';
import {
  createPickupReceiptEnqueuer,
  LogisticsPrintingService,
} from './logistics-printing-service.ts';
import { executeLocalPaymentChain } from '../../test/helpers/local-payment-chain.ts';

const BUSINESS_MIGRATIONS = fileURLToPath(new URL('./migrations/business/', import.meta.url));
const AUDIT_MIGRATIONS = fileURLToPath(new URL('./migrations/audit/', import.meta.url));
const ABI_BUNDLE_PATH = fileURLToPath(
  new URL('../../../packages/core-artifacts/contracts/abi-bundle.json', import.meta.url),
);
const HASH = `0x${'1'.repeat(64)}`;
const HASH_2 = `0x${'2'.repeat(64)}`;
const BUYER = '0x1111111111111111111111111111111111111111';
const MERCHANT = '0x2222222222222222222222222222222222222222';

test('business and audit migrations apply from empty databases', async () => {
  const business = await PGlite.create();
  const audit = await PGlite.create();
  try {
    const businessNames = await applyMigrations(adapter(business), 'core', BUSINESS_MIGRATIONS);
    const auditNames = await applyMigrations(adapter(audit), 'audit', AUDIT_MIGRATIONS);
    assert.deepEqual(businessNames, [
      '001_core_schema.sql',
      '002_inventory_and_queue.sql',
      '003_indexer.sql',
      '004_parallel_auth_nonces.sql',
      '005_payment_ledger.sql',
      '006_fulfillment.sql',
      '007_settlement_admin.sql',
      '008_admin_services.sql',
      '009_product_surfaces.sql',
      '010_evidence_media.sql',
      '011_catalog_management.sql',
      '012_order_operations.sql',
      '013_business_analytics.sql',
      '014_accounts_and_profiles.sql',
      '015_coverage_breaker_governance.sql',
      '016_coverage_breaker_safe_nonce.sql',
      '017_risk_management.sql',
      '018_seckill_operations.sql',
      '019_logistics_printing.sql',
      '020_merchant_lifecycle.sql',
      '021_logistics_admin.sql',
      '022_admin_global_operations.sql',
      '023_merchant_store_management.sql',
      '024_merchant_fulfillment_completion.sql',
      '025_takeover_assignments.sql',
      '026_admin_product_lifecycle_batches.sql',
      '027_merchant_governance_completion.sql',
      '028_buyer_uid.sql',
      '029_usdt_freight.sql',
      '030_platform_service_fee.sql',
      '031_change_risk_alerts.sql',
      '032_seckill_prize_settlement.sql',
      '033_eoa_wallet_execution.sql',
      '034_reward_account_subtypes.sql',
      '035_settlement_attempt_retryable.sql',
      '036_retire_merchant_levels.sql',
      '037_payment_quote_source_evidence.sql',
    ]);
    assert.deepEqual(auditNames, [
      '001_audit_schema.sql',
      '002_evidence_policy.sql',
      '003_admin_query_and_ingest.sql',
      '004_merchant_scope.sql',
    ]);
    const businessTables = await business.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'core' ORDER BY table_name",
    );
    assert.ok(businessTables.rows.some((row) => row.table_name === 'orders'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'outbox_events'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'chain_blocks'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'ledger_journals'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'payment_events'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'policy_publication_transitions'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'cms_versions'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'notification_deliveries'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'audit_outbox_events'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'operations_metric_snapshots'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'media_upload_intents'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'media_upload_wallet_locks'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'media_assets'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'evidence_envelopes'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'catalog_category_versions'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'catalog_tag_versions'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'product_review_events'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'catalog_inventory_adjustments'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'merchant_concession_previews'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'admin_batch_operations'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'buyer_profiles'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'buyer_saved_addresses'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'takeover_case_transitions'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'seckill_governance_actions'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'seckill_session_plans'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'seckill_prize_injections'));
    assert.equal(businessTables.rows.some((row) => row.table_name === 'claim_projections'), false);
    const finalityColumns = await business.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'core' AND table_name = 'transaction_finality'",
    );
    assert.ok(finalityColumns.rows.some((row) => row.column_name === 'required_confirmations'));
    const auditTables = await audit.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'audit' ORDER BY table_name",
    );
    assert.deepEqual(
      auditTables.rows.map((row) => row.table_name),
      ['entries', 'retention_policies', 'schema_migrations', 'stream_heads'],
    );
    await assert.rejects(
      audit.query(
        `INSERT INTO audit.entries (
           entry_id, stream_name, evidence_profile, sequence, event_type, resource_type, resource_id,
           correlation_id, request_hash, payload, previous_hash, entry_hash
         ) VALUES ('missing-evidence', 'financial', 'SIGNED_OFFCHAIN', 1, 'PaymentIndexed', 'ORDER', 'order-1',
           'constraint-test', $1, '{}', $1, $2)`,
        ['a'.repeat(64), 'b'.repeat(64)],
      ),
      /audit_entries_stream_evidence_check/,
    );
  } finally {
    await business.close();
    await audit.close();
  }
});

test('risk observations create exact restrictions, block new payment and preserve appeal evidence', async () => {
  const db = await createBusinessDatabase();
  try {
    let now = new Date('2026-07-16T00:00:00.000Z');
    const admin = Wallet.createRandom();
    const operator = Wallet.createRandom();
    const auditor = Wallet.createRandom();
    const highGasWallet = Wallet.createRandom();
    await db.query(
      `INSERT INTO core.wallet_role_bindings (wallet_address, role, status, evidence_hash)
       VALUES ($1,'ADMIN','ACTIVE',$4), ($2,'OPERATOR','ACTIVE',$4), ($3,'AUDITOR','ACTIVE',$4)`,
      [admin.address.toLowerCase(), operator.address.toLowerCase(), auditor.address.toLowerCase(), HASH],
    );
    await db.query(
      `INSERT INTO core.system_config_versions (
         config_version_id, config_key, version, payload, payload_hash, effective_from,
         idempotency_key, request_hash, created_by, created_at
       ) VALUES ('risk-gas-v1','GAS',1,$1,$2,$3,'risk-gas-config',$4,$5,$3)`,
      [
        JSON.stringify({ seckillMaxGasPriceWei: '100', highGasRestrictionSeconds: 86_400 }),
        `0x${'3'.repeat(64)}`,
        new Date('2026-07-14T23:00:00.000Z'),
        `0x${'4'.repeat(64)}`,
        admin.address.toLowerCase(),
      ],
    );
    await db.query(
      `INSERT INTO core.system_config_publication_events (
         event_id, config_key, active_config_version_id, action_digest, secondary_signer,
         governance_wallet_address, approval_signature_hash, actor_wallet, created_at
       ) VALUES ('risk-gas-published','GAS','risk-gas-v1',$1,$2,$3,$4,$5,$6)`,
      [
        `0x${'5'.repeat(64)}`,
        operator.address.toLowerCase(),
        '0x8888888888888888888888888888888888888888',
        `0x${'6'.repeat(64)}`,
        admin.address.toLowerCase(),
        new Date('2026-07-14T23:01:00.000Z'),
      ],
    );
    const risk = new RiskService({ transactions: transactionAdapter(db), clock: () => now });
    const observedAt = now.toISOString();
    const highGasInput = {
      observationId: `0x${'7'.repeat(64)}`,
      signalType: 'HIGH_GAS' as const,
      sourceType: 'CHAIN_MONITOR' as const,
      walletAddress: highGasWallet.address,
      txHash: `0x${'8'.repeat(64)}`,
      gasPriceWei: '101',
      evidenceHash: `0x${'9'.repeat(64)}`,
      observedAt,
    };
    const highGas = await risk.ingestObservation(highGasInput, 'risk-high-gas');
    assert.equal(highGas.restrictions.length, 1);
    assert.equal(highGas.restrictions[0]?.reasonCode, 'HIGH_GAS_24H');
    assert.equal(highGas.restrictions[0]?.expiresAt, '2026-07-17T00:00:00.000Z');
    const repeatedHighGas = await risk.ingestObservation(highGasInput, 'risk-high-gas-repeat');
    assert.equal(repeatedHighGas.restrictions.length, 1);
    assert.deepEqual((await db.query<{ observations: string; restrictions: string }>(
      `SELECT
         (SELECT count(*)::text FROM core.risk_observations WHERE observation_id = $1) AS observations,
         (SELECT count(*)::text FROM core.risk_restrictions WHERE source_observation_id = $1) AS restrictions`,
      [highGasInput.observationId],
    )).rows[0], { observations: '1', restrictions: '1' });
    await assert.rejects(
      assertWalletPaymentAllowed(adapter(db), highGasWallet.address, now),
      (error: unknown) => error instanceof CoreError && error.code === 'RiskRestricted',
    );
    const blockedQuoteService = new CatalogPaymentService({
      transactions: transactionAdapter(db),
      signer: { sign: async () => { throw new Error('risk restriction must run before signing'); } },
      nplQuotes: { quote: async () => { throw new Error('risk restriction must run before NPL quote access'); } },
      beneficiaries: { resolve: async () => { throw new Error('risk restriction must run before beneficiary lookup'); } },
      policies: { assertPublished: async () => { throw new Error('risk restriction must run before policy lookup'); } },
      bnmWallets: { assertRegistered: async () => { throw new Error('risk restriction must run before BNM lookup'); } },
      paymentRouterAddress: '0x9999999999999999999999999999999999999999',
      clock: () => now,
    });
    const blockedQuoteInput = {
      idempotencyKey: 'risk-blocked-ordinary',
      productId: 'risk-product',
      skuId: 'risk-sku',
      quantity: 1,
      fulfillmentMode: 'DELIVERY' as const,
      fulfillmentTargetHash: HASH,
      regionCodeHash: HASH,
    };
    for (const operation of [
      blockedQuoteService.createOrdinaryQuote(highGasWallet.address, blockedQuoteInput),
      blockedQuoteService.createSeckillQuote(highGasWallet.address, {
        ...blockedQuoteInput,
        idempotencyKey: 'risk-blocked-seckill',
        sessionId: HASH,
      }),
    ]) {
      await assert.rejects(
        operation,
        (error: unknown) => error instanceof CoreError && error.code === 'RiskRestricted',
      );
    }

    const sharedIpHash = `0x${'a'.repeat(64)}`;
    const clusterWallets = Array.from({ length: 6 }, () => Wallet.createRandom());
    for (const [index, wallet] of clusterWallets.entries()) {
      const result = await risk.ingestObservation({
        observationId: `0x${(index + 1).toString(16).repeat(64)}`,
        signalType: 'WALLET_CONTEXT',
        sourceType: 'EDGE_AUTH',
        walletAddress: wallet.address,
        ipHash: sharedIpHash,
        evidenceHash: `0x${(index + 2).toString(16).repeat(64)}`,
        observedAt: new Date(now.getTime() + index * 5_000).toISOString(),
      }, `risk-wallet-context-${index}`);
      if (index < 5) assert.equal(result.restrictions.length, 0);
      if (index === 5) assert.equal(result.restrictions.length, 7);
    }
    const clusterRestrictions = await db.query<{ subject_type: string; count: string }>(
      `SELECT subject_type, count(*)::text AS count FROM core.risk_restrictions
       WHERE trigger_type IN ('WALLET_SWITCH','SUBJECT_BLACKLIST') GROUP BY subject_type ORDER BY subject_type`,
    );
    assert.deepEqual(clusterRestrictions.rows, [
      { subject_type: 'IP', count: '1' },
      { subject_type: 'WALLET', count: '6' },
    ]);

    const manualIpHash = `0x${'b'.repeat(64)}`;
    const manualIpWallet = Wallet.createRandom();
    await risk.ingestObservation({
      observationId: `0x${'8'.repeat(64)}`,
      signalType: 'WALLET_CONTEXT',
      sourceType: 'EDGE_AUTH',
      walletAddress: manualIpWallet.address,
      ipHash: manualIpHash,
      evidenceHash: `0x${'c'.repeat(64)}`,
      observedAt: new Date(now.getTime() + 30_000).toISOString(),
    }, 'risk-manual-ip-context');
    const manualIpExpiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
    await risk.createManualRestriction(
      { walletAddress: admin.address, roles: ['ADMIN'] },
      {
        subjectType: 'IP',
        subjectValue: manualIpHash,
        restrictionKind: 'NEW_PAYMENT',
        reasonCode: 'MANUAL_PAYMENT_REVIEW',
        evidenceHash: HASH,
        expiresAt: manualIpExpiresAt,
        idempotencyKey: 'risk-manual-ip-1',
        correlationId: 'risk-manual-ip-1',
      },
    );
    assert.deepEqual((await db.query<{
      restriction_kind: string;
      reason_code: string;
      source_observation_id: string | null;
      expires_at: Date;
    }>(
      `SELECT restriction_kind, reason_code, source_observation_id, expires_at
       FROM core.risk_restrictions
       WHERE subject_type = 'WALLET' AND subject_value = $1 AND trigger_type = 'SUBJECT_BLACKLIST'`,
      [manualIpWallet.address.toLowerCase()],
    )).rows[0], {
      restriction_kind: 'NEW_PAYMENT',
      reason_code: 'MANUAL_PAYMENT_REVIEW',
      source_observation_id: null,
      expires_at: new Date(manualIpExpiresAt),
    });

    const cancellationWallet = Wallet.createRandom();
    for (let index = 0; index < 3; index += 1) {
      const result = await risk.ingestObservation({
        observationId: `0x${(index + 11).toString(16).repeat(64)}`,
        signalType: 'ORDER_CANCELLATION',
        sourceType: 'ORDER_SERVICE',
        walletAddress: cancellationWallet.address,
        resourceId: `unpaid-order-${index}`,
        evidenceHash: `0x${String(index + 4).repeat(64)}`,
        observedAt: new Date(now.getTime() + index * 30_000).toISOString(),
      }, `risk-cancellation-${index}`);
      assert.equal(result.restrictions.length, index === 2 ? 1 : 0);
    }
    const cancellationRestriction = (await db.query<{
      restriction_id: string;
      expires_at: Date;
    }>(
      "SELECT restriction_id, expires_at FROM core.risk_restrictions WHERE trigger_type = 'ORDER_CANCELLATION'",
    )).rows[0]!;
    assert.equal(cancellationRestriction.expires_at.toISOString(), '2026-07-16T02:01:00.000Z');

    const manual = await risk.createManualRestriction(
      { walletAddress: admin.address, roles: ['ADMIN'] },
      {
        subjectType: 'WALLET',
        subjectValue: cancellationWallet.address,
        restrictionKind: 'BLACKLIST',
        reasonCode: 'MANUAL_INVESTIGATION',
        evidenceHash: `0x${'d'.repeat(64)}`,
        idempotencyKey: 'risk-manual-1',
        correlationId: 'risk-manual-1',
      },
    );
    assert.throws(
      () => risk.createManualRestriction(
        { walletAddress: operator.address, roles: ['OPERATOR'] },
        {
          subjectType: 'WALLET', subjectValue: cancellationWallet.address,
          restrictionKind: 'BLACKLIST', reasonCode: 'FORBIDDEN_TEST',
          evidenceHash: HASH, idempotencyKey: 'risk-forbidden', correlationId: 'risk-forbidden',
        },
      ),
      /Session cannot manage risk/,
    );
    assert.equal((await risk.listOverview(
      { walletAddress: auditor.address, roles: ['AUDITOR'] },
    )).artifactVersion, CORE_ARTIFACT_VERSION);
    assert.throws(
      () => risk.overrideRestriction(
        { walletAddress: operator.address, roles: ['OPERATOR'] },
        cancellationRestriction.restriction_id,
        { reasonCode: 'FORBIDDEN_TEST', evidenceHash: HASH, correlationId: 'risk-forbidden-override' },
      ),
      /Session cannot manage risk/,
    );
    const appeal = await risk.submitAppeal(
      { walletAddress: operator.address, roles: ['OPERATOR'] },
      {
        restrictionId: manual.restrictionId,
        statementHash: `0x${'e'.repeat(64)}`,
        evidenceHash: `0x${'f'.repeat(64)}`,
        idempotencyKey: 'risk-appeal-1',
        correlationId: 'risk-appeal-1',
      },
    );
    assert.throws(
      () => risk.decideAppeal(
        { walletAddress: operator.address, roles: ['OPERATOR'] },
        appeal.appealId,
        { decision: 'APPROVE', reasonCode: 'FORBIDDEN_TEST', evidenceHash: HASH, correlationId: 'risk-forbidden-decision' },
      ),
      /Session cannot manage risk/,
    );
    const decided = await risk.decideAppeal(
      { walletAddress: admin.address, roles: ['ADMIN'] },
      appeal.appealId,
      {
        decision: 'APPROVE',
        reasonCode: 'APPEAL_ACCEPTED',
        evidenceHash: `0x${'c'.repeat(64)}`,
        correlationId: 'risk-appeal-decision',
      },
    );
    assert.equal(decided.state, 'APPROVED');
    assert.equal((await db.query<{ state: string }>(
      'SELECT state FROM core.risk_restrictions WHERE restriction_id = $1',
      [manual.restrictionId],
    )).rows[0]?.state, 'OVERRIDDEN');

    now = new Date('2026-07-17T00:00:00.001Z');
    await assert.doesNotReject(assertWalletPaymentAllowed(adapter(db), highGasWallet.address, now));
    assert.equal((await db.query<{ state: string }>(
      "SELECT state FROM core.risk_restrictions WHERE trigger_type = 'HIGH_GAS'",
    )).rows[0]?.state, 'EXPIRED');
    assert.ok((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.audit_outbox_events WHERE resource_type LIKE 'RISK_%'",
    )).rows[0]?.count !== '0');
  } finally {
    await db.close();
  }
});

test('buyer account data is encrypted, tenant scoped and creates targets only from active saved addresses', async () => {
  const db = await createBusinessDatabase();
  const now = new Date('2026-07-15T06:00:00.000Z');
  const createdTargets: Array<Record<string, unknown>> = [];
  let reverseGeocodeCalls = 0;
  try {
    await seedCatalog(db, 2);
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES ($1,'BUYER',NULL,'ACTIVE',$2),($3,'BUYER',NULL,'ACTIVE',$2)`,
      [BUYER, HASH, '0x3333333333333333333333333333333333333333'],
    );
    const region = {
      regionCode: '210211',
      province: 'Liaoning',
      city: 'Dalian',
      district: 'Ganjingzi',
      formattedAddress: 'Liaoning Dalian Ganjingzi Software Park',
      sourceReferenceHash: `0x${'3'.repeat(64)}`,
    };
    const service = new AccountService({
      transactions: transactionAdapter(db),
      regions: { reverseGeocode: async () => {
        reverseGeocodeCalls += 1;
        return region;
      } },
      parser: {
        parse: async () => ({
          recipientName: 'Zhang San',
          phone: '13800138000',
          province: region.province,
          city: region.city,
          district: region.district,
          detailAddress: region.formattedAddress,
          regionCode: region.regionCode,
          longitude: 121.6,
          latitude: 38.9,
          sourceReferenceHash: region.sourceReferenceHash,
        }),
      },
      encryptionKey: '11'.repeat(32),
      retentionPolicyVersion: 'pii-v1',
      createDeliveryTarget: async (_actor, input) => {
        createdTargets.push(input);
        return { targetId: 'target:saved-address', ...input };
      },
      clock: () => now,
    });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const uid = await service.ensureBuyerUid(BUYER);
    assert.equal(await service.ensureBuyerUid(BUYER), uid);
    assert.notEqual(await service.ensureBuyerUid('0x3333333333333333333333333333333333333333'), uid);
    await assert.rejects(
      db.query('UPDATE core.buyer_accounts SET created_at = created_at + interval \'1 second\' WHERE buyer_wallet = $1', [BUYER]),
      /ImmutableRecord/,
    );
    const profile = await service.updateBuyerProfile(buyer, {
      nickname: 'Private Nickname',
      avatarAssetId: null,
      expectedVersion: 0,
      idempotencyKey: 'buyer-profile-update-1',
    });
    assert.equal(profile.nickname, 'Private Nickname');
    assert.equal(profile.accountId, uid);
    const profileStorage = await db.query<{ encrypted: string }>(
      "SELECT encode(encrypted_nickname, 'hex') AS encrypted FROM core.buyer_profiles WHERE buyer_wallet = $1",
      [BUYER],
    );
    assert.equal(profileStorage.rows[0]?.encrypted.includes(Buffer.from('Private Nickname').toString('hex')), false);
    assert.equal((await service.parseBuyerAddress(buyer, 'Zhang San 13800138000 Dalian Software Park')).canSave, true);

    const home = await service.createBuyerAddress(buyer, {
      label: 'Home',
      recipientName: 'Zhang San',
      phone: '13800138000',
      detailAddress: 'Dalian Software Park Building 1',
      longitude: 121.6,
      latitude: 38.9,
      isDefault: false,
      idempotencyKey: 'buyer-address-home-1',
    });
    assert.equal(home.isDefault, true);
    const repeatedHome = await service.createBuyerAddress(buyer, {
      label: 'Home',
      recipientName: 'Zhang San',
      phone: '13800138000',
      detailAddress: 'Dalian Software Park Building 1',
      longitude: 121.6,
      latitude: 38.9,
      isDefault: false,
      idempotencyKey: 'buyer-address-home-1',
    });
    assert.equal(repeatedHome.addressId, home.addressId);
    assert.equal(reverseGeocodeCalls, 1);
    const office = await service.createBuyerAddress(buyer, {
      label: 'Office',
      recipientName: 'Li Si',
      phone: '13900139000',
      detailAddress: 'Dalian Software Park Building 2',
      longitude: 121.61,
      latitude: 38.91,
      isDefault: true,
      idempotencyKey: 'buyer-address-office-1',
    });
    assert.equal(office.isDefault, true);
    const listed = await service.listBuyerAddresses(buyer);
    assert.equal(listed.addresses.length, 2);
    assert.equal(listed.addresses.filter((address) => address.isDefault).length, 1);
    assert.equal(listed.addresses[0]?.addressId, office.addressId);
    await assert.rejects(
      db.query(
        "UPDATE core.buyer_saved_addresses SET is_default = true WHERE buyer_wallet = $1 AND status = 'ACTIVE'",
        [BUYER],
      ),
      /buyer_saved_addresses_one_default_idx|duplicate key/,
    );
    const target = await service.createBuyerAddressTarget(buyer, office.addressId, 'saved-address-target-1');
    assert.equal((target as { targetId: string }).targetId, 'target:saved-address');
    assert.equal(createdTargets[0]?.phone, '13900139000');
    await assert.rejects(
      service.deleteBuyerAddress(
        { walletAddress: '0x3333333333333333333333333333333333333333', roles: ['BUYER'] },
        office.addressId,
        { expectedVersion: office.version, idempotencyKey: 'wrong-buyer-address-delete' },
      ),
      /outside the wallet scope/,
    );
    await service.deleteBuyerAddress(buyer, office.addressId, {
      expectedVersion: office.version,
      idempotencyKey: 'buyer-address-delete-office',
    });
    await assert.rejects(
      service.createBuyerAddressTarget(buyer, office.addressId, 'deleted-address-target-1'),
      /deleted/,
    );
    const afterDelete = await service.listBuyerAddresses(buyer);
    assert.equal(afterDelete.addresses.length, 1);
    assert.equal(afterDelete.addresses[0]?.isDefault, true);
    assert.equal(JSON.stringify((await db.query(
      'SELECT encrypted_payload FROM core.buyer_saved_addresses WHERE buyer_wallet = $1',
      [BUYER],
    )).rows).includes('13900139000'), false);
    const addressColumns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'core' AND table_name = 'buyer_saved_addresses'`,
    );
    assert.equal(addressColumns.rows.some((row) => ['label', 'region_code', 'source_reference_hash'].includes(row.column_name)), false);
    const auditPayloads = await db.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM core.audit_outbox_events WHERE actor_wallet = $1',
      [BUYER],
    );
    const serializedAudit = JSON.stringify(auditPayloads.rows);
    assert.equal(serializedAudit.includes('13800138000'), false);
    assert.equal(serializedAudit.includes('Zhang San'), false);
    for (let index = 0; index < 7; index += 1) {
      await service.createBuyerAddress(buyer, {
        label: `Alert ${index}`,
        recipientName: 'Risk Evidence',
        phone: '13700137000',
        detailAddress: `Dalian Software Park Building ${index + 3}`,
        longitude: 121.62 + index / 1_000,
        latitude: 38.92 + index / 1_000,
        isDefault: false,
        idempotencyKey: `buyer-address-alert-${index}`,
      });
    }
    const addressAlert = await db.query<{ signal_type: string; source_type: string }>(
      "SELECT signal_type, source_type FROM core.risk_observations WHERE signal_type = 'ADDRESS_CHANGE'",
    );
    assert.deepEqual(addressAlert.rows, [{ signal_type: 'ADDRESS_CHANGE', source_type: 'ACCOUNT_SERVICE' }]);
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.risk_restrictions WHERE subject_value = $1',
      [BUYER],
    )).rows[0]?.count, '0');
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.audit_outbox_events WHERE event_type = 'RiskChangeThresholdReached'",
    )).rows[0]?.count, '1');
    await assert.doesNotReject(assertWalletPaymentAllowed(adapter(db), BUYER, now));
    await db.query(
      `UPDATE core.buyer_saved_addresses
       SET encryption_tag = decode($3, 'hex')
       WHERE buyer_wallet = $1 AND address_id = $2`,
      [BUYER, home.addressId, '00'.repeat(16)],
    );
    await assert.rejects(service.listBuyerAddresses(buyer), /decryption failed/);
  } finally {
    await db.close();
  }
});

test('merchant profile keeps settlement wallet immutable and merchant audit never crosses tenant scope', async () => {
  const business = await createBusinessDatabase();
  const audit = await PGlite.create();
  const now = new Date('2026-07-15T07:00:00.000Z');
  try {
    await seedCatalog(business, 2);
    await business.query(
      `INSERT INTO core.merchants (
         merchant_id, settlement_wallet, status, level, guarantee_status
       ) VALUES ('merchant-2','0x3333333333333333333333333333333333333333','APPROVED','V1','READY')`,
    );
    await business.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES ($1,'MERCHANT','merchant-1','ACTIVE',$2),
                ('0x3333333333333333333333333333333333333333','MERCHANT','merchant-2','ACTIVE',$2)`,
      [MERCHANT, HASH],
    );
    await applyMigrations(adapter(audit), 'audit', AUDIT_MIGRATIONS);
    const service = new AccountService({
      transactions: transactionAdapter(business),
      regions: { reverseGeocode: async () => { throw new Error('unused'); } },
      parser: { parse: async () => { throw new Error('unused'); } },
      encryptionKey: '11'.repeat(32),
      retentionPolicyVersion: 'pii-v1',
      createDeliveryTarget: async () => { throw new Error('unused'); },
      clock: () => now,
    });
    const merchantActor = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const profile = await service.updateMerchantProfile(merchantActor, {
      shopName: 'Merchant One',
      logoAssetId: null,
      expectedVersion: 1,
      idempotencyKey: 'merchant-profile-update-1',
      correlationId: 'merchant-profile-correlation',
    });
    assert.equal(profile.shopName, 'Merchant One');
    assert.equal(profile.settlementWallet, MERCHANT);
    assert.equal(profile.settlementWalletMutable, false);
    await business.query("UPDATE core.merchants SET status = 'SUSPENDED' WHERE merchant_id = 'merchant-1'");
    await assert.rejects(
      business.query(
        "UPDATE core.merchants SET settlement_wallet = '0x4444444444444444444444444444444444444444' WHERE merchant_id = 'merchant-1'",
      ),
      /ImmutableSettlementWallet/,
    );
    await business.query("UPDATE core.merchants SET status = 'APPROVED' WHERE merchant_id = 'merchant-1'");
    await assert.rejects(
      service.getMerchantProfile({ ...merchantActor, merchantId: 'merchant-2' }),
      /inactive or mismatched/,
    );
    const worker = new AuditOutboxWorker({
      business: transactionAdapter(business),
      audit: transactionAdapter(audit),
      clock: () => now,
    });
    assert.equal(await worker.pollOnce(), true);
    await appendAuditEntry(transactionAdapter(audit), {
      sourceEventId: 'audit:merchant-two:test',
      streamName: 'operational',
      evidenceProfile: 'AUTHORIZATION',
      eventType: 'MerchantTwoAction',
      resourceType: 'MERCHANT_PROFILE',
      resourceId: 'merchant-2',
      merchantId: 'merchant-2',
      actorWallet: '0x3333333333333333333333333333333333333333',
      actorRole: 'MERCHANT',
      correlationId: 'merchant-two-action',
      requestHash: '4'.repeat(64),
      payload: { evidence: 'bounded' },
      authorizationEvidence: {
        scheme: 'SESSION_RESOURCE_OWNERSHIP',
        subject: '0x3333333333333333333333333333333333333333',
        roles: ['MERCHANT'],
        evidenceHash: `0x${'4'.repeat(64)}`,
        checkedAt: now.toISOString(),
      },
      createdAt: now,
    });
    const query = new AuditQueryService(adapter(audit));
    const merchantOne = await query.listMerchant(merchantActor, { limit: 20 });
    assert.equal(merchantOne.entries.length, 1);
    assert.equal(merchantOne.entries[0]?.operationType, 'MerchantProfileUpdated');
    assert.equal(merchantOne.proofScope, 'MERCHANT_SCOPED_ENTRY_HASHES');
    assert.equal(merchantOne.historyStatus, 'PARTIAL_PRE_MERCHANT_SCOPE');
    assert.deepEqual(merchantOne.chainProof, { merchantId: 'merchant-1', entries: 1 });
    assert.equal(JSON.stringify(merchantOne).includes('merchant-2'), false);
    const merchantTwo = await query.listMerchant({
      walletAddress: '0x3333333333333333333333333333333333333333',
      roles: ['MERCHANT'],
      merchantId: 'merchant-2',
    }, { limit: 20 });
    assert.equal(merchantTwo.entries.length, 1);
    const exported = await query.exportMerchant(merchantActor, {
      from: new Date(now.getTime() - 60_000),
      to: new Date(now.getTime() + 60_000),
    });
    assert.equal(exported.merchantId, 'merchant-1');
    assert.equal(exported.entryCount, 1);
    assert.equal(exported.csv.includes('MerchantProfileUpdated'), true);
    assert.equal(exported.csv.includes('merchant-2'), false);
  } finally {
    await business.close();
    await audit.close();
  }
});

test('merchant lifecycle encrypts qualification and governs exact review transitions with private license evidence', async () => {
  const db = await createBusinessDatabase();
  let now = new Date('2026-07-15T08:00:00.000Z');
  const admin = Wallet.createRandom();
  const operator = Wallet.createRandom();
  const auditor = Wallet.createRandom();
  const arbitrator = Wallet.createRandom();
  const secondary = Wallet.createRandom();
  const wrongSigner = Wallet.createRandom();
  const governanceWallet = Wallet.createRandom().address;
  const settlementWallet = Wallet.createRandom().address;
  const storage: MediaStorageAdapter = {
    createUpload: async () => ({
      method: 'PUT',
      uploadUrl: 'https://uploads.example.invalid/merchant-license',
      headers: { 'if-none-match': '*' },
      providerReferenceHash: `0x${'7'.repeat(64)}`,
      writeOnce: true,
    }),
    finalizeUpload: async () => ({
      providerEvidenceHash: `0x${'8'.repeat(64)}`,
      objectVersionHash: `0x${'9'.repeat(64)}`,
      sealed: true,
    }),
    createRead: async (input) => ({
      method: 'GET',
      readUrl: 'https://media.example.invalid/merchant-license',
      expiresAt: input.expiresAt.toISOString(),
      providerReferenceHash: `0x${'7'.repeat(64)}`,
      assetId: input.assetId,
      contentSha256: input.contentSha256,
      objectVersionHash: input.objectVersionHash,
    }),
  };
  try {
    await db.query(
      `INSERT INTO core.policy_snapshots (
         policy_version, artifact_version, policy_hash,
         rules_content_hash, beneficiary_set_hash, payload, publication_status
       ) VALUES (1,$1,$2,$2,$3,'{}','PUBLISHED')`,
      [CORE_ARTIFACT_VERSION, HASH, HASH_2],
    );
    for (const [wallet, role] of [
      [admin.address, 'ADMIN'],
      [operator.address, 'OPERATOR'],
      [auditor.address, 'AUDITOR'],
      [arbitrator.address, 'ARBITRATOR'],
    ] as const) {
      await db.query(
        `INSERT INTO core.wallet_role_bindings (
           wallet_address, role, merchant_id, status, evidence_hash
         ) VALUES ($1,$2,NULL,'ACTIVE',$3)`,
        [wallet.toLowerCase(), role, HASH],
      );
    }
    const service = new MerchantLifecycleService({
      transactions: transactionAdapter(db),
      secondarySigner: secondary.address,
      governanceWallet,
      verifyingContract: governanceWallet,
      encryptionKey: '11'.repeat(32),
      retentionPolicyVersion: 'pii-v1',
      auditReady: () => true,
      clock: () => now,
    });
    const operatorActor = { walletAddress: operator.address, roles: ['OPERATOR'] as const };
    const adminActor = { walletAddress: admin.address, roles: ['ADMIN'] as const };
    const auditorActor = { walletAddress: auditor.address, roles: ['AUDITOR'] as const };
    const arbitratorActor = { walletAddress: arbitrator.address, roles: ['ARBITRATOR'] as const };
    const applicationInput = {
      shopName: 'Private Gold Shop',
      legalName: 'Li Ming',
      legalId: '210211199001011234',
      contactPhone: '13800138000',
      settlementWallet,
      idempotencyKey: 'merchant-application-create-1',
      correlationId: 'merchant-application-create-correlation',
    };
    const created = await service.createApplication(operatorActor, applicationInput);
    const merchantId = created.merchant.merchantId;
    assert.equal(created.merchant.status, 'PENDING');
    assert.equal('level' in created.merchant, false);
    assert.equal('levelPolicy' in created, false);
    assert.equal((await db.query<{ level: string | null }>(
      'SELECT level FROM core.merchants WHERE merchant_id = $1',
      [merchantId],
    )).rows[0]?.level, null);
    assert.deepEqual(created.analytics.fulfillment.fastShip48h, {
      status: 'UNAVAILABLE', numerator: '0', denominator: '0', bps: null,
      reason: 'NO_ELIGIBLE_DELIVERY_ORDERS',
    });
    assert.equal(created.qualification.access, 'FULL');
    assert.equal(created.qualification.legalId, applicationInput.legalId);
    assert.equal((await service.createApplication(operatorActor, applicationInput)).merchant.merchantId, merchantId);
    await assert.rejects(
      service.createApplication(operatorActor, { ...applicationInput, legalId: '210211199001019999' }),
      /idempotency key changed/,
    );
    await assert.rejects(
      service.createApplication(operatorActor, {
        ...applicationInput,
        idempotencyKey: 'merchant-application-duplicate-wallet',
      }),
      /already merchant-bound/,
    );
    await assert.rejects(
      service.createApplication(auditorActor, {
        ...applicationInput,
        settlementWallet: Wallet.createRandom().address,
        idempotencyKey: 'merchant-application-auditor-denied',
      }),
      /role is forbidden/,
    );
    const encrypted = await db.query<{
      encrypted_payload: Uint8Array; payload_hash: string; request_hash: string;
    }>('SELECT encrypted_payload, payload_hash, request_hash FROM core.merchant_application_versions WHERE merchant_id = $1', [merchantId]);
    const stored = encrypted.rows[0]!;
    const serializedStorage = JSON.stringify({
      encrypted: Buffer.from(stored.encrypted_payload).toString('hex'),
      payloadHash: stored.payload_hash,
      requestHash: stored.request_hash,
    });
    assert.equal(serializedStorage.includes(applicationInput.legalName), false);
    assert.equal(serializedStorage.includes(applicationInput.legalId), false);
    assert.equal(serializedStorage.includes(applicationInput.contactPhone), false);
    const auditorDetail = await service.get(auditorActor, merchantId);
    assert.deepEqual(auditorDetail.qualification, {
      access: 'REDACTED',
      legalName: null,
      legalId: null,
      contactPhone: null,
      licenseAssetId: null,
      payloadHash: stored.payload_hash,
      retentionPolicyVersion: null,
      version: 1,
      updatedAt: now.toISOString(),
    });

    const evidence = new EvidenceService({
      transactions: transactionAdapter(db),
      storage,
      uploadLimits: { maxIntentsPerWalletHour: 10, maxBytesPerWalletHour: 20_000_000n },
      clock: () => now,
    });
    await assert.rejects(
      evidence.createUploadIntent(auditorActor, {
        purpose: 'MERCHANT_LICENSE', resourceType: 'MERCHANT', resourceId: merchantId,
        contentType: 'application/pdf', sizeBytes: 1000, contentSha256: `0x${'6'.repeat(64)}`,
        idempotencyKey: 'merchant-license-auditor-denied',
      }),
      /outside the wallet scope/,
    );
    const upload = await evidence.createUploadIntent(operatorActor, {
      purpose: 'MERCHANT_LICENSE', resourceType: 'MERCHANT', resourceId: merchantId,
      contentType: 'application/pdf', sizeBytes: 1000, contentSha256: `0x${'6'.repeat(64)}`,
      idempotencyKey: 'merchant-license-upload-1',
    });
    await db.query(
      "UPDATE core.wallet_role_bindings SET status = 'SUSPENDED' WHERE wallet_address = $1 AND role = 'OPERATOR'",
      [operator.address.toLowerCase()],
    );
    await assert.rejects(evidence.completeUpload(operatorActor, upload.uploadIntentId), /outside the wallet scope/);
    await db.query(
      "UPDATE core.wallet_role_bindings SET status = 'ACTIVE' WHERE wallet_address = $1 AND role = 'OPERATOR'",
      [operator.address.toLowerCase()],
    );
    const license = await evidence.completeUpload(operatorActor, upload.uploadIntentId);
    assert.equal((await evidence.createReadAccess(operatorActor, license.assetId)).accessScope, 'AUTHENTICATED');
    await assert.rejects(evidence.createReadAccess(auditorActor, license.assetId), /restricted to active review roles/);
    await assert.rejects(evidence.createReadAccess(arbitratorActor, license.assetId), /restricted to active review roles/);
    await db.query(
      "UPDATE core.wallet_role_bindings SET status = 'SUSPENDED' WHERE wallet_address = $1 AND role = 'OPERATOR'",
      [operator.address.toLowerCase()],
    );
    await assert.rejects(evidence.createReadAccess(operatorActor, license.assetId), /restricted to active review roles/);
    await db.query(
      "UPDATE core.wallet_role_bindings SET status = 'ACTIVE' WHERE wallet_address = $1 AND role = 'OPERATOR'",
      [operator.address.toLowerCase()],
    );
    const updated = await service.updateApplication(operatorActor, merchantId, {
      shopName: applicationInput.shopName,
      legalName: applicationInput.legalName,
      legalId: applicationInput.legalId,
      contactPhone: applicationInput.contactPhone,
      licenseAssetId: license.assetId,
      expectedVersion: 1,
      idempotencyKey: 'merchant-application-update-license-1',
      correlationId: 'merchant-application-update-correlation',
    });
    assert.equal(updated.merchant.qualificationComplete, true);
    assert.equal(updated.qualification.licenseAssetId, license.assetId);
    await assert.rejects(
      service.createReviewChallenge(adminActor, merchantId, {
        action: 'BLACKLIST', reasonCode: 'RISK_REVIEW',
        idempotencyKey: 'merchant-blacklist-before-approval', correlationId: 'merchant-blacklist-before-approval',
      }),
      /cannot apply BLACKLIST/,
    );
    const challenge = await service.createReviewChallenge(adminActor, merchantId, {
      action: 'APPROVE', reasonCode: 'QUALIFICATION_VERIFIED',
      idempotencyKey: 'merchant-review-approve-1', correlationId: 'merchant-review-approve-correlation',
    });
    const wrongSignature = await wrongSigner.signTypedData(
      challenge.typedData.domain, challenge.typedData.types, challenge.typedData.message,
    );
    await assert.rejects(service.publishReview(adminActor, merchantId, challenge.actionId, wrongSignature), /signer/);
    const signature = await secondary.signTypedData(
      challenge.typedData.domain, challenge.typedData.types, challenge.typedData.message,
    );
    const approved = await service.publishReview(adminActor, merchantId, challenge.actionId, signature);
    assert.equal(approved.merchant.status, 'APPROVED');
    assert.equal((await db.query<{ status: string; merchant_id: string }>(
      "SELECT status, merchant_id FROM core.wallet_role_bindings WHERE wallet_address = $1 AND role = 'MERCHANT'",
      [settlementWallet.toLowerCase()],
    )).rows[0]?.status, 'ACTIVE');
    assert.equal((await service.publishReview(adminActor, merchantId, challenge.actionId, signature)).merchant.status, 'APPROVED');
    await assert.rejects(
      db.query("UPDATE core.merchants SET settlement_wallet = $2 WHERE merchant_id = $1", [merchantId, Wallet.createRandom().address]),
      /ImmutableSettlementWallet/,
    );
    assert.throws(
      () => service.createReviewChallenge(adminActor, merchantId, {
        action: 'CHANGE_SETTLEMENT_WALLET' as never, reasonCode: 'WALLET_ROTATION',
        idempotencyKey: 'merchant-wallet-change-missing', correlationId: 'merchant-wallet-change-missing',
      }),
      /review action is invalid/,
    );

    const wrongAddressApplication = await service.createApplication(operatorActor, {
      ...applicationInput,
      settlementWallet: Wallet.createRandom().address,
      idempotencyKey: 'merchant-application-wrong-address-1',
      correlationId: 'merchant-application-wrong-address-correlation',
    });
    const rejectWrongAddress = await service.createReviewChallenge(adminActor, wrongAddressApplication.merchant.merchantId, {
      action: 'REJECT', reasonCode: 'INCORRECT_SETTLEMENT_WALLET',
      idempotencyKey: 'merchant-reject-wrong-address-1', correlationId: 'merchant-reject-wrong-address-correlation',
    });
    const rejectWrongAddressSignature = await secondary.signTypedData(
      rejectWrongAddress.typedData.domain, rejectWrongAddress.typedData.types, rejectWrongAddress.typedData.message,
    );
    assert.equal((await service.publishReview(
      adminActor,
      wrongAddressApplication.merchant.merchantId,
      rejectWrongAddress.actionId,
      rejectWrongAddressSignature,
    )).merchant.status, 'REJECTED');
    const correctedAddress = Wallet.createRandom().address;
    const correctedApplication = await service.createApplication(operatorActor, {
      ...applicationInput,
      settlementWallet: correctedAddress,
      idempotencyKey: 'merchant-application-corrected-address-1',
      correlationId: 'merchant-application-corrected-address-correlation',
    });
    assert.equal(correctedApplication.merchant.settlementWallet, correctedAddress.toLowerCase());
    assert.equal(correctedApplication.merchant.status, 'PENDING');

    const blacklist = await service.createReviewChallenge(adminActor, merchantId, {
      action: 'BLACKLIST', reasonCode: 'CONFIRMED_ABUSE',
      idempotencyKey: 'merchant-review-blacklist-1', correlationId: 'merchant-review-blacklist-correlation',
    });
    const blacklistSignature = await secondary.signTypedData(
      blacklist.typedData.domain, blacklist.typedData.types, blacklist.typedData.message,
    );
    const blacklisted = await service.publishReview(adminActor, merchantId, blacklist.actionId, blacklistSignature);
    assert.equal(blacklisted.merchant.status, 'BLACKLISTED');
    assert.equal((await db.query<{ status: string }>(
      "SELECT status FROM core.wallet_role_bindings WHERE wallet_address = $1 AND role = 'MERCHANT'",
      [settlementWallet.toLowerCase()],
    )).rows[0]?.status, 'SUSPENDED');
    const publishedActions = await db.query<{ action_kind: string; state: string }>(
      'SELECT action_kind, state FROM core.merchant_review_actions WHERE merchant_id = $1 ORDER BY action_kind',
      [merchantId],
    );
    assert.deepEqual(publishedActions.rows, [
      { action_kind: 'APPROVE', state: 'PUBLISHED' },
      { action_kind: 'BLACKLIST', state: 'PUBLISHED' },
    ]);

    const staleSettlement = Wallet.createRandom().address;
    const stale = await service.createApplication(operatorActor, {
      ...applicationInput,
      settlementWallet: staleSettlement,
      idempotencyKey: 'merchant-application-stale-1',
      correlationId: 'merchant-application-stale-correlation',
    });
    const staleChallenge = await service.createReviewChallenge(adminActor, stale.merchant.merchantId, {
      action: 'REJECT', reasonCode: 'INCOMPLETE_APPLICATION',
      idempotencyKey: 'merchant-review-stale-1', correlationId: 'merchant-review-stale-correlation',
    });
    const staleSignature = await secondary.signTypedData(
      staleChallenge.typedData.domain, staleChallenge.typedData.types, staleChallenge.typedData.message,
    );
    await db.query("UPDATE core.merchants SET level = 'V2' WHERE merchant_id = $1", [stale.merchant.merchantId]);
    await assert.rejects(
      service.publishReview(adminActor, stale.merchant.merchantId, staleChallenge.actionId, staleSignature),
      /snapshot changed/,
    );

    const expiring = await service.createApplication(operatorActor, {
      ...applicationInput,
      settlementWallet: Wallet.createRandom().address,
      idempotencyKey: 'merchant-application-expiring-1',
      correlationId: 'merchant-application-expiring-correlation',
    });
    const expiringChallenge = await service.createReviewChallenge(adminActor, expiring.merchant.merchantId, {
      action: 'REJECT', reasonCode: 'INCOMPLETE_APPLICATION',
      idempotencyKey: 'merchant-review-expiring-1', correlationId: 'merchant-review-expiring-correlation',
    });
    const expiringSignature = await secondary.signTypedData(
      expiringChallenge.typedData.domain, expiringChallenge.typedData.types, expiringChallenge.typedData.message,
    );
    now = new Date(now.getTime() + 6 * 60_000);
    await assert.rejects(
      service.publishReview(adminActor, expiring.merchant.merchantId, expiringChallenge.actionId, expiringSignature),
      /expired/,
    );
    assert.equal((await db.query<{ state: string }>(
      'SELECT state FROM core.merchant_review_actions WHERE action_id = $1',
      [expiringChallenge.actionId],
    )).rows[0]?.state, 'EXPIRED');
    assert.equal(JSON.stringify((await db.query(
      "SELECT payload FROM core.audit_outbox_events WHERE resource_type = 'MERCHANT'",
    )).rows).includes(applicationInput.legalId), false);
  } finally {
    await db.close();
  }
});

test('merchant drilldown uses named canonical amounts and fails closed when contribution snapshots diverge from the ledger', async () => {
  const db = await createBusinessDatabase();
  const admin = Wallet.createRandom();
  const secondary = Wallet.createRandom();
  const governanceWallet = Wallet.createRandom().address;
  try {
    const { intent, now } = await completeDeliveryForBnm(db);
    await grantRole(db, admin.address, 'ADMIN');
    const service = new MerchantLifecycleService({
      transactions: transactionAdapter(db),
      secondarySigner: secondary.address,
      governanceWallet,
      verifyingContract: governanceWallet,
      auditReady: () => true,
      clock: () => now,
    });
    const detail = await service.get({ walletAddress: admin.address, roles: ['ADMIN'] }, 'merchant-1');
    assert.equal('level' in detail.merchant, false);
    assert.equal('levelPolicy' in detail, false);
    const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60_000);
    const shanghaiDayStart = new Date(Date.UTC(
      shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth(), shanghaiNow.getUTCDate(),
    ) - 8 * 60 * 60_000);
    assert.deepEqual(detail.analytics.orders, {
      totalFinalized: '1',
      ordinaryFinalized: '1',
      seckillFinalized: '0',
      cumulative: {
        listPriceUsdt: intent.listPriceUsdt,
        buyerPaidUsdt: intent.usdtPaymentAmount,
        merchantBaseReceivableUsdt: intent.merchantBaseReceivableUsdt,
        merchantNetReceivableUsdt: intent.merchantNetReceivableUsdt,
      },
      today: {
        listPriceUsdt: intent.listPriceUsdt,
        buyerPaidUsdt: intent.usdtPaymentAmount,
        merchantBaseReceivableUsdt: intent.merchantBaseReceivableUsdt,
        merchantNetReceivableUsdt: intent.merchantNetReceivableUsdt,
      },
      timezone: 'Asia/Shanghai',
      window: {
        start: shanghaiDayStart.toISOString(),
        end: new Date(shanghaiDayStart.getTime() + 24 * 60 * 60_000).toISOString(),
      },
    });
    assert.deepEqual(detail.analytics.fulfillment.fastShip48h, {
      status: 'AVAILABLE',
      numerator: '1',
      denominator: '1',
      bps: 10_000,
      reason: null,
    });
    assert.deepEqual(detail.analytics.contributions, {
      finalizedNplBurnAmount: intent.nplBurnAmount,
      fulfillmentAvailableBnmAmount: intent.bnmAmount,
      ledgerReconciled: true,
    });
    assert.deepEqual(detail.balances, [
      { state: 'LOCKED', amount: '0' },
      { state: 'AVAILABLE', amount: intent.merchantNetReceivableUsdt },
      { state: 'REQUESTED', amount: '0' },
      { state: 'SUBMITTED', amount: '0' },
      { state: 'SETTLED', amount: '0' },
    ]);
    const paymentJournal = await db.query<{ journal_id: string }>(
      "SELECT journal_id FROM core.ledger_journals WHERE order_id = $1 AND event_type = 'PAYMENT_LOCKED'",
      [intent.orderId],
    );
    await db.query(
      `INSERT INTO core.ledger_lines (
         journal_id, account_id, side, amount, balance_state, backing_wallet_address
       ) VALUES ($1,'burn:npl','CREDIT',1,'POSTED',NULL)`,
      [paymentJournal.rows[0]!.journal_id],
    );
    await assert.rejects(
      service.get({ walletAddress: admin.address, roles: ['ADMIN'] }, 'merchant-1'),
      /NPL Burn snapshot does not reconcile/,
    );
  } finally {
    await db.close();
  }
});

test('existing rc.1 database upgrades from wallet-keyed to parallel SIWE nonces', async () => {
  const db = await PGlite.create();
  try {
    await db.exec(
      `CREATE SCHEMA core;
       CREATE TABLE core.schema_migrations (
         migration_name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
       );`,
    );
    for (const name of ['001_core_schema.sql', '002_inventory_and_queue.sql']) {
      await db.exec(readFileSync(join(BUSINESS_MIGRATIONS, name), 'utf8'));
      await db.query('INSERT INTO core.schema_migrations (migration_name) VALUES ($1)', [name]);
    }
    const now = new Date('2026-07-14T00:00:00.000Z');
    await db.query(
      `INSERT INTO core.auth_nonces (
         wallet_address, nonce_hash, domain, uri, chain_id, issued_at, expires_at
       ) VALUES ($1, $2, 'mall.abu.test', 'https://mall.abu.test', 56, $3, $4)`,
      [BUYER, 'a'.repeat(64), now, new Date(now.getTime() + 60_000)],
    );
    await applyMigrations(adapter(db), 'core', BUSINESS_MIGRATIONS);
    const store = new PostgresNonceStore(adapter(db));
    await store.save({
      walletAddress: BUYER,
      nonceHash: 'b'.repeat(64),
      domain: 'mall.abu.test',
      uri: 'https://mall.abu.test',
      chainId: 56,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    assert.ok(await store.consume(BUYER, 'a'.repeat(64), now));
    assert.ok(await store.consume(BUYER, 'b'.repeat(64), now));
  } finally {
    await db.close();
  }
});

test('PostgreSQL indexer replaces a proven segment atomically and preserves old branch evidence', async () => {
  const db = await createBusinessDatabase();
  try {
    const store = new PostgresIndexerStore(transactionAdapter(db));
    const block100 = { number: 100, hash: HASH, parentHash: `0x${'0'.repeat(64)}`, timestamp: 1_800_000_000 };
    const block101 = { number: 101, hash: HASH_2, parentHash: HASH, timestamp: 1_800_000_001 };
    await store.appendCanonical(undefined, [{ block: block100, events: [] }, { block: block101, events: [] }]);
    assert.deepEqual(await store.canonicalAt(100), { blockNumber: 100, blockHash: HASH });
    const replacement = {
      number: 101,
      hash: `0x${'3'.repeat(64)}`,
      parentHash: HASH,
      timestamp: 1_800_000_002,
    };
    await store.replaceCanonical(
      { blockNumber: 101, blockHash: HASH_2 },
      { blockNumber: 100, blockHash: HASH },
      [{ block: replacement, events: [] }],
    );
    assert.deepEqual(await store.checkpoint(), { blockNumber: 101, blockHash: replacement.hash });
    const branches = await db.query<{ block_hash: string; canonical: boolean }>(
      'SELECT block_hash, canonical FROM core.chain_blocks WHERE block_number = 101 ORDER BY block_hash',
    );
    assert.deepEqual(branches.rows, [
      { block_hash: HASH_2, canonical: false },
      { block_hash: replacement.hash, canonical: true },
    ]);

    const failingStore = new PostgresIndexerStore(
      transactionAdapter(db, (sql) => {
        if (sql.startsWith('INSERT INTO core.chain_blocks')) throw new Error('InjectedIndexerFailure');
      }),
    );
    await assert.rejects(
      failingStore.replaceCanonical(
        { blockNumber: 101, blockHash: replacement.hash },
        { blockNumber: 100, blockHash: HASH },
        [{ block: { ...replacement, hash: `0x${'4'.repeat(64)}` }, events: [] }],
      ),
      /InjectedIndexerFailure/,
    );
    assert.deepEqual(await store.checkpoint(), { blockNumber: 101, blockHash: replacement.hash });
  } finally {
    await db.close();
  }
});

test('PostgreSQL indexer atomically projects payment, rolls back a bad reorg and reaches 15 confirmations', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const intent = paymentIntent();
    await reserveInventory(adapter(db), {
      reservationId: intent.reservationId,
      reservationHash: intent.reservationHash,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(intent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, intent);
    const store = new PostgresIndexerStore(transactionAdapter(db));
    const block99 = chainBlock(99, blockHash(99), blockHash(98), intent.issuedAt - 1);
    const original100 = chainBlock(100, blockHash(100), block99.block.hash, intent.issuedAt);
    await store.appendCanonical(undefined, [block99, {
      ...original100,
      events: [decodedPaymentEvent(intent, original100.block.hash)],
    }]);
    assert.deepEqual(await store.checkpoint(), { blockNumber: 100, blockHash: original100.block.hash });
    await assertLedgerBalanced(db, 1);

    const replacement100 = chainBlock(100, blockHash(1_100), block99.block.hash, intent.issuedAt + 1);
    const invalidEvent = decodedPaymentEvent(intent, replacement100.block.hash);
    invalidEvent.values.snapshotHash = HASH;
    await assert.rejects(
      store.replaceCanonical(
        { blockNumber: 100, blockHash: original100.block.hash },
        { blockNumber: 99, blockHash: block99.block.hash },
        [{ ...replacement100, events: [invalidEvent] }],
      ),
      /signed quote leg/,
    );
    assert.deepEqual(await store.checkpoint(), { blockNumber: 100, blockHash: original100.block.hash });
    await assertLedgerBalanced(db, 1);

    await store.replaceCanonical(
      { blockNumber: 100, blockHash: original100.block.hash },
      { blockNumber: 99, blockHash: block99.block.hash },
      [{ ...replacement100, events: [decodedPaymentEvent(intent, replacement100.block.hash)] }],
    );
    const canonical = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.payment_events WHERE canonical',
    );
    assert.equal(canonical.rows[0]?.count, '1');
    await assertLedgerBalanced(db, 1);

    const confirmations: IndexedChainBlock[] = [];
    let parentHash = replacement100.block.hash;
    for (let number = 101; number <= 114; number += 1) {
      const block = chainBlock(number, blockHash(1_000 + number), parentHash, intent.issuedAt + number - 99);
      confirmations.push(block);
      parentHash = block.block.hash;
    }
    await store.appendCanonical({ blockNumber: 100, blockHash: replacement100.block.hash }, confirmations);
    const final = await db.query<{ confirmations: string; finality_status: string; state: string; finalized_at: Date }>(
      `SELECT payment.confirmations::text, orders.finality_status, finality.state, finality.finalized_at
       FROM core.payment_events payment
       JOIN core.orders orders ON orders.order_id = payment.order_id
       JOIN core.transaction_finality finality ON finality.transaction_id = 'payment:' || payment.event_key
       WHERE payment.canonical`,
    );
    assert.deepEqual(final.rows[0], {
      confirmations: '15',
      finality_status: 'FINAL',
      state: 'FINAL',
      finalized_at: new Date((intent.issuedAt + 15) * 1000),
    });
  } finally {
    await db.close();
  }
});

test('local PaymentRouter receipt reaches 15 confirmations and a balanced PostgreSQL order projection', async () => {
  const execution = await executeLocalPaymentChain();
  const db = await createBusinessDatabase();
  try {
    const intent = execution.intent;
    await seedCatalog(db, 1, intent.merchant, {
      buyerWallet: intent.buyer,
      fulfillmentTargetHash: intent.fulfillmentTargetHash,
      regionCodeHash: intent.regionCodeHash,
      listPriceUsdt: intent.listPriceUsdt,
      merchantCostUsdt: intent.merchantBaseReceivableUsdt,
      policyPayload: {
        ...paymentPolicyPayload(),
        platformServiceFeeWallet: execution.wallets.platformServiceFee,
        usdtSettlementWallet: execution.wallets.usdtCustody,
        nplRewardWallet: execution.wallets.nplReward,
        operationsWallet: execution.wallets.operationsTreasury,
        concessionDestinationSetHash: intent.concessionAllocationHash,
        genesisNodeDestinations: intent.nplRewardAllocations
          .filter((allocation) => allocation.role === 'genesis')
          .map((allocation) => ({ account: allocation.account, weightBps: 10_000 })),
        operationsDestinations: [
          ...intent.nplRewardAllocations
            .filter((allocation) => allocation.role === 'operations')
            .map((allocation) => ({ account: allocation.account, weightBps: 2_500 })),
        ],
      },
    });
    await reserveInventory(adapter(db), {
      reservationId: intent.reservationId,
      reservationHash: intent.reservationHash,
      policyVersion: intent.policyVersion,
      skuId: 'sku-1',
      buyerWallet: intent.buyer,
      quantity: intent.quantity,
      classification: 'ORDINARY',
      expiresAt: new Date(intent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, intent);
    const reservationEvidence = await db.query<{
      reservation_hash: string;
      policy_version: string;
      reservation_sku_id: string;
      quote_sku_id: string;
      buyer_wallet: string;
      quantity: string;
      classification: string;
    }>(
      `SELECT lower(reservation.reservation_hash) AS reservation_hash,
         reservation.policy_version::text, reservation.sku_id AS reservation_sku_id,
         quote.sku_id AS quote_sku_id, lower(reservation.buyer_wallet) AS buyer_wallet,
         reservation.quantity::text, reservation.classification
       FROM core.inventory_reservations reservation
       JOIN core.payment_quotes quote ON quote.order_id = $2
       WHERE reservation.reservation_id = $1`,
      [intent.reservationId, intent.orderId],
    );
    assert.deepEqual(reservationEvidence.rows[0], {
      reservation_hash: intent.reservationHash.toLowerCase(),
      policy_version: String(intent.policyVersion),
      reservation_sku_id: 'sku-1',
      quote_sku_id: 'sku-1',
      buyer_wallet: intent.buyer.toLowerCase(),
      quantity: String(intent.quantity),
      classification: 'ORDINARY',
    });
    const decoder = await AbiEventDecoder.load(ABI_BUNDLE_PATH, { PaymentRouterV2: execution.routerAddress });
    const indexer = new ChainIndexer(decoder, new PostgresIndexerStore(transactionAdapter(db)));
    await indexer.ingestSegment(execution.segment);
    const projection = await db.query<{
      classification: string;
      confirmations: string;
      canonical: boolean;
      finality_status: string;
      order_state: string;
      payment_tx_hash: string;
    }>(
      `SELECT payment.classification, payment.confirmations::text, payment.canonical,
         orders.finality_status, orders.state AS order_state, lower(orders.payment_tx_hash) AS payment_tx_hash
       FROM core.payment_events payment
       JOIN core.orders orders ON orders.order_id = payment.order_id
       JOIN core.transaction_finality finality ON finality.resource_id = payment.order_id
       WHERE payment.order_id = $1`,
      [intent.orderId],
    );
    assert.deepEqual(projection.rows[0], {
      classification: 'ORDINARY',
      confirmations: '15',
      canonical: true,
      finality_status: 'FINAL',
      order_state: 'PAID',
      payment_tx_hash: execution.transactionHash,
    });
    const inventory = await db.query<{ state: string; stock_available: string }>(
      `SELECT reservation.state, sku.stock_available::text
       FROM core.inventory_reservations reservation
       JOIN core.skus sku ON sku.sku_id = reservation.sku_id
       WHERE reservation.reservation_id = $1`,
      [intent.reservationId],
    );
    assert.deepEqual(inventory.rows[0], { state: 'CONSUMED', stock_available: '0' });
    const balances = await db.query<{ asset: string; net: string }>(
      `SELECT account.asset,
         sum(CASE WHEN line.side = 'DEBIT' THEN line.amount ELSE -line.amount END)::text AS net
       FROM core.ledger_journals journal
       JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
       JOIN core.ledger_accounts account ON account.account_id = line.account_id
       WHERE journal.order_id = $1 GROUP BY account.asset ORDER BY account.asset`,
      [intent.orderId],
    );
    assert.ok(balances.rows.length >= 3);
    assert.ok(balances.rows.every((row) => row.net === '0'));
    assert.deepEqual(await purposeBalances(db, intent.orderId, 'MERCHANT_RECEIVABLE'), {
      LOCKED: intent.merchantNetReceivableUsdt,
    });
    assert.deepEqual(await purposeBalances(db, intent.orderId, 'BNM_LIABILITY'), {
      LOCKED: intent.bnmAmount,
    });
    assert.deepEqual(execution.balances, {
      platformServiceFeeUsdt: intent.platformServiceFeeUsdt,
      custodyUsdt: (BigInt(intent.custodyProductUsdt) + BigInt(intent.freightUsdt)).toString(),
      burnedNpl: intent.nplBurnAmount,
      rewardNpl: intent.nplRewardAmount,
      routerUsdt: '0',
      routerNpl: '0',
    });
  } finally {
    await db.close();
  }
});

test('inventory reservation is atomic, idempotent and cannot oversell', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const expiresAt = new Date(Date.now() + 60_000);
    const common = {
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY' as const,
      expiresAt,
    };
    const attempts = await Promise.allSettled([
      reserveInventory(adapter(db), { ...common, reservationId: 'reservation-a', reservationHash: HASH }),
      reserveInventory(adapter(db), { ...common, reservationId: 'reservation-b', reservationHash: HASH_2 }),
    ]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
    const stock = await db.query<{ stock_available: number; stock_reserved: number }>(
      "SELECT stock_available, stock_reserved FROM core.skus WHERE sku_id = 'sku-1'",
    );
    assert.deepEqual(stock.rows[0], { stock_available: 0, stock_reserved: 1 });

    const winner = attempts.find((result) => result.status === 'fulfilled');
    assert.ok(winner && winner.status === 'fulfilled');
    const replay = await reserveInventory(adapter(db), {
      ...common,
      reservationId: winner.value.reservation_id,
      reservationHash: winner.value.reservation_id === 'reservation-a' ? HASH : HASH_2,
    });
    assert.equal(replay.reservation_id, winner.value.reservation_id);
    const count = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM core.inventory_reservations');
    assert.equal(count.rows[0]?.count, '1');
  } finally {
    await db.close();
  }
});

test('two PaymentCompleted logs in one transaction keep independent finality records', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 2);
    const first = paymentIntent();
    const second: CanonicalPaymentIntent = {
      ...paymentIntent(),
      orderId: `0x${'7'.repeat(64)}`,
      reservationId: `0x${'8'.repeat(64)}`,
      reservationHash: `0x${'9'.repeat(64)}`,
      nonce: '2',
    };
    for (const intent of [first, second]) {
      await reserveInventory(adapter(db), {
        reservationId: intent.reservationId,
        reservationHash: intent.reservationHash,
        policyVersion: 1,
        skuId: 'sku-1',
        buyerWallet: BUYER,
        quantity: 1,
        classification: 'ORDINARY',
        expiresAt: new Date(intent.reservationDeadline * 1000),
      });
    }
    await insertPaymentQuote(db, first, 'same-tx-order-1');
    await insertPaymentQuote(db, second, 'same-tx-order-2');
    const store = new PostgresPaymentStore(transactionAdapter(db));
    await store.record(paymentInput(first));
    const secondInput = paymentInput(second);
    secondInput.event.logIndex = 1;
    await store.record(secondInput);

    const rows = await db.query<{ resource_id: string; tx_hash: string; state: string }>(
      `SELECT resource_id, tx_hash, state FROM core.transaction_finality
       WHERE resource_type = 'ORDER_PAYMENT' ORDER BY resource_id`,
    );
    assert.deepEqual(rows.rows, [
      { resource_id: second.orderId, tx_hash: secondInput.event.transactionHash, state: 'FINAL' },
      { resource_id: first.orderId, tx_hash: secondInput.event.transactionHash, state: 'FINAL' },
    ]);
  } finally {
    await db.close();
  }
});

test('seckill and fallback reservations use independent session and retail inventory', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const sessionId = `0x${'f'.repeat(64)}`;
    const now = new Date();
    await db.query(
      `INSERT INTO core.seckill_sessions (
         session_id, policy_version, merchant_id, product_id, sku_id,
         product_policy_hash, starts_at, main_deadline, relay_deadline,
         inventory, seckill_list_price_usdt, phase, snapshot
       ) VALUES ($1, 1, 'merchant-1', 'product-1', 'sku-1', $2,
         $3, $4, $5, 1, 80, 'LIVE', '{}')`,
      [
        sessionId,
        HASH,
        new Date(now.getTime() - 60_000),
        new Date(now.getTime() + 59 * 60_000),
        new Date(now.getTime() + 60_000),
      ],
    );
    await reserveInventory(adapter(db), {
      reservationId: 'seckill-reservation',
      reservationHash: HASH,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'SECKILL',
      sessionId,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    await reserveInventory(adapter(db), {
      reservationId: 'fallback-reservation',
      reservationHash: HASH_2,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'FALLBACK_RETAIL',
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    const reserved = await db.query<{
      stock_available: number;
      stock_reserved: number;
      session_reserved: number;
      sold: number;
    }>(
      `SELECT sku.stock_available, sku.stock_reserved, session.reserved AS session_reserved, session.sold
       FROM core.skus sku JOIN core.seckill_sessions session ON session.sku_id = sku.sku_id`,
    );
    assert.deepEqual(reserved.rows[0], { stock_available: 0, stock_reserved: 1, session_reserved: 1, sold: 0 });
    await db.query('SELECT core.consume_inventory_reservation_at($1, $2, $3)', [
      'seckill-reservation',
      `0x${'a'.repeat(64)}`,
      now,
    ]);
    await db.query("SELECT core.release_inventory_reservation('fallback-reservation', 'RELEASED')");
    const consumed = await db.query<{
      stock_available: number;
      stock_reserved: number;
      session_reserved: number;
      sold: number;
    }>(
      `SELECT sku.stock_available, sku.stock_reserved, session.reserved AS session_reserved, session.sold
       FROM core.skus sku JOIN core.seckill_sessions session ON session.sku_id = sku.sku_id`,
    );
    assert.deepEqual(consumed.rows[0], { stock_available: 1, stock_reserved: 0, session_reserved: 0, sold: 1 });
    await db.query("SELECT core.restore_reorged_inventory_reservation('seckill-reservation')");
    const restored = await db.query<{ reserved: number; sold: number }>(
      'SELECT reserved, sold FROM core.seckill_sessions WHERE session_id = $1',
      [sessionId],
    );
    assert.deepEqual(restored.rows[0], { reserved: 1, sold: 0 });
  } finally {
    await db.close();
  }
});

test('seckill operations publish locked inventory, reconcile prize funding and govern force-close recovery', async () => {
  const db = await createBusinessDatabase();
  const admin = Wallet.createRandom();
  const operator = Wallet.createRandom();
  const secondary = Wallet.createRandom();
  const governanceWallet = '0x3333333333333333333333333333333333333333';
  const custodySafe = '0x4444444444444444444444444444444444444444';
  const operationsSafe = '0x5555555555555555555555555555555555555555';
  const router = '0x6666666666666666666666666666666666666666';
  const now = new Date('2026-07-15T08:00:00.000Z');
  let clock = now;
  try {
    await seedCatalog(db, 10);
    await db.query('UPDATE core.skus SET proposed_seckill_inventory = 4 WHERE sku_id = $1', ['sku-1']);
    for (const [wallet, role] of [[admin.address, 'ADMIN'], [operator.address, 'OPERATOR']] as const) {
      await db.query(
        `INSERT INTO core.wallet_role_bindings (
           wallet_address, role, merchant_id, status, evidence_hash
         ) VALUES ($1,$2,NULL,'ACTIVE',$3)`,
        [wallet.toLowerCase(), role, HASH],
      );
    }
    await db.query(
      `INSERT INTO core.merchant_guarantees (
         merchant_id, backing_wallet_address, balance_usdt, minimum_usdt,
         source_evidence_hash, updated_at
       ) VALUES ('merchant-1',$1,$2,$2,$3,$4)`,
      [operationsSafe, (1_000n * 10n ** 18n).toString(), HASH_2, now],
    );
    await db.query(
      `INSERT INTO core.coverage_snapshots (
         snapshot_id, chain_id, block_number, block_hash, canonical, evidence_hash, recorded_at
       ) VALUES ('coverage:seckill',56,100,$1,true,$2,$3)`,
      [HASH, HASH_2, now],
    );
    await db.query(
      `INSERT INTO core.coverage_snapshot_items (
         snapshot_id, wallet_address, asset, verified_asset_balance,
         unsettled_liability, coverage_met
       ) VALUES ('coverage:seckill',$1,'USDT',1000,1000,true)`,
      [custodySafe],
    );
    await db.query(
      `INSERT INTO core.circuit_breakers (
         scope, paused, evidence_hash, policy_version, changed_by, changed_at
       ) VALUES ('SECKILL_PURCHASE',false,$1,1,'TEST',$2)
       ON CONFLICT (scope) DO UPDATE SET paused = false`,
      [HASH, now],
    );
    await db.query(
      `INSERT INTO core.cms_entries (
         entry_id, slug, content_type, placement, created_by, created_at
       ) VALUES ('cms:seckill-rules','seckill-rules','SECKILL_RULES','SECKILL_RULES',$1,$2)`,
      [admin.address.toLowerCase(), now],
    );
    await db.query(
      `INSERT INTO core.cms_versions (
         version_id, entry_id, version, locale, content_format, source_content,
         sanitized_content, content_hash, audience, policy_version,
         idempotency_key, request_hash, created_by, created_at
       ) VALUES ('cms:seckill-rules:v1','cms:seckill-rules',1,'zh-CN','STRUCTURED_RICH_TEXT',
         $1,$1,$2,'{"type":"ALL"}',1,'seckill-rules-v1',$3,$4,$5)`,
      [
        JSON.stringify({ type: 'doc', children: [] }),
        HASH,
        HASH_2,
        admin.address.toLowerCase(),
        now,
      ],
    );
    await db.query(
      `INSERT INTO core.cms_publication_events (
         event_id, entry_id, active_version_id, event_type, evidence_hash,
         actor_wallet, created_at
       ) VALUES ('cms:seckill-rules:published','cms:seckill-rules','cms:seckill-rules:v1',
         'PUBLISHED',$1,$2,$3)`,
      [HASH_2, admin.address.toLowerCase(), now],
    );

    const service = new SeckillOperationsService({
      transactions: transactionAdapter(db),
      governanceWalletAddress: governanceWallet,
      operationsWalletAddress: operationsSafe,
      settlementWalletAddress: custodySafe,
      paymentRouterAddress: router,
      secondarySignerAddress: secondary.address,
      clock: () => clock,
    });
    const operatorActor = { walletAddress: operator.address, roles: ['OPERATOR'] as const };
    const adminActor = { walletAddress: admin.address, roles: ['ADMIN'] as const };
    const sessionInput = {
      policyVersion: '1',
      rulesContentHash: HASH,
      productId: 'product-1',
      skuId: 'sku-1',
      inventory: 4,
      seckillListPriceUsdt: '80',
      startsAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      idempotencyKey: 'seckill-session-001',
      correlationId: 'seckill-session-create',
    };
    const sessionAction = await service.createSession(operatorActor, sessionInput);
    assert.equal(sessionAction.state, 'DRAFT');
    assert.equal(sessionAction.sessionPlan?.inventory, '4');
    assert.equal(sessionAction.sessionPlan?.timers.mainDurationSeconds, 3_600);
    assert.equal('merchantLevelPolicy' in sessionAction.sessionPlan!.snapshot, false);
    assert.equal((await service.createSession(operatorActor, sessionInput)).actionId, sessionAction.actionId);
    assert.deepEqual(
      (await db.query<{ stock_available: number; stock_seckill_locked: number }>(
        'SELECT stock_available, stock_seckill_locked FROM core.skus WHERE sku_id = $1',
        ['sku-1'],
      )).rows[0],
      { stock_available: 6, stock_seckill_locked: 4 },
    );
    await assert.rejects(
      service.createSession({ walletAddress: secondary.address, roles: ['AUDITOR'] }, {
        policyVersion: '1', rulesContentHash: HASH, productId: 'product-1', skuId: 'sku-1',
        inventory: 1, seckillListPriceUsdt: '80', startsAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        idempotencyKey: 'seckill-audit-denied', correlationId: 'denied',
      }),
      (error: unknown) => error instanceof CoreError && error.code === 'Forbidden',
    );

    const approve = async (actionId: string, nonce: string) => {
      const deadline = String(Math.floor(clock.getTime() / 1_000) + 600);
      const challenge = await service.approvalChallenge(adminActor, actionId, { nonce, deadline });
      const signature = await secondary.signTypedData(
        challenge.typedData.domain,
        challenge.typedData.types,
        challenge.typedData.message,
      );
      const approved = await service.submitApproval(adminActor, actionId, {
        nonce,
        deadline,
        signature,
        correlationId: `seckill-approval-${nonce}`,
      });
      assert.deepEqual(approved.allowedActions, ['EXECUTE', 'CANCEL']);
      await service.execute(adminActor, actionId, `seckill-execution-${nonce}`);
    };

    const nonceByExecutor = new Map<string, bigint>();
    const reorged = new Set<string>();
    const worker = new SeckillGovernanceWorker({
      transactions: transactionAdapter(db),
      executor: {
        execute: async (input: SeckillExecution) => {
          const current = nonceByExecutor.get(input.governanceWallet) ?? BigInt(input.minimumExecutorNonce);
          nonceByExecutor.set(input.governanceWallet, current + 1n);
          const executorNonce = current.toString();
          return {
            executorWallet: input.governanceWallet,
            executorNonce,
            submittedTxHash: keccak256(toUtf8Bytes(`execution:${input.actionId}:${executorNonce}`)),
            executionEvidenceHash: keccak256(toUtf8Bytes(`execution-evidence:${input.actionId}:${executorNonce}`)),
          };
        },
      },
      chain: {
        observe: async (input: SeckillFinalityCandidate): Promise<SeckillObservation> => {
          const executionTxHash = keccak256(toUtf8Bytes(`execution:${input.actionId}`));
          const blockHash = keccak256(toUtf8Bytes(`block:${input.actionId}`));
          if (reorged.has(input.actionId) && input.priorState === 'FINAL') {
            const canonicalBlockHash = keccak256(toUtf8Bytes(`canonical:${input.actionId}`));
            const evidence = {
              submittedTxHash: input.submittedTxHash,
              executionTxHash,
              blockNumber: 100,
              blockHash,
              canonicalBlockHash,
              confirmations: 0 as const,
              canonical: false as const,
              actionKind: input.actionKind,
              evidenceHash: input.evidenceHash,
            };
            return {
              state: 'REORGED',
              ...evidence,
              observationEvidenceHash: keccak256(toUtf8Bytes(JSON.stringify(evidence))),
            };
          }
          const evidence = {
            submittedTxHash: input.submittedTxHash,
            executionTxHash,
            blockNumber: 100,
            blockHash,
            confirmations: 15,
            canonical: true as const,
            actionKind: input.actionKind,
            evidenceHash: input.evidenceHash,
          };
          return {
            state: 'FINAL',
            ...evidence,
            observationEvidenceHash: keccak256(toUtf8Bytes(JSON.stringify(evidence))),
          };
        },
      },
      clock: () => clock,
    });

    await approve(sessionAction.actionId, '1');
    assert.deepEqual(await worker.pollOnce(), { executions: 1, finality: 1 });
    assert.deepEqual(worker.status(), { healthy: true, errorCode: undefined });
    const session = await db.query<{
      phase: string; inventory: number; governance_action_id: string;
      rules_content_hash: string; publication_tx_hash: string;
    }>(
      `SELECT phase, inventory, governance_action_id, rules_content_hash, publication_tx_hash
       FROM core.seckill_sessions WHERE session_id = $1`,
      [sessionAction.sessionId],
    );
    assert.equal(session.rows[0]?.phase, 'PREHEAT');
    assert.equal(session.rows[0]?.inventory, 4);
    assert.equal(session.rows[0]?.governance_action_id, sessionAction.actionId);
    assert.equal(session.rows[0]?.rules_content_hash, HASH);

    const injection = await service.createPrizeInjection(adminActor, sessionAction.sessionId, {
      amountUsdt: '50',
      idempotencyKey: 'seckill-prize-001',
      correlationId: 'seckill-prize-create',
    });
    await approve(injection.actionId, '2');
    await worker.pollOnce();
    assert.equal(
      (await db.query<{ prize_pool_usdt: string }>(
        'SELECT prize_pool_usdt::text FROM core.seckill_sessions WHERE session_id = $1',
        [sessionAction.sessionId],
      )).rows[0]?.prize_pool_usdt,
      '50',
    );
    const prizeJournal = await db.query<{ debits: string; credits: string }>(
      `SELECT sum(CASE WHEN line.side = 'DEBIT' THEN line.amount ELSE 0 END)::text AS debits,
         sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE 0 END)::text AS credits
       FROM core.ledger_lines line
       JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
       WHERE journal.event_type = 'SECKILL_PRIZE_INJECTED'`,
    );
    assert.deepEqual(prizeJournal.rows[0], { debits: '50', credits: '50' });

    reorged.add(injection.actionId);
    await worker.pollOnce();
    assert.deepEqual(worker.status(), { healthy: true, errorCode: undefined });
    assert.equal(
      (await db.query<{ prize_pool_usdt: string }>(
        'SELECT prize_pool_usdt::text FROM core.seckill_sessions WHERE session_id = $1',
        [sessionAction.sessionId],
      )).rows[0]?.prize_pool_usdt,
      '0',
    );
    assert.equal(
      (await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM core.ledger_journals WHERE event_type = 'SECKILL_PRIZE_INJECTION_REVERSED'",
      )).rows[0]?.count,
      '1',
    );

    const forceClose = await service.createForceClose(adminActor, sessionAction.sessionId, {
      reasonCode: 'OPERATIONS_STOP',
      idempotencyKey: 'seckill-force-close-001',
      correlationId: 'seckill-force-close-create',
    });
    await approve(forceClose.actionId, '3');
    await worker.pollOnce();
    assert.deepEqual(worker.status(), { healthy: true, errorCode: undefined });
    assert.equal(
      (await db.query<{ phase: string }>('SELECT phase FROM core.seckill_sessions WHERE session_id = $1', [sessionAction.sessionId])).rows[0]?.phase,
      'FORCE_CLOSED',
    );
    assert.deepEqual(
      (await db.query<{ stock_available: number; stock_seckill_locked: number }>(
        'SELECT stock_available, stock_seckill_locked FROM core.skus WHERE sku_id = $1',
        ['sku-1'],
      )).rows[0],
      { stock_available: 10, stock_seckill_locked: 0 },
    );
    assert.equal(
      (await db.query<{ paused: boolean }>("SELECT paused FROM core.circuit_breakers WHERE scope = 'SECKILL_PURCHASE'")).rows[0]?.paused,
      true,
    );

    const resume = await service.createResume(adminActor, {
      sessionId: sessionAction.sessionId,
      idempotencyKey: 'seckill-resume-001',
      correlationId: 'seckill-resume-create',
    });
    await approve(resume.actionId, '4');
    await worker.pollOnce();
    assert.equal(
      (await db.query<{ paused: boolean }>("SELECT paused FROM core.circuit_breakers WHERE scope = 'SECKILL_PURCHASE'")).rows[0]?.paused,
      false,
    );
    assert.equal(
      (await db.query<{ phase: string }>('SELECT phase FROM core.seckill_sessions WHERE session_id = $1', [sessionAction.sessionId])).rows[0]?.phase,
      'FORCE_CLOSED',
    );
    const secondSession = await service.createSession(operatorActor, {
      ...sessionInput,
      inventory: 1,
      startsAt: new Date(now.getTime() + 90 * 60_000).toISOString(),
      idempotencyKey: 'seckill-session-no-level-quota',
    });
    assert.equal(secondSession.state, 'DRAFT');
  } finally {
    await db.close();
  }
});

test('catalog payment service builds an authoritative idempotent quote and records transaction replacement', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 2);
    const quoteNow = new Date();
    let signCalls = 0;
    const ids = [
      `0x${'9'.repeat(64)}`,
      `0x${'d'.repeat(64)}`,
      `0x${'7'.repeat(64)}`,
      `0x${'8'.repeat(64)}`,
    ];
    let bnmRegistered = false;
    const service = new CatalogPaymentService({
      transactions: transactionAdapter(db),
      signer: {
        sign: async (request) => {
          signCalls += 1;
          assert.equal(request.purpose, 'ORDER_QUOTE');
          return { signature: `0x${'1'.repeat(130)}`, signer: '0x8888888888888888888888888888888888888888' };
        },
      },
      nplQuotes: {
        quote: async () => ({
          nplQuoteAmount: 1_000n,
          quoteSourceEvidence: { source: 'PRIMARY', observedBlock: 40_000_000, reservesHash: HASH },
        }),
      },
      beneficiaries: {
        resolve: async () => ({
          genesis: '0x0000000000000000000000000000000000000000',
          directReferral: '0x5000000000000000000000000000000000000002',
          district: '0x5000000000000000000000000000000000000003',
          city: '0x5000000000000000000000000000000000000004',
          province: '0x5000000000000000000000000000000000000005',
          region: '0x5000000000000000000000000000000000000006',
        }),
      },
      policies: { assertPublished: async () => undefined },
      bnmWallets: {
        assertRegistered: async () => {
          if (!bnmRegistered) throw new CoreError('Forbidden', 'BNM registration required', 403);
        },
      },
      paymentRouterAddress: '0x9999999999999999999999999999999999999999',
      clock: () => quoteNow,
      bytes32: () => ids.shift()!,
      nonce: () => 7n,
    });
    const request = {
      idempotencyKey: 'checkout-attempt-1',
      productId: 'product-1',
      skuId: 'sku-1',
      quantity: 1,
      fulfillmentMode: 'DELIVERY' as const,
      fulfillmentTargetHash: HASH,
      regionCodeHash: HASH,
    };
    await assert.rejects(
      service.createOrdinaryQuote(BUYER, request),
      (error: unknown) => error instanceof CoreError && error.code === 'Forbidden',
    );
    assert.equal(signCalls, 0);
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.inventory_reservations',
    )).rows[0]?.count, '0');
    bnmRegistered = true;
    const catalog = await service.listCatalog();
    assert.equal(catalog[0]?.skus[0]?.listPriceUsdt, '100');
    assert.equal(catalog[0]?.subtitle, 'Authoritative catalog product');
    assert.deepEqual(catalog[0]?.richDetail, { blocks: [] });
    assert.equal(catalog[0]?.defaultFreightUsdt, '5');
    assert.deepEqual(catalog[0]?.fulfillmentModes, ['DELIVERY', 'PICKUP']);
    assert.equal(catalog[0]?.categoryId, null);
    assert.deepEqual(catalog[0]?.tagIds, []);
    assert.deepEqual(catalog[0]?.mainImageAssetIds, []);
    assert.equal(catalog[0]?.videoAssetId, null);
    assert.equal(catalog[0]?.skus[0]?.seckill, null);
    assert.equal('merchantCostUsdt' in (catalog[0]?.skus[0] ?? {}), false);

    const sessionId = `0x${'a'.repeat(64)}`;
    await insertLiveSeckillSession(db, sessionId, quoteNow, 90);
    const liveCatalog = await service.getProduct('product-1');
    assert.deepEqual(liveCatalog.skus[0]?.seckill, {
      sessionId,
      policyVersion: '1',
      phase: 'LIVE',
      startsAt: new Date(quoteNow.getTime() - 60_000).toISOString(),
      mainDeadline: new Date(quoteNow.getTime() + 59 * 60_000).toISOString(),
      relayDeadline: new Date(quoteNow.getTime() + 60_000).toISOString(),
      seckillListPriceUsdt: '90',
      inventory: { total: '1', sold: '0', reserved: '0', available: '1' },
      ordinaryCheckoutAllowed: false,
    });
    await assert.rejects(
      service.createOrdinaryQuote(BUYER, { ...request, idempotencyKey: 'checkout-attempt-seckill' }),
      (error: unknown) => error instanceof CoreError
        && error.code === 'SeckillOnlyProduct'
        && typeof error.details.blockingResource === 'object',
    );
    await db.query(
      `UPDATE core.seckill_sessions SET phase = 'PREHEAT', starts_at = $2,
         main_deadline = $3, relay_deadline = $4 WHERE session_id = $1`,
      [sessionId, new Date(quoteNow.getTime() + 10 * 60_000),
        new Date(quoteNow.getTime() + 70 * 60_000), new Date(quoteNow.getTime() + 11 * 60_000)],
    );
    await assert.rejects(
      service.createOrdinaryQuote(BUYER, { ...request, idempotencyKey: 'checkout-attempt-preheat' }),
      (error: unknown) => error instanceof CoreError && error.code === 'SeckillOnlyProduct',
    );
    const overlappingSessionId = `0x${'e'.repeat(64)}`;
    await insertLiveSeckillSession(db, overlappingSessionId, quoteNow, 89);
    await assert.rejects(service.getProduct('product-1'), /Multiple active seckill sessions/);
    await assert.rejects(
      service.createOrdinaryQuote(BUYER, { ...request, idempotencyKey: 'checkout-attempt-overlap' }),
      (error: unknown) => error instanceof CoreError && error.code === 'UnknownState',
    );
    await db.query("UPDATE core.seckill_sessions SET phase = 'FORCE_CLOSED' WHERE session_id = $1", [overlappingSessionId]);
    await db.query(
      `UPDATE core.seckill_sessions SET phase = 'SETTLING', starts_at = $2,
         main_deadline = $3, relay_deadline = $3 WHERE session_id = $1`,
      [sessionId, new Date(quoteNow.getTime() - 70 * 60_000), new Date(quoteNow.getTime() - 10 * 60_000)],
    );
    await assert.rejects(
      service.createOrdinaryQuote(BUYER, { ...request, idempotencyKey: 'checkout-attempt-settling' }),
      (error: unknown) => error instanceof CoreError && error.code === 'SeckillOnlyProduct',
    );
    await db.query("UPDATE core.seckill_sessions SET phase = 'FORCE_CLOSED' WHERE session_id = $1", [sessionId]);

    const quote = await service.createOrdinaryQuote(BUYER, request);
    assert.equal(quote.intent.productUsdtPaymentAmount, '70');
    assert.equal(quote.intent.freightUsdt, '5');
    assert.equal(quote.intent.usdtPaymentAmount, '75');
    assert.equal(quote.intent.nplPaymentAmount, '300');
    assert.deepEqual((await db.query<{ quote_source_evidence: Record<string, unknown> }>(
      `SELECT quote_source_evidence FROM core.payment_quote_legs
       WHERE order_id = $1 AND classification = 'ORDINARY'`,
      [quote.orderId],
    )).rows[0]?.quote_source_evidence, {
      source: 'PRIMARY', observedBlock: 40_000_000, reservesHash: HASH,
    });
    assert.equal(quote.intent.productId, `0x${'b'.repeat(64)}`);
    assert.equal(quote.snapshotHash, paymentIntentHash(quote.intent));
    assert.equal(quote.approvalRequirements[0]?.requiredAmount, '75');
    assert.equal(quote.approvalRequirements[0]?.approvalMode, 'ONLY_IF_ALLOWANCE_BELOW_REQUIRED');
    assert.equal(quote.approvalRequirements[0]?.revocation.method, 'ERC20_APPROVE_ZERO');
    assert.equal((await service.createOrdinaryQuote(BUYER, request)).orderId, quote.orderId);
    assert.equal(signCalls, 1);
    await assert.rejects(
      service.createOrdinaryQuote(BUYER, { ...request, quantity: 2 }),
      /Idempotency key was used for a different quote/,
    );
    const stock = await db.query<{ stock_available: number; stock_reserved: number }>(
      "SELECT stock_available, stock_reserved FROM core.skus WHERE sku_id = 'sku-1'",
    );
    assert.deepEqual(stock.rows[0], { stock_available: 1, stock_reserved: 1 });
    await assert.rejects(
      insertLiveSeckillSession(db, `0x${'f'.repeat(64)}`, quoteNow, 88),
      /ActiveOrdinaryQuote/,
    );
    await db.query(
      `INSERT INTO core.circuit_breakers (scope, paused, evidence_hash, policy_version, changed_by)
       VALUES ('NEW_PAYMENT', true, $1, 1, 'test')`,
      [HASH],
    );
    await assert.rejects(
      service.createOrdinaryQuote(BUYER, { ...request, idempotencyKey: 'checkout-attempt-2' }),
      /New payments are paused/,
    );

    const firstTx = `0x${'6'.repeat(64)}`;
    const replacementTx = `0x${'7'.repeat(64)}`;
    assert.equal((await service.submitPayment(BUYER, { orderId: quote.orderId, txHash: firstTx })).state, 'SUBMITTED');
    await assert.rejects(
      service.submitPayment(BUYER, { orderId: quote.orderId, txHash: replacementTx }),
      /Replacement transaction does not match/,
    );
    await service.submitPayment(BUYER, {
      orderId: quote.orderId,
      txHash: replacementTx,
      replacementForTxHash: firstTx,
    });
    const projection = await service.getPayment(BUYER, quote.orderId);
    assert.equal(projection.state, 'SUBMITTED');
    assert.equal(projection.submittedTxHash, replacementTx);
    const adminProjection = await service.getAdminPayment(
      { walletAddress: '0x9999999999999999999999999999999999999998', roles: ['AUDITOR'] },
      quote.orderId,
    );
    assert.equal(adminProjection.orderId, quote.orderId);
    assert.equal(adminProjection.submittedTxHash, replacementTx);
    assert.throws(
      () => service.getAdminPayment({ walletAddress: BUYER, roles: ['BUYER'] }, quote.orderId),
      /Platform role is required/,
    );
    await db.query("UPDATE core.payment_quotes SET state = 'REORGED' WHERE order_id = $1", [quote.orderId]);
    const reorgReplacement = `0x${'9'.repeat(64)}`;
    assert.equal((await service.submitPayment(BUYER, {
      orderId: quote.orderId,
      txHash: reorgReplacement,
      replacementForTxHash: replacementTx,
    })).state, 'SUBMITTED');
    await db.query("UPDATE core.payment_quotes SET state = 'PAID' WHERE order_id = $1", [quote.orderId]);
    assert.equal((await service.submitPayment(BUYER, {
      orderId: quote.orderId,
      txHash: reorgReplacement,
    })).state, 'SUBMITTED');
    await assert.rejects(
      service.submitPayment(BUYER, { orderId: quote.orderId, txHash: firstTx }),
      /Indexed payment transaction does not match/,
    );
  } finally {
    await db.close();
  }
});

test('business analytics uses canonical Asia Shanghai finality windows and fail-closed live projections', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db, { ...paymentIntent(), fulfillmentMode: 'PICKUP' });
    const admin = '0x3333333333333333333333333333333333333333';
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES
         ($1, 'MERCHANT', 'merchant-1', 'ACTIVE', $3),
         ($2, 'ADMIN', NULL, 'ACTIVE', $3)`,
      [MERCHANT, admin, HASH],
    );
    const now = new Date((intent.issuedAt + 120) * 1_000);
    await db.query(
      'INSERT INTO core.buyer_accounts (buyer_wallet, created_at) VALUES ($1,$2)',
      [BUYER, now],
    );
    const service = new BusinessAnalyticsService({ transactions: transactionAdapter(db), clock: () => now });
    const merchant = await service.merchantDashboard({
      walletAddress: MERCHANT,
      roles: ['MERCHANT'],
      merchantId: 'merchant-1',
    });
    assert.equal(merchant.artifactVersion, CORE_ARTIFACT_VERSION);
    assert.equal(merchant.timezone, 'Asia/Shanghai');
    assert.equal(merchant.window.start.slice(11), '16:00:00.000Z');
    assert.equal(merchant.orders.finalizedToday, '1');
    assert.equal(merchant.orders.pendingShipment, '0');
    assert.deepEqual(merchant.sales, {
      listPriceUsdt: '100',
      buyerUsdtPaid: '70',
      merchantBaseReceivableUsdt: '69',
      merchantNetReceivableUsdt: '52',
    });
    assert.deepEqual(merchant.shipmentRate, { numerator: '0', denominator: '1', bps: '0' });
    assert.equal(merchant.product?.state, 'SOLD_OUT');

    const platform = await service.adminDashboard({ walletAddress: admin, roles: ['ADMIN'] });
    assert.equal(platform.orders.finalizedToday, '1');
    assert.equal(platform.orders.listPriceUsdt, '100');
    assert.equal(platform.orders.pendingShipment, '1');
    assert.equal(platform.merchants.total, '1');
    assert.deepEqual(platform.buyers, { total: '1', newToday: '1' });
    assert.equal(platform.products.total, '1');
    assert.deepEqual(platform.risk, {
      abnormalObservationsToday: '0',
      blacklistBlocksToday: '0',
      activeRestrictions: '0',
      pendingAppeals: '0',
    });
    assert.equal(platform.unavailable.some((metric) => metric.metric === 'NEW_UID_USERS'), false);
    assert.equal(platform.unavailable.some((metric) => metric.metric === 'ABNORMAL_ORDERS'), false);
    assert.equal(platform.unavailable.some((metric) => metric.metric === 'BLACKLIST_BLOCKS'), false);
    assert.equal(platform.unavailable.find((metric) => metric.metric === 'LOW_STOCK_PRODUCTS')?.reasonCode, 'ExternalBlocked');
    assert.deepEqual(platform.breakers, [
      { scope: 'NEW_PAYMENT', paused: false },
      { scope: 'SECKILL_PURCHASE', paused: false },
      { scope: 'NEW_SETTLEMENT_BATCH', paused: false },
    ]);
    assert.equal(platform.coverage.length, 0);
    assert.equal(platform.unavailable.find((metric) => metric.metric === 'WALLET_COVERAGE')?.reasonCode, 'ExternalBlocked');

    await db.query(
      `INSERT INTO core.coverage_snapshots (
         snapshot_id, chain_id, block_number, block_hash, canonical, evidence_hash, recorded_at
       ) VALUES ('coverage:analytics:1', 56, 1000, $1, true, $2, $3)`,
      [`0x${'3'.repeat(64)}`, `0x${'4'.repeat(64)}`, now],
    );
    await db.query(
      `INSERT INTO core.coverage_snapshot_items (
         snapshot_id, wallet_address, asset, verified_asset_balance,
         unsettled_liability, coverage_met
       ) VALUES ('coverage:analytics:1', $1, 'USDT', 70, 70, true)`,
      ['0x3333333333333333333333333333333333333333'],
    );
    await db.query(
      `INSERT INTO core.coverage_snapshot_canonicality (
         observation_id, snapshot_id, canonical, observed_block_hash, evidence_hash, observed_at
       ) VALUES ('coverage-observation:analytics:true', 'coverage:analytics:1', true, $1, $2, $3)`,
      [`0x${'3'.repeat(64)}`, `0x${'4'.repeat(64)}`, now],
    );
    assert.equal((await service.adminDashboard({ walletAddress: admin, roles: ['ADMIN'] })).coverage.length, 1);
    await db.query(
      `INSERT INTO core.coverage_snapshot_canonicality (
         observation_id, snapshot_id, canonical, observed_block_hash, evidence_hash, observed_at
       ) VALUES ('coverage-observation:analytics:false', 'coverage:analytics:1', false, $1, $2, $3)`,
      [`0x${'5'.repeat(64)}`, `0x${'6'.repeat(64)}`, new Date(now.getTime() + 1_000)],
    );
    const reorgedCoverage = await service.adminDashboard({ walletAddress: admin, roles: ['ADMIN'] });
    assert.equal(reorgedCoverage.coverage.length, 0);
    assert.equal(reorgedCoverage.unavailable.find((metric) => metric.metric === 'WALLET_COVERAGE')?.reasonCode, 'ExternalBlocked');

    await db.query('UPDATE core.payment_events SET canonical = false WHERE order_id = $1', [intent.orderId]);
    const reorged = await service.merchantDashboard({
      walletAddress: MERCHANT,
      roles: ['MERCHANT'],
      merchantId: 'merchant-1',
    });
    assert.equal(reorged.orders.finalizedToday, '0');
    assert.equal(reorged.orders.pendingShipment, '0');
    assert.deepEqual(reorged.shipmentRate, { numerator: '0', denominator: '0', bps: null });
    await db.query('UPDATE core.payment_events SET canonical = true WHERE order_id = $1', [intent.orderId]);

    const malformedOrderId = `0x${'9'.repeat(64)}`;
    const malformedReservationId = 'reservation:analytics:malformed';
    const malformedTxHash = `0x${'8'.repeat(64)}`;
    const malformedBlockHash = `0x${'7'.repeat(64)}`;
    await db.query(
      `INSERT INTO core.inventory_reservations (
         reservation_id, reservation_hash, policy_version, sku_id, buyer_wallet,
         quantity, classification, state, expires_at, consumed_order_id
       ) VALUES ($1, $2, 1, 'sku-1', $3, 1, 'ORDINARY', 'CONSUMED', $4, $5)`,
      [malformedReservationId, `0x${'6'.repeat(64)}`, BUYER, new Date(now.getTime() + 60_000), malformedOrderId],
    );
    await insertOrder(db, malformedOrderId, malformedReservationId);
    await db.query(
      `UPDATE core.orders SET state = 'PAID', finality_status = 'FINAL',
         payment_tx_hash = $2, payment_block_hash = $3, paid_at = $4
       WHERE order_id = $1`,
      [malformedOrderId, malformedTxHash, malformedBlockHash, now],
    );
    await db.query(
      `INSERT INTO core.ledger_journals (
         journal_id, event_key, event_type, order_id, policy_version, content_hash,
         source_tx_hash, source_block_hash, resource_type, resource_id,
         source_reference_hash, payload, created_at
       ) VALUES ('journal:analytics:malformed', 'event:analytics:malformed',
         'PAYMENT_LOCKED', $1, 1, $2, $3, $4, 'ORDER', $1, $3, '{}', $5)`,
      [malformedOrderId, HASH, malformedTxHash, malformedBlockHash, now],
    );
    await db.query(
      `INSERT INTO core.payment_events (
         event_key, order_id, journal_id, transaction_hash, log_index, block_number,
         block_hash, snapshot_hash, classification, confirmations, canonical, observed_at
       ) VALUES ('event:analytics:malformed', $1, 'journal:analytics:malformed',
         $2, 0, 2, $3, $4, 'ORDINARY', 15, true, $5)`,
      [malformedOrderId, malformedTxHash, malformedBlockHash, HASH, now],
    );
    await db.query(
      `INSERT INTO core.transaction_finality (
         transaction_id, resource_type, resource_id, chain_id, contract_address,
         expected_event_hash, tx_hash, block_number, block_hash, confirmations,
         required_confirmations, receipt_status, state, evidence, submitted_at, finalized_at
       ) VALUES ('payment:analytics:malformed', 'ORDER_PAYMENT', $1, 56, $2,
         $3, $4, 2, $5, 15, 15, 1, 'FINAL', '{}', $6, $6)`,
      [malformedOrderId, '0x9999999999999999999999999999999999999999', HASH,
        malformedTxHash, malformedBlockHash, now],
    );
    await assert.rejects(
      service.adminDashboard({ walletAddress: admin, roles: ['ADMIN'] }),
      /exact payment snapshot is invalid/,
    );
    await db.query("UPDATE core.payment_events SET canonical = false WHERE event_key = 'event:analytics:malformed'");

    const expiredSession = (character: string) => db.query(
      `INSERT INTO core.seckill_sessions (
         session_id, policy_version, merchant_id, product_id, sku_id,
         product_policy_hash, starts_at, main_deadline, relay_deadline,
         inventory, seckill_list_price_usdt, phase, snapshot
       ) VALUES ($1, 1, 'merchant-1', 'product-1', 'sku-1', $2, $3, $4, $4, 1, 80, 'PREHEAT', '{}')`,
      [`0x${character.repeat(64)}`, HASH, new Date(now.getTime() - 3_700_000), new Date(now.getTime() - 100_000)],
    );
    await expiredSession('7');
    await expiredSession('8');
    const effectiveSessions = await service.adminDashboard({ walletAddress: admin, roles: ['ADMIN'] });
    assert.equal(effectiveSessions.seckill.active, '0');
    assert.equal(effectiveSessions.seckill.settling, '2');
    await assert.rejects(
      service.merchantDashboard({ walletAddress: MERCHANT, roles: ['MERCHANT'], merchantId: 'merchant-1' }),
      /overlapping active seckill sessions/,
    );

    await db.query(
      `UPDATE core.wallet_role_bindings SET status = 'REVOKED', revoked_at = $2
       WHERE wallet_address = $1 AND role = 'MERCHANT'`,
      [MERCHANT, now],
    );
    await assert.rejects(
      service.merchantDashboard({ walletAddress: MERCHANT, roles: ['MERCHANT'], merchantId: 'merchant-1' }),
      /Merchant dashboard scope is unavailable/,
    );
  } finally {
    await db.close();
  }
});

test('catalog management enforces product scope, signed preview, review locks and taxonomy blockers', async () => {
  const db = await createBusinessDatabase();
  const now = new Date('2026-07-15T08:00:00.000Z');
  let sequence = 16;
  const bytes32 = () => `0x${(sequence++).toString(16).padStart(64, '0')}`;
  try {
    await seedCatalog(db, 3);
    const admin = '0x3333333333333333333333333333333333333333';
    const auditor = '0x4444444444444444444444444444444444444444';
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES
         ($1, 'MERCHANT', 'merchant-1', 'ACTIVE', $4),
         ($2, 'ADMIN', NULL, 'ACTIVE', $4),
         ($3, 'AUDITOR', NULL, 'ACTIVE', $4)`,
      [MERCHANT, admin, auditor, HASH],
    );
    await db.query(
      `INSERT INTO core.merchant_stores (
         store_id, merchant_id, idempotency_key, request_hash, name, region_code,
         longitude, latitude, address, phone, status, version
       ) VALUES
       (
         'store-catalog-1', 'merchant-1', 'catalog-store-seed-1', $1,
         'Catalog Store', '110101', 116.397000, 39.908000,
         '1 Catalog Street', '01012345678', 'ACTIVE', 1
       ),
       (
         'store-catalog-empty', 'merchant-1', 'catalog-store-seed-2', $1,
         'Empty Catalog Store', '110101', 116.398000, 39.909000,
         '2 Catalog Street', '01012345679', 'ACTIVE', 1
       )`,
      [HASH],
    );
    const catalogQueries: string[] = [];
    const service = new CatalogManagementService({
      transactions: transactionAdapter(db, (sql) => catalogQueries.push(sql)),
      signer: {
        sign: async (request) => {
          assert.equal(request.purpose, 'PRODUCT_CONCESSION_PREVIEW');
          return {
            signature: `0x${'1'.repeat(130)}`,
            signer: '0x8888888888888888888888888888888888888888',
          };
        },
      },
      clock: () => now,
      bytes32,
    });
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const platform = { walletAddress: admin, roles: ['ADMIN'] as const };
    const auditActor = { walletAddress: auditor, roles: ['AUDITOR'] as const };
    const category = await service.upsertCategory(platform, {
      name: 'Gold',
      sortOrder: 1,
      idempotencyKey: 'catalog-category-create-1',
    });
    const childCategory = await service.upsertCategory(platform, {
      parentCategoryId: String(category.categoryId),
      name: 'Gold Bars',
      sortOrder: 2,
      idempotencyKey: 'catalog-category-child-create-1',
    });
    const preservedChild = await service.upsertCategory(platform, {
      categoryId: String(childCategory.categoryId),
      name: 'Gold Bars Updated',
      sortOrder: 2,
      idempotencyKey: 'catalog-category-child-preserve-1',
    });
    assert.equal(preservedChild.parentCategoryId, category.categoryId);
    assert.equal(preservedChild.level, 2);
    const rootedChild = await service.upsertCategory(platform, {
      categoryId: String(childCategory.categoryId),
      parentCategoryId: null,
      name: 'Gold Bars Updated',
      sortOrder: 2,
      idempotencyKey: 'catalog-category-child-root-1',
    });
    assert.equal(rootedChild.parentCategoryId, null);
    assert.equal(rootedChild.level, 1);
    const tag = await service.upsertTag(platform, {
      name: 'Featured',
      example: 'Featured products',
      sortOrder: 1,
      idempotencyKey: 'catalog-tag-create-1',
    });
    const fastTag = await service.upsertTag(platform, {
      name: 'Fast delivery',
      example: 'Operational delivery tag',
      sortOrder: 2,
      idempotencyKey: 'catalog-tag-create-2',
    });
    assert.throws(
      () => service.upsertCategory(platform, {
        name: 'Blocked Fee',
        sortOrder: 2,
        serviceFeeBps: 100,
        idempotencyKey: 'catalog-category-fee-1',
      }),
      /Category service fee is not frozen/,
    );

    const productInput: Parameters<CatalogManagementService['saveProductSlot']>[2] = {
      idempotencyKey: 'catalog-product-save-1',
      title: '24K Product',
      subtitle: 'Verified catalog draft',
      richDetail: { blocks: [{ type: 'paragraph', text: 'Detail' }] },
      defaultFreightUsdt: '2',
      merchantConcessionBps: 2500,
      fulfillmentModes: ['DELIVERY', 'PICKUP'],
      categoryId: String(category.categoryId),
      tagIds: [String(tag.tagId)],
      skus: [{
        attributes: { size: 'standard' },
        listPriceUsdt: '100',
        merchantBaseReceivableUsdt: '60',
        stockTotal: 10,
        proposedSeckillInventory: 3,
      }],
    };
    const draft = await service.saveProductSlot(merchant, 'store-catalog-1', productInput);
    const productId = String(draft.productId);
    const skuId = String((draft.skus as Array<{ skuId: string }>)[0]!.skuId);
    assert.equal(draft.lifecycleState, 'DRAFT');
    assert.deepEqual(draft.allowedActions, ['SAVE_DRAFT', 'CREATE_CONCESSION_PREVIEW', 'SUBMIT_REVIEW', 'DELIST']);
    assert.equal((await service.saveProductSlot(merchant, 'store-catalog-1', productInput)).productId, productId);
    const tagBatchInput = {
      productIds: [productId],
      tagIds: [String(fastTag.tagId)],
      idempotencyKey: 'catalog-product-batch-tag-1',
    };
    const tagBatch = await service.batchAddProductTags(platform, tagBatchInput);
    assert.equal(tagBatch.changedCount, 1);
    assert.deepEqual(tagBatch.products, [{
      productId,
      previousVersion: '1',
      version: '2',
      addedTagIds: [fastTag.tagId],
    }]);
    assert.deepEqual((await service.batchAddProductTags(platform, tagBatchInput)), tagBatch);
    const taggedProduct = (await service.listAdminProducts(platform)).find((product) => product.productId === productId)!;
    assert.deepEqual(taggedProduct.tagIds, [tag.tagId, fastTag.tagId].sort());
    assert.equal(taggedProduct.version, '2');
    await assert.rejects(
      service.batchAddProductTags(auditActor, {
        ...tagBatchInput,
        idempotencyKey: 'catalog-product-batch-tag-auditor',
      }),
      /Catalog write role is required/,
    );
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.audit_outbox_events WHERE event_type = 'CatalogProductsBatchTagged'",
    )).rows[0]?.count, '1');
    assert.equal(catalogQueries.some((sql) => (
      sql.includes('FROM core.merchant_stores WHERE store_id = $1 FOR UPDATE')
    )), true);
    const adminDraft = await service.getProductSlot(platform, 'store-catalog-1', 'merchant-1');
    assert.deepEqual(adminDraft.allowedActions, [
      'SAVE_DRAFT', 'CREATE_CONCESSION_PREVIEW', 'SUBMIT_REVIEW',
      'ADJUST_INVENTORY', 'HIDE', 'DELIST',
    ]);
    assert.deepEqual((await service.getProductSlot(
      auditActor,
      'store-catalog-1',
      'merchant-1',
    )).allowedActions, []);
    assert.deepEqual((await service.getProductSlot(
      auditActor,
      'store-catalog-empty',
      'merchant-1',
    )).allowedActions, []);
    assert.equal((await service.listAdminProducts(auditActor)).every((product) => (
      (product.allowedActions as string[]).length === 0
    )), true);
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.products WHERE store_id = 'store-catalog-1' AND lifecycle_state <> 'DELISTED'",
    )).rows[0]?.count, '1');
    await assert.rejects(
      service.getProductSlot(
        { walletAddress: MERCHANT, roles: ['MERCHANT'], merchantId: 'merchant-other' },
        'store-catalog-1',
      ),
      /Merchant binding is not active|outside the merchant scope/,
    );

    const uploadIntentId = `0x${'a'.repeat(64)}`;
    const imageAssetId = `0x${'b'.repeat(64)}`;
    await db.query(
      `INSERT INTO core.media_upload_intents (
         upload_intent_id, owner_wallet, purpose, resource_type, resource_id,
         object_key, content_type, size_bytes, content_sha256, idempotency_key,
         request_hash, state, expires_at, provider_reference_hash,
         provider_evidence_hash, verified_at, created_at, updated_at
       ) VALUES ($1,$2,'PRODUCT_IMAGE','PRODUCT',$3,$4,'image/webp',512,$5,$6,$5,
         'VERIFIED',$7,$8,$9,$10,$10,$10)`,
      [uploadIntentId, MERCHANT, productId, `catalog/${productId}/main.webp`, HASH,
        'catalog-product-image-1', new Date(now.getTime() + 3600_000), HASH_2,
        `0x${'3'.repeat(64)}`, now],
    );
    await db.query(
      `INSERT INTO core.media_assets (
         asset_id, upload_intent_id, owner_wallet, purpose, resource_type,
         resource_id, object_key, content_type, size_bytes, content_sha256,
         provider_evidence_hash, object_version_hash, created_at
       ) VALUES ($1,$2,$3,'PRODUCT_IMAGE','PRODUCT',$4,$5,'image/webp',512,$6,$7,$8,$9)`,
      [imageAssetId, uploadIntentId, MERCHANT, productId, `catalog/${productId}/main.webp`,
        HASH, `0x${'3'.repeat(64)}`, `0x${'4'.repeat(64)}`, now],
    );
    const saved = await service.saveProductSlot(merchant, 'store-catalog-1', {
      idempotencyKey: 'catalog-product-save-2',
      title: '24K Product',
      subtitle: 'Verified catalog draft',
      mainImageAssetIds: [imageAssetId],
      richDetail: { blocks: [{ type: 'paragraph', text: 'Detail' }] },
      defaultFreightUsdt: '2',
      merchantConcessionBps: 2500,
      fulfillmentModes: ['DELIVERY', 'PICKUP'],
      categoryId: String(category.categoryId),
      tagIds: [String(tag.tagId)],
      skus: [{
        skuId,
        attributes: { size: 'standard' },
        listPriceUsdt: '100',
        merchantBaseReceivableUsdt: '60',
        stockTotal: 10,
        proposedSeckillInventory: 3,
      }],
    });
    assert.deepEqual(saved.mainImageAssetIds, [imageAssetId]);
    const preview = await service.createConcessionPreview(merchant, productId, {
      merchantConcessionBps: 2500,
      idempotencyKey: 'catalog-concession-preview-1',
    });
    const previewPayload = preview.payload as {
      items: Array<{
        merchantConcessionAmount: string;
        merchantNetReceivableUsdt: string;
        allocations: Array<{ amount: string }>;
      }>;
    };
    assert.equal(previewPayload.items[0]?.merchantConcessionAmount, '17');
    assert.equal(previewPayload.items[0]?.merchantNetReceivableUsdt, '52');
    assert.deepEqual(previewPayload.items[0]?.allocations.map((item) => item.amount), ['7', '7', '3']);
    assert.equal((preview.authorization as { signature: string }).signature, `0x${'1'.repeat(130)}`);

    const submitted = await service.submitReview(merchant, productId, {
      previewId: String(preview.previewId),
      idempotencyKey: 'catalog-review-submit-1',
    });
    assert.equal(submitted.lifecycleState, 'REVIEW');
    assert.equal((await service.submitReview(merchant, productId, {
      previewId: String(preview.previewId),
      idempotencyKey: 'catalog-review-submit-1',
    })).lifecycleState, 'REVIEW');
    await assert.rejects(
      service.saveProductSlot(merchant, 'store-catalog-1', {
        idempotencyKey: 'catalog-product-save-locked-1',
        title: 'Locked Edit',
        mainImageAssetIds: [imageAssetId],
        richDetail: {},
        defaultFreightUsdt: '2',
        merchantConcessionBps: 2500,
        fulfillmentModes: ['DELIVERY'],
        skus: [{
          skuId,
          attributes: {},
          listPriceUsdt: '100',
          merchantBaseReceivableUsdt: '60',
          stockTotal: 10,
          proposedSeckillInventory: 3,
        }],
      }),
      /Product is locked against catalog writes/,
    );
    await publishTestPolicy(db, 2);
    await assert.rejects(
      service.decideReview(platform, productId, {
        decision: 'APPROVE',
        reasonCode: 'CATALOG_APPROVED',
        idempotencyKey: 'catalog-review-approve-stale-1',
      }),
      /Submitted concession preview no longer matches/,
    );
    assert.equal((await service.decideReview(platform, productId, {
      decision: 'REJECT',
      reasonCode: 'POLICY_CHANGED',
      idempotencyKey: 'catalog-review-reject-stale-1',
    })).lifecycleState, 'DRAFT');
    const preview2 = await service.createConcessionPreview(merchant, productId, {
      merchantConcessionBps: 2500,
      idempotencyKey: 'catalog-concession-preview-2',
    });
    await service.submitReview(merchant, productId, {
      previewId: String(preview2.previewId),
      idempotencyKey: 'catalog-review-submit-2',
    });
    assert.equal((await service.decideReview(platform, productId, {
      decision: 'APPROVE',
      reasonCode: 'CATALOG_APPROVED',
      idempotencyKey: 'catalog-review-approve-2',
    })).lifecycleState, 'SCHEDULED');
    await publishTestPolicy(db, 3);
    await assert.rejects(
      service.decideReview(platform, productId, {
        decision: 'PUBLISH',
        reasonCode: 'CATALOG_PUBLISHED',
        idempotencyKey: 'catalog-review-publish-stale-2',
      }),
      /Submitted concession preview no longer matches/,
    );
    assert.deepEqual((await service.getProductSlot(platform, 'store-catalog-1', 'merchant-1')).allowedActions, [
      'PUBLISH', 'REJECT', 'HIDE', 'DELIST',
    ]);
    assert.equal((await service.decideReview(platform, productId, {
      decision: 'REJECT',
      reasonCode: 'POLICY_CHANGED',
      idempotencyKey: 'catalog-review-reject-stale-2',
    })).lifecycleState, 'DRAFT');
    assert.deepEqual((await db.query<{ submission_hash: string | null; submission_preview_id: string | null }>(
      'SELECT submission_hash, submission_preview_id FROM core.products WHERE product_id = $1',
      [productId],
    )).rows[0], { submission_hash: null, submission_preview_id: null });
    const preview3 = await service.createConcessionPreview(merchant, productId, {
      merchantConcessionBps: 2500,
      idempotencyKey: 'catalog-concession-preview-3',
    });
    await service.submitReview(merchant, productId, {
      previewId: String(preview3.previewId),
      idempotencyKey: 'catalog-review-submit-3',
    });
    await service.decideReview(platform, productId, {
      decision: 'APPROVE',
      reasonCode: 'CATALOG_APPROVED',
      idempotencyKey: 'catalog-review-approve-3',
    });
    assert.equal((await service.decideReview(platform, productId, {
      decision: 'PUBLISH',
      reasonCode: 'CATALOG_PUBLISHED',
      idempotencyKey: 'catalog-review-publish-3',
    })).lifecycleState, 'ACTIVE');
    const publicCatalog = new CatalogPaymentService({
      transactions: transactionAdapter(db),
      signer: { sign: async () => { throw new Error('unused'); } },
      nplQuotes: { quote: async () => { throw new Error('unused'); } },
      beneficiaries: { resolve: async () => { throw new Error('unused'); } },
      policies: { assertPublished: async () => { throw new Error('unused'); } },
      bnmWallets: { assertRegistered: async () => { throw new Error('unused'); } },
      paymentRouterAddress: '0x9999999999999999999999999999999999999999',
      clock: () => now,
    });
    const publicProduct = await publicCatalog.getProduct(productId);
    assert.equal(publicProduct.subtitle, 'Verified catalog draft');
    assert.deepEqual(publicProduct.richDetail, { blocks: [{ type: 'paragraph', text: 'Detail' }] });
    assert.equal(publicProduct.defaultFreightUsdt, '2');
    assert.deepEqual(publicProduct.fulfillmentModes, ['DELIVERY', 'PICKUP']);
    assert.equal(publicProduct.categoryId, category.categoryId);
    assert.deepEqual(publicProduct.tagIds, [tag.tagId]);
    assert.equal(publicProduct.skus[0]?.seckill, null);
    const mediaRead = new EvidenceService({
      transactions: transactionAdapter(db),
      storage: {
        createUpload: async () => { throw new Error('unused'); },
        finalizeUpload: async () => { throw new Error('unused'); },
        createRead: async (input) => ({
          method: 'GET',
        readUrl: 'https://media.example.invalid/catalog-image',
        expiresAt: input.expiresAt.toISOString(),
        providerReferenceHash: HASH,
        assetId: input.assetId,
        contentSha256: input.contentSha256,
        objectVersionHash: input.objectVersionHash,
        }),
      },
      clock: () => now,
    });
    assert.equal((await mediaRead.createReadAccess(undefined, imageAssetId)).accessScope, 'PUBLIC');

    await db.query(
      `INSERT INTO core.seckill_sessions (
         session_id, policy_version, merchant_id, product_id, sku_id,
         product_policy_hash, starts_at, main_deadline, relay_deadline,
         inventory, seckill_list_price_usdt, phase, snapshot
       ) SELECT $1, 1, merchant_id, product_id, $2, product_policy_hash,
         $3, $4, $5, 3, 90, 'LIVE', '{}'
       FROM core.products WHERE product_id = $6`,
      [`0x${'c'.repeat(64)}`, skuId, new Date(now.getTime() - 60_000),
        new Date(now.getTime() + 59 * 60_000), new Date(now.getTime() + 60_000), productId],
    );
    assert.equal((await publicCatalog.getProduct(productId)).skus[0]?.seckill instanceof Object, true);
    await assert.rejects(
      service.upsertCategory(platform, {
        categoryId: String(category.categoryId),
        name: 'Gold',
        sortOrder: 1,
        status: 'DISABLED',
        idempotencyKey: 'catalog-category-disable-1',
      }),
      /contains a seckill product/,
    );
    await assert.rejects(
      service.adjustInventory(platform, skuId, {
        delta: '2',
        reasonCode: 'RESTOCK',
        idempotencyKey: 'catalog-inventory-live-1',
      }),
      /Product is locked against catalog writes/,
    );
    await db.query("UPDATE core.seckill_sessions SET phase = 'SETTLED' WHERE product_id = $1", [productId]);
    const adjustment = await service.adjustInventory(platform, skuId, {
      delta: '2',
      reasonCode: 'RESTOCK',
      idempotencyKey: 'catalog-inventory-adjust-1',
    });
    assert.deepEqual(
      { before: adjustment.beforeTotal, delta: adjustment.delta, after: adjustment.afterTotal },
      { before: '10', delta: '2', after: '12' },
    );
    await assert.rejects(
      db.query('DELETE FROM core.catalog_inventory_adjustments WHERE adjustment_id = $1', [adjustment.adjustmentId]),
      /ImmutableRecord/,
    );

    const replacement = await service.saveProductSlot(merchant, 'store-catalog-1', {
      idempotencyKey: 'catalog-product-history-replacement-1',
      title: '24K Replacement',
      richDetail: { blocks: [] },
      defaultFreightUsdt: '2',
      merchantConcessionBps: 2500,
      fulfillmentModes: ['DELIVERY'],
      categoryId: String(category.categoryId),
      tagIds: [String(tag.tagId)],
      skus: [{
        attributes: { size: 'replacement' },
        listPriceUsdt: '100',
        merchantBaseReceivableUsdt: '60',
        stockTotal: 5,
        proposedSeckillInventory: 2,
      }],
    });
    assert.notEqual(replacement.productId, productId);
    assert.equal(replacement.supersedesProductId, productId);
    assert.equal((await db.query<{ lifecycle_state: string }>(
      'SELECT lifecycle_state FROM core.products WHERE product_id = $1',
      [productId],
    )).rows[0]?.lifecycle_state, 'DELISTED');
    await assert.rejects(
      mediaRead.createReadAccess(undefined, imageAssetId),
      /Media asset is not public/,
    );
    assert.equal((await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.products
       WHERE store_id = 'store-catalog-1' AND lifecycle_state NOT IN ('HIDDEN','DELISTED')`,
    )).rows[0]?.count, '1');
    await assert.rejects(
      service.adjustInventory(platform, skuId, {
        delta: '1',
        reasonCode: 'INVALID_DELISTED_ADJUSTMENT',
        idempotencyKey: 'catalog-inventory-delisted-1',
      }),
      /Product is locked against catalog writes/,
    );
    const replacementSkuId = String((replacement.skus as Array<{ skuId: string }>)[0]!.skuId);
    await db.query(
      `INSERT INTO core.seckill_sessions (
         session_id, policy_version, merchant_id, product_id, sku_id,
         product_policy_hash, starts_at, main_deadline, relay_deadline,
         inventory, seckill_list_price_usdt, phase, snapshot
       ) SELECT $1, 3, merchant_id, product_id, $2, product_policy_hash,
         $3, $4, $5, 1, 90, 'SETTLED', '{}'
       FROM core.products WHERE product_id = $6`,
      [`0x${'7'.repeat(64)}`, replacementSkuId, new Date(now.getTime() - 3_600_000),
        new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000), replacement.productId],
    );
    await service.delistProduct(platform, String(replacement.productId), {
      reasonCode: 'EXPLICIT_HISTORY_DELIST',
      idempotencyKey: 'catalog-explicit-delist-1',
    });
    const postDelistReplacement = await service.saveProductSlot(merchant, 'store-catalog-1', {
      idempotencyKey: 'catalog-post-delist-replacement-1',
      title: '24K Post Delist Replacement',
      richDetail: { blocks: [] },
      defaultFreightUsdt: '2',
      merchantConcessionBps: 2500,
      fulfillmentModes: ['DELIVERY'],
      categoryId: String(category.categoryId),
      tagIds: [String(tag.tagId)],
      skus: [{
        attributes: { size: 'post-delist' },
        listPriceUsdt: '100',
        merchantBaseReceivableUsdt: '60',
        stockTotal: 5,
        proposedSeckillInventory: 2,
      }],
    });
    assert.equal(postDelistReplacement.supersedesProductId, replacement.productId);

    const lockedCategory = await service.upsertCategory(platform, {
      name: 'Locked Liability Category',
      sortOrder: 2,
      idempotencyKey: 'catalog-category-locked-create-1',
    });
    await db.query(
      `INSERT INTO core.product_category_assignments (
         product_id, product_version, category_id, assigned_by, assigned_at
       ) VALUES ('product-1', 1, $1, $2, $3)`,
      [lockedCategory.categoryId, admin, now],
    );
    const lockedIntent = paymentIntent();
    await reserveInventory(adapter(db), {
      reservationId: lockedIntent.reservationId,
      reservationHash: lockedIntent.reservationHash,
      policyVersion: lockedIntent.policyVersion,
      skuId: 'sku-1',
      buyerWallet: lockedIntent.buyer,
      quantity: lockedIntent.quantity,
      classification: 'ORDINARY',
      expiresAt: new Date(lockedIntent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, lockedIntent, 'catalog-locked-liability-quote-1');
    await new PostgresPaymentStore(transactionAdapter(db)).record(paymentInput(lockedIntent));
    await assert.rejects(
      service.upsertCategory(platform, {
        categoryId: String(lockedCategory.categoryId),
        name: 'Locked Liability Category',
        sortOrder: 2,
        status: 'DISABLED',
        idempotencyKey: 'catalog-category-locked-disable-1',
      }),
      /contains Locked funds/,
    );
  } finally {
    await db.close();
  }
});

test('merchant store management versions verified profiles while AMap location remains immutable', async () => {
  const db = await createBusinessDatabase();
  const now = new Date('2026-07-16T01:00:00.000Z');
  try {
    await seedCatalog(db, 3);
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES ($1,'MERCHANT','merchant-1','ACTIVE',$2)`,
      [MERCHANT, HASH],
    );
    const service = new FulfillmentTargetService({
      transactions: transactionAdapter(db),
      regions: {
        reverseGeocode: async () => ({
          regionCode: '210211',
          province: 'Liaoning',
          city: 'Dalian',
          district: 'Ganjingzi',
          formattedAddress: 'Dalian Ganjingzi Software Park 24',
          sourceReferenceHash: HASH_2,
        }),
      },
      encryptionKey: 'ab'.repeat(32),
      clock: () => now,
    });
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const created = await service.createStore(merchant, {
      idempotencyKey: 'merchant-store-create-full-1',
      name: 'Abu Dalian Store',
      phone: '+8641112345678',
      businessHours: '09:00-18:00',
      longitude: 121.53,
      latitude: 38.88,
      correlationId: 'merchant-store-create-full-1',
    });
    assert.equal(created.status, 'DRAFT');
    assert.equal(created.regionCode, '210211');
    assert.equal(created.allowedActions.find((item) => item.action === 'ACTIVATE')?.enabled, false);
    assert.equal((await service.createStore(merchant, {
      idempotencyKey: 'merchant-store-create-full-1',
      name: 'Abu Dalian Store',
      phone: '+8641112345678',
      businessHours: '09:00-18:00',
      longitude: 121.53,
      latitude: 38.88,
      correlationId: 'merchant-store-create-full-retry',
    })).storeId, created.storeId);
    assert.equal((await service.listStores()).length, 0);
    await assert.rejects(
      service.listMerchantStores({
        walletAddress: '0x9999999999999999999999999999999999999999',
        roles: ['MERCHANT'],
        merchantId: 'merchant-1',
      }),
      /scope is unavailable/,
    );

    const uploadIntentId = `0x${'d'.repeat(64)}`;
    const imageAssetId = `0x${'e'.repeat(64)}`;
    await db.query(
      `INSERT INTO core.media_upload_intents (
         upload_intent_id, owner_wallet, purpose, resource_type, resource_id,
         object_key, content_type, size_bytes, content_sha256, idempotency_key,
         request_hash, state, expires_at, provider_reference_hash,
         provider_evidence_hash, verified_at, created_at, updated_at
       ) VALUES ($1,$2,'STORE_IMAGE','STORE',$3,$4,'image/webp',512,$5,$6,$5,
         'VERIFIED',$7,$8,$9,$10,$10,$10)`,
      [
        uploadIntentId,
        MERCHANT,
        created.storeId,
        `stores/${created.storeId}/main.webp`,
        HASH,
        'merchant-store-image-full-1',
        new Date(now.getTime() + 3_600_000),
        HASH_2,
        `0x${'3'.repeat(64)}`,
        now,
      ],
    );
    await db.query(
      `INSERT INTO core.media_assets (
         asset_id, upload_intent_id, owner_wallet, purpose, resource_type,
         resource_id, object_key, content_type, size_bytes, content_sha256,
         provider_evidence_hash, object_version_hash, created_at
       ) VALUES ($1,$2,$3,'STORE_IMAGE','STORE',$4,$5,'image/webp',512,$6,$7,$8,$9)`,
      [
        imageAssetId,
        uploadIntentId,
        MERCHANT,
        created.storeId,
        `stores/${created.storeId}/main.webp`,
        HASH,
        `0x${'3'.repeat(64)}`,
        `0x${'4'.repeat(64)}`,
        now,
      ],
    );
    const updated = await service.updateStore(merchant, created.storeId, {
      name: 'Abu Dalian Flagship',
      phone: '+8641187654321',
      businessHours: '10:00-20:00',
      imageAssetIds: [imageAssetId],
      expectedVersion: 1,
      idempotencyKey: 'merchant-store-update-full-1',
      correlationId: 'merchant-store-update-full-1',
    });
    assert.equal(updated.version, 2);
    assert.deepEqual(updated.imageAssetIds, [imageAssetId]);
    assert.equal(updated.allowedActions.find((item) => item.action === 'ACTIVATE')?.enabled, true);
    await assert.rejects(
      service.updateStore(merchant, created.storeId, {
        name: 'Stale Update',
        phone: '+8641187654321',
        businessHours: '10:00-20:00',
        imageAssetIds: [imageAssetId],
        expectedVersion: 1,
        idempotencyKey: 'merchant-store-update-stale-1',
        correlationId: 'merchant-store-update-stale-1',
      }),
      /version changed/,
    );
    await assert.rejects(
      db.query(
        `UPDATE core.merchant_stores
         SET region_code = '110101', version = version + 1 WHERE store_id = $1`,
        [created.storeId],
      ),
      /ImmutableStoreLocation/,
    );

    const activated = await service.activateStore(merchant, created.storeId, {
      expectedVersion: 2,
      idempotencyKey: 'merchant-store-activate-full-1',
      correlationId: 'merchant-store-activate-full-1',
    });
    assert.equal(activated.status, 'ACTIVE');
    assert.equal(activated.version, 3);
    assert.equal((await service.listStores('210211'))[0]?.storeId, created.storeId);
    assert.equal((await service.activateStore(merchant, created.storeId, {
      expectedVersion: 2,
      idempotencyKey: 'merchant-store-activate-full-1',
      correlationId: 'merchant-store-activate-full-retry',
    })).version, 3);

    const closed = await service.closeStore(merchant, created.storeId, {
      expectedVersion: 3,
      idempotencyKey: 'merchant-store-close-full-1',
      correlationId: 'merchant-store-close-full-1',
    });
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.version, 4);
    assert.equal((await service.listStores()).length, 0);
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.merchant_store_versions WHERE store_id = $1',
      [created.storeId],
    )).rows[0]?.count, '4');
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.audit_outbox_events WHERE resource_type = 'MERCHANT_STORE'",
    )).rows[0]?.count, '4');
  } finally {
    await db.close();
  }
});

test('seckill quote locks both inventories and final classification releases the unused fallback leg', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const sessionId = `0x${'f'.repeat(64)}`;
    await insertLiveSeckillSession(db, sessionId, now, 90);
    const ids = [`0x${'8'.repeat(64)}`, `0x${'d'.repeat(64)}`, `0x${'e'.repeat(64)}`];
    let signCalls = 0;
    let bnmRegistrationChecks = 0;
    const service = new CatalogPaymentService({
      transactions: transactionAdapter(db),
      signer: {
        sign: async () => {
          signCalls += 1;
          return {
            signature: `0x${'1'.repeat(130)}`,
            signer: '0x8888888888888888888888888888888888888888',
          };
        },
      },
      nplQuotes: {
        quote: async ({ listPriceUsdt }) => ({
          nplQuoteAmount: listPriceUsdt * 10n,
          quoteSourceEvidence: { source: 'PRIMARY', observedBlock: 40_000_000, reservesHash: HASH },
        }),
      },
      beneficiaries: {
        resolve: async () => ({
          genesis: '0x0000000000000000000000000000000000000000',
          directReferral: '0x5000000000000000000000000000000000000002',
          district: '0x5000000000000000000000000000000000000003',
          city: '0x5000000000000000000000000000000000000004',
          province: '0x5000000000000000000000000000000000000005',
          region: '0x5000000000000000000000000000000000000006',
        }),
      },
      policies: { assertPublished: async () => undefined },
      bnmWallets: { assertRegistered: async () => { bnmRegistrationChecks += 1; } },
      paymentRouterAddress: '0x9999999999999999999999999999999999999999',
      clock: () => now,
      bytes32: () => ids.shift()!,
      nonce: () => 9n,
    });
    const request = {
      idempotencyKey: 'seckill-attempt-1',
      sessionId,
      productId: 'product-1',
      skuId: 'sku-1',
      quantity: 1,
      fulfillmentMode: 'DELIVERY' as const,
      fulfillmentTargetHash: HASH,
      regionCodeHash: HASH,
    };
    const quote = await service.createSeckillQuote(BUYER, request);
    assert.equal(bnmRegistrationChecks, 1);
    const seckillPrizeAmount = quote.dual.seckill.merchantConcessionAllocations
      .find((allocation) => allocation.pool === 'SECKILL_PRIZE')!.amount;
    assert.equal(quote.dual.seckill.listPriceUsdt, '90');
    assert.equal(quote.dual.fallback.listPriceUsdt, '100');
    assert.deepEqual(
      quote.approvalRequirements.map((item) => item.requiredAmount),
      ['75', '300'],
    );
    const repeated = await service.createSeckillQuote(BUYER, request);
    assert.equal(repeated.orderId, quote.orderId);
    assert.equal(repeated.dual.classificationAuthority, 'PAYMENT_ROUTER_BLOCK_TIMESTAMP');
    assert.equal(signCalls, 1);
    const reserved = await db.query<{ stock_reserved: number; session_reserved: number }>(
      `SELECT sku.stock_reserved, session.reserved AS session_reserved
       FROM core.skus sku JOIN core.seckill_sessions session ON session.sku_id = sku.sku_id`,
    );
    assert.deepEqual(reserved.rows[0], { stock_reserved: 1, session_reserved: 1 });

    const event = paymentInput(quote.dual.seckill, 'SECKILL');
    event.event.blockTimestamp = new Date(now.getTime() + 42_000);
    event.event.finalizedAt = new Date(now.getTime() + 84_000);
    const store = new PostgresPaymentStore(transactionAdapter(db));
    await store.record(event);
    const relayBeforeFinality = await db.query<{ relay_deadline: Date }>(
      'SELECT relay_deadline FROM core.seckill_sessions WHERE session_id = $1',
      [sessionId],
    );
    const relayDeadline = Math.floor(relayBeforeFinality.rows[0]!.relay_deadline.getTime() / 1000) + 30;
    await assert.rejects(
      recordSeckillRelayProjection(
        adapter(db),
        {
          number: event.event.blockNumber,
          hash: event.event.blockHash,
          parentHash: blockHash(event.event.blockNumber - 1),
          timestamp: Math.floor(event.event.blockTimestamp.getTime() / 1000),
        },
        decodedSeckillRelayEvent(sessionId, quote.orderId, event.event.blockHash, relayDeadline + 1),
      ),
      /deadline does not match the Router event/,
    );
    await recordSeckillRelayProjection(
      adapter(db),
      {
        number: event.event.blockNumber,
        hash: event.event.blockHash,
        parentHash: blockHash(event.event.blockNumber - 1),
        timestamp: Math.floor(event.event.blockTimestamp.getTime() / 1000),
      },
      decodedSeckillRelayEvent(sessionId, quote.orderId, event.event.blockHash, relayDeadline),
    );
    const relayAfterIndexing = await db.query<{ relay_deadline: Date }>(
      'SELECT relay_deadline FROM core.seckill_sessions WHERE session_id = $1',
      [sessionId],
    );
    assert.equal(
      relayAfterIndexing.rows[0]!.relay_deadline.getTime(),
      relayBeforeFinality.rows[0]!.relay_deadline.getTime() + 30_000,
    );
    await advancePaymentFinality(adapter(db), event.event.blockNumber + 14);
    const relayAfterFinality = await db.query<{ relay_deadline: Date; events: string }>(
      `SELECT session.relay_deadline,
         (SELECT count(*)::text FROM core.outbox_events
          WHERE event_type = 'SeckillRelayExtended' AND aggregate_id = session.session_id) AS events
       FROM core.seckill_sessions session WHERE session.session_id = $1`,
      [sessionId],
    );
    assert.equal(
      relayAfterFinality.rows[0]!.relay_deadline.getTime(),
      relayAfterIndexing.rows[0]!.relay_deadline.getTime(),
    );
    assert.equal(relayAfterFinality.rows[0]!.events, '1');
    const seckill = new SeckillService({
      transactions: transactionAdapter(db),
      clock: () => new Date(now.getTime() + 84_000),
    });
    const currentSession = await seckill.current();
    assert.equal(currentSession.sessionId, sessionId);
    assert.equal(currentSession.phase, 'LIVE');
    assert.equal(currentSession.timers.mainDurationSeconds, 3_600);
    assert.equal(currentSession.timers.relayInitialSeconds, 60);
    assert.equal(currentSession.timers.relayIncrementSeconds, 30);
    assert.equal(currentSession.timers.relayCapSeconds, 60);
    assert.equal(currentSession.inventory.available, '0');
    const publicEvents = await seckill.events(sessionId, { cursor: '0', limit: 20 });
    assert.equal(publicEvents.items.length, 1);
    assert.equal(publicEvents.items[0]!.eventType, 'SeckillRelayExtended');
    assert.equal(publicEvents.items[0]!.payload.relayDeadline, relayAfterFinality.rows[0]!.relay_deadline.toISOString());
    assert.equal(publicEvents.items[0]!.payload.extensionSeconds, 30);
    assert.equal(publicEvents.nextCursor, publicEvents.items[0]!.cursor);
    assert.deepEqual(await seckill.events(sessionId, { cursor: publicEvents.nextCursor }), {
      items: [],
      nextCursor: publicEvents.nextCursor,
    });
    assert.throws(() => seckill.events(sessionId, { cursor: '-1' }), /Invalid event cursor/);
    const settlementProjection = new SettlementService({ transactions: transactionAdapter(db) });
    const buyerAssets = await settlementProjection.list({ walletAddress: BUYER, roles: ['BUYER'] });
    assert.deepEqual(buyerAssets.points, [{
      pointsType: 'BNM',
      purpose: 'BNM_LIABILITY',
      state: 'LOCKED',
      amount: '90',
      transferable: false,
    }]);
    const genesisAssets = await settlementProjection.list({
      walletAddress: '0x5000000000000000000000000000000000000011',
      roles: ['BUYER'],
    });
    assert.ok(genesisAssets.balances.some((balance) =>
      balance.asset === 'NPL'
      && balance.purpose === 'REWARD_LIABILITY'
      && balance.rewardSubtype === 'GENESIS'
      && balance.state === 'LOCKED'));
    const inventory = await db.query<{
      stock_available: number;
      stock_reserved: number;
      session_reserved: number;
      sold: number;
    }>(
      `SELECT sku.stock_available, sku.stock_reserved, session.reserved AS session_reserved, session.sold
       FROM core.skus sku JOIN core.seckill_sessions session ON session.sku_id = sku.sku_id`,
    );
    assert.deepEqual(inventory.rows[0], { stock_available: 1, stock_reserved: 0, session_reserved: 0, sold: 1 });
    const projection = await service.getPayment(BUYER, quote.orderId);
    assert.ok('dual' in projection);
    assert.equal(projection.dual.classificationAuthority, 'PAYMENT_ROUTER_BLOCK_TIMESTAMP');
    assert.deepEqual(projection.finality, {
      transactionHash: event.event.transactionHash,
      replacementForTxHash: null,
      blockNumber: event.event.blockNumber,
      blockHash: event.event.blockHash,
      confirmations: 15,
      requiredConfirmations: 15,
      receiptStatus: 1,
      state: 'FINAL',
      canonicalBlock: true,
      classification: 'SECKILL',
    });
    await advancePaymentFinality(adapter(db), event.event.blockNumber + 20);
    const relayAfterReplay = await db.query<{ relay_deadline: Date; events: string }>(
      `SELECT session.relay_deadline,
         (SELECT count(*)::text FROM core.outbox_events
          WHERE event_type = 'SeckillRelayExtended' AND aggregate_id = session.session_id) AS events
       FROM core.seckill_sessions session WHERE session.session_id = $1`,
      [sessionId],
    );
    assert.equal(relayAfterReplay.rows[0]!.relay_deadline.getTime(), relayAfterFinality.rows[0]!.relay_deadline.getTime());
    assert.equal(relayAfterReplay.rows[0]!.events, '1');
    await assertLedgerBalanced(db, 1, { usdt: 68n, nplReward: 90n, bnm: 90n });
    assert.deepEqual(await purposeBalances(db, quote.orderId, 'MERCHANT_FREIGHT_RECEIVABLE'), { LOCKED: '5' });

    const fulfillment = new FulfillmentService({
      transactions: transactionAdapter(db),
      clock: () => new Date(event.event.finalizedAt!.getTime() + 60_000),
    });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const arbitrator = { walletAddress: '0x4444444444444444444444444444444444444444', roles: ['ARBITRATOR'] as const };
    await fulfillment.recordShipment(merchant, quote.orderId, {
      idempotencyKey: 'seckill-prize-shipment',
      evidenceHash: `0x${'8'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'7'.repeat(64)}`,
    });
    await fulfillment.openArbitration(buyer, quote.orderId, {
      idempotencyKey: 'seckill-prize-arbitration',
      evidenceHash: `0x${'7'.repeat(64)}`,
      reasonCode: 'SECKILL_DELIVERY_DISPUTE',
    });
    assert.deepEqual(await purposeBalances(db, quote.orderId, 'SECKILL_PRIZE_LIABILITY'), {
      DISPUTED: seckillPrizeAmount,
    });
    await fulfillment.decideArbitration(arbitrator, quote.orderId, {
      idempotencyKey: 'seckill-prize-fulfill',
      evidenceHash: `0x${'8'.repeat(64)}`,
      outcome: 'FULFILL',
      noteCode: 'PRIZE_REMAINS_LOCKED',
    });
    assert.deepEqual(await purposeBalances(db, quote.orderId, 'SECKILL_PRIZE_LIABILITY'), {
      LOCKED: seckillPrizeAmount,
    });
    assert.deepEqual(await liabilityStates(db, quote.orderId, 'AVAILABLE'), {
      BNM_POINTS: '90',
      NPL: '90',
      USDT: '62',
    });
    assert.deepEqual(await liabilityStates(db, quote.orderId, 'LOCKED'), { USDT: seckillPrizeAmount });

    const selectedEventKey = paymentEventKey(
      event.event.transactionHash,
      event.event.logIndex,
      event.event.blockHash,
    );
    const replacementBlockHash = `0x${'4'.repeat(64)}`;
    await store.reverse(selectedEventKey, replacementBlockHash);
    const relayAfterReorg = await db.query<{ relay_deadline: Date; canonical_events: string; reorg_events: string }>(
      `SELECT session.relay_deadline,
         (SELECT count(*)::text FROM core.seckill_relay_events
          WHERE session_id = session.session_id AND canonical) AS canonical_events,
         (SELECT count(*)::text FROM core.outbox_events
          WHERE event_type = 'SeckillRelayReorged' AND aggregate_id = session.session_id) AS reorg_events
       FROM core.seckill_sessions session WHERE session.session_id = $1`,
      [sessionId],
    );
    assert.equal(relayAfterReorg.rows[0]!.relay_deadline.getTime(), relayBeforeFinality.rows[0]!.relay_deadline.getTime());
    assert.equal(relayAfterReorg.rows[0]!.canonical_events, '0');
    assert.equal(relayAfterReorg.rows[0]!.reorg_events, '1');
    for (const state of ['LOCKED', 'AVAILABLE', 'DISPUTED']) {
      assert.deepEqual(await liabilityStates(db, quote.orderId, state), {});
    }
    const fallbackEvent = paymentInput(quote.dual.fallback, 'FALLBACK_RETAIL');
    fallbackEvent.event.transactionHash = `0x${'3'.repeat(64)}`;
    fallbackEvent.event.blockHash = replacementBlockHash;
    fallbackEvent.event.blockNumber += 1;
    assert.deepEqual(await store.record(fallbackEvent), {
      status: 'QUARANTINED',
      orderId: quote.orderId,
    });
    const recovery = await db.query<{ state: string; classification: string; jobs: string }>(
      `SELECT reservation.state, reservation.classification,
         (SELECT count(*)::text FROM core.durable_jobs WHERE resource_id = $1) AS jobs
       FROM core.inventory_reservations reservation
       WHERE reservation.reservation_id IN ($2, $3)
       ORDER BY reservation.classification DESC`,
      [quote.orderId, quote.dual.seckill.reservationId, quote.dual.fallback.reservationId],
    );
    assert.deepEqual(recovery.rows, [
      { state: 'CONSUMED', classification: 'SECKILL', jobs: '2' },
      { state: 'RELEASED', classification: 'FALLBACK_RETAIL', jobs: '2' },
    ]);
    await assertLedgerBalanced(db, 0, { usdt: 63n, nplReward: 90n, bnm: 90n });
  } finally {
    await db.close();
  }
});

test('seckill prize freezes the final canonical order and only the reviewed winner can settle the whole session pool', async () => {
  const db = await createBusinessDatabase();
  const admin = Wallet.createRandom();
  const secondary = Wallet.createRandom();
  try {
    await seedCatalog(db, 1);
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const sessionId = `0x${'6'.repeat(64)}`;
    await insertLiveSeckillSession(db, sessionId, now, 90);
    const ids = [`0x${'1'.repeat(64)}`, `0x${'2'.repeat(64)}`, `0x${'3'.repeat(64)}`];
    const catalog = new CatalogPaymentService({
      transactions: transactionAdapter(db),
      signer: {
        sign: async () => ({
          signature: `0x${'1'.repeat(130)}`,
          signer: '0x8888888888888888888888888888888888888888',
        }),
      },
      nplQuotes: {
        quote: async ({ listPriceUsdt }) => ({
          nplQuoteAmount: listPriceUsdt * 10n,
          quoteSourceEvidence: { source: 'PRIMARY', observedBlock: 40_000_000, reservesHash: HASH },
        }),
      },
      beneficiaries: {
        resolve: async () => ({
          genesis: '0x0000000000000000000000000000000000000000',
          directReferral: '0x5000000000000000000000000000000000000002',
          district: '0x5000000000000000000000000000000000000003',
          city: '0x5000000000000000000000000000000000000004',
          province: '0x5000000000000000000000000000000000000005',
          region: '0x5000000000000000000000000000000000000006',
        }),
      },
      policies: { assertPublished: async () => undefined },
      bnmWallets: { assertRegistered: async () => undefined },
      paymentRouterAddress: '0x9999999999999999999999999999999999999999',
      clock: () => now,
      bytes32: () => ids.shift()!,
      nonce: () => 9n,
    });
    const quote = await catalog.createSeckillQuote(BUYER, {
      idempotencyKey: 'seckill-prize-final-order',
      sessionId,
      productId: 'product-1',
      skuId: 'sku-1',
      quantity: 1,
      fulfillmentMode: 'DELIVERY',
      fulfillmentTargetHash: HASH,
      regionCodeHash: HASH,
    });
    const prizeAmount = quote.dual.seckill.merchantConcessionAllocations
      .find((allocation) => allocation.pool === 'SECKILL_PRIZE')!.amount;
    const payment = paymentInput(quote.dual.seckill, 'SECKILL');
    payment.event.blockTimestamp = new Date(now.getTime() + 42_000);
    payment.event.finalizedAt = new Date(now.getTime() + 84_000);
    await new PostgresPaymentStore(transactionAdapter(db)).record(payment);
    const initialRelay = (await db.query<{ relay_deadline: Date }>(
      'SELECT relay_deadline FROM core.seckill_sessions WHERE session_id = $1',
      [sessionId],
    )).rows[0]!.relay_deadline;
    await recordSeckillRelayProjection(
      adapter(db),
      {
        number: payment.event.blockNumber,
        hash: payment.event.blockHash,
        parentHash: blockHash(payment.event.blockNumber - 1),
        timestamp: Math.floor(payment.event.blockTimestamp.getTime() / 1000),
      },
      decodedSeckillRelayEvent(
        sessionId,
        quote.orderId,
        payment.event.blockHash,
        Math.floor(initialRelay.getTime() / 1000) + 30,
      ),
    );
    await advancePaymentFinality(adapter(db), payment.event.blockNumber + 14);
    assert.equal((await db.query<{ amount: string; pool: string }>(
      `SELECT contribution.amount_usdt::text AS amount, session.prize_pool_usdt::text AS pool
       FROM core.seckill_prize_contributions contribution
       JOIN core.seckill_sessions session ON session.session_id = contribution.session_id
       WHERE contribution.order_id = $1`,
      [quote.orderId],
    )).rows[0]?.amount, prizeAmount);

    const settlementAt = new Date(now.getTime() + 7 * 60_000);
    assert.deepEqual(await settleMaturedSeckillPrizes(adapter(db), settlementAt), [sessionId]);
    const seckill = new SeckillService({ transactions: transactionAdapter(db), clock: () => settlementAt });
    const pending = await seckill.get(sessionId);
    assert.equal(pending.winnerWallet, null);
    assert.equal(pending.prizeSettlement?.state, 'REVIEW_PENDING');
    assert.equal(pending.prizeSettlement?.candidate?.orderId, quote.orderId);
    assert.equal(pending.prizeSettlement?.candidate?.blockNumber, String(payment.event.blockNumber));
    assert.equal(pending.prizeSettlement?.candidate?.logIndex, String(payment.event.logIndex));
    assert.equal(pending.prizeSettlement?.poolAmountUsdt, prizeAmount);
    assert.equal(
      pending.prizeSettlement?.cutoffAt,
      (await db.query<{ cutoff_at: Date }>(
        'SELECT cutoff_at FROM core.seckill_prize_settlements WHERE session_id = $1',
        [sessionId],
      )).rows[0]?.cutoff_at.toISOString(),
    );

    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES ($1,'ADMIN',NULL,'ACTIVE',$2)`,
      [admin.address.toLowerCase(), HASH],
    );
    const operations = new SeckillOperationsService({
      transactions: transactionAdapter(db),
      governanceWalletAddress: '0x3333333333333333333333333333333333333333',
      operationsWalletAddress: '0x5555555555555555555555555555555555555555',
      settlementWalletAddress: '0x3333333333333333333333333333333333333333',
      paymentRouterAddress: '0x6666666666666666666666666666666666666666',
      secondarySignerAddress: secondary.address,
      clock: () => settlementAt,
    });
    const reviewInput = {
      decision: 'APPROVE' as const,
      reasonCode: 'ORDER_VALID',
      evidenceHash: HASH_2,
      idempotencyKey: 'seckill-winner-review-approve',
      correlationId: 'seckill-winner-review-approve',
    };
    const approved = await operations.reviewWinner(
      { walletAddress: admin.address, roles: ['ADMIN'] },
      sessionId,
      reviewInput,
    );
    assert.equal(approved.state, 'APPROVED');
    assert.equal(approved.candidate?.buyerWallet, BUYER);
    assert.equal(approved.review?.reviewedBy, admin.address.toLowerCase());
    assert.equal(approved.payout?.state, 'AVAILABLE');
    assert.equal((await operations.reviewWinner(
      { walletAddress: admin.address, roles: ['ADMIN'] },
      sessionId,
      reviewInput,
    )).awardJournalId, approved.awardJournalId);
    await assert.rejects(
      operations.reviewWinner(
        { walletAddress: admin.address, roles: ['ADMIN'] },
        sessionId,
        { ...reviewInput, decision: 'REJECT', idempotencyKey: 'seckill-winner-review-replace' },
      ),
      (error: unknown) => error instanceof CoreError && error.code === 'InvalidRequest',
    );

    const settlements = new SettlementService({ transactions: transactionAdapter(db), clock: () => settlementAt });
    const intent = await settlements.createIntent(
      { walletAddress: BUYER, roles: ['BUYER'] },
      { rail: 'PRIZE_USDT', amount: prizeAmount, idempotencyKey: 'seckill-prize-winner-intent' },
    );
    assert.equal(intent.intent.wallet, BUYER);
    assert.equal(intent.intent.recipient, BUYER);
    assert.equal(intent.intent.amount, prizeAmount);
    await assert.rejects(
      settlements.createIntent(
        { walletAddress: '0x7777777777777777777777777777777777777777', roles: ['BUYER'] },
        { rail: 'PRIZE_USDT', amount: prizeAmount, idempotencyKey: 'seckill-prize-nonwinner-intent' },
      ),
      (error: unknown) => error instanceof CoreError && error.code === 'FinalityPending',
    );
    const finalProjection = await seckill.get(sessionId);
    assert.equal(finalProjection.phase, 'SETTLED');
    assert.equal(finalProjection.winnerWallet, BUYER);
    assert.equal(finalProjection.prizeSettlement?.review?.reviewedBy, admin.address.toLowerCase());
    assert.equal(finalProjection.prizeSettlement?.payout?.state, 'AVAILABLE');
    assert.deepEqual(finalProjection.prizeSettlement?.payout?.transferIds, []);
    assert.deepEqual(finalProjection.prizeSettlement?.payout?.finalExecutionTxHashes, []);
  } finally {
    await db.close();
  }
});

test('empty seckill rolls its existing locked prize into the next session without creating a winner', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 2);
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const sourceSessionId = `0x${'4'.repeat(64)}`;
    const targetSessionId = `0x${'5'.repeat(64)}`;
    await insertLiveSeckillSession(db, sourceSessionId, now, 90);
    await insertLiveSeckillSession(db, targetSessionId, new Date(now.getTime() + 60 * 60_000), 90);
    const custodySafe = paymentPolicyPayload().usdtSettlementWallet;
    const safeAccountId = `safe:usdt-custody:${custodySafe}:usdt`;
    const sourceAccountId = `seckill-prize:${sourceSessionId}:usdt`;
    await db.query(
      `INSERT INTO core.ledger_accounts (
         account_id, owner_type, owner_id, asset, purpose, wallet_address
       ) VALUES
         ($1,'WALLET',$2,'USDT','WALLET_ASSET',$2),
         ($3,'BENEFICIARY',$4,'USDT','SECKILL_PRIZE_LIABILITY',NULL)`,
      [safeAccountId, custodySafe, sourceAccountId, sourceSessionId],
    );
    await db.query(
      'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [
        `journal:empty-prize:${sourceSessionId}`,
        `empty-prize:${sourceSessionId}`,
        'SECKILL_PRIZE_INJECTED',
        'SECKILL_SESSION',
        sourceSessionId,
        null,
        1,
        HASH,
        null,
        null,
        'GOVERNED_EVIDENCE',
        HASH,
        null,
        JSON.stringify({ source: 'test-injection', amountUsdt: '50' }),
        JSON.stringify([
          {
            account_id: safeAccountId,
            side: 'DEBIT',
            amount: '50',
            balance_state: 'POSTED',
            backing_wallet_address: custodySafe,
          },
          {
            account_id: sourceAccountId,
            side: 'CREDIT',
            amount: '50',
            balance_state: 'LOCKED',
            backing_wallet_address: custodySafe,
          },
        ]),
      ],
    );
    await db.query(
      'UPDATE core.seckill_sessions SET prize_pool_usdt = 50 WHERE session_id = $1',
      [sourceSessionId],
    );

    assert.deepEqual(
      await settleMaturedSeckillPrizes(adapter(db), new Date(now.getTime() + 7 * 60_000)),
      [sourceSessionId],
    );
    const sessions = await db.query<{ session_id: string; phase: string; prize_pool_usdt: string }>(
      `SELECT session_id, phase, prize_pool_usdt::text
       FROM core.seckill_sessions WHERE session_id IN ($1,$2) ORDER BY session_id`,
      [sourceSessionId, targetSessionId],
    );
    assert.deepEqual(sessions.rows, [
      { session_id: sourceSessionId, phase: 'SETTLED', prize_pool_usdt: '0' },
      { session_id: targetSessionId, phase: 'LIVE', prize_pool_usdt: '50' },
    ]);
    const outcome = await db.query<{
      state: string;
      candidate_order_id: string | null;
      rollover_target_session_id: string | null;
      rollover_journal_id: string | null;
    }>(
      `SELECT state, candidate_order_id, rollover_target_session_id, rollover_journal_id
       FROM core.seckill_prize_settlements WHERE session_id = $1`,
      [sourceSessionId],
    );
    assert.equal(outcome.rows[0]?.state, 'ROLLED_OVER');
    assert.equal(outcome.rows[0]?.candidate_order_id, null);
    assert.equal(outcome.rows[0]?.rollover_target_session_id, targetSessionId);
    assert.ok(outcome.rows[0]?.rollover_journal_id);
    assert.equal((await db.query<{ amount: string }>(
      `SELECT sum(CASE WHEN side = 'CREDIT' THEN amount ELSE -amount END)::text AS amount
       FROM core.ledger_lines WHERE account_id = $1 AND balance_state = 'LOCKED'`,
      [`seckill-prize:${targetSessionId}:usdt`],
    )).rows[0]?.amount, '50');
  } finally {
    await db.close();
  }
});

test('payment event atomically consumes inventory and posts balanced Locked journals with reorg recovery', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const intent = paymentIntent();
    const input = paymentInput(intent);
    await reserveInventory(adapter(db), {
      reservationId: intent.reservationId,
      reservationHash: intent.reservationHash,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(intent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, intent);
    const store = new PostgresPaymentStore(transactionAdapter(db));
    const recorded = await store.record(input);
    assert.equal(recorded.status, 'RECORDED');
    assert.equal((await store.record(input)).status, 'IDEMPOTENT');
    const stock = await db.query<{ stock_total: number; stock_available: number; stock_reserved: number }>(
      "SELECT stock_total, stock_available, stock_reserved FROM core.skus WHERE sku_id = 'sku-1'",
    );
    assert.deepEqual(stock.rows[0], { stock_total: 0, stock_available: 0, stock_reserved: 0 });
    await assertLedgerBalanced(db, 1);

    const replacementBlockHash = `0x${'8'.repeat(64)}`;
    const eventKey = paymentEventKey(input.event.transactionHash, 0, input.event.blockHash);
    assert.equal((await store.reverse(eventKey, replacementBlockHash)).status, 'REVERSED');
    assert.equal((await store.reverse(eventKey, replacementBlockHash)).status, 'IDEMPOTENT');
    const restored = await db.query<{ state: string; stock_total: number; stock_reserved: number }>(
      `SELECT reservation.state, sku.stock_total, sku.stock_reserved
       FROM core.inventory_reservations reservation
       JOIN core.skus sku ON sku.sku_id = reservation.sku_id
       WHERE reservation.reservation_id = $1`,
      [intent.reservationId],
    );
    assert.deepEqual(restored.rows[0], { state: 'CONSUMED', stock_total: 0, stock_reserved: 0 });
    await assertLedgerBalanced(db, 0);

    const replacement: RecordPaymentInput = {
      ...input,
      event: {
        ...input.event,
        transactionHash: `0x${'9'.repeat(64)}`,
        blockHash: replacementBlockHash,
        replacementForTxHash: input.event.transactionHash,
      },
    };
    assert.equal((await store.record(replacement)).status, 'RECORDED');
    const canonical = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.payment_events WHERE order_id = $1 AND canonical",
      [intent.orderId],
    );
    assert.equal(canonical.rows[0]?.count, '1');
    await assertLedgerBalanced(db, 1);

    await advancePaymentFinality(adapter(db), replacement.event.blockNumber + 14);
    const notifications = new NotificationService({ transactions: transactionAdapter(db) });
    const notificationWorker = new NotificationWorker({
      transactions: transactionAdapter(db),
      service: notifications,
      workerId: 'real-payment-notification-worker',
    });
    assert.ok(await notificationWorker.pollOnce() > 0);
    assert.ok((await notifications.listInbox({ walletAddress: BUYER, roles: ['BUYER'] }))
      .some((message) => message.topic === 'PAYMENT_FINALIZED'));
    const genesisInbox = await notifications.listInbox({
      walletAddress: intent.nplRewardAllocations.find((allocation) => allocation.role === 'genesis')!.account,
      roles: ['BUYER'],
    });
    const genesisPayment = genesisInbox.find((message) => message.topic === 'PAYMENT_FINALIZED');
    assert.equal(genesisPayment?.templateData.lockedNplAmount, '20');
    assert.equal(genesisPayment?.templateData.rewardSubtypes, 'GENESIS');

    await assert.rejects(
      db.query(
        `SELECT core.post_balanced_journal(
           'bad-journal','bad-event','PAYMENT_LOCKED',$1,1,$2,$3,$4,NULL,'{}',
           '[{"account_id":"safe:usdt-custody:0x3333333333333333333333333333333333333333:usdt","side":"DEBIT","amount":"1","balance_state":"POSTED"}]'
         )`,
        [intent.orderId, HASH, input.event.transactionHash, input.event.blockHash],
      ),
      /InvalidLedgerLines/,
    );
  } finally {
    await db.close();
  }
});

test('payment ledger keeps separate reward subtypes when one wallet fills multiple beneficiary roles', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const original = paymentIntent();
    const sharedBeneficiary = original.beneficiaries.directReferral!;
    const intent: CanonicalPaymentIntent = {
      ...original,
      beneficiaries: { ...original.beneficiaries, district: sharedBeneficiary },
      nplRewardAllocations: original.nplRewardAllocations.map((allocation) =>
        allocation.role === 'district' ? { ...allocation, account: sharedBeneficiary } : allocation),
    };
    await reserveInventory(adapter(db), {
      reservationId: intent.reservationId,
      reservationHash: intent.reservationHash,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(intent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, intent);
    assert.equal((await new PostgresPaymentStore(transactionAdapter(db)).record(paymentInput(intent))).status, 'RECORDED');

    const accounts = await db.query<{ subtype: string; amount: string }>(
      `SELECT account.subtype,
         sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
       FROM core.ledger_accounts account
       JOIN core.ledger_lines line ON line.account_id = account.account_id
       WHERE account.owner_type = 'BENEFICIARY' AND account.owner_id = $1
         AND account.asset = 'NPL' AND account.purpose = 'REWARD_LIABILITY'
       GROUP BY account.subtype ORDER BY account.subtype`,
      [sharedBeneficiary],
    );
    assert.deepEqual(accounts.rows, [
      { subtype: 'DIRECT_REFERRAL', amount: '10' },
      { subtype: 'DISTRICT', amount: '12' },
    ]);
    await assertLedgerBalanced(db, 1);
  } finally {
    await db.close();
  }
});

test('payment projection rejects a snapshot whose off-chain allocations differ from frozen policy', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const original = paymentIntent();
    const intent: CanonicalPaymentIntent = {
      ...original,
      merchantConcessionAllocations: [
        { pool: 'SECKILL_PRIZE', amount: '8', balanceState: 'LOCKED' },
        { pool: 'NODE_REWARD', amount: '6', balanceState: 'LOCKED' },
        { pool: 'REWARD_RESERVE', amount: '3', balanceState: 'LOCKED' },
      ],
    };
    await reserveInventory(adapter(db), {
      reservationId: intent.reservationId,
      reservationHash: intent.reservationHash,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(intent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, intent);
    const store = new PostgresPaymentStore(transactionAdapter(db));
    await assert.rejects(store.record(paymentInput(intent)), /does not match authoritative catalog and policy/);
    const journals = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM core.ledger_journals');
    assert.equal(journals.rows[0]?.count, '0');
  } finally {
    await db.close();
  }
});

test('payment projection rejects a ledger account identity bound to different wallet metadata', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const intent = paymentIntent();
    await reserveInventory(adapter(db), {
      reservationId: intent.reservationId,
      reservationHash: intent.reservationHash,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(intent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, intent);
    await db.query(
      `INSERT INTO core.ledger_accounts (
         account_id, owner_type, owner_id, asset, purpose, wallet_address
       ) VALUES ($1, 'WALLET', $2, 'USDT', 'WALLET_ASSET', $2)`,
      [
        'wallet:usdt-custody:0x3333333333333333333333333333333333333333:usdt',
        '0x9999999999999999999999999999999999999999',
      ],
    );
    const store = new PostgresPaymentStore(transactionAdapter(db));
    await assert.rejects(store.record(paymentInput(intent)), /immutable account identity/);
    const journals = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM core.ledger_journals');
    assert.equal(journals.rows[0]?.count, '0');
  } finally {
    await db.close();
  }
});

test('fulfillment targets encrypt delivery PII and bind quotes to an AMap six-digit region or active store snapshot', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 3);
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES ($1,'MERCHANT','merchant-1','ACTIVE',$2)`,
      [MERCHANT, HASH],
    );
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES ($1,'BUYER',NULL,'ACTIVE',$2)`,
      [BUYER, HASH],
    );
    let regionCalls = 0;
    const regions = {
      reverseGeocode: async () => {
        regionCalls += 1;
        return {
          regionCode: '310101',
          province: 'Shanghai',
          city: 'Shanghai',
          district: 'Huangpu',
          formattedAddress: 'Shanghai Huangpu Test Road 1',
          sourceReferenceHash: HASH_2,
        };
      },
    };
    const service = new FulfillmentTargetService({
      transactions: transactionAdapter(db),
      regions,
      encryptionKey: 'ab'.repeat(32),
      clock: () => new Date(),
    });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const store = await service.createStore(merchant, {
      idempotencyKey: 'store-create-command-1',
      name: 'Huangpu Store',
      phone: '+862112345678',
      businessHours: '09:00-18:00',
      longitude: 121.4737,
      latitude: 31.2304,
      correlationId: 'store-create-1',
    });
    assert.equal((await service.createStore(merchant, {
      idempotencyKey: 'store-create-command-1',
      name: 'Huangpu Store',
      phone: '+862112345678',
      businessHours: '09:00-18:00',
      longitude: 121.4737,
      latitude: 31.2304,
      correlationId: 'store-create-retry-1',
    })).storeId, store.storeId);
    assert.equal(regionCalls, 1);
    await db.query(
      "UPDATE core.merchant_stores SET status = 'ACTIVE', version = version + 1 WHERE store_id = $1",
      [store.storeId],
    );

    const delivery = await service.createDeliveryTarget(buyer, {
      idempotencyKey: 'delivery-target-command-1',
      recipientName: 'Test Recipient',
      phone: '+8613800000000',
      address: 'Test Road 1 Building 2 Room 3',
      longitude: 121.4737,
      latitude: 31.2304,
    });
    assert.equal((await service.createDeliveryTarget(buyer, {
      idempotencyKey: 'delivery-target-command-1',
      recipientName: 'Test Recipient',
      phone: '+8613800000000',
      address: 'Test Road 1 Building 2 Room 3',
      longitude: 121.4737,
      latitude: 31.2304,
    })).targetHash, delivery.targetHash);
    assert.equal(regionCalls, 2);
    const encrypted = await db.query<{ payload_hex: string }>(
      `SELECT encode(encrypted_payload, 'hex') AS payload_hex
       FROM core.fulfillment_targets WHERE target_hash = $1`,
      [delivery.targetHash],
    );
    assert.equal(encrypted.rows[0]?.payload_hex.includes(Buffer.from('Test Recipient').toString('hex')), false);
    assert.equal(encrypted.rows[0]?.payload_hex.includes(Buffer.from('+8613800000000').toString('hex')), false);
    await assertQuoteFulfillmentTarget(adapter(db), {
      buyerWallet: BUYER,
      fulfillmentMode: 'DELIVERY',
      fulfillmentTargetHash: delivery.targetHash,
      regionCodeHash: delivery.regionCodeHash,
      now: new Date(),
    });
    await assert.rejects(
      assertQuoteFulfillmentTarget(adapter(db), {
        buyerWallet: BUYER,
        fulfillmentMode: 'DELIVERY',
        fulfillmentTargetHash: delivery.targetHash,
        regionCodeHash: HASH,
        now: new Date(),
      }),
      /mismatched/,
    );

    const reservationId = `0x${'7'.repeat(64)}`;
    await reserveInventory(adapter(db), {
      reservationId,
      reservationHash: `0x${'8'.repeat(64)}`,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const targetOrderId = `0x${'9'.repeat(64)}`;
    await insertOrder(db, targetOrderId, reservationId, delivery.targetHash, delivery.regionCodeHash);
    const detail = await service.getOrderTarget(buyer, targetOrderId);
    assert.equal(detail.payload.recipientName, 'Test Recipient');
    assert.equal((await service.getOrderTarget(buyer, targetOrderId)).payload.phone, '+8613800000000');
    await db.query(
      `UPDATE core.wallet_role_bindings SET status = 'REVOKED', revoked_at = clock_timestamp()
       WHERE lower(wallet_address) = $1 AND role = 'BUYER'`,
      [BUYER],
    );
    await assert.rejects(service.getOrderTarget(buyer, targetOrderId), /outside the authenticated wallet scope/);
    assert.equal((await service.getOrderTarget(merchant, targetOrderId)).payload.phone, '+8613800000000');
    const platformReaders = [
      { walletAddress: '0x9000000000000000000000000000000000000001', role: 'ADMIN' },
      { walletAddress: '0x9000000000000000000000000000000000000002', role: 'OPERATOR' },
      { walletAddress: '0x9000000000000000000000000000000000000003', role: 'ARBITRATOR' },
    ] as const;
    for (const reader of platformReaders) {
      await grantRole(db, reader.walletAddress, reader.role);
      const actor = { walletAddress: reader.walletAddress, roles: [reader.role] } as never;
      assert.equal((await service.getOrderTarget(actor, targetOrderId)).payload.address, 'Test Road 1 Building 2 Room 3');
      await db.query(
        `UPDATE core.wallet_role_bindings SET status = 'REVOKED', revoked_at = clock_timestamp()
         WHERE lower(wallet_address) = $1 AND role = $2`,
        [reader.walletAddress, reader.role],
      );
      await assert.rejects(service.getOrderTarget(actor, targetOrderId), /outside the authenticated wallet scope/);
    }
    await db.query(
      `UPDATE core.wallet_role_bindings SET status = 'REVOKED', revoked_at = clock_timestamp()
       WHERE lower(wallet_address) = $1 AND role = 'MERCHANT'`,
      [MERCHANT],
    );
    await assert.rejects(service.getOrderTarget(merchant, targetOrderId), /outside the authenticated wallet scope/);
    await db.query(
      `UPDATE core.wallet_role_bindings SET status = 'ACTIVE', revoked_at = NULL
       WHERE lower(wallet_address) = $1 AND role = 'MERCHANT'`,
      [MERCHANT],
    );
    const auditRows = await db.query<{ actor_role: string; count: string }>(
      `SELECT actor_role, count(*)::text AS count
       FROM core.audit_outbox_events
       WHERE event_type = 'OrderFulfillmentTargetRead' AND resource_id = $1
       GROUP BY actor_role ORDER BY actor_role`,
      [targetOrderId],
    );
    assert.deepEqual(auditRows.rows, [
      { actor_role: 'ADMIN', count: '1' },
      { actor_role: 'ARBITRATOR', count: '1' },
      { actor_role: 'BUYER', count: '2' },
      { actor_role: 'MERCHANT', count: '1' },
      { actor_role: 'OPERATOR', count: '1' },
    ]);
    await grantRole(db, '0x9000000000000000000000000000000000000004', 'OPERATOR');
    const auditFailingTargets = new FulfillmentTargetService({
      transactions: transactionAdapter(db, (sql) => {
        if (sql.includes('INSERT INTO core.audit_outbox_events')) throw new Error('audit insert unavailable');
      }),
      regions,
      encryptionKey: 'ab'.repeat(32),
      clock: () => new Date(),
    });
    await assert.rejects(
      auditFailingTargets.getOrderTarget(
        { walletAddress: '0x9000000000000000000000000000000000000004', roles: ['OPERATOR'] },
        targetOrderId,
      ),
      /audit insert unavailable/,
    );
    const exportNow = new Date();
    const paymentTxHash = `0x${'6'.repeat(64)}`;
    await db.query(
      `UPDATE core.orders SET state = 'PAID', finality_status = 'FINAL',
         payment_tx_hash = $2, paid_at = $3, updated_at = $3 WHERE order_id = $1`,
      [targetOrderId, paymentTxHash, exportNow],
    );
    await db.query(
      `INSERT INTO core.transaction_finality (
         transaction_id, resource_type, resource_id, chain_id, contract_address,
         expected_event_hash, tx_hash, block_number, block_hash, confirmations,
         required_confirmations, receipt_status, state, evidence, submitted_at,
         finalized_at, updated_at
       ) VALUES ($1,'ORDER_PAYMENT',$2,56,$3,$4,$5,100,$6,15,15,1,'FINAL','{}',$7,$7,$7)`,
      ['merchant-export-finality-1', targetOrderId, MERCHANT, HASH, paymentTxHash, HASH_2, exportNow],
    );
    const evidence = new EvidenceService({
      transactions: transactionAdapter(db),
      trackingHashKey: 'cd'.repeat(32),
      trackingEncryptionKey: 'ab'.repeat(32),
      clock: () => exportNow,
      storage: {
        createUpload: async () => { throw new Error('unused'); },
        finalizeUpload: async () => { throw new Error('unused'); },
        createRead: async () => { throw new Error('unused'); },
      },
    });
    const tracking = await evidence.createTrackingEvidence(merchant, {
      orderId: targetOrderId,
      carrierCode: 'SF',
      trackingNumber: 'SF123456789',
      idempotencyKey: 'merchant-export-tracking-1',
    });
    await new FulfillmentService({ transactions: transactionAdapter(db), clock: () => exportNow }).recordShipment(
      merchant,
      targetOrderId,
      {
        idempotencyKey: 'merchant-export-shipment-1',
        evidenceHash: String(tracking.evidenceHash),
        carrierCode: 'SF',
        trackingNumberHash: String(tracking.trackingNumberHash),
      },
    );
    const exported = await service.exportMerchantOrders(merchant, {
      from: new Date(exportNow.getTime() - 60_000),
      to: new Date(exportNow.getTime() + 60_000),
      fulfillmentMode: 'DELIVERY',
      limit: 100,
    });
    const workbook = Buffer.from(exported.contentBase64, 'base64').toString('utf8');
    assert.equal(exported.rowCount, 1);
    assert.equal(exported.nextCursor, null);
    assert.match(workbook, /Merchant Orders/);
    for (const value of ['订单号', '支付TxHash', '收货人', '电话', '完整地址', '物流单号', 'Test Recipient', '+8613800000000', 'SF123456789']) {
      assert.equal(workbook.includes(value), true);
    }
    const storedTracking = await db.query<{ encrypted: string; payload: unknown }>(
      `SELECT encode(encrypted_tracking_number, 'hex') AS encrypted, payload
       FROM core.evidence_envelopes WHERE evidence_hash = $1`,
      [tracking.evidenceHash],
    );
    assert.equal(storedTracking.rows[0]?.encrypted.includes(Buffer.from('SF123456789').toString('hex')), false);
    assert.equal(JSON.stringify(storedTracking.rows[0]?.payload).includes('SF123456789'), false);
    const account = new AccountService({
      transactions: transactionAdapter(db),
      regions,
      parser: { parse: async () => { throw new Error('unused'); } },
      encryptionKey: 'ab'.repeat(32),
      retentionPolicyVersion: 'pii-v1',
      createDeliveryTarget: async () => { throw new Error('unused'); },
      clock: () => exportNow,
    });
    const auditInput = {
      exportId: exported.exportId,
      contentHash: exported.contentHash,
      rowCount: exported.rowCount,
      filters: exported.filters,
      idempotencyKey: 'merchant-order-export-audit-1',
      correlationId: 'merchant-order-export-correlation-1',
    };
    assert.deepEqual(await account.recordMerchantOrderExport(merchant, auditInput), { recorded: true, existing: false });
    assert.deepEqual(await account.recordMerchantOrderExport(merchant, auditInput), { recorded: true, existing: true });
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.audit_outbox_events WHERE event_type = 'MerchantOrdersExported'",
    )).rows[0]?.count, '1');
    await assert.rejects(
      service.getOrderTarget(
        { walletAddress: '0x9999999999999999999999999999999999999999', roles: ['BUYER'] },
        targetOrderId,
      ),
      /outside the authenticated wallet scope/,
    );
    await assert.rejects(
      service.exportMerchantOrders(
        { walletAddress: '0x9999999999999999999999999999999999999999', roles: ['MERCHANT'], merchantId: 'merchant-1' },
        { from: new Date(exportNow.getTime() - 60_000), to: new Date(exportNow.getTime() + 60_000) },
      ),
      /scope is unavailable/,
    );
    await assert.rejects(
      service.getOrderTarget(
        { walletAddress: '0x9999999999999999999999999999999999999999', roles: ['AUDITOR'] },
        targetOrderId,
      ),
      /outside the authenticated wallet scope/,
    );

    const pickup = await service.createPickupTarget(buyer, {
      idempotencyKey: 'pickup-target-command-1',
      storeId: store.storeId,
    });
    assert.equal(pickup.fulfillmentMode, 'PICKUP');
    assert.equal(pickup.storeId, store.storeId);
    assert.equal(pickup.store.regionCode, '310101');
    const alternateStore = await service.createStore(merchant, {
      idempotencyKey: 'store-create-command-2',
      name: 'Huangpu Alternate Store',
      phone: '+862112345679',
      businessHours: '10:00-19:00',
      longitude: 121.4837,
      latitude: 31.2404,
      correlationId: 'store-create-2',
    });
    await db.query(
      "UPDATE core.merchant_stores SET status = 'ACTIVE', version = version + 1 WHERE store_id = $1",
      [alternateStore.storeId],
    );
    for (let index = 0; index < 10; index += 1) {
      await service.createPickupTarget(buyer, {
        idempotencyKey: `pickup-target-change-${index}`,
        storeId: index % 2 === 0 ? alternateStore.storeId : store.storeId,
      });
    }
    const pickupAlert = await db.query<{ signal_type: string; source_type: string }>(
      "SELECT signal_type, source_type FROM core.risk_observations WHERE signal_type = 'PICKUP_STORE_CHANGE'",
    );
    assert.deepEqual(pickupAlert.rows, [{
      signal_type: 'PICKUP_STORE_CHANGE',
      source_type: 'FULFILLMENT_TARGET_SERVICE',
    }]);
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.risk_restrictions WHERE subject_value = $1',
      [BUYER],
    )).rows[0]?.count, '0');
    await assert.doesNotReject(assertWalletPaymentAllowed(adapter(db), BUYER, new Date()));
    assert.equal((await service.listStores('310101')).length, 2);
    assert.throws(
      () => new FulfillmentTargetService({ transactions: transactionAdapter(db), regions, encryptionKey: 'short' }),
      /must contain 32 bytes/,
    );
  } finally {
    await db.close();
  }
});

test('admin logistics versions carriers and provider references while warehouse PII stays encrypted and RBAC-scoped', async () => {
  const db = await createBusinessDatabase();
  const admin = Wallet.createRandom();
  const auditor = Wallet.createRandom();
  const outsider = Wallet.createRandom();
  const now = new Date('2026-07-16T01:00:00.000Z');
  const encryptionKey = 'e1'.repeat(32);
  try {
    await db.query(
      `INSERT INTO core.wallet_role_bindings (wallet_address, role, status, evidence_hash)
       VALUES ($1,'ADMIN','ACTIVE',$3),($2,'AUDITOR','ACTIVE',$3)`,
      [admin.address.toLowerCase(), auditor.address.toLowerCase(), HASH],
    );
    const service = new LogisticsAdminService({
      transactions: transactionAdapter(db),
      encryptionKey,
      runtimeReadiness: { KUAIDI100: 'READY', CAINIAO: 'CONFIGURATION_REQUIRED' },
      clock: () => now,
    });
    const adminActor = { walletAddress: admin.address, roles: ['ADMIN'] as const };
    const auditorActor = { walletAddress: auditor.address, roles: ['AUDITOR'] as const };
    assert.equal((await service.listCarrierConfig(adminActor)).readiness, 'CONFIGURATION_REQUIRED');
    const carrierInput = {
      carriers: [
        { carrierCode: 'SF' as const, enabled: true },
        { carrierCode: 'JD' as const, enabled: false },
        { carrierCode: 'YTO' as const, enabled: true },
        { carrierCode: 'ZTO' as const, enabled: true },
        { carrierCode: 'STO' as const, enabled: true },
        { carrierCode: 'EMS' as const, enabled: true },
      ],
      defaultCarrierCode: 'SF' as const,
      idempotencyKey: 'admin-logistics-carriers-1',
    };
    const carriers = await service.createCarrierConfigVersion(adminActor, carrierInput);
    assert.equal(carriers.version, 1);
    assert.equal(carriers.defaultCarrierCode, 'SF');
    assert.equal(carriers.carriers.find((item) => item.carrierCode === 'JD')?.enabled, false);
    assert.equal((await service.createCarrierConfigVersion(adminActor, carrierInput)).configVersionId, carriers.configVersionId);
    assert.throws(
      () => service.createCarrierConfigVersion(adminActor, {
        ...carrierInput,
        carriers: carrierInput.carriers.map((item) => ({
          ...item,
          enabled: item.carrierCode !== 'SF',
        })),
        idempotencyKey: 'admin-logistics-carriers-invalid',
      }),
      /Default logistics carrier must be enabled/,
    );

    const provider = await service.createProviderConfigVersion(adminActor, {
      provider: 'KUAIDI100',
      enabled: true,
      partnerIdSecretRef: 'secret://logistics/kuaidi100/partner-id',
      credentialSecretRef: 'vault://logistics/kuaidi100/credential',
      monthlyAccountSecretRef: 'secret://logistics/kuaidi100/monthly-account',
      callbackSecretRef: 'vault://logistics/kuaidi100/callback',
      idempotencyKey: 'admin-logistics-provider-1',
    });
    assert.equal(provider.readiness, 'READY');
    assert.equal(provider.configured, true);
    assert.equal(JSON.stringify(provider).includes('secret://'), false);
    await service.createProviderConfigVersion(adminActor, {
      provider: 'CAINIAO',
      enabled: false,
      partnerIdSecretRef: 'secret://logistics/cainiao/partner-id',
      credentialSecretRef: 'vault://logistics/cainiao/credential',
      monthlyAccountSecretRef: 'secret://logistics/cainiao/monthly-account',
      callbackSecretRef: 'vault://logistics/cainiao/callback',
      idempotencyKey: 'admin-logistics-provider-2',
    });
    const providerList = await service.listProviderConfigs(auditorActor);
    assert.equal(providerList.providers.find((item) => item.provider === 'CAINIAO')?.readiness, 'DISABLED');

    const warehouse = await service.createWarehouse(adminActor, {
      warehouseKind: 'PLATFORM',
      name: 'Dalian Platform Warehouse',
      partnerName: null,
      contactName: 'Warehouse Operator',
      phone: '+8641112345678',
      regionCode: '210211',
      addressLine: 'Dalian Ganjingzi Logistics Road 18',
      enabled: true,
      idempotencyKey: 'admin-logistics-warehouse-1',
    });
    assert.equal(warehouse.access, 'FULL');
    assert.equal(warehouse.contactName, 'Warehouse Operator');
    const encrypted = (await db.query<{ encrypted_payload: Uint8Array }>(
      'SELECT encrypted_payload FROM core.logistics_warehouse_versions WHERE warehouse_id = $1',
      [warehouse.warehouseId],
    )).rows[0]!.encrypted_payload;
    assert.equal(Buffer.from(encrypted).toString('utf8').includes('Warehouse Operator'), false);
    const redacted = (await service.listWarehouses(auditorActor)).warehouses[0]!;
    assert.equal(redacted.access, 'REDACTED');
    assert.equal(redacted.contactName, null);
    assert.equal(redacted.addressLine, null);
    const updated = await service.updateWarehouse(adminActor, warehouse.warehouseId, {
      warehouseKind: 'PLATFORM',
      name: 'Dalian Platform Warehouse A',
      partnerName: null,
      contactName: 'Warehouse Operator 2',
      phone: '+8641112345679',
      regionCode: '210211',
      addressLine: 'Dalian Ganjingzi Logistics Road 20',
      enabled: true,
      expectedVersion: 1,
      idempotencyKey: 'admin-logistics-warehouse-2',
    });
    assert.equal(updated.version, 2);
    await assert.rejects(
      service.updateWarehouse(adminActor, warehouse.warehouseId, {
        warehouseKind: 'PLATFORM', name: 'Stale Warehouse', partnerName: null,
        contactName: 'Warehouse Operator', phone: '+8641112345678', regionCode: '210211',
        addressLine: 'Dalian Ganjingzi Logistics Road 99', enabled: true,
        expectedVersion: 1, idempotencyKey: 'admin-logistics-warehouse-stale',
      }),
      /Warehouse version changed/,
    );
    const deactivated = await service.deactivateWarehouse(adminActor, warehouse.warehouseId, {
      expectedVersion: 2,
      idempotencyKey: 'admin-logistics-warehouse-3',
    });
    assert.equal(deactivated.version, 3);
    assert.equal(deactivated.enabled, false);
    await assert.rejects(
      service.listCarrierConfig({ walletAddress: outsider.address, roles: ['ADMIN'] }),
      /Current wallet role cannot manage logistics/,
    );
    await db.query(
      `UPDATE core.wallet_role_bindings SET status = 'REVOKED'
       WHERE wallet_address = $1 AND role = 'ADMIN'`,
      [admin.address.toLowerCase()],
    );
    await assert.rejects(
      service.createProviderConfigVersion(adminActor, {
        provider: 'KUAIDI100', enabled: false,
        partnerIdSecretRef: 'secret://logistics/kuaidi100/partner-id',
        credentialSecretRef: 'vault://logistics/kuaidi100/credential',
        monthlyAccountSecretRef: 'secret://logistics/kuaidi100/monthly-account',
        callbackSecretRef: 'vault://logistics/kuaidi100/callback',
        idempotencyKey: 'admin-logistics-provider-revoked',
      }),
      /Current wallet role cannot manage logistics/,
    );
    assert.equal((await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.audit_outbox_events
       WHERE resource_type IN ('LOGISTICS_CARRIER_CONFIG','LOGISTICS_PROVIDER_CONFIG','LOGISTICS_WAREHOUSE')`,
    )).rows[0]?.count, '6');
  } finally {
    await db.close();
  }
});

test('printer binding, provider waybill and durable print jobs form one merchant-scoped idempotent chain', async () => {
  const db = await createBusinessDatabase();
  const now = new Date('2026-07-16T02:00:00.000Z');
  const merchantWallet = Wallet.createRandom();
  const logisticsAdminWallet = Wallet.createRandom();
  const merchant = {
    walletAddress: merchantWallet.address,
    roles: ['MERCHANT'] as const,
    merchantId: 'merchant-1',
  };
  const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
  const encryptionKey = 'ab'.repeat(32);
  try {
    await seedCatalog(db, 5);
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES ($1,'MERCHANT','merchant-1','ACTIVE',$2)`,
      [merchantWallet.address.toLowerCase(), HASH],
    );
    await db.query(
      `INSERT INTO core.wallet_role_bindings (wallet_address, role, status, evidence_hash)
       VALUES ($1,'ADMIN','ACTIVE',$2)`,
      [logisticsAdminWallet.address.toLowerCase(), HASH],
    );
    const logisticsConfig = new LogisticsAdminService({
      transactions: transactionAdapter(db),
      encryptionKey,
      runtimeReadiness: { KUAIDI100: 'READY' },
      clock: () => now,
    });
    const logisticsAdmin = { walletAddress: logisticsAdminWallet.address, roles: ['ADMIN'] as const };
    await logisticsConfig.createCarrierConfigVersion(logisticsAdmin, {
      carriers: [
        { carrierCode: 'SF', enabled: true },
        { carrierCode: 'JD', enabled: false },
        { carrierCode: 'YTO', enabled: true },
        { carrierCode: 'ZTO', enabled: true },
        { carrierCode: 'STO', enabled: true },
        { carrierCode: 'EMS', enabled: true },
      ],
      defaultCarrierCode: 'SF',
      idempotencyKey: 'merchant-waybill-carriers-1',
    });
    await logisticsConfig.createProviderConfigVersion(logisticsAdmin, {
      provider: 'KUAIDI100', enabled: true,
      partnerIdSecretRef: 'secret://logistics/kuaidi100/partner-id',
      credentialSecretRef: 'vault://logistics/kuaidi100/credential',
      monthlyAccountSecretRef: 'secret://logistics/kuaidi100/monthly-account',
      callbackSecretRef: 'vault://logistics/kuaidi100/callback',
      idempotencyKey: 'merchant-waybill-provider-1',
    });
    const regions = {
      reverseGeocode: async () => ({
        regionCode: '210211',
        province: 'Liaoning',
        city: 'Dalian',
        district: 'Ganjingzi',
        formattedAddress: 'Dalian Test Road 1',
        sourceReferenceHash: HASH_2,
      }),
    };
    const targets = new FulfillmentTargetService({
      transactions: transactionAdapter(db),
      regions,
      encryptionKey,
      clock: () => now,
    });
    const store = await targets.createStore(merchant, {
      idempotencyKey: 'logistics-store-create-1',
      name: 'Dalian Logistics Store',
      phone: '+8641112345678',
      businessHours: '09:00-18:00',
      longitude: 121.53,
      latitude: 38.88,
      correlationId: 'logistics-store-create-1',
    });
    const unboundStore = await targets.createStore(merchant, {
      idempotencyKey: 'logistics-store-create-2',
      name: 'Unbound Pickup Store',
      phone: '+8641187654321',
      businessHours: '09:00-18:00',
      longitude: 121.54,
      latitude: 38.89,
      correlationId: 'logistics-store-create-2',
    });
    await db.query(
      "UPDATE core.merchant_stores SET status = 'ACTIVE', version = version + 1 WHERE store_id = ANY($1::text[])",
      [[store.storeId, unboundStore.storeId]],
    );
    const delivery = await targets.createDeliveryTarget(buyer, {
      idempotencyKey: 'logistics-delivery-target-1',
      recipientName: 'Delivery Recipient',
      phone: '+8613800000000',
      address: 'Dalian Delivery Road 8',
      longitude: 121.55,
      latitude: 38.90,
    });
    const reservationId = 'logistics-reservation-1';
    await reserveInventory(adapter(db), {
      reservationId,
      reservationHash: `0x${'a'.repeat(64)}`,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const orderId = `0x${'b'.repeat(64)}`;
    await insertOrder(db, orderId, reservationId, delivery.targetHash, delivery.regionCodeHash);
    await db.query(
      `UPDATE core.orders SET state = 'PAID', finality_status = 'FINAL',
         payment_tx_hash = $2, paid_at = $3 WHERE order_id = $1`,
      [orderId, `0x${'c'.repeat(64)}`, now],
    );
    await db.query(
      `INSERT INTO core.transaction_finality (
         transaction_id, resource_type, resource_id, chain_id, contract_address,
         expected_event_hash, tx_hash, block_number, block_hash, confirmations,
         required_confirmations, receipt_status, state, evidence, submitted_at, finalized_at
       ) VALUES ($1,'ORDER_PAYMENT',$2,56,$3,$4,$5,1,$4,15,15,1,'FINAL','{}',$6,$6)`,
      [
        'payment-logistics-1',
        orderId,
        '0x9999999999999999999999999999999999999999',
        HASH,
        `0x${'c'.repeat(64)}`,
        now,
      ],
    );
    const adminOrderId = `0x${'e'.repeat(64)}`;
    await reserveInventory(adapter(db), {
      reservationId: 'logistics-reservation-admin-1',
      reservationHash: `0x${'e'.repeat(64)}`,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    await insertOrder(
      db,
      adminOrderId,
      'logistics-reservation-admin-1',
      delivery.targetHash,
      delivery.regionCodeHash,
    );
    await db.query(
      `UPDATE core.orders SET state = 'PAID', finality_status = 'FINAL',
         payment_tx_hash = $2, paid_at = $3 WHERE order_id = $1`,
      [adminOrderId, `0x${'e'.repeat(64)}`, now],
    );
    await db.query(
      `INSERT INTO core.transaction_finality (
         transaction_id, resource_type, resource_id, chain_id, contract_address,
         expected_event_hash, tx_hash, block_number, block_hash, confirmations,
         required_confirmations, receipt_status, state, evidence, submitted_at, finalized_at
       ) VALUES ($1,'ORDER_PAYMENT',$2,56,$3,$4,$5,2,$4,15,15,1,'FINAL','{}',$6,$6)`,
      [
        'payment-logistics-admin-1',
        adminOrderId,
        '0x9999999999999999999999999999999999999999',
        HASH_2,
        `0x${'e'.repeat(64)}`,
        now,
      ],
    );
    const fulfillment = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
    const evidence = new EvidenceService({
      transactions: transactionAdapter(db),
      trackingHashKey: 'cd'.repeat(32),
      trackingEncryptionKey: 'ef'.repeat(32),
      clock: () => now,
      storage: {
        createUpload: async () => { throw new Error('unused'); },
        finalizeUpload: async () => { throw new Error('unused'); },
        createRead: async () => { throw new Error('unused'); },
      },
    });
    let waybillCalls = 0;
    const printed: Array<{ printJobId: string; deviceId: string; copyCount: number }> = [];
    const service = new LogisticsPrintingService({
      transactions: transactionAdapter(db),
      encryptionKey,
      verifyingContract: '0x9999999999999999999999999999999999999999',
      evidence,
      fulfillment,
      waybillAdapters: {
        KUAIDI100: {
          createWaybill: async (input) => {
            waybillCalls += 1;
            assert.equal(input.recipient.name, 'Delivery Recipient');
            assert.equal(input.sender.name, 'Dalian Logistics Store');
            return {
              providerReference: `kuaidi-task-${waybillCalls}`,
              trackingNumber: `SF10000000${waybillCalls}`,
            };
          },
        },
      },
      printAdapters: {
        YILIANYUN: {
          print: async (input) => {
            printed.push(input);
            return { providerReference: `print-${printed.length}` };
          },
        },
      },
      clock: () => now,
    });
    const pendingOrderId = `0x${'d'.repeat(64)}`;
    await reserveInventory(adapter(db), {
      reservationId: 'logistics-reservation-pending-1',
      reservationHash: `0x${'d'.repeat(64)}`,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    await insertOrder(
      db,
      pendingOrderId,
      'logistics-reservation-pending-1',
      delivery.targetHash,
      delivery.regionCodeHash,
    );
    await db.query(
      `UPDATE core.orders SET state = 'PAID', finality_status = 'PENDING', paid_at = $2 WHERE order_id = $1`,
      [pendingOrderId, now],
    );
    await assert.rejects(
      service.createWaybillBatch(merchant, {
        provider: 'KUAIDI100',
        carrierCode: 'SF',
        storeId: store.storeId,
        orderIds: [pendingOrderId],
        idempotencyKey: 'waybill-pending-finality-1',
      }),
      /15 canonical confirmations/,
    );
    assert.equal(waybillCalls, 0);
    await assert.rejects(
      service.createWaybillBatch(merchant, {
        provider: 'KUAIDI100',
        carrierCode: 'JD',
        storeId: store.storeId,
        orderIds: [orderId],
        idempotencyKey: 'waybill-disabled-carrier-1',
      }),
      /Selected logistics carrier is disabled/,
    );
    assert.equal(waybillCalls, 0);
    const challenge = await service.createPrinterBindingChallenge(merchant, store.storeId, {
      provider: 'YILIANYUN',
      deviceId: 'printer-device-001',
      idempotencyKey: 'printer-binding-challenge-1',
    });
    const serializedChallenge = JSON.parse(JSON.stringify(challenge)) as {
      typedData: { message: { nonce: string; deadline: string } };
    };
    assert.match(serializedChallenge.typedData.message.nonce, /^\d+$/);
    assert.match(serializedChallenge.typedData.message.deadline, /^\d+$/);
    const signature = await merchantWallet.signTypedData(
      challenge.typedData.domain,
      challenge.typedData.types,
      challenge.typedData.message,
    );
    const binding = await service.applyPrinterBinding(merchant, store.storeId, {
      challengeId: challenge.challengeId,
      signature,
      idempotencyKey: 'printer-binding-apply-1',
    });
    assert.equal(binding.provider, 'YILIANYUN');
    assert.equal((await service.applyPrinterBinding(merchant, store.storeId, {
      challengeId: challenge.challengeId,
      signature,
      idempotencyKey: 'printer-binding-apply-1',
    })).bindingId, binding.bindingId);

    const waybillInput = {
      provider: 'KUAIDI100' as const,
      carrierCode: 'SF' as const,
      storeId: store.storeId,
      orderIds: [orderId],
      idempotencyKey: 'waybill-batch-create-1',
    };
    const batch = await service.createWaybillBatch(merchant, waybillInput);
    assert.equal(batch.items[0]?.state, 'COMPLETED', JSON.stringify(batch.items[0]));
    assert.equal(batch.items[0]?.trackingNumber, 'SF100000001');
    assert.equal(waybillCalls, 1);
    assert.equal((await service.createWaybillBatch(merchant, waybillInput)).batchId, batch.batchId);
    assert.equal(waybillCalls, 1);
    const shipped = await db.query<{ state: string }>('SELECT state FROM core.orders WHERE order_id = $1', [orderId]);
    assert.equal(shipped.rows[0]?.state, 'SHIPPED');
    assert.equal((await service.listPrintJobs(merchant))[0]?.state, 'QUEUED');
    assert.equal((await service.dispatchNextPrintJob())?.state, 'ACCEPTED');
    assert.deepEqual(printed.map((item) => [item.deviceId, item.copyCount]), [['printer-device-001', 1]]);

    const adminBatch = await service.createAdminWaybillBatch(logisticsAdmin, {
      merchantId: 'merchant-1',
      provider: 'KUAIDI100',
      carrierCode: 'SF',
      storeId: store.storeId,
      orderIds: [adminOrderId],
      idempotencyKey: 'admin-waybill-batch-create-1',
    });
    assert.equal(adminBatch.items[0]?.state, 'COMPLETED');
    assert.equal(adminBatch.items[0]?.trackingNumber, 'SF100000002');
    assert.equal((await service.listAdminWaybills(logisticsAdmin, { merchantId: 'merchant-1' })).waybills.length, 2);
    assert.equal((await service.listAdminPrintJobs(logisticsAdmin, { merchantId: 'merchant-1' })).printJobs.length, 2);
    assert.equal((await service.dispatchNextPrintJob())?.state, 'ACCEPTED');

    const enqueuePickup = createPickupReceiptEnqueuer({ encryptionKey, clock: () => now });
    await transactionAdapter(db).transaction((executor) => enqueuePickup(executor, {
      orderId,
      merchantId: 'merchant-1',
      storeId: unboundStore.storeId,
      quantity: '1',
      fulfilledAt: now,
    }));
    const jobs = await service.listPrintJobs(merchant);
    assert.equal(jobs.find((job) => job.jobKind === 'PICKUP_RECEIPT')?.state, 'CONFIGURATION_REQUIRED');
    assert.equal(jobs.find((job) => job.jobKind === 'PICKUP_RECEIPT')?.copyCount, 2);
    const pickupJob = jobs.find((job) => job.jobKind === 'PICKUP_RECEIPT')!;
    const adminRetry = await service.retryAdminPrintJob(
      logisticsAdmin,
      pickupJob.printJobId,
      'admin-print-job-retry-1',
    );
    assert.equal(adminRetry.state, 'CONFIGURATION_REQUIRED');
    assert.equal(adminRetry.merchantId, 'merchant-1');
    assert.equal((await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.audit_outbox_events
       WHERE event_type IN ('AdminWaybillBatchCreated','AdminPrintJobRetryQueued')`,
    )).rows[0]?.count, '2');
    const ciphertext = await db.query<{ content: string }>(
      `SELECT encode(encrypted_content, 'hex') AS content FROM core.print_jobs
       WHERE job_kind = 'PICKUP_RECEIPT'`,
    );
    assert.equal(ciphertext.rows[0]?.content.includes(Buffer.from(orderId).toString('hex')), false);
  } finally {
    await db.close();
  }
});

test('order pages use stable scoped cursors and shipment batches are canonical, idempotent and atomic', async () => {
  const db = await createBusinessDatabase();
  const now = new Date('2026-07-15T10:00:00.000Z');
  const merchantAgent = '0x7777777777777777777777777777777777777777';
  try {
    await seedCatalog(db, 10);
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES
         ($1,'MERCHANT','merchant-1','ACTIVE',$4),
         ($2,'ADMIN',NULL,'ACTIVE',$4),
         ($3,'AUDITOR',NULL,'ACTIVE',$4)`,
      [
        merchantAgent,
        '0x3333333333333333333333333333333333333333',
        '0x4444444444444444444444444444444444444444',
        HASH,
      ],
    );
    const createPaidOrder = async (character: string, finalized = true) => {
      const orderId = `0x${character.repeat(64)}`;
      const reservationId = `reservation-page-${character}`;
      await reserveInventory(adapter(db), {
        reservationId,
        reservationHash: `0x${character.repeat(64)}`,
        policyVersion: 1,
        skuId: 'sku-1',
        buyerWallet: BUYER,
        quantity: 1,
        classification: 'ORDINARY',
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      await insertOrder(db, orderId, reservationId);
      await db.query(
        `UPDATE core.orders SET state = 'PAID', finality_status = $2,
           payment_tx_hash = $3, paid_at = $4, created_at = $4
         WHERE order_id = $1`,
        [orderId, finalized ? 'FINAL' : 'PENDING', `0x${character.repeat(64)}`, now],
      );
      if (finalized) {
        await db.query(
          `INSERT INTO core.transaction_finality (
             transaction_id, resource_type, resource_id, chain_id, contract_address,
             expected_event_hash, tx_hash, block_number, block_hash, confirmations,
             required_confirmations, receipt_status, state, evidence, submitted_at,
             finalized_at
           ) VALUES ($1,'ORDER_PAYMENT',$2,56,$3,$4,$5,1,$4,15,15,1,'FINAL','{}',$6,$6)`,
          [`payment-page:${character}`, orderId, '0x9999999999999999999999999999999999999999',
            HASH, `0x${character.repeat(64)}`, now],
        );
      }
      return orderId;
    };
    const orderA = await createPaidOrder('a');
    const orderB = await createPaidOrder('b');
    const fulfillmentQueries: string[] = [];
    const service = new FulfillmentService({
      transactions: transactionAdapter(db, (sql) => fulfillmentQueries.push(sql)),
      clock: () => now,
    });
    const merchant = { walletAddress: merchantAgent, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };

    const first = await service.listOrderPage(merchant, {
      limit: 1,
      state: 'PAID',
      fulfillmentMode: 'DELIVERY',
      orderKind: 'ORDINARY',
      skuId: 'sku-1',
      from: now,
      to: now,
    });
    assert.equal(first.orders[0]?.orderId, orderB);
    assert.equal(first.orders[0]?.quantity, '1');
    assert.equal(first.orders[0]?.paymentTxHash, orderB);
    assert.equal(first.orders[0]?.orderKind, 'ORDINARY');
    assert.equal(first.orders[0]?.createdAt, now.toISOString());
    assert.equal(first.orders[0]?.allowedActions.some((action) => (
      action.action === 'RECORD_SHIPMENT' && action.enabled
    )), true);
    assert.deepEqual(first.nextCursor, { createdAt: now.toISOString(), orderId: orderB });
    const second = await service.listOrderPage(merchant, {
      limit: 1,
      cursorCreatedAt: new Date(first.nextCursor!.createdAt),
      cursorOrderId: first.nextCursor!.orderId,
    });
    assert.equal(second.orders[0]?.orderId, orderA);
    assert.equal(second.nextCursor, null);
    assert.throws(
      () => service.listOrderPage(merchant, { cursorOrderId: orderA }),
      /requires createdAt and orderId together/,
    );
    assert.deepEqual((await service.listOrderPage({
      walletAddress: '0x8888888888888888888888888888888888888888',
      roles: ['MERCHANT'],
      merchantId: 'merchant-other',
    })).orders, []);
    await db.query(
      `INSERT INTO core.circuit_breakers (scope, paused, evidence_hash, policy_version, changed_by)
       VALUES ('NEW_PAYMENT', true, $1, 1, 'order-page-test')`,
      [HASH],
    );
    const platform = {
      walletAddress: '0x3333333333333333333333333333333333333333',
      roles: ['ADMIN'] as const,
    };
    const adminSearch = await service.searchAdminOrders(platform, {
      orderId: orderB,
      productId: 'product-1',
      txHash: orderB,
      wallet: BUYER,
      pendingProductReview: false,
      breakerScope: 'NEW_PAYMENT',
    });
    assert.deepEqual(adminSearch.orders.map((order) => order.orderId), [orderB]);
    assert.deepEqual(adminSearch.breaker, { scope: 'NEW_PAYMENT', active: true });
    assert.deepEqual(adminSearch.pausedScopes, ['NEW_PAYMENT']);
    const globalOperations = new AdminGlobalOperationsService({
      transactions: transactionAdapter(db),
      clock: () => now,
      bytes32: () => `0x${'d'.repeat(64)}`,
    });
    const buyerUid = (await db.query<{ uid: string }>(
      'INSERT INTO core.buyer_accounts (buyer_wallet, created_at) VALUES ($1,$2) RETURNING uid::text AS uid',
      [BUYER, now],
    )).rows[0]!.uid;
    const globalPage = await globalOperations.search(platform, { limit: 10 });
    assert.equal(globalPage.relation, 'AND');
    assert.deepEqual(new Set(globalPage.resources.map((resource) => resource.resourceType)), new Set([
      'ORDER', 'PRODUCT', 'MERCHANT',
    ]));
    assert.deepEqual((await globalOperations.search(platform, { wallet: BUYER })).resources.map((resource) => (
      resource.resourceType
    )), ['ORDER', 'ORDER']);
    const uidPage = await globalOperations.search(platform, { uid: buyerUid });
    assert.deepEqual(uidPage.resources.map((resource) => resource.resourceType), ['ORDER', 'ORDER']);
    assert.deepEqual(uidPage.unavailableFilters, ['PHONE', 'YELLOW_QUEUE']);
    assert.deepEqual((await globalOperations.search(platform, { uid: '999999999' })).resources, []);
    assert.throws(
      () => globalOperations.search(platform, { uid: '9223372036854775808' }),
      /Buyer UID is invalid/,
    );
    assert.throws(
      () => globalOperations.search(platform, { uid: buyerUid, relation: 'OR' }),
      /requires exact AND search/,
    );
    assert.deepEqual((await globalOperations.search(platform, {
      productId: 'product-1',
    })).resources.map((resource) => resource.resourceType), ['PRODUCT', 'ORDER', 'ORDER']);
    assert.deepEqual((await globalOperations.search(platform, {
      relation: 'OR',
      orderId: orderA,
      productId: 'missing-product',
    })).resources.map((resource) => [resource.resourceType, resource.resourceId]), [
      ['ORDER', orderA],
    ]);
    const fuzzyResources = await globalOperations.search(platform, {
      wallet: MERCHANT.slice(8, 20),
      walletMatch: 'FUZZY',
    });
    assert.equal(fuzzyResources.walletMatch, 'FUZZY');
    assert.deepEqual(new Set(fuzzyResources.resources.map((resource) => resource.resourceType)), new Set([
      'ORDER', 'PRODUCT', 'MERCHANT',
    ]));
    assert.throws(
      () => globalOperations.search(platform, { wallet: '12%34', walletMatch: 'FUZZY' }),
      /6-40 hexadecimal characters/,
    );
    const productResource = globalPage.resources.find((resource) => resource.resourceType === 'PRODUCT')!;
    assert.equal(productResource.allowedBatchActions.some((action) => (
      action.action === 'HIDE_PRODUCTS' && action.enabled
    )), true);
    assert.equal(productResource.allowedBatchActions.some((action) => (
      action.action === 'APPROVE_PRODUCTS' && !action.enabled
    )), true);
    await db.query("UPDATE core.products SET title = '=SUM(1,1)' WHERE product_id = 'product-1'");
    const exportInput = {
      selection: [
        { resourceType: 'ORDER' as const, resourceId: orderA },
        { resourceType: 'PRODUCT' as const, resourceId: 'product-1' },
        { resourceType: 'MERCHANT' as const, resourceId: 'merchant-1' },
      ],
      format: 'CSV' as const,
      idempotencyKey: 'admin-global-export-1',
    };
    const exported = await globalOperations.exportSelection(platform, exportInput);
    const csv = Buffer.from(String(exported.contentBase64), 'base64').toString('utf8');
    assert.equal(exported.rowCount, 3);
    assert.match(csv, /"'=SUM\(1,1\)"/);
    assert.equal(csv.includes(BUYER), false);
    assert.equal(csv.includes(MERCHANT), false);
    assert.deepEqual(await globalOperations.exportSelection(platform, exportInput), exported);
    await assert.rejects(
      globalOperations.exportSelection(platform, { ...exportInput, selection: exportInput.selection.slice(0, 1) }),
      /idempotency key was reused/,
    );
    await assert.rejects(
      globalOperations.search({
        walletAddress: '0x5555555555555555555555555555555555555555',
        roles: ['ADMIN'],
      }),
      /Active Admin resource role is required/,
    );
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.audit_outbox_events WHERE event_type = 'AdminResourcesExported'",
    )).rows[0]?.count, '1');
    await db.query(
      `INSERT INTO core.products (
         product_id, chain_product_id, merchant_id, version, title, lifecycle_state,
         product_policy_hash, merchant_concession_bps, metadata, allowed_actions,
         subtitle, main_image_asset_ids, rich_detail, default_freight_usdt, fulfillment_modes
       ) SELECT 'product-2', $1, merchant_id, version, 'Product Two', 'ACTIVE',
           product_policy_hash, merchant_concession_bps, metadata, allowed_actions,
           subtitle, main_image_asset_ids, rich_detail, default_freight_usdt, fulfillment_modes
         FROM core.products WHERE product_id = 'product-1'`,
      [`0x${'f'.repeat(64)}`],
    );
    await db.query(
      `INSERT INTO core.products (
         product_id, chain_product_id, merchant_id, version, title, lifecycle_state,
         product_policy_hash, merchant_concession_bps, metadata, allowed_actions,
         subtitle, main_image_asset_ids, rich_detail, default_freight_usdt, fulfillment_modes
       ) SELECT 'product-3', $1, merchant_id, version, 'Product Three', 'ACTIVE',
           product_policy_hash, merchant_concession_bps, metadata, allowed_actions,
           subtitle, main_image_asset_ids, rich_detail, default_freight_usdt, fulfillment_modes
         FROM core.products WHERE product_id = 'product-1'`,
      [`0x${'8'.repeat(64)}`],
    );
    await db.query(
      `INSERT INTO core.skus (
         sku_id, chain_sku_id, product_id, sku_version, attributes, list_price_usdt,
         merchant_cost_usdt, stock_total, stock_available, stock_reserved,
         lifecycle_state, proposed_seckill_inventory
       ) VALUES ('sku-2',$1,'product-2',1,'{}',100,60,10,10,0,'ACTIVE',1)`,
      [`0x${'e'.repeat(64)}`],
    );
    const catalog = new CatalogManagementService({
      transactions: transactionAdapter(db),
      signer: { sign: async () => { throw new Error('unused'); } },
      clock: () => now,
      bytes32: () => `0x${'e'.repeat(64)}`,
    });
    const lifecycleInput = {
      action: 'HIDE' as const,
      productIds: ['product-2', 'product-1'],
      reasonCode: 'OPERATIONS_HIDE',
      idempotencyKey: 'catalog-product-lifecycle-batch-1',
    };
    const lifecycleBatch = await catalog.batchProductLifecycle(platform, lifecycleInput) as {
      changedCount: number;
      products: Array<{ productId: string; state: string }>;
    };
    assert.equal(lifecycleBatch.changedCount, 2);
    assert.deepEqual(lifecycleBatch.products.map((product) => [product.productId, product.state]), [
      ['product-1', 'HIDDEN'],
      ['product-2', 'HIDDEN'],
    ]);
    assert.deepEqual(await catalog.batchProductLifecycle(platform, lifecycleInput), lifecycleBatch);
    await assert.rejects(
      catalog.batchProductLifecycle(platform, { ...lifecycleInput, action: 'DELIST' }),
      /idempotency key was reused/,
    );
    await assert.rejects(
      catalog.batchProductLifecycle({
        walletAddress: '0x4444444444444444444444444444444444444444',
        roles: ['AUDITOR'],
      }, { ...lifecycleInput, idempotencyKey: 'catalog-product-lifecycle-auditor' }),
      /Catalog write role is required/,
    );
    await db.query(
      `UPDATE core.products SET lifecycle_state = CASE product_id
         WHEN 'product-2' THEN 'REVIEW' ELSE 'ACTIVE' END
       WHERE product_id IN ('product-2','product-3')`,
    );
    await db.query(
      "UPDATE core.skus SET lifecycle_state = 'REVIEW' WHERE product_id = 'product-2'",
    );
    await assert.rejects(
      catalog.batchProductLifecycle(platform, {
        action: 'REJECT',
        productIds: ['product-2', 'product-3'],
        reasonCode: 'OPERATIONS_REJECT',
        idempotencyKey: 'catalog-product-lifecycle-rollback',
      }),
      /Cannot REJECT a ACTIVE product/,
    );
    assert.equal((await db.query<{ lifecycle_state: string }>(
      "SELECT lifecycle_state FROM core.products WHERE product_id = 'product-2'",
    )).rows[0]?.lifecycle_state, 'REVIEW');
    await db.query("UPDATE core.products SET lifecycle_state = 'REVIEW' WHERE product_id = 'product-1'");
    await db.query("UPDATE core.skus SET lifecycle_state = 'ACTIVE' WHERE sku_id = 'sku-1'");
    await assert.rejects(
      catalog.batchProductLifecycle(platform, {
        action: 'APPROVE',
        productIds: ['product-1'],
        reasonCode: 'OPERATIONS_APPROVE',
        idempotencyKey: 'catalog-product-lifecycle-locked',
      }),
      /Product is locked against catalog writes/,
    );
    assert.equal((await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.audit_outbox_events
       WHERE event_type = 'CatalogProductsLifecycleBatchApplied'`,
    )).rows[0]?.count, '1');
    const preview = await service.previewOrderBatchActions(platform, [orderA, orderB]);
    assert.deepEqual(preview.rows.map((row) => row.orderId), [orderA, orderB]);
    assert.equal(preview.enabledActionIntersection.includes('RECORD_SHIPMENT'), true);
    assert.throws(
      () => service.previewOrderBatchActions(platform, [orderA, orderA]),
      /duplicate orders/,
    );

    const evidence = new EvidenceService({
      transactions: transactionAdapter(db),
      trackingHashKey: 'ab'.repeat(32),
      trackingEncryptionKey: 'cd'.repeat(32),
      clock: () => now,
      storage: {
        createUpload: async () => { throw new Error('unused'); },
        finalizeUpload: async () => { throw new Error('unused'); },
        createRead: async () => { throw new Error('unused'); },
      },
    });
    const evidenceA = await evidence.createTrackingEvidence(merchant, {
      orderId: orderA,
      carrierCode: 'SF',
      trackingNumber: 'SF100001',
      idempotencyKey: 'page-tracking-a',
    });
    const evidenceB = await evidence.createTrackingEvidence(merchant, {
      orderId: orderB,
      carrierCode: 'JD',
      trackingNumber: 'JD100002',
      idempotencyKey: 'page-tracking-b',
    });
    const batchInput = {
      idempotencyKey: 'shipment-batch-page-1',
      items: [
        {
          orderId: orderA,
          idempotencyKey: 'shipment-item-page-a',
          evidenceHash: String(evidenceA.evidenceHash),
          carrierCode: 'SF' as const,
          trackingNumberHash: String(evidenceA.trackingNumberHash),
        },
        {
          orderId: orderB,
          idempotencyKey: 'shipment-item-page-b',
          evidenceHash: String(evidenceB.evidenceHash),
          carrierCode: 'JD' as const,
          trackingNumberHash: String(evidenceB.trackingNumberHash),
        },
      ],
    };
    fulfillmentQueries.length = 0;
    const batch = await service.recordShipmentBatch(merchant, batchInput) as {
      batchId: string;
      shipments: unknown[];
      createdAt: string;
    };
    assert.ok(
      fulfillmentQueries.findIndex((sql) => sql.includes('pg_advisory_xact_lock'))
        < fulfillmentQueries.findIndex((sql) => sql.includes('FROM core.fulfillment_shipment_batches')),
    );
    assert.ok(
      fulfillmentQueries.findLastIndex((sql) => sql.includes('pg_advisory_xact_lock'))
        < fulfillmentQueries.findIndex((sql) => sql.includes('FROM core.fulfillment_commands')),
    );
    assert.equal(batch.shipments.length, 2);
    assert.deepEqual(await service.recordShipmentBatch(merchant, batchInput), batch);
    await assert.rejects(
      service.recordShipmentBatch(merchant, { ...batchInput, items: [...batchInput.items].reverse() }),
      /Shipment batch idempotency key was reused with different input/,
    );
    assert.equal((await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.orders
       WHERE order_id IN ($1,$2) AND state = 'SHIPPED'`,
      [orderA, orderB],
    )).rows[0]?.count, '2');

    const orderE = await createPaidOrder('e');
    const evidenceE = await evidence.createTrackingEvidence(merchant, {
      orderId: orderE,
      carrierCode: 'SF',
      trackingNumber: 'SF100005',
      idempotencyKey: 'page-tracking-e',
    });
    const sharedItem = {
      orderId: orderE,
      idempotencyKey: 'shipment-item-concurrent-e',
      evidenceHash: String(evidenceE.evidenceHash),
      carrierCode: 'SF' as const,
      trackingNumberHash: String(evidenceE.trackingNumberHash),
    };
    const concurrentService = new FulfillmentService({
      transactions: concurrentTransactionAdapter(db),
      clock: () => now,
    });
    const [concurrentA, concurrentB] = await Promise.all([
      concurrentService.recordShipmentBatch(merchant, {
        idempotencyKey: 'shipment-batch-concurrent-a',
        items: [sharedItem],
      }),
      concurrentService.recordShipmentBatch(merchant, {
        idempotencyKey: 'shipment-batch-concurrent-b',
        items: [sharedItem],
      }),
    ]);
    assert.notEqual(concurrentA.batchId, concurrentB.batchId);
    assert.deepEqual(concurrentA.shipments, concurrentB.shipments);
    await assert.rejects(
      concurrentService.recordShipmentBatch(merchant, {
        idempotencyKey: 'shipment-batch-concurrent-conflict',
        items: [{ ...sharedItem, trackingNumberHash: HASH_2 }],
      }),
      /Shipment item idempotency key was reused with different input/,
    );
    assert.deepEqual((await db.query<{ commands: string; shipments: string; outbox: string }>(
      `SELECT
         (SELECT count(*)::text FROM core.fulfillment_commands WHERE order_id = $1) AS commands,
         (SELECT count(*)::text FROM core.shipments WHERE order_id = $1) AS shipments,
         (SELECT count(*)::text FROM core.outbox_events WHERE aggregate_id = $1) AS outbox`,
      [orderE],
    )).rows[0], { commands: '1', shipments: '1', outbox: '1' });

    const orderC = await createPaidOrder('c');
    const orderD = await createPaidOrder('d', false);
    const evidenceC = await evidence.createTrackingEvidence(merchant, {
      orderId: orderC,
      carrierCode: 'SF',
      trackingNumber: 'SF100003',
      idempotencyKey: 'page-tracking-c',
    });
    const evidenceD = await evidence.createTrackingEvidence(merchant, {
      orderId: orderD,
      carrierCode: 'JD',
      trackingNumber: 'JD100004',
      idempotencyKey: 'page-tracking-d',
    });
    await assert.rejects(service.recordShipmentBatch(merchant, {
      idempotencyKey: 'shipment-batch-rollback-1',
      items: [
        {
          orderId: orderC,
          idempotencyKey: 'shipment-item-page-c',
          evidenceHash: String(evidenceC.evidenceHash),
          carrierCode: 'SF',
          trackingNumberHash: String(evidenceC.trackingNumberHash),
        },
        {
          orderId: orderD,
          idempotencyKey: 'shipment-item-page-d',
          evidenceHash: String(evidenceD.evidenceHash),
          carrierCode: 'JD',
          trackingNumberHash: String(evidenceD.trackingNumberHash),
        },
      ],
    }), /Payment must reach 15 canonical confirmations/);
    assert.equal((await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.shipments WHERE order_id IN ($1,$2)`,
      [orderC, orderD],
    )).rows[0]?.count, '0');
    assert.equal((await db.query<{ state: string }>(
      'SELECT state FROM core.orders WHERE order_id = $1',
      [orderC],
    )).rows[0]?.state, 'PAID');
  } finally {
    await db.close();
  }
});

test('fulfillment service keeps evidence append-only and unlocks every order liability only after receipt', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    let now = new Date((intent.issuedAt + 60) * 1000);
    const service = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const operator = { walletAddress: '0x3333333333333333333333333333333333333333', roles: ['OPERATOR'] as const };

    const shipment = await service.recordShipment(merchant, intent.orderId, {
      idempotencyKey: 'shipment-command-1',
      evidenceHash: `0x${'3'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'4'.repeat(64)}`,
    });
    assert.equal(shipment.state, 'SHIPPED');
    assert.deepEqual(
      await service.recordShipment(merchant, intent.orderId, {
        idempotencyKey: 'shipment-command-1',
        evidenceHash: `0x${'3'.repeat(64)}`,
        carrierCode: 'SF',
        trackingNumberHash: `0x${'4'.repeat(64)}`,
      }),
      shipment,
    );
    await assert.rejects(
      service.recordShipment(merchant, intent.orderId, {
        idempotencyKey: 'shipment-command-1',
        evidenceHash: `0x${'5'.repeat(64)}`,
        carrierCode: 'SF',
        trackingNumberHash: `0x${'4'.repeat(64)}`,
      }),
      /idempotency key was reused/i,
    );

    now = new Date(now.getTime() + 30_000);
    await service.recordLogisticsUpdate(operator, intent.orderId, {
      idempotencyKey: 'logistics-transit-command-1',
      evidenceHash: `0x${'5'.repeat(64)}`,
      provider: 'KUAIDI100',
      providerEventIdHash: `0x${'a'.repeat(64)}`,
      status: 'IN_TRANSIT',
      occurredAt: now,
    });
    now = new Date(now.getTime() + 30_000);
    await service.recordLogisticsUpdate(operator, intent.orderId, {
      idempotencyKey: 'logistics-delivered-command-1',
      evidenceHash: `0x${'b'.repeat(64)}`,
      provider: 'KUAIDI100',
      providerEventIdHash: `0x${'c'.repeat(64)}`,
      status: 'DELIVERED',
      occurredAt: now,
    });
    const exchange = await service.requestExchange(buyer, intent.orderId, {
      idempotencyKey: 'exchange-request-command-1',
      evidenceHash: `0x${'d'.repeat(64)}`,
      reasonCode: 'SIZE_MISMATCH',
    });
    await service.decideFulfillmentRequest(merchant, intent.orderId, {
      idempotencyKey: 'exchange-approval-command-1',
      evidenceHash: `0x${'e'.repeat(64)}`,
      requestId: exchange.requestId,
      approved: true,
      noteCode: 'REPLACEMENT_APPROVED',
    });
    now = new Date(now.getTime() + 30_000);
    await service.recordShipment(merchant, intent.orderId, {
      idempotencyKey: 'replacement-shipment-command-1',
      evidenceHash: `0x${'f'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'1'.repeat(64)}`,
    });
    now = new Date(now.getTime() + 30_000);
    await service.recordLogisticsUpdate(operator, intent.orderId, {
      idempotencyKey: 'replacement-delivered-command-1',
      evidenceHash: `0x${'2'.repeat(64)}`,
      provider: 'KUAIDI100',
      providerEventIdHash: `0x${'3'.repeat(64)}`,
      status: 'DELIVERED',
      occurredAt: now,
    });
    await service.requestDelay(buyer, intent.orderId, {
      idempotencyKey: 'delay-request-command-1',
      evidenceHash: `0x${'6'.repeat(64)}`,
      reasonCode: 'CUSTOMER_SCHEDULE',
    });

    const lockedBeforeReceipt = await liabilityStates(db, intent.orderId, 'LOCKED');
    assert.deepEqual(lockedBeforeReceipt, { BNM_POINTS: '100', NPL: '100', USDT: '69' });
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'AVAILABLE'), {});

    now = new Date(now.getTime() + 60_000);
    const fulfilled = await service.confirmReceipt(buyer, intent.orderId, {
      idempotencyKey: 'receipt-command-1',
      evidenceHash: `0x${'7'.repeat(64)}`,
    });
    assert.deepEqual(
      { state: fulfilled.state, method: fulfilled.method },
      { state: 'FULFILLED', method: 'CUSTOMER_RECEIPT' },
    );
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'LOCKED'), { USDT: '7' });
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'AVAILABLE'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '62',
    });
    const projection = await service.getOrder(buyer, intent.orderId);
    assert.equal(projection.state, 'FULFILLED');
    assert.equal(projection.requests[0]?.state, 'RESOLVED');
    assert.deepEqual(
      projection.shipments.map((shipment) => shipment.trackingNumberHash),
      [`0x${'4'.repeat(64)}`, `0x${'1'.repeat(64)}`],
    );
    assert.deepEqual(projection.logistics.map((event) => event.status), ['IN_TRANSIT', 'DELIVERED', 'DELIVERED']);
    await assertLedgerBalanced(db, 1);
    await assert.rejects(
      db.query("UPDATE core.fulfillment_commands SET result = '{}' WHERE command_id LIKE 'command:%'"),
      /ImmutableRecord/,
    );

    const bnmStates: string[] = [];
    const bnmWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      adapter: {
        setState: async (input) => {
          bnmStates.push(input.state);
          return {
            providerReference: `bnm:${input.orderId}:${input.state}`,
            syncedAt: now.toISOString(),
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
      workerId: 'bnm-test-worker',
    });
    assert.equal(await bnmWorker.pollOnce(), 1);
    assert.deepEqual(bnmStates, ['AVAILABLE']);

    now = new Date(now.getTime() + 60_000);
    const payment = paymentInput(intent);
    await new PostgresPaymentStore(transactionAdapter(db)).reverse(
      paymentEventKey(payment.event.transactionHash, payment.event.logIndex, payment.event.blockHash),
      `0x${'9'.repeat(64)}`,
    );
    for (const state of ['LOCKED', 'AVAILABLE', 'DISPUTED']) {
      assert.deepEqual(await liabilityStates(db, intent.orderId, state), {});
    }
    assert.equal((await service.getOrder(buyer, intent.orderId)).state, 'REORG_PENDING');
    assert.equal(await bnmWorker.pollOnce(), 1);
    assert.deepEqual(bnmStates, ['AVAILABLE', 'LOCKED']);
    const bnmSync = await db.query<{ state: string }>(
      'SELECT state FROM core.bnm_state_syncs WHERE order_id = $1 ORDER BY synced_at, sync_id',
      [intent.orderId],
    );
    assert.deepEqual(bnmSync.rows.map((row) => row.state), ['AVAILABLE', 'LOCKED']);
    await assertLedgerBalanced(db, 0);
  } finally {
    await db.close();
  }
});

test('arbitration moves Locked liabilities to Disputed and only an arbitrator can resume or fulfill', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    let now = new Date((intent.issuedAt + 60) * 1000);
    const service = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const arbitrator = { walletAddress: '0x4444444444444444444444444444444444444444', roles: ['ARBITRATOR'] as const };

    await service.recordShipment(merchant, intent.orderId, {
      idempotencyKey: 'shipment-arbitration-1',
      evidenceHash: `0x${'3'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'4'.repeat(64)}`,
    });
    const exchange = await service.requestExchange(buyer, intent.orderId, {
      idempotencyKey: 'exchange-before-arbitration',
      evidenceHash: `0x${'4'.repeat(64)}`,
      reasonCode: 'SIZE_MISMATCH',
    });
    await service.openArbitration(buyer, intent.orderId, {
      idempotencyKey: 'open-arbitration-1',
      evidenceHash: `0x${'5'.repeat(64)}`,
      reasonCode: 'DELIVERY_DISPUTE',
    });
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'LOCKED'), {});
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'DISPUTED'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '69',
    });
    await assert.rejects(
      service.decideFulfillmentRequest(merchant, intent.orderId, {
        idempotencyKey: 'exchange-decision-during-arbitration',
        evidenceHash: `0x${'5'.repeat(64)}`,
        requestId: exchange.requestId,
        approved: true,
        noteCode: 'INVALID_DURING_ARBITRATION',
      }),
      /current order state/,
    );
    await assert.rejects(
      service.decideArbitration(buyer, intent.orderId, {
        idempotencyKey: 'bad-arbitration-decision',
        evidenceHash: `0x${'6'.repeat(64)}`,
        outcome: 'FULFILL',
        noteCode: 'BUYER_CANNOT_DECIDE',
      }),
      /role is required/,
    );

    await service.decideArbitration(arbitrator, intent.orderId, {
      idempotencyKey: 'resume-arbitration-1',
      evidenceHash: `0x${'6'.repeat(64)}`,
      outcome: 'RESUME_FULFILLMENT',
      noteCode: 'CONTINUE_DELIVERY',
    });
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'DISPUTED'), {});
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'LOCKED'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '69',
    });

    now = new Date(now.getTime() + 60_000);
    await service.openArbitration(buyer, intent.orderId, {
      idempotencyKey: 'open-arbitration-2',
      evidenceHash: `0x${'7'.repeat(64)}`,
      reasonCode: 'DELIVERY_DISPUTE',
    });
    await service.decideArbitration(arbitrator, intent.orderId, {
      idempotencyKey: 'fulfill-arbitration-2',
      evidenceHash: `0x${'8'.repeat(64)}`,
      outcome: 'FULFILL',
      noteCode: 'PLATFORM_FULFILLED',
    });
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'AVAILABLE'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '62',
    });
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'LOCKED'), { USDT: '7' });
    await assertLedgerBalanced(db, 1);
  } finally {
    await db.close();
  }
});

test('merchant forced receipt remains a platform-reviewed request until seven days after delivery', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    let now = new Date((intent.issuedAt + 60) * 1000);
    const service = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const operator = { walletAddress: '0x3333333333333333333333333333333333333333', roles: ['OPERATOR'] as const };
    await service.recordShipment(merchant, intent.orderId, {
      idempotencyKey: 'forced-shipment-command-1',
      evidenceHash: `0x${'3'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'4'.repeat(64)}`,
    });
    await service.recordDelivery(operator, intent.orderId, {
      idempotencyKey: 'forced-delivery-command-1',
      evidenceHash: `0x${'5'.repeat(64)}`,
    });
    await assert.rejects(
      service.requestForcedReceipt(merchant, intent.orderId, {
        idempotencyKey: 'forced-too-early-command-1',
        evidenceHash: `0x${'6'.repeat(64)}`,
        reasonCode: 'CUSTOMER_NO_RESPONSE',
      }),
      /not eligible/,
    );
    now = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
    const request = await service.requestForcedReceipt(merchant, intent.orderId, {
      idempotencyKey: 'forced-request-command-1',
      evidenceHash: `0x${'6'.repeat(64)}`,
      reasonCode: 'CUSTOMER_NO_RESPONSE',
    });
    assert.equal(request.canFinalizeDirectly, false);
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'LOCKED'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '69',
    });
    await service.decideForcedReceipt(operator, intent.orderId, {
      idempotencyKey: 'forced-approval-command-1',
      evidenceHash: `0x${'7'.repeat(64)}`,
      approved: true,
      noteCode: 'DELIVERY_EVIDENCE_VALID',
    });
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'AVAILABLE'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '62',
    });
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'LOCKED'), { USDT: '7' });
    const requests = await db.query<{ state: string; resolved_by: string }>(
      `SELECT state, resolved_by FROM core.fulfillment_requests
       WHERE order_id = $1 AND request_type = 'FORCED_RECEIPT'`,
      [intent.orderId],
    );
    assert.deepEqual(requests.rows[0], { state: 'APPROVED', resolved_by: operator.walletAddress });
  } finally {
    await db.close();
  }
});

test('takeover freezes the merchant after seven days while funds stay Locked and pickup verification is one-use', async () => {
  const deliveryDb = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(deliveryDb);
    const now = new Date((intent.issuedAt + 8 * 24 * 60 * 60) * 1000);
    const service = new FulfillmentService({ transactions: transactionAdapter(deliveryDb), clock: () => now });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const operator = { walletAddress: '0x3333333333333333333333333333333333333333', roles: ['OPERATOR'] as const };
    const takeover = await service.openTakeover(buyer, intent.orderId, {
      idempotencyKey: 'takeover-command-1',
      evidenceHash: `0x${'3'.repeat(64)}`,
      reasonCode: 'NO_SHIPMENT_SEVEN_DAYS',
    });
    assert.equal(takeover.customerFundsRemainLocked, true);
    assert.deepEqual(await liabilityStates(deliveryDb, intent.orderId, 'LOCKED'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '69',
    });
    const frozen = await deliveryDb.query<{ status: string; guarantee_status: string; lifecycle_state: string }>(
      `SELECT merchant.status, merchant.guarantee_status, product.lifecycle_state
       FROM core.merchants merchant JOIN core.products product ON product.merchant_id = merchant.merchant_id`,
    );
    assert.deepEqual(frozen.rows[0], { status: 'SUSPENDED', guarantee_status: 'FROZEN', lifecycle_state: 'LOCKED' });
    const funding = await deliveryDb.query<{ required_usdt: string | null }>(
      'SELECT required_usdt::text FROM core.takeover_cases WHERE order_id = $1',
      [intent.orderId],
    );
    assert.equal(funding.rows[0]?.required_usdt, null);
    await service.recordShipment(operator, intent.orderId, {
      idempotencyKey: 'takeover-shipment-command-1',
      evidenceHash: `0x${'4'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'5'.repeat(64)}`,
    });
    await service.recordDelivery(operator, intent.orderId, {
      idempotencyKey: 'takeover-delivery-command-1',
      evidenceHash: `0x${'6'.repeat(64)}`,
    });
    await service.confirmReceipt(buyer, intent.orderId, {
      idempotencyKey: 'takeover-receipt-command-1',
      evidenceHash: `0x${'7'.repeat(64)}`,
    });
    const closed = await deliveryDb.query<{ state: string }>(
      'SELECT state FROM core.takeover_cases WHERE order_id = $1',
      [intent.orderId],
    );
    assert.equal(closed.rows[0]?.state, 'CLOSED');
    assert.deepEqual(await liabilityStates(deliveryDb, intent.orderId, 'AVAILABLE'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '62',
    });
    assert.deepEqual(await liabilityStates(deliveryDb, intent.orderId, 'LOCKED'), { USDT: '7' });
  } finally {
    await deliveryDb.close();
  }

  const pickupDb = await createBusinessDatabase();
  try {
    const intent = paymentIntent();
    intent.fulfillmentMode = 'PICKUP';
    intent.fulfillmentTargetHash = `0x${'8'.repeat(64)}`;
    await recordFinalPayment(pickupDb, intent);
    await pickupDb.exec(`
      INSERT INTO core.administrative_regions (
        region_code, province, city, district, source, source_reference_hash, status
      ) VALUES ('110101','Beijing','Beijing','Dongcheng','GOVERNED_IMPORT','${HASH}','ACTIVE')
      ON CONFLICT (region_code) DO NOTHING;
      INSERT INTO core.merchant_stores (
        store_id, merchant_id, idempotency_key, request_hash, name, region_code,
        longitude, latitude, address, phone, status, version
      ) VALUES (
        'store-pickup-1','merchant-1','pickup-store-fixture','${HASH_2}',
        'Pickup Store','110101',116.397,39.908,'Pickup Store Address','01012345678','ACTIVE',1
      ), (
        'store-pickup-2','merchant-1','pickup-store-other','${HASH_2}',
        'Other Store','110101',116.398,39.909,'Other Store Address','01012345679','ACTIVE',1
      );
      INSERT INTO core.fulfillment_targets (
        target_id, target_hash, buyer_wallet, idempotency_key, request_hash,
        fulfillment_mode, region_code, region_code_hash, store_id,
        encrypted_payload, encryption_iv, encryption_tag, expires_at, created_at
      ) VALUES (
        'target-pickup-1','${intent.fulfillmentTargetHash}','${BUYER}','pickup-target-fixture','${HASH_2}',
        'PICKUP','110101','${HASH}','store-pickup-1',
        decode(repeat('00',32),'hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),
        clock_timestamp() + interval '1 day',clock_timestamp()
      );
    `);
    let now = new Date((intent.issuedAt + 60) * 1000);
    const pickupReceipts: Array<{ orderId: string; storeId: string; quantity: string }> = [];
    const service = new FulfillmentService({
      transactions: transactionAdapter(pickupDb),
      clock: () => now,
      enqueuePickupReceipt: async (_executor, receipt) => {
        pickupReceipts.push(receipt);
      },
    });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    await service.registerPickupCredential(buyer, intent.orderId, {
      idempotencyKey: 'pickup-credential-1',
      evidenceHash: `0x${'3'.repeat(64)}`,
      code: '123456',
      expiresAt: new Date(now.getTime() + 1_000),
    });
    now = new Date(now.getTime() + 2_000);
    await service.registerPickupCredential(buyer, intent.orderId, {
      idempotencyKey: 'pickup-credential-2',
      evidenceHash: `0x${'8'.repeat(64)}`,
      code: '234567',
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    const credentials = await pickupDb.query<{ consumed_at: Date | null; invalidated_at: Date | null }>(
      `SELECT consumed_at, invalidated_at FROM core.pickup_credentials
       WHERE order_id = $1 ORDER BY created_at, credential_id`,
      [intent.orderId],
    );
    assert.equal(credentials.rows[0]?.consumed_at, null);
    assert.ok(credentials.rows[0]?.invalidated_at);
    assert.equal(credentials.rows[1]?.invalidated_at, null);
    const failedAttempts = [
      { idempotencyKey: 'pickup-wrong-store-1', code: '234567', storeId: 'store-pickup-2' },
      { idempotencyKey: 'pickup-unknown-store', code: '234567', storeId: 'store-does-not-exist' },
      { idempotencyKey: 'pickup-wrong-code-3', code: '654322', storeId: 'store-pickup-1' },
      { idempotencyKey: 'pickup-wrong-code-4', code: '654323', storeId: 'store-pickup-1' },
      { idempotencyKey: 'pickup-wrong-code-5', code: '654324', storeId: 'store-pickup-1' },
    ];
    for (const failed of failedAttempts) {
      await assert.rejects(
        service.verifyPickup(merchant, intent.orderId, {
          ...failed,
          evidenceHash: `0x${'4'.repeat(64)}`,
        }),
        /invalid or expired/,
      );
    }
    await assert.rejects(
      service.verifyPickup(merchant, intent.orderId, {
        ...failedAttempts[4]!,
        evidenceHash: `0x${'4'.repeat(64)}`,
      }),
      /invalid or expired/,
    );
    const blockedCredential = await pickupDb.query<{
      failed_attempts: number;
      invalidated_at: Date | null;
      attempts: string;
    }>(
      `SELECT credential.failed_attempts, credential.invalidated_at,
         (SELECT count(*)::text FROM core.pickup_verification_attempts attempt
          WHERE attempt.order_id = credential.order_id AND NOT attempt.successful) AS attempts
       FROM core.pickup_credentials credential
       WHERE credential.order_id = $1 ORDER BY credential.created_at DESC LIMIT 1`,
      [intent.orderId],
    );
    assert.equal(blockedCredential.rows[0]?.failed_attempts, 5);
    assert.ok(blockedCredential.rows[0]?.invalidated_at);
    assert.equal(blockedCredential.rows[0]?.attempts, '5');

    await service.registerPickupCredential(buyer, intent.orderId, {
      idempotencyKey: 'pickup-credential-3',
      evidenceHash: `0x${'9'.repeat(64)}`,
      code: '345678',
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    await service.verifyPickup(merchant, intent.orderId, {
      idempotencyKey: 'pickup-correct-code-1',
      evidenceHash: `0x${'5'.repeat(64)}`,
      code: '345678',
      storeId: 'store-pickup-1',
    });
    assert.deepEqual(await liabilityStates(pickupDb, intent.orderId, 'AVAILABLE'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '62',
    });
    assert.deepEqual(await liabilityStates(pickupDb, intent.orderId, 'LOCKED'), { USDT: '7' });
    assert.deepEqual(
      pickupReceipts.map(({ orderId, storeId, quantity }) => ({ orderId, storeId, quantity })),
      [{ orderId: intent.orderId, storeId: 'store-pickup-1', quantity: '1' }],
    );
    const pickupNotifications = new NotificationService({ transactions: transactionAdapter(pickupDb), clock: () => now });
    const pickupNotificationWorker = new NotificationWorker({
      transactions: transactionAdapter(pickupDb),
      service: pickupNotifications,
      workerId: 'pickup-notification-worker',
      clock: () => now,
    });
    assert.ok(await pickupNotificationWorker.pollOnce() > 0);
    const genesisPickup = (await pickupNotifications.listInbox({
      walletAddress: intent.nplRewardAllocations.find((allocation) => allocation.role === 'genesis')!.account,
      roles: ['BUYER'],
    })).find((message) => message.topic === 'FULFILLMENT_FINALIZED');
    assert.equal(genesisPickup?.templateData.availableNplAmount, '20');
    assert.equal(genesisPickup?.templateData.rewardSubtypes, 'GENESIS');
    assert.equal(genesisPickup?.templateData.method, 'PICKUP_VERIFICATION');
    await assert.rejects(
      service.verifyPickup(merchant, intent.orderId, {
        idempotencyKey: 'pickup-replay-code-1',
        evidenceHash: `0x${'6'.repeat(64)}`,
        code: '123456',
        storeId: 'store-pickup-1',
      }),
      /paid pickup order/,
    );
  } finally {
    await pickupDb.close();
  }
});

test('payment reorg cancels unsent BNM availability and synchronizes Locked next', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    const now = new Date((intent.issuedAt + 60) * 1000);
    const fulfillment = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const operator = { walletAddress: '0x3333333333333333333333333333333333333333', roles: ['OPERATOR'] as const };
    await fulfillment.recordShipment(merchant, intent.orderId, {
      idempotencyKey: 'bnm-race-shipment',
      evidenceHash: `0x${'3'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'4'.repeat(64)}`,
    });
    await fulfillment.recordDelivery(operator, intent.orderId, {
      idempotencyKey: 'bnm-race-delivery',
      evidenceHash: `0x${'5'.repeat(64)}`,
    });
    await fulfillment.confirmReceipt(buyer, intent.orderId, {
      idempotencyKey: 'bnm-race-receipt',
      evidenceHash: `0x${'6'.repeat(64)}`,
    });

    const payment = paymentInput(intent);
    await new PostgresPaymentStore(transactionAdapter(db)).reverse(
      paymentEventKey(payment.event.transactionHash, payment.event.logIndex, payment.event.blockHash),
      `0x${'9'.repeat(64)}`,
    );
    const states: string[] = [];
    const worker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-race-worker',
      adapter: {
        setState: async (input) => {
          states.push(input.state);
          return {
            providerReference: `bnm:${input.orderId}:${input.state}`,
            syncedAt: now.toISOString(),
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });
    assert.equal(await worker.pollOnce(), 1);
    assert.deepEqual(states, ['LOCKED']);
    const outbox = await db.query<{ event_type: string; state: string; last_error_code: string | null }>(
      `SELECT event_type, state, last_error_code FROM core.outbox_events
       WHERE aggregate_id = $1 AND event_type IN ('BnmAvailabilityRequested', 'BnmLockRequested')
       ORDER BY event_type`,
      [intent.orderId],
    );
    assert.deepEqual(outbox.rows, [
      { event_type: 'BnmAvailabilityRequested', state: 'DEAD_LETTER', last_error_code: 'PaymentReorged' },
      { event_type: 'BnmLockRequested', state: 'DELIVERED', last_error_code: null },
    ]);
  } finally {
    await db.close();
  }
});

test('payment reorg waits for in-flight BNM availability acknowledgement before synchronizing Locked', async () => {
  const db = await createBusinessDatabase();
  try {
    const { intent, now } = await completeDeliveryForBnm(db);
    let releaseAvailable!: () => void;
    let markAvailableStarted!: () => void;
    const availableGate = new Promise<void>((resolve) => { releaseAvailable = resolve; });
    const availableStarted = new Promise<void>((resolve) => { markAvailableStarted = resolve; });
    const states: string[] = [];
    const availableWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-in-flight-success',
      adapter: {
        setState: async (input) => {
          states.push(input.state);
          markAvailableStarted();
          await availableGate;
          return {
            providerReference: 'in-flight-available',
            syncedAt: now.toISOString(),
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });
    const lockedWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-in-flight-locked',
      adapter: {
        setState: async (input) => {
          states.push(input.state);
          return {
            providerReference: 'in-flight-locked',
            syncedAt: now.toISOString(),
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });

    const availablePoll = availableWorker.pollOnce();
    await availableStarted;
    await reversePayment(db, intent);
    assert.equal(await lockedWorker.pollOnce(), 0);
    releaseAvailable();
    assert.equal(await availablePoll, 1);
    assert.equal(await lockedWorker.pollOnce(), 1);
    assert.deepEqual(states, ['AVAILABLE', 'LOCKED']);
  } finally {
    await db.close();
  }
});

test('BNM monotonic state version rejects a timed-out AVAILABLE side effect that arrives after reorg Locked', async () => {
  const db = await createBusinessDatabase();
  try {
    const { intent, now } = await completeDeliveryForBnm(db);
    let releaseAvailable!: () => void;
    let markAvailableStarted!: () => void;
    const availableGate = new Promise<void>((resolve) => { releaseAvailable = resolve; });
    const availableStarted = new Promise<void>((resolve) => { markAvailableStarted = resolve; });
    const states: Array<{ state: string; stateVersion: string }> = [];
    let lateAvailable: (() => void) | undefined;
    let external = { state: 'LOCKED' as 'LOCKED' | 'AVAILABLE', stateVersion: '0' };
    const applyAtBackend = (input: { state: 'LOCKED' | 'AVAILABLE'; stateVersion: string }) => {
      const incoming = BigInt(input.stateVersion);
      const current = BigInt(external.stateVersion);
      if (incoming > current) external = { state: input.state, stateVersion: input.stateVersion };
      if (incoming === current && input.state !== external.state) throw new Error('BNM_STATE_VERSION_CONFLICT');
    };
    const availableWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-in-flight-failure',
      adapter: {
        setState: async (input) => {
          states.push({ state: input.state, stateVersion: input.stateVersion });
          lateAvailable = () => applyAtBackend(input);
          markAvailableStarted();
          await availableGate;
          throw new Error('ambiguous provider timeout');
        },
      },
    });
    const lockedWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-after-in-flight-failure',
      adapter: {
        setState: async (input) => {
          states.push({ state: input.state, stateVersion: input.stateVersion });
          applyAtBackend(input);
          return {
            providerReference: 'locked-after-timeout',
            syncedAt: now.toISOString(),
            state: external.state,
            stateVersion: external.stateVersion,
          };
        },
      },
    });

    const availablePoll = availableWorker.pollOnce();
    await availableStarted;
    await reversePayment(db, intent);
    assert.equal(await lockedWorker.pollOnce(), 0);
    releaseAvailable();
    assert.equal(await availablePoll, 1);
    const canceled = await db.query<{ state: string; last_error_code: string | null }>(
      `SELECT state, last_error_code FROM core.outbox_events
       WHERE aggregate_id = $1 AND event_type = 'BnmAvailabilityRequested'`,
      [intent.orderId],
    );
    assert.deepEqual(canceled.rows[0], { state: 'DEAD_LETTER', last_error_code: 'PaymentReorged' });
    assert.equal(await lockedWorker.pollOnce(), 1);
    assert.equal(await lockedWorker.pollOnce(), 0);
    assert.ok(lateAvailable);
    lateAvailable();
    assert.deepEqual(states, [
      { state: 'AVAILABLE', stateVersion: '1' },
      { state: 'LOCKED', stateVersion: '2' },
    ]);
    assert.deepEqual(external, { state: 'LOCKED', stateVersion: '2' });
  } finally {
    await db.close();
  }
});

test('BNM outbox attempt token fences a stale promise after the same worker id re-leases an event', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    await db.query(
      `INSERT INTO core.outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
       ) VALUES ('bnm-fenced','ORDER',$1,'BnmAvailabilityRequested',$2,'bnm-fenced','PENDING')`,
      [intent.orderId, JSON.stringify({
        orderId: intent.orderId,
        buyerWallet: intent.buyer,
        amount: intent.bnmAmount,
        state: 'AVAILABLE',
        stateVersion: '1',
        reason: 'FENCING_TEST',
        sourceEvidenceHash: HASH,
      })],
    );
    let releaseStale!: () => void;
    let releaseCurrent!: () => void;
    let markStaleStarted!: () => void;
    let markCurrentStarted!: () => void;
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    const currentGate = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    const staleStarted = new Promise<void>((resolve) => { markStaleStarted = resolve; });
    const currentStarted = new Promise<void>((resolve) => { markCurrentStarted = resolve; });
    const staleWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'same-worker-id',
      adapter: {
        setState: async (input) => {
          markStaleStarted();
          await staleGate;
          return {
            providerReference: 'stale-provider',
            syncedAt: '2026-07-14T00:00:01.000Z',
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });
    const currentWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'same-worker-id',
      adapter: {
        setState: async (input) => {
          markCurrentStarted();
          await currentGate;
          return {
            providerReference: 'current-provider',
            syncedAt: '2026-07-14T00:00:02.000Z',
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });

    const stalePoll = staleWorker.pollOnce();
    await staleStarted;
    await db.query(
      "UPDATE core.outbox_events SET locked_until = clock_timestamp() - interval '1 second' WHERE event_id = 'bnm-fenced'",
    );
    const currentPoll = currentWorker.pollOnce();
    await currentStarted;
    releaseStale();
    assert.equal(await stalePoll, 1);
    const fenced = await db.query<{ state: string; attempt_count: number; syncs: string }>(
      `SELECT event.state, event.attempt_count,
         (SELECT count(*)::text FROM core.bnm_state_syncs sync WHERE sync.event_id = event.event_id) AS syncs
       FROM core.outbox_events event WHERE event.event_id = 'bnm-fenced'`,
    );
    assert.deepEqual(fenced.rows[0], { state: 'PROCESSING', attempt_count: 2, syncs: '0' });
    releaseCurrent();
    assert.equal(await currentPoll, 1);
    const delivered = await db.query<{ state: string; provider_reference_hash: string }>(
      `SELECT event.state, sync.provider_reference_hash
       FROM core.outbox_events event JOIN core.bnm_state_syncs sync ON sync.event_id = event.event_id
       WHERE event.event_id = 'bnm-fenced'`,
    );
    assert.deepEqual(delivered.rows[0], {
      state: 'DELIVERED',
      provider_reference_hash: `0x${createHash('sha256').update('current-provider').digest('hex')}`,
    });
  } finally {
    await db.close();
  }
});

test('BNM outbox leases one event per order and preserves AVAILABLE then LOCKED FIFO', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    const payload = (state: 'AVAILABLE' | 'LOCKED') => JSON.stringify({
      orderId: intent.orderId,
      buyerWallet: intent.buyer,
      amount: intent.bnmAmount,
      state,
      stateVersion: state === 'AVAILABLE' ? '1' : '2',
      reason: 'FIFO_TEST',
      sourceEvidenceHash: state === 'AVAILABLE' ? HASH : HASH_2,
    });
    await db.query(
      `INSERT INTO core.outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload,
         idempotency_key, state, created_at
       ) VALUES
         ('bnm-fifo-available','ORDER',$1,'BnmAvailabilityRequested',$2,'bnm-fifo-available','PENDING',$4),
         ('bnm-fifo-locked','ORDER',$1,'BnmLockRequested',$3,'bnm-fifo-locked','PENDING',$4 + interval '1 second')`,
      [intent.orderId, payload('AVAILABLE'), payload('LOCKED'), new Date('2026-07-14T00:00:00.000Z')],
    );
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const states: string[] = [];
    const firstWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-fifo-1',
      adapter: {
        setState: async (input) => {
          states.push(input.state);
          markStarted();
          await firstGate;
          return {
            providerReference: 'fifo-available',
            syncedAt: '2026-07-14T00:00:01.000Z',
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });
    const secondWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-fifo-2',
      adapter: {
        setState: async (input) => {
          states.push(input.state);
          return {
            providerReference: 'fifo-locked',
            syncedAt: '2026-07-14T00:00:02.000Z',
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });
    const firstPoll = firstWorker.pollOnce();
    await started;
    assert.equal(await secondWorker.pollOnce(), 0);
    releaseFirst();
    assert.equal(await firstPoll, 1);
    assert.equal(await secondWorker.pollOnce(), 1);
    assert.deepEqual(states, ['AVAILABLE', 'LOCKED']);
  } finally {
    await db.close();
  }
});

test('fulfillment scheduler isolates order failures and persists takeover retry evidence', async () => {
  const db = await createBusinessDatabase();
  try {
    const opened: string[] = [];
    const worker = new FulfillmentSchedulerWorker({
      transactions: transactionAdapter(db),
      platformWallet: '0x3333333333333333333333333333333333333333',
      clock: () => new Date('2026-07-14T00:00:00.000Z'),
      service: {
        listOrders: async () => [
          {
            orderId: 'failing-order',
            fulfillmentMode: 'DELIVERY',
            state: 'PAID',
            paymentFinalizedAt: '2026-07-01T00:00:00.000Z',
            shipments: [],
          },
          {
            orderId: 'healthy-order',
            fulfillmentMode: 'DELIVERY',
            state: 'PAID',
            paymentFinalizedAt: '2026-07-01T00:00:00.000Z',
            shipments: [],
          },
        ],
        openTakeover: async (_actor, orderId) => {
          if (orderId === 'failing-order') throw new Error('provider failure');
          opened.push(orderId);
        },
      },
    });
    assert.deepEqual(await worker.pollOnce(), {
      checked: 2,
      opened: 1,
      pickupBlocked: 0,
      deferred: 0,
      failed: 1,
    });
    assert.deepEqual(opened, ['healthy-order']);
    assert.deepEqual(worker.status(), { healthy: false, errorCode: 'TakeoverOrderFailure' });
    const failure = await db.query<{ state: string; attempt_count: number; last_error_code: string }>(
      "SELECT state, attempt_count, last_error_code FROM core.durable_jobs WHERE resource_id = 'failing-order'",
    );
    assert.deepEqual(failure.rows[0], {
      state: 'RETRY',
      attempt_count: 1,
      last_error_code: 'UnexpectedTakeoverFailure',
    });
  } finally {
    await db.close();
  }
});

test('fulfillment scheduler honors takeover backoff and stops after the fifth failed attempt', async () => {
  const db = await createBusinessDatabase();
  try {
    let attempts = 0;
    const worker = new FulfillmentSchedulerWorker({
      transactions: transactionAdapter(db),
      platformWallet: '0x3333333333333333333333333333333333333333',
      clock: () => new Date('2026-07-14T00:00:00.000Z'),
      service: {
        listOrders: async () => [{
          orderId: 'backoff-order',
          fulfillmentMode: 'DELIVERY',
          state: 'PAID',
          paymentFinalizedAt: '2026-07-01T00:00:00.000Z',
          shipments: [],
        }],
        openTakeover: async () => {
          attempts += 1;
          throw new Error('provider failure');
        },
      },
    });

    assert.equal((await worker.pollOnce()).failed, 1);
    assert.equal(attempts, 1);
    assert.deepEqual(await worker.pollOnce(), {
      checked: 1,
      opened: 0,
      pickupBlocked: 0,
      deferred: 1,
      failed: 0,
    });
    assert.equal(attempts, 1);
    assert.deepEqual(worker.status(), { healthy: false, errorCode: 'TakeoverOrderRetryPending' });

    for (let expectedAttempt = 2; expectedAttempt <= 5; expectedAttempt += 1) {
      await db.query(
        "UPDATE core.durable_jobs SET available_at = clock_timestamp() - interval '1 second' WHERE resource_id = 'backoff-order'",
      );
      assert.equal((await worker.pollOnce()).failed, 1);
      assert.equal(attempts, expectedAttempt);
    }
    const deadLetter = await db.query<{ state: string; attempt_count: number }>(
      "SELECT state, attempt_count FROM core.durable_jobs WHERE resource_id = 'backoff-order'",
    );
    assert.deepEqual(deadLetter.rows[0], { state: 'DEAD_LETTER', attempt_count: 5 });
    assert.equal((await worker.pollOnce()).deferred, 1);
    assert.equal(attempts, 5);
    assert.deepEqual(worker.status(), { healthy: false, errorCode: 'TakeoverOrderDeadLetter' });
  } finally {
    await db.close();
  }
});

test('PostgreSQL SIWE nonces coexist per wallet and each consumes atomically once', async () => {
  const db = await createBusinessDatabase();
  try {
    const store = new PostgresNonceStore(adapter(db));
    const now = new Date('2026-07-14T00:00:00.000Z');
    await store.save({
      walletAddress: BUYER,
      nonceHash: 'a'.repeat(64),
      domain: 'mall.abu.test',
      uri: 'https://mall.abu.test',
      chainId: 56,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await store.save({
      walletAddress: BUYER,
      nonceHash: 'b'.repeat(64),
      domain: 'mall.abu.test',
      uri: 'https://mall.abu.test',
      chainId: 56,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    assert.ok(await store.consume(BUYER, 'a'.repeat(64), now));
    assert.equal(await store.consume(BUYER, 'a'.repeat(64), now), undefined);
    assert.ok(await store.consume(BUYER, 'b'.repeat(64), now));
  } finally {
    await db.close();
  }
});

test('Redis SIWE limiter hashes identities, enforces limits and fails closed', async () => {
  let capturedKeys: string[] = [];
  const allowed = new RedisNonceRateLimiter({
    eval: async (_script, options) => {
      capturedKeys = options.keys;
      return 1;
    },
  });
  await allowed.consume({ walletAddress: BUYER, clientAddress: '127.0.0.1', now: new Date('2026-07-14T00:00:00Z') });
  assert.equal(capturedKeys.some((key) => key.includes(BUYER) || key.includes('127.0.0.1')), false);
  const blocked = new RedisNonceRateLimiter({ eval: async () => 0 });
  await assert.rejects(
    blocked.consume({ walletAddress: BUYER, clientAddress: '127.0.0.1', now: new Date() }),
    (error: unknown) =>
      error instanceof Error && error.message.includes('rate limit exceeded') && 'status' in error && error.status === 429,
  );
  const unavailable = new RedisNonceRateLimiter({ eval: async () => Promise.reject(new Error('offline')) });
  await assert.rejects(
    unavailable.consume({ walletAddress: BUYER, clientAddress: '127.0.0.1', now: new Date() }),
    /unavailable/,
  );
});

test('order financial snapshots and evidence history are immutable', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 2);
    await reserveInventory(adapter(db), {
      reservationId: 'reservation-order',
      reservationHash: HASH,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await insertOrder(db, 'order-1', 'reservation-order');
    await db.query("UPDATE core.orders SET state = 'SUBMITTED', updated_at = clock_timestamp() WHERE order_id = 'order-1'");
    await assert.rejects(
      db.query("UPDATE core.orders SET exact_amounts = '{\"usdt\":\"999\"}'::jsonb WHERE order_id = 'order-1'"),
      /ImmutableOrderSnapshot/,
    );
    await assert.rejects(db.query("DELETE FROM core.orders WHERE order_id = 'order-1'"), /ImmutableRecord/);

    await db.query(
      `INSERT INTO core.fulfillment_evidence (
         evidence_id, order_id, evidence_type, evidence_hash, source, recorded_by
       ) VALUES ('evidence-1', 'order-1', 'SHIPMENT', $1, 'KUAIDI100', 'worker')`,
      [HASH],
    );
    await assert.rejects(
      db.query("UPDATE core.fulfillment_evidence SET source = 'tampered' WHERE evidence_id = 'evidence-1'"),
      /ImmutableRecord/,
    );
  } finally {
    await db.close();
  }
});

test('policy drafts remain editable while published policy and historical catalog records do not', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 2);
    await db.query(
      `INSERT INTO core.policy_drafts (
         draft_id, next_policy_version, base_policy_version, payload, state, created_by
       ) VALUES ('draft-2', 2, 1, '{}', 'DRAFT', 'admin')`,
    );
    await db.query(
      `UPDATE core.policy_drafts
       SET payload = '{"futureOnly":true}', updated_at = clock_timestamp()
       WHERE draft_id = 'draft-2'`,
    );
    await assert.rejects(
      db.query("UPDATE core.policy_snapshots SET artifact_version = 'tampered' WHERE policy_version = 1"),
      /ImmutableRecord/,
    );
    await assert.rejects(
      db.query(
        "UPDATE core.merchants SET settlement_wallet = '0x3333333333333333333333333333333333333333' WHERE merchant_id = 'merchant-1'",
      ),
      /ImmutableSettlementWallet/,
    );
    await assert.rejects(db.query("DELETE FROM core.products WHERE product_id = 'product-1'"), /ImmutableRecord/);
  } finally {
    await db.close();
  }
});

test('policy publication binds the Registry signature and EOA execution, activates at 15 confirmations and reorgs append-only', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 3);
    const admin = Wallet.createRandom();
    const secondary = Wallet.createRandom();
    const governanceWallet = '0x9000000000000000000000000000000000000001';
    const registry = '0x9000000000000000000000000000000000000002';
    const rulesHash = HASH;
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, status, evidence_hash
       ) VALUES ($1, 'ADMIN', 'ACTIVE', $2)`,
      [admin.address.toLowerCase(), HASH],
    );
    const priorPolicy = paymentPolicyPayload();
    const policy = {
      ...priorPolicy,
      platformServiceFeeWallet: '0x2222222222222222222222222222222222222224',
      decisionEvidenceHash: `0x${'3'.repeat(64)}`,
    };
    policy.concessionDestinationSetHash = paymentAllocationSetHash().toLowerCase();
    let now = new Date('2026-07-15T03:00:00.000Z');
    const frozenSessionId = `0x${'9'.repeat(64)}`;
    await insertLiveSeckillSession(db, frozenSessionId, now, 80);
    let proposalInput: { calldataHash: string; draftId: string } | undefined;
    const service = new PolicyService({
      transactions: transactionAdapter(db),
      executor: {
        execute: async (input) => {
          proposalInput = input;
          return {
            executionTxHash: `0x${'4'.repeat(64)}`,
            executorWallet: governanceWallet,
            executorNonce: '7',
            executionEvidenceHash: `0x${'5'.repeat(64)}`,
          };
        },
      },
      executionGasLimit: '500000',
      policyRegistryAddress: registry,
      governanceWallet,
      platformServiceFeeWallet: policy.platformServiceFeeWallet,
      secondarySigner: secondary.address,
      auditReady: () => true,
      clock: () => now,
    });
    const actor = { walletAddress: admin.address, roles: ['ADMIN'] as const };
    await assert.rejects(
      service.createDraft(actor, {
        payload: {
          rulesContentHash: rulesHash,
          policy: { ...policy, platformServiceFeeWallet: '0x9000000000000000000000000000000000000003' },
        },
        idempotencyKey: 'policy-wrong-service-fee-wallet',
        correlationId: 'policy-wrong-service-fee-wallet',
      }),
      /platformServiceFeeWallet does not match the attested PaymentRouter binding/,
    );
    await assert.rejects(
      service.createDraft(actor, {
        payload: {
          rulesContentHash: rulesHash,
          policy: { ...policy, seckillMainDuration: policy.seckillMainDuration + 1 },
        },
        idempotencyKey: 'policy-v2-forbidden-financial-diff',
        correlationId: 'policy-v2-forbidden-financial-diff',
      }),
      /Policy V2 may only change the platform service-fee recipient/,
    );
    await assert.rejects(
      service.createDraft(actor, {
        payload: { rulesContentHash: rulesHash, policy: { ...policy, unsupportedFutureField: true } },
        idempotencyKey: 'policy-v2-unknown-field',
        correlationId: 'policy-v2-unknown-field',
      }),
      /Published payment policy contains unknown fields/,
    );
    await assert.rejects(
      service.createDraft(actor, {
        payload: {
          rulesContentHash: rulesHash,
          policy: {
            ...policy,
            genesisNodeDestinations: [{ ...policy.genesisNodeDestinations[0]!, memo: true }],
          },
        },
        idempotencyKey: 'policy-v2-nested-unknown-field',
        correlationId: 'policy-v2-nested-unknown-field',
      }),
      /genesisNodeDestinations\[0\] contains unknown fields/,
    );
    await assert.rejects(
      service.createDraft(actor, {
        payload: { rulesContentHash: HASH_2, policy },
        idempotencyKey: 'policy-v2-forbidden-rules-diff',
        correlationId: 'policy-v2-forbidden-rules-diff',
      }),
      /Policy V2 may only change the platform service-fee recipient/,
    );
    const draft = await service.createDraft(actor, {
      payload: { rulesContentHash: rulesHash, policy },
      idempotencyKey: 'policy-draft-v2',
      correlationId: 'policy-draft-v2',
    });
    assert.equal(draft.state, 'DRAFT');
    assert.equal(draft.nextPolicyVersion, '2');
    const replayedDraft = await service.createDraft(actor, {
      payload: { rulesContentHash: rulesHash, policy },
      idempotencyKey: 'policy-draft-v2',
      correlationId: 'policy-draft-v2-retry',
    });
    assert.equal(replayedDraft.draftId, draft.draftId);
    assert.equal(replayedDraft.transitions.length, 1);

    const deadline = String(Math.floor(now.getTime() / 1_000) + 300);
    const challenge = await service.approvalChallenge(actor, draft.draftId, { nonce: '17', deadline });
    const signature = await secondary.signTypedData(
      challenge.typedData.domain,
      challenge.typedData.types,
      challenge.typedData.message,
    );
    const wrongSignature = await Wallet.createRandom().signTypedData(
      challenge.typedData.domain,
      challenge.typedData.types,
      challenge.typedData.message,
    );
    await assert.rejects(
      service.submitSecondarySignature(actor, draft.draftId, {
        nonce: '17',
        deadline,
        signature: wrongSignature,
        correlationId: 'policy-wrong-signature',
      }),
      /secondary signer mismatch/,
    );
    const signed = await service.submitSecondarySignature(actor, draft.draftId, {
      nonce: '17',
      deadline,
      signature,
      correlationId: 'policy-secondary-signature',
    });
    assert.equal(signed.state, 'SECONDARY_SIGNED');
    assert.equal(signed.publicationDigest, challenge.digest);
    await db.query(
      "UPDATE core.wallet_role_bindings SET status = 'REVOKED', revoked_at = $2 WHERE wallet_address = $1 AND role = 'ADMIN'",
      [admin.address.toLowerCase(), now],
    );
    await assert.rejects(
      service.execute(actor, draft.draftId, 'policy-eoa-execution-revoked'),
      /Current wallet role cannot govern policy/,
    );
    await db.query(
      "UPDATE core.wallet_role_bindings SET status = 'ACTIVE', revoked_at = NULL WHERE wallet_address = $1 AND role = 'ADMIN'",
      [admin.address.toLowerCase()],
    );
    const proposed = await service.execute(actor, draft.draftId, 'policy-eoa-execution');
    assert.equal(proposed.state, 'SUBMITTED');
    assert.equal(proposalInput?.draftId, draft.draftId);
    assert.equal(proposalInput?.calldataHash, signed.executionCalldataHash);
    const replayedProposal = await service.execute(actor, draft.draftId, 'policy-eoa-execution-retry');
    assert.equal(replayedProposal.executionTxHash, proposed.executionTxHash);
    assert.ok(replayedProposal.transitions.length >= 3);

    const observation = {
      executionTxHash: proposed.executionTxHash!,
      blockNumber: 123,
      blockHash: `0x${'7'.repeat(64)}`,
      canonical: true as const,
      policyVersion: 2,
      policyHash: signed.policyHash!,
      operationsHash: signed.operationsHash!,
      decisionEvidenceHash: policy.decisionEvidenceHash,
      governanceExecutor: governanceWallet,
    };
    now = new Date(now.getTime() + 1_000);
    const pending = await service.recordObservation(draft.draftId, {
      ...observation,
      state: 'MINED',
      confirmations: 14,
    });
    assert.equal(pending?.state, 'FINALITY_PENDING');
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.policy_snapshots WHERE policy_version = 2',
    )).rows[0]?.count, '0');

    now = new Date(now.getTime() + 1_000);
    const published = await service.recordObservation(draft.draftId, {
      ...observation,
      state: 'FINAL',
      confirmations: 15,
    });
    assert.equal(published?.state, 'PUBLISHED');
    assert.deepEqual((await db.query<{ policy_version: string | number }>(
      'SELECT policy_version FROM core.canonical_policy_publications ORDER BY policy_version',
    )).rows.map((row) => Number(row.policy_version)), [1, 2]);
    const sessionPolicy = await db.query<{ policy_version: string | number }>(
      'SELECT policy_version FROM core.seckill_sessions WHERE session_id = $1',
      [frozenSessionId],
    );
    assert.equal(Number(sessionPolicy.rows[0]?.policy_version), 1);

    now = new Date(now.getTime() + 1_000);
    const reorged = await service.recordObservation(draft.draftId, {
      ...observation,
      state: 'REORGED',
      canonical: false,
      confirmations: 0,
      canonicalBlockHash: `0x${'8'.repeat(64)}`,
    });
    assert.equal(reorged?.state, 'REORGED');
    assert.deepEqual((await db.query<{ policy_version: string | number }>(
      'SELECT policy_version FROM core.canonical_policy_publications ORDER BY policy_version',
    )).rows.map((row) => Number(row.policy_version)), [1]);
    const publicationHistory = await db.query<{ event_type: string }>(
      'SELECT event_type FROM core.policy_publication_transitions WHERE policy_version = 2 ORDER BY transition_sequence',
    );
    assert.deepEqual(publicationHistory.rows.map((row) => row.event_type), ['FINAL', 'REORGED']);
    await assert.rejects(
      db.query("UPDATE core.policy_publication_transitions SET event_type = 'FINAL' WHERE policy_version = 2"),
      /ImmutableRecord/,
    );
    const afterReorg = await service.pendingFinality(25);
    const replacementCandidate = afterReorg.find((item) => item.draftId === draft.draftId);
    assert.equal(replacementCandidate?.priorState, 'REORGED');
    assert.deepEqual(replacementCandidate?.priorFinality, {
      executionTxHash: observation.executionTxHash,
      blockNumber: observation.blockNumber,
      blockHash: observation.blockHash,
    });

    now = new Date(now.getTime() + 1_000);
    const republished = await service.recordObservation(draft.draftId, {
      ...observation,
      state: 'FINAL',
      blockNumber: 124,
      blockHash: `0x${'a'.repeat(64)}`,
      confirmations: 15,
    });
    assert.equal(republished?.state, 'PUBLISHED');
    assert.deepEqual((await db.query<{ policy_version: string | number }>(
      'SELECT policy_version FROM core.canonical_policy_publications ORDER BY policy_version',
    )).rows.map((row) => Number(row.policy_version)), [1, 2]);
    assert.deepEqual((await db.query<{ event_type: string }>(
      'SELECT event_type FROM core.policy_publication_transitions WHERE policy_version = 2 ORDER BY transition_sequence',
    )).rows.map((row) => row.event_type), ['FINAL', 'REORGED', 'FINAL']);
  } finally {
    await db.close();
  }
});

test('CMS sanitizes structured content, targets audiences, binds seckill rules and rolls back by append-only publication', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 3);
    const admin = Wallet.createRandom();
    const now = new Date('2026-07-15T04:00:00.000Z');
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, status, evidence_hash
       ) VALUES ($1, 'ADMIN', 'ACTIVE', $2)`,
      [admin.address.toLowerCase(), HASH],
    );
    const service = new CmsService({ transactions: transactionAdapter(db), clock: () => now });
    const actor = { walletAddress: admin.address, roles: ['ADMIN'] as const };
    const content = (text: string) => ({
      type: 'doc',
      children: [{ type: 'paragraph', children: [{ type: 'text', text, marks: ['bold'] }] }],
    });
    assert.throws(
      () => sanitizeStructuredContent({
        type: 'doc',
        children: [{ type: 'link', href: 'javascript:alert(1)', children: [{ type: 'text', text: 'bad', marks: [] }] }],
      }),
      /link protocol is not allowed/,
    );
    assert.throws(
      () => sanitizeStructuredContent({ type: 'doc', children: [{ type: 'script', source: 'alert(1)' }] }),
      /node type script is not allowed/,
    );
    assert.throws(
      () => sanitizeStructuredContent({
        type: 'doc',
        children: [{ type: 'paragraph', onClick: 'bad', children: [] }],
      }),
      /unknown fields/,
    );

    const first = await service.createVersion(actor, {
      slug: 'regional-banner',
      contentType: 'BANNER',
      placement: 'MALL_HOME_TOP',
      locale: 'zh-CN',
      contentFormat: 'STRUCTURED_RICH_TEXT',
      content: content('First banner'),
      audience: { type: 'REGION', regionCodes: ['110101'] },
      startsAt: new Date(now.getTime() - 1_000).toISOString(),
      endsAt: new Date(now.getTime() + 60_000).toISOString(),
      frequencyCap: 2,
      idempotencyKey: 'cms-banner-v1',
      correlationId: 'cms-test-v1',
    });
    assert.equal(first.version, 1);
    assert.equal((await service.createVersion(actor, {
      slug: 'regional-banner',
      contentType: 'BANNER',
      placement: 'MALL_HOME_TOP',
      locale: 'zh-CN',
      contentFormat: 'STRUCTURED_RICH_TEXT',
      content: content('First banner'),
      audience: { type: 'REGION', regionCodes: ['110101'] },
      startsAt: new Date(now.getTime() - 1_000).toISOString(),
      endsAt: new Date(now.getTime() + 60_000).toISOString(),
      frequencyCap: 2,
      idempotencyKey: 'cms-banner-v1',
      correlationId: 'cms-test-v1',
    })).versionId, first.versionId);
    await service.publish(actor, first.versionId, { evidenceHash: HASH, correlationId: 'cms-publish-v1' });
    const buyerAudience = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const firstPublished = await service.listPublished({ actor: buyerAudience, now });
    assert.equal(firstPublished.length, 1);
    assert.deepEqual(firstPublished[0]?.audience, { type: 'REGION' });
    assert.equal((await service.listPublished({ now })).length, 0);

    const second = await service.createVersion(actor, {
      entryId: first.entryId,
      slug: 'regional-banner',
      contentType: 'BANNER',
      placement: 'MALL_HOME_TOP',
      locale: 'zh-CN',
      contentFormat: 'STRUCTURED_RICH_TEXT',
      content: content('Second banner'),
      audience: { type: 'REGION', regionCodes: ['110101'] },
      startsAt: new Date(now.getTime() - 1_000).toISOString(),
      endsAt: new Date(now.getTime() + 60_000).toISOString(),
      frequencyCap: 1,
      idempotencyKey: 'cms-banner-v2',
      correlationId: 'cms-test-v2',
    });
    await service.publish(actor, second.versionId, { evidenceHash: HASH_2, correlationId: 'cms-publish-v2' });
    assert.equal((await service.listPublished({ actor: buyerAudience, now }))[0]?.version, 2);
    await service.rollback(actor, first.versionId, {
      evidenceHash: `0x${'4'.repeat(64)}`,
      correlationId: 'cms-rollback-v1',
    });
    assert.equal((await service.listPublished({ actor: buyerAudience, now }))[0]?.version, 1);
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.cms_versions WHERE entry_id = $1',
      [first.entryId],
    )).rows[0]?.count, '2');
    await assert.rejects(
      db.query("UPDATE core.cms_versions SET locale = 'en-US' WHERE version_id = $1", [first.versionId]),
      /ImmutableRecord/,
    );

    const rules = await service.createVersion(actor, {
      slug: 'seckill-rules-v2',
      contentType: 'SECKILL_RULES',
      placement: 'SECKILL_RULES',
      locale: 'zh-CN',
      contentFormat: 'STRUCTURED_RICH_TEXT',
      content: content('Version two rules'),
      audience: { type: 'ALL' },
      policyVersion: '2',
      idempotencyKey: 'cms-rules-v2',
      correlationId: 'cms-rules-create',
    });
    await db.query(
      `INSERT INTO core.policy_drafts (
         draft_id, next_policy_version, base_policy_version, payload,
         validation_errors, state, created_by, artifact_version
       ) VALUES ('cms-policy-draft-2', 2, 1, $1, '[]', 'DRAFT', $2, $3)`,
      [JSON.stringify({ rulesContentHash: rules.contentHash }), admin.address.toLowerCase(), CORE_ARTIFACT_VERSION],
    );
    await service.publish(actor, rules.versionId, {
      evidenceHash: `0x${'5'.repeat(64)}`,
      correlationId: 'cms-rules-publish',
    });
    assert.equal((await service.getVersion(actor, rules.versionId)).published, true);

    const wrongRules = await service.createVersion(actor, {
      slug: 'seckill-rules-v3',
      contentType: 'SECKILL_RULES',
      placement: 'SECKILL_RULES_NEXT',
      locale: 'zh-CN',
      contentFormat: 'STRUCTURED_RICH_TEXT',
      content: content('Unbound rules'),
      audience: { type: 'ALL' },
      policyVersion: '3',
      idempotencyKey: 'cms-rules-v3',
      correlationId: 'cms-rules-wrong',
    });
    await assert.rejects(
      service.publish(actor, wrongRules.versionId, {
        evidenceHash: `0x${'6'.repeat(64)}`,
        correlationId: 'cms-rules-wrong-publish',
      }),
      /rules hash does not match policyVersion/,
    );
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.audit_outbox_events WHERE event_type LIKE 'Cms%'",
    )).rows[0]?.count, '8');
  } finally {
    await db.close();
  }
});

test('notifications consume finalized domain events independently and isolate ConfigurationRequired provider delivery', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 3);
    await db.query(
      `INSERT INTO core.inventory_reservations (
         reservation_id, reservation_hash, policy_version, sku_id, buyer_wallet,
         quantity, classification, state, expires_at
       ) VALUES ('reservation-notification', $1, 1, 'sku-1', $2, 1,
         'ORDINARY', 'ACTIVE', clock_timestamp() + interval '1 hour')`,
      [`0x${'8'.repeat(64)}`, BUYER],
    );
    await insertOrder(db, 'order-notification', 'reservation-notification');
    const now = new Date('2026-07-15T05:00:00.000Z');
    const beneficiary = '0x3333333333333333333333333333333333333333';
    await db.query(
      `INSERT INTO core.ledger_accounts (
         account_id, owner_type, owner_id, asset, purpose, wallet_address, subtype
       ) VALUES
         ('notification-safe-npl','WALLET',$1,'NPL','WALLET_ASSET',$1,NULL),
         ('notification-beneficiary-npl','BENEFICIARY',$2,'NPL','REWARD_LIABILITY',NULL,'GENESIS')`,
      ['0x4444444444444444444444444444444444444444', beneficiary],
    );
    await db.query(
      `SELECT core.post_balanced_journal(
         'journal:notification-beneficiary','notification-beneficiary-locked','PAYMENT_LOCKED',
         'order-notification',1,$1,$2,$3,NULL,'{}',$4
       )`,
      [
        HASH,
        `0x${'7'.repeat(64)}`,
        `0x${'8'.repeat(64)}`,
        JSON.stringify([
          { account_id: 'notification-safe-npl', side: 'DEBIT', amount: '10', balance_state: 'POSTED' },
          { account_id: 'notification-beneficiary-npl', side: 'CREDIT', amount: '10', balance_state: 'LOCKED' },
        ]),
      ],
    );
    const service = new NotificationService({ transactions: transactionAdapter(db), clock: () => now });
    const endpoint = await service.registerEndpoint({ walletAddress: BUYER, roles: ['BUYER'] }, {
      channel: 'SMS',
      provider: 'ALIYUN_SMS',
      endpointReference: 'secret://recipients/buyer-sms',
      topics: ['*'],
      regionCode: '110101',
      correlationId: 'notification-endpoint-register',
    });
    await service.registerEndpoint({ walletAddress: BUYER, roles: ['BUYER'] }, {
      channel: 'SMS',
      provider: 'ALIYUN_SMS',
      endpointReference: 'secret://recipients/buyer-sms-v2',
      topics: ['*'],
      regionCode: '110101',
      correlationId: 'notification-endpoint-update',
    });
    const endpointAudits = await db.query<{
      event_type: string;
      evidence_profile: string;
      correlation_id: string;
      payload: Record<string, unknown>;
      authorization_evidence: Record<string, unknown>;
    }>(
      `SELECT event_type, evidence_profile, correlation_id, payload, authorization_evidence
       FROM core.audit_outbox_events WHERE resource_type = 'NOTIFICATION_ENDPOINT'
       ORDER BY created_at, event_type`,
    );
    assert.deepEqual(endpointAudits.rows.map((row) => row.event_type).sort(), [
      'NotificationEndpointRegistered',
      'NotificationEndpointUpdated',
    ]);
    assert.deepEqual(endpointAudits.rows.map((row) => row.correlation_id).sort(), [
      'notification-endpoint-register',
      'notification-endpoint-update',
    ]);
    assert.ok(endpointAudits.rows.every((row) => row.evidence_profile === 'AUTHORIZATION'));
    assert.ok(endpointAudits.rows.every((row) => row.authorization_evidence.scheme === 'SESSION_RESOURCE_OWNERSHIP'));
    assert.ok(endpointAudits.rows.every((row) => typeof row.payload.endpointReferenceHash === 'string'));
    assert.doesNotMatch(JSON.stringify(endpointAudits.rows), /secret:\/\/recipients\/buyer-sms/);

    const failingEndpointService = new NotificationService({
      transactions: transactionAdapter(db, (sql) => {
        if (sql.includes('INSERT INTO core.audit_outbox_events')) throw new Error('InjectedNotificationAuditFailure');
      }),
      clock: () => now,
    });
    await assert.rejects(
      failingEndpointService.registerEndpoint({ walletAddress: BUYER, roles: ['BUYER'] }, {
        channel: 'SMS',
        provider: 'TENCENT_SMS',
        endpointReference: 'secret://recipients/rollback-insert',
        topics: ['*'],
        correlationId: 'notification-endpoint-rollback-insert',
      }),
      /InjectedNotificationAuditFailure/,
    );
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.notification_endpoints WHERE provider = 'TENCENT_SMS'",
    )).rows[0]?.count, '0');
    await assert.rejects(
      failingEndpointService.registerEndpoint({ walletAddress: BUYER, roles: ['BUYER'] }, {
        channel: 'SMS',
        provider: 'ALIYUN_SMS',
        endpointReference: 'secret://recipients/rollback-update',
        topics: ['*'],
        correlationId: 'notification-endpoint-rollback-update',
      }),
      /InjectedNotificationAuditFailure/,
    );
    assert.equal((await db.query<{ endpoint_reference: string }>(
      'SELECT endpoint_reference FROM core.notification_endpoints WHERE endpoint_id = $1',
      [endpoint.endpointId],
    )).rows[0]?.endpoint_reference, 'secret://recipients/buyer-sms-v2');
    await db.query(
      `INSERT INTO core.outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload,
         idempotency_key, state, available_at, created_at
       ) VALUES
         ('notify-payment-final', 'ORDER', 'order-notification', 'PaymentFinalized',
          '{"orderId":"order-notification","confirmations":15}', 'notify-payment-final', 'PENDING', $1, $1),
         ('notify-bnm-final', 'ORDER', 'order-notification', 'BnmStateFinalized',
          '{"orderId":"order-notification","state":"AVAILABLE","amount":"100","stateVersion":"2"}',
          'notify-bnm-final', 'PENDING', $1, $1)`,
      [now],
    );
    assert.equal(await service.projectNext(), 2);
    assert.equal(await service.projectNext(), 0);
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.notification_source_consumptions',
    )).rows[0]?.count, '2');
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.notification_messages',
    )).rows[0]?.count, '4');
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.notification_deliveries',
    )).rows[0]?.count, '6');

    const unconfigured = new NotificationWorker({
      transactions: transactionAdapter(db),
      service,
      workerId: 'notification-worker-unconfigured',
      clock: () => now,
    });
    assert.equal(await unconfigured.pollOnce(), 6);
    const deliveryStates = await db.query<{ provider: string; state: string; count: string }>(
      `SELECT provider, state, count(*)::text AS count FROM core.notification_deliveries
       GROUP BY provider, state ORDER BY provider, state`,
    );
    assert.deepEqual(deliveryStates.rows, [
      { provider: 'ALIYUN_SMS', state: 'CONFIGURATION_REQUIRED', count: '2' },
      { provider: 'CORE', state: 'DELIVERED', count: '4' },
    ]);
    const initialDeliveryAudits = await db.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM core.audit_outbox_events
       WHERE resource_type = 'NOTIFICATION_DELIVERY' ORDER BY event_type`,
    );
    assert.equal(initialDeliveryAudits.rows.filter((row) => row.event_type === 'NotificationDeliveryDelivered').length, 4);
    assert.equal(initialDeliveryAudits.rows.filter((row) => row.event_type === 'NotificationDeliveryConfigurationRequired').length, 2);
    assert.ok(initialDeliveryAudits.rows.every((row) => typeof row.payload.endpointReferenceHash === 'string'));
    assert.doesNotMatch(JSON.stringify(initialDeliveryAudits.rows), /secret:\/\/recipients\/buyer-sms/);
    const inbox = await service.listInbox({ walletAddress: BUYER, roles: ['BUYER'] });
    assert.equal(inbox.length, 2);
    const bnm = inbox.find((message) => message.topic === 'BNM_AVAILABLE');
    assert.equal(bnm?.templateData.copyKey, 'BNM_POINTS_AVAILABLE');
    assert.doesNotMatch(JSON.stringify(bnm), /mint|claim|token/i);
    const beneficiaryInbox = await service.listInbox({ walletAddress: beneficiary, roles: ['BUYER'] });
    assert.equal(beneficiaryInbox.length, 1);
    assert.equal(beneficiaryInbox[0]?.templateData.lockedNplAmount, '10');
    assert.equal(beneficiaryInbox[0]?.templateData.rewardSubtypes, 'GENESIS');
    assert.equal((await service.listInbox({ walletAddress: '0x9999999999999999999999999999999999999999', roles: ['BUYER'] })).length, 0);

    const configured = new NotificationWorker({
      transactions: transactionAdapter(db),
      service,
      adapters: [{
        provider: 'ALIYUN_SMS' as const,
        send: async (input) => ({
          providerMessageId: `provider:${input.deliveryId}`,
          acceptedAt: now.toISOString(),
        }),
      }],
      workerId: 'notification-worker-configured',
      clock: () => now,
    });
    assert.equal(await configured.retryConfigured('ALIYUN_SMS'), 2);
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.audit_outbox_events WHERE event_type = 'NotificationDeliveryRetryScheduled'",
    )).rows[0]?.count, '2');
    assert.equal(await configured.pollOnce(), 2);
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.notification_deliveries WHERE provider = 'ALIYUN_SMS' AND state = 'DELIVERED'",
    )).rows[0]?.count, '2');

    await db.query(
      `SELECT core.post_balanced_journal(
         'journal:notification-beneficiary-available','notification-beneficiary-available','FULFILLMENT_AVAILABLE',
         'order-notification',1,$1,$2,NULL,NULL,$3,$4
       )`,
      [
        HASH_2,
        HASH,
        JSON.stringify({ method: 'PICKUP_VERIFICATION' }),
        JSON.stringify([
          { account_id: 'notification-beneficiary-npl', side: 'DEBIT', amount: '10', balance_state: 'LOCKED' },
          { account_id: 'notification-beneficiary-npl', side: 'CREDIT', amount: '10', balance_state: 'AVAILABLE' },
        ]),
      ],
    );
    await db.query(
      `INSERT INTO core.outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload,
         idempotency_key, state, available_at, created_at
       ) VALUES ('notify-fulfillment-final', 'ORDER', 'order-notification', 'FulfillmentFinalized',
         '{"orderId":"order-notification","method":"PICKUP_VERIFICATION"}',
         'notify-fulfillment-final', 'PENDING', $1, $1)`,
      [now],
    );
    assert.equal(await service.projectNext(), 1);
    assert.equal(await configured.pollOnce(), 4);
    const beneficiaryAvailable = (await service.listInbox({ walletAddress: beneficiary, roles: ['BUYER'] }))
      .find((message) => message.topic === 'FULFILLMENT_FINALIZED');
    assert.equal(beneficiaryAvailable?.templateData.availableNplAmount, '10');
    assert.equal(beneficiaryAvailable?.templateData.rewardSubtypes, 'GENESIS');
    assert.equal(beneficiaryAvailable?.templateData.method, 'PICKUP_VERIFICATION');

    await db.query(
      `INSERT INTO core.outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload,
         idempotency_key, state, available_at, created_at
       ) VALUES ('notify-payment-reorg', 'ORDER', 'order-notification', 'PaymentReorged',
         '{"orderId":"order-notification","state":"REORGED"}',
         'notify-payment-reorg', 'PENDING', $2, $1)`,
      [new Date(now.getTime() + 1_000), now],
    );
    assert.equal(await service.projectNext(), 1);
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.notification_messages WHERE recipient_wallet = $1 AND topic = 'PAYMENT_REORGED'",
      [BUYER],
    )).rows[0]?.count, '1');

    const admin = Wallet.createRandom();
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, status, evidence_hash
       ) VALUES ($1, 'ADMIN', 'ACTIVE', $2)`,
      [admin.address.toLowerCase(), HASH],
    );
    const campaign = await service.createCampaign({ walletAddress: admin.address, roles: ['ADMIN'] }, {
      topic: 'ANNOUNCEMENT',
      audience: { type: 'WALLET', wallets: [BUYER] },
      message: { titleKey: 'SYSTEM_ANNOUNCEMENT', bodyKey: 'SYSTEM_ANNOUNCEMENT_BODY', variables: { version: '2' } },
      idempotencyKey: 'notification-campaign-1',
      correlationId: 'notification-campaign-create',
    });
    await service.publishCampaign({ walletAddress: admin.address, roles: ['ADMIN'] }, campaign.campaignId, {
      evidenceHash: HASH_2,
      correlationId: 'notification-campaign-publish',
    });
    const replayedCampaign = await service.createCampaign({ walletAddress: admin.address, roles: ['ADMIN'] }, {
      topic: 'ANNOUNCEMENT',
      audience: { type: 'WALLET', wallets: [BUYER] },
      message: { titleKey: 'SYSTEM_ANNOUNCEMENT', bodyKey: 'SYSTEM_ANNOUNCEMENT_BODY', variables: { version: '2' } },
      idempotencyKey: 'notification-campaign-1',
      correlationId: 'notification-campaign-create',
    });
    assert.equal(replayedCampaign.state, 'PUBLISHED');
    assert.equal(replayedCampaign.contentHash, campaign.contentHash);
    assert.equal(await service.projectNext(), 1);
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.notification_messages WHERE topic = 'ANNOUNCEMENT'",
    )).rows[0]?.count, '1');
    await db.query(
      `UPDATE core.notification_deliveries delivery SET state = 'DEAD_LETTER'
       FROM core.notification_messages message, core.outbox_events source
       WHERE delivery.message_id = message.message_id AND message.source_event_id = source.event_id
         AND source.aggregate_id = $1`,
      [campaign.campaignId],
    );
    const campaignList = await service.listCampaigns({ walletAddress: admin.address, roles: ['ADMIN'] });
    assert.equal(campaignList[0]?.deliveryCounts.DEAD_LETTER, 2);
    assert.deepEqual(campaignList[0]?.allowedActions, ['RETRY_FAILED']);
    const auditor = Wallet.createRandom();
    await db.query(
      `INSERT INTO core.wallet_role_bindings (wallet_address, role, status, evidence_hash)
       VALUES ($1,'AUDITOR','ACTIVE',$2)`,
      [auditor.address.toLowerCase(), HASH],
    );
    const auditView = await service.listCampaigns({ walletAddress: auditor.address, roles: ['AUDITOR'] });
    assert.deepEqual(auditView[0]?.allowedActions, []);
    assert.throws(
      () => service.listCampaigns({ walletAddress: BUYER, roles: ['BUYER'] }),
      /Wallet session cannot manage notifications/,
    );
    const retry = await service.retryCampaignDeliveries({ walletAddress: admin.address, roles: ['ADMIN'] }, campaign.campaignId, {
      correlationId: 'notification-campaign-retry',
    });
    assert.equal(retry.retriedDeliveries, 2);
    assert.equal((await service.listCampaigns({ walletAddress: admin.address, roles: ['ADMIN'] }))[0]?.deliveryCounts.RETRY, 2);
    assert.equal(await configured.pollOnce(), 5);
    assert.equal((await service.listCampaigns({ walletAddress: admin.address, roles: ['ADMIN'] }))[0]?.deliveryCounts.DELIVERED, 2);
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.audit_outbox_events WHERE event_type LIKE 'NotificationCampaign%'",
    )).rows[0]?.count, '3');
  } finally {
    await db.close();
  }
});

test('notification delivery failures audit exact states and lost leases fail closed', async () => {
  const db = await createBusinessDatabase();
  try {
    const now = new Date('2026-07-15T05:30:00.000Z');
    const endpointId = 'notification-endpoint:worker-failures';
    await db.query(
      `INSERT INTO core.notification_endpoints (
         endpoint_id, wallet_address, channel, provider, endpoint_reference,
         topics, state, created_at, updated_at
       ) VALUES ($1,$2,'SMS','ALIYUN_SMS','secret://recipients/worker-failures',
         '["*"]','ACTIVE',$3,$3)`,
      [endpointId, BUYER, now],
    );
    for (const [deliveryId, attempts] of [
      ['notification-delivery:a-retry', 0],
      ['notification-delivery:b-dead', 7],
      ['notification-delivery:z-lost', 0],
    ] as const) {
      const messageId = `notification-message:${deliveryId}`;
      await db.query(
        `INSERT INTO core.notification_messages (
           message_id, source_event_id, source_event_type, recipient_wallet,
           topic, template_data, created_at
         ) VALUES ($1,$2,'PaymentFinalized',$3,'PAYMENT_FINALIZED','{}',$4)`,
        [messageId, `source:${deliveryId}`, BUYER, now],
      );
      await db.query(
        `INSERT INTO core.notification_deliveries (
           delivery_id, message_id, endpoint_id, channel, provider,
           endpoint_reference, state, attempt_count, available_at
         ) VALUES ($1,$2,$3,'SMS','ALIYUN_SMS','secret://recipients/worker-failures','PENDING',$4,$5)`,
        [deliveryId, messageId, endpointId, attempts, now],
      );
    }
    const service = new NotificationService({ transactions: transactionAdapter(db), clock: () => now });
    const worker = new NotificationWorker({
      transactions: transactionAdapter(db),
      service,
      adapters: [{
        provider: 'ALIYUN_SMS' as const,
        send: async (input) => {
          if (input.deliveryId.endsWith('z-lost')) {
            await db.query(
              "UPDATE core.notification_deliveries SET locked_by = 'replacement-worker' WHERE delivery_id = $1",
              [input.deliveryId],
            );
            return { providerMessageId: 'provider:lost', acceptedAt: now.toISOString() };
          }
          throw new Error('ProviderBoom');
        },
      }],
      workerId: 'notification-failure-worker',
      clock: () => now,
    });
    await assert.rejects(worker.pollOnce(), /NotificationLeaseLost/);
    const states = await db.query<{ delivery_id: string; state: string; locked_by: string | null }>(
      'SELECT delivery_id, state, locked_by FROM core.notification_deliveries ORDER BY delivery_id',
    );
    assert.deepEqual(states.rows, [
      { delivery_id: 'notification-delivery:a-retry', state: 'RETRY', locked_by: null },
      { delivery_id: 'notification-delivery:b-dead', state: 'DEAD_LETTER', locked_by: null },
      { delivery_id: 'notification-delivery:z-lost', state: 'PROCESSING', locked_by: 'replacement-worker' },
    ]);
    const audits = await db.query<{ event_type: string; resource_id: string }>(
      `SELECT event_type, resource_id FROM core.audit_outbox_events
       WHERE resource_type = 'NOTIFICATION_DELIVERY' ORDER BY resource_id`,
    );
    assert.deepEqual(audits.rows, [
      { event_type: 'NotificationDeliveryRetryScheduled', resource_id: 'notification-delivery:a-retry' },
      { event_type: 'NotificationDeliveryDeadLettered', resource_id: 'notification-delivery:b-dead' },
    ]);
    assert.doesNotMatch(JSON.stringify(await db.query(
      "SELECT * FROM core.audit_outbox_events WHERE resource_type = 'NOTIFICATION_DELIVERY'",
    )), /secret:\/\/recipients\/worker-failures/);

    const rollbackDeliveryId = 'notification-delivery:zz-audit-rollback';
    const rollbackMessageId = `notification-message:${rollbackDeliveryId}`;
    await db.query(
      `INSERT INTO core.notification_messages (
         message_id, source_event_id, source_event_type, recipient_wallet,
         topic, template_data, created_at
       ) VALUES ($1,$2,'PaymentFinalized',$3,'PAYMENT_FINALIZED','{}',$4)`,
      [rollbackMessageId, `source:${rollbackDeliveryId}`, BUYER, now],
    );
    await db.query(
      `INSERT INTO core.notification_deliveries (
         delivery_id, message_id, endpoint_id, channel, provider,
         endpoint_reference, state, available_at
       ) VALUES ($1,$2,$3,'SMS','ALIYUN_SMS','secret://recipients/worker-failures','PENDING',$4)`,
      [rollbackDeliveryId, rollbackMessageId, endpointId, now],
    );
    const auditFailingWorker = new NotificationWorker({
      transactions: transactionAdapter(db, (sql) => {
        if (sql.includes('INSERT INTO core.audit_outbox_events')) throw new Error('InjectedDeliveryAuditFailure');
      }),
      service,
      adapters: [{ provider: 'ALIYUN_SMS' as const, send: async () => { throw new Error('ProviderBoom'); } }],
      workerId: 'notification-audit-failure-worker',
      clock: () => now,
    });
    await assert.rejects(auditFailingWorker.pollOnce(), /InjectedDeliveryAuditFailure/);
    assert.deepEqual((await db.query<{ state: string; locked_by: string }>(
      'SELECT state, locked_by FROM core.notification_deliveries WHERE delivery_id = $1',
      [rollbackDeliveryId],
    )).rows[0], { state: 'PROCESSING', locked_by: 'notification-audit-failure-worker' });
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.audit_outbox_events WHERE resource_id = $1',
      [rollbackDeliveryId],
    )).rows[0]?.count, '0');
  } finally {
    await db.close();
  }
});

test('notifications project real shipment and operator delivery evidence for the buyer wallet', async () => {
  const db = await createBusinessDatabase();
  try {
    const { intent, now } = await completeDeliveryForBnm(db);
    const service = new NotificationService({ transactions: transactionAdapter(db), clock: () => now });
    const worker = new NotificationWorker({
      transactions: transactionAdapter(db),
      service,
      workerId: 'real-logistics-notification-worker',
      clock: () => now,
    });
    assert.ok(await worker.pollOnce() > 0);
    const inbox = await service.listInbox({ walletAddress: intent.buyer, roles: ['BUYER'] });
    const shipment = inbox.find((message) => message.sourceEventType === 'ShipmentRecorded');
    assert.equal(shipment?.topic, 'SHIPMENT_UPDATED');
    assert.equal(shipment?.templateData.carrierCode, 'SF');
    assert.equal(shipment?.templateData.trackingNumberHash, `0x${'4'.repeat(64)}`);
    const delivery = inbox.find((message) => message.sourceEventType === 'DeliveryRecorded');
    assert.equal(delivery?.topic, 'SHIPMENT_UPDATED');
    assert.equal(delivery?.templateData.state, 'DELIVERED');
    assert.equal(delivery?.templateData.deliveredAt, now.toISOString());
  } finally {
    await db.close();
  }
});

test('system config keeps secrets as references and publishes exact old/new versions through RBAC and secondary signature', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 3);
    const admin = Wallet.createRandom();
    const secondary = Wallet.createRandom();
    const governanceWallet = '0x9100000000000000000000000000000000000001';
    let now = new Date('2026-07-15T06:00:00.000Z');
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, status, evidence_hash
       ) VALUES ($1, 'ADMIN', 'ACTIVE', $2)`,
      [admin.address.toLowerCase(), HASH],
    );
    const service = new SystemConfigService({
      transactions: transactionAdapter(db),
      secondarySigner: secondary.address,
      governanceWallet,
      verifyingContract: governanceWallet,
      auditReady: () => true,
      clock: () => now,
    });
    const actor = { walletAddress: admin.address, roles: ['ADMIN'] as const };
    assert.throws(
      () => service.createVersion(actor, {
        configKey: 'RPC',
        payload: {
          chainId: 56,
          primaryRpcSecretRef: 'https://rpc.example.invalid/secret',
          fallbackRpcSecretRef: 'secret://rpc/fallback',
          explorerApiSecretRef: 'secret://explorer/key',
        },
        effectiveFrom: '2020-01-01T00:00:00.000Z',
        idempotencyKey: 'system-rpc-invalid',
        correlationId: 'system-rpc-invalid',
      }),
      /must be a secret reference/,
    );
    const first = await service.createVersion(actor, {
      configKey: 'RPC',
      payload: {
        chainId: 56,
        primaryRpcSecretRef: 'secret://rpc/primary-v1',
        fallbackRpcSecretRef: 'secret://rpc/fallback-v1',
        explorerApiSecretRef: 'secret://explorer/key-v1',
      },
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      idempotencyKey: 'system-rpc-v1',
      correlationId: 'system-rpc-create-v1',
    });
    assert.equal(first.version, 1);
    assert.equal(first.payload.primaryRpcSecretRef, 'secret://rpc/primary-v1');
    assert.equal(JSON.stringify(first).includes('https://'), false);
    const challenge = await service.approvalChallenge(actor, first.configVersionId, {
      nonce: '101',
      deadline: String(Math.floor(now.getTime() / 1_000) + 300),
    });
    assert.equal(challenge.signer, secondary.address.toLowerCase());
    assert.notEqual(challenge.signer, admin.address.toLowerCase());
    assert.equal(challenge.oldValueHash, `0x${'0'.repeat(64)}`);
    assert.equal(challenge.newValueHash, first.payloadHash);
    assert.equal(challenge.typedData.message.resourceId, first.configVersionId);
    assert.equal(challenge.typedData.message.nonce, '101');
    assert.throws(
      () => service.approvalChallenge({ walletAddress: admin.address, roles: ['OPERATOR'] }, first.configVersionId, {
        nonce: '102', deadline: challenge.deadline,
      }),
      /Wallet session cannot manage system config/,
    );
    assert.throws(
      () => service.approvalChallenge({ walletAddress: admin.address, roles: ['AUDITOR'] }, first.configVersionId, {
        nonce: '103', deadline: challenge.deadline,
      }),
      /Wallet session cannot manage system config/,
    );
    assert.throws(
      () => service.approvalChallenge(actor, first.configVersionId, {
        nonce: '104', deadline: String(Math.floor(now.getTime() / 1_000) - 1),
      }),
      /System config approval expired/,
    );
    assert.throws(
      () => service.createVersion(actor, {
        configKey: 'FREIGHT',
        payload: {},
        effectiveFrom: '2020-01-01T00:00:00.000Z',
        idempotencyKey: 'system-freight-retired',
        correlationId: 'system-freight-retired',
      }),
      /Freight is configured per product/,
    );
    const intent: SensitiveActionIntent = {
      action: 'PUBLISH_SYSTEM_CONFIG',
      resourceType: 'SYSTEM_CONFIG',
      resourceId: first.configVersionId,
      policyVersion: 1n,
      oldValueHash: `0x${'0'.repeat(64)}`,
      newValueHash: first.payloadHash,
      executorWallet: governanceWallet,
      nonce: 101n,
      deadline: BigInt(Math.floor(now.getTime() / 1_000) + 300),
    };
    const approval = {
      action: intent.action,
      resourceType: intent.resourceType,
      resourceId: intent.resourceId,
      policyVersion: intent.policyVersion.toString(),
      oldValueHash: intent.oldValueHash,
      newValueHash: intent.newValueHash,
      executorWallet: intent.executorWallet,
      nonce: intent.nonce.toString(),
      deadline: intent.deadline.toString(),
      signature: await secondary.signTypedData(sensitiveActionDomain(governanceWallet), sensitiveActionTypes, intent),
    };
    await db.query(
      "UPDATE core.wallet_role_bindings SET status = 'REVOKED', revoked_at = $2 WHERE wallet_address = $1 AND role = 'ADMIN'",
      [admin.address.toLowerCase(), now],
    );
    await assert.rejects(service.publish(actor, first.configVersionId, approval), /Current wallet role cannot manage system config/);
    await db.query(
      "UPDATE core.wallet_role_bindings SET status = 'ACTIVE', revoked_at = NULL WHERE wallet_address = $1 AND role = 'ADMIN'",
      [admin.address.toLowerCase()],
    );
    assert.equal((await service.publish(actor, first.configVersionId, approval)).published, true);
    assert.equal((await service.publish(actor, first.configVersionId, approval)).published, true);

    now = new Date(now.getTime() + 1_000);
    const second = await service.createVersion(actor, {
      configKey: 'RPC',
      payload: {
        chainId: 56,
        primaryRpcSecretRef: 'secret://rpc/primary-v2',
        fallbackRpcSecretRef: 'secret://rpc/fallback-v2',
        explorerApiSecretRef: 'secret://explorer/key-v2',
      },
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      idempotencyKey: 'system-rpc-v2',
      correlationId: 'system-rpc-create-v2',
    });
    const secondIntent: SensitiveActionIntent = {
      ...intent,
      resourceId: second.configVersionId,
      oldValueHash: first.payloadHash,
      newValueHash: second.payloadHash,
      nonce: 102n,
      deadline: BigInt(Math.floor(now.getTime() / 1_000) + 300),
    };
    const secondChallenge = await service.approvalChallenge(actor, second.configVersionId, {
      nonce: secondIntent.nonce.toString(),
      deadline: secondIntent.deadline.toString(),
    });
    assert.equal(secondChallenge.oldValueHash, first.payloadHash);
    assert.equal(secondChallenge.newValueHash, second.payloadHash);
    const secondApproval = {
      action: secondIntent.action,
      resourceType: secondIntent.resourceType,
      resourceId: secondIntent.resourceId,
      policyVersion: secondIntent.policyVersion.toString(),
      oldValueHash: secondIntent.oldValueHash,
      newValueHash: secondIntent.newValueHash,
      executorWallet: secondIntent.executorWallet,
      nonce: secondIntent.nonce.toString(),
      deadline: secondIntent.deadline.toString(),
      signature: await secondary.signTypedData(sensitiveActionDomain(governanceWallet), sensitiveActionTypes, secondIntent),
    };
    assert.equal((await service.publish(actor, second.configVersionId, secondApproval)).published, true);
    const current = await db.query<{ version: number; payload: Record<string, unknown> }>(
      "SELECT version, payload FROM core.current_system_config WHERE config_key = 'RPC'",
    );
    assert.equal(current.rows[0]?.version, 2);
    assert.equal(current.rows[0]?.payload.primaryRpcSecretRef, 'secret://rpc/primary-v2');
    assert.throws(
      () => service.createVersion(actor, {
        configKey: 'MERCHANT_LEVELS' as never,
        payload: { levels: [{ level: 'V1', maxProductSettlementUsdt: '0', monthlySeckillQuota: -1 }] },
        effectiveFrom: '2020-01-01T00:00:00.000Z',
        idempotencyKey: 'merchant-levels-invalid',
        correlationId: 'merchant-levels-invalid',
      }),
      /System config key is invalid/,
    );
    await db.query(
      `INSERT INTO core.system_config_versions (
         config_version_id, config_key, version, payload, payload_hash, effective_from,
         idempotency_key, request_hash, created_by, created_at
       ) VALUES ('system-config:merchant-levels:legacy', 'MERCHANT_LEVELS', 1, '{}', $1,
         '2020-01-01T00:00:00.000Z', 'legacy-merchant-levels', $1, $2, $3)`,
      [HASH, admin.address.toLowerCase(), now],
    );
    await assert.rejects(
      service.approvalChallenge(actor, 'system-config:merchant-levels:legacy', {
        nonce: '105', deadline: String(Math.floor(now.getTime() / 1_000) + 300),
      }),
      /System config key is retired/,
    );
    assert.equal((await service.list(actor)).some((item) => String(item.configKey) === 'MERCHANT_LEVELS'), false);
    await assert.rejects(
      db.query("UPDATE core.system_config_versions SET payload = '{}' WHERE config_version_id = $1", [first.configVersionId]),
      /ImmutableRecord/,
    );
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.audit_outbox_events WHERE event_type LIKE 'SystemConfig%'",
    )).rows[0]?.count, '4');
  } finally {
    await db.close();
  }
});

test('monitoring treats missing samples as unavailable and alerts only when RPC height lag exceeds three blocks', async () => {
  const db = await createBusinessDatabase();
  try {
    const admin = Wallet.createRandom();
    let now = new Date('2026-07-15T07:00:00.000Z');
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, status, evidence_hash
       ) VALUES ($1, 'ADMIN', 'ACTIVE', $2)`,
      [admin.address.toLowerCase(), HASH],
    );
    const runtime = new RuntimeMetricsRegistry(60_000);
    const noSamples = await runtime.collect(now);
    assert.equal(noSamples.find((metric) => metric.metricName === 'throughput')?.status, 'UNAVAILABLE');
    assert.equal(noSamples.find((metric) => metric.metricName === 'throughput')?.value, null);
    runtime.record('HTTP', 120, false, now);
    assert.equal((await runtime.collect(now)).find((metric) => metric.component === 'HTTP' && metric.metricName === 'throughput')?.status, 'HEALTHY');

    const redisZero = new MiddlewareMonitoringSource({
      database: adapter(db),
      redis: { info: async () => 'keyspace_hits:0\r\nkeyspace_misses:0\r\n' },
      dbPool: () => ({ active: 1, maximum: 10 }),
    });
    assert.equal((await redisZero.collect(now)).find((metric) => metric.component === 'REDIS')?.status, 'UNAVAILABLE');

    let explorerHeight = 97;
    const heights = new RpcExplorerHeightSource({
      primaryRpcUrl: 'https://primary.example.invalid',
      fallbackRpcUrl: 'https://fallback.example.invalid',
      explorerApiUrl: 'https://explorer.example.invalid/api',
      explorerApiKey: 'test-key',
      fetchImpl: (async (input) => {
        const url = String(input);
        const height = url.includes('explorer') ? explorerHeight : 100;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${height.toString(16)}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    assert.equal((await heights.collect(now)).find((metric) => metric.component === 'RPC_PRIMARY')?.status, 'HEALTHY');
    explorerHeight = 96;
    assert.equal((await heights.collect(now)).find((metric) => metric.component === 'RPC_PRIMARY')?.status, 'CRITICAL');

    let lag = 3;
    const worker = new OperationsMonitoringWorker({
      transactions: transactionAdapter(db),
      sources: [{
        name: 'height-boundary',
        collect: async (at) => [{
          component: 'RPC_PRIMARY' as const,
          metricName: 'height_lag',
          unit: 'BLOCK' as const,
          value: lag,
          status: lag > 3 ? 'CRITICAL' as const : 'HEALTHY' as const,
          windowStartedAt: at,
          windowEndedAt: at,
          evidence: { rpc: 100, explorer: 100 - lag },
        }],
      }],
      clock: () => now,
    });
    assert.equal(await worker.pollOnce(), 1);
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.operations_alert_events',
    )).rows[0]?.count, '0');
    lag = 4;
    now = new Date(now.getTime() + 1_000);
    assert.equal(await worker.pollOnce(), 1);
    const service = new MonitoringService({ transactions: transactionAdapter(db), clock: () => now });
    const actor = { walletAddress: admin.address, roles: ['ADMIN'] as const };
    let dashboard = await service.dashboard(actor);
    assert.equal(dashboard.metrics.find((metric) => metric.metricName === 'height_lag')?.status, 'CRITICAL');
    assert.equal(dashboard.alerts.find((alert) => alert.alertKey === 'RPC_PRIMARY:height_lag')?.state, 'OPENED');
    const openedAudit = await db.query<{
      evidence_profile: string;
      payload: Record<string, unknown>;
      transaction_evidence: Record<string, unknown>;
    }>(
      "SELECT evidence_profile, payload, transaction_evidence FROM core.audit_outbox_events WHERE event_type = 'MonitoringAlertOpened'",
    );
    assert.equal(openedAudit.rows[0]?.evidence_profile, 'SYSTEM');
    assert.match(String(openedAudit.rows[0]?.payload.evidenceHash), /^0x[0-9a-f]{64}$/);
    assert.deepEqual(openedAudit.rows[0]?.transaction_evidence, {});

    await db.query(
      "UPDATE core.wallet_role_bindings SET status = 'REVOKED', revoked_at = $2 WHERE wallet_address = $1 AND role = 'ADMIN'",
      [admin.address.toLowerCase(), now],
    );
    await assert.rejects(service.dashboard(actor), /Current wallet role cannot read or acknowledge monitoring/);
    await assert.rejects(
      service.acknowledge(actor, 'RPC_PRIMARY:height_lag', 'monitoring-revoked'),
      /Current wallet role cannot read or acknowledge monitoring/,
    );
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.operations_alert_events WHERE event_type = 'ACKNOWLEDGED'",
    )).rows[0]?.count, '0');
    await db.query(
      "UPDATE core.wallet_role_bindings SET status = 'ACTIVE', revoked_at = NULL WHERE wallet_address = $1 AND role = 'ADMIN'",
      [admin.address.toLowerCase()],
    );

    const auditFailingService = new MonitoringService({
      transactions: transactionAdapter(db, (sql) => {
        if (sql.includes('INSERT INTO core.audit_outbox_events')) throw new Error('InjectedMonitoringAuditFailure');
      }),
      clock: () => now,
    });
    await assert.rejects(
      auditFailingService.acknowledge(actor, 'RPC_PRIMARY:height_lag', 'monitoring-ack-rollback'),
      /InjectedMonitoringAuditFailure/,
    );
    assert.equal((await db.query<{ event_type: string }>(
      "SELECT event_type FROM core.current_operations_alerts WHERE alert_key = 'RPC_PRIMARY:height_lag'",
    )).rows[0]?.event_type, 'OPENED');
    assert.deepEqual(await service.acknowledge(actor, 'RPC_PRIMARY:height_lag', 'monitoring-acknowledge'), {
      alertKey: 'RPC_PRIMARY:height_lag',
      state: 'ACKNOWLEDGED',
    });
    const acknowledgedAudit = await db.query<{
      evidence_profile: string;
      correlation_id: string;
      authorization_evidence: Record<string, unknown>;
    }>(
      "SELECT evidence_profile, correlation_id, authorization_evidence FROM core.audit_outbox_events WHERE event_type = 'MonitoringAlertAcknowledged'",
    );
    assert.equal(acknowledgedAudit.rows[0]?.evidence_profile, 'RBAC');
    assert.equal(acknowledgedAudit.rows[0]?.correlation_id, 'monitoring-acknowledge');
    assert.equal(acknowledgedAudit.rows[0]?.authorization_evidence.scheme, 'RBAC_ROLE_REVALIDATION');
    assert.equal(acknowledgedAudit.rows[0]?.authorization_evidence.subject, admin.address.toLowerCase());
    now = new Date(now.getTime() + 1_000);
    await worker.pollOnce();
    dashboard = await service.dashboard(actor);
    assert.equal(dashboard.alerts.find((alert) => alert.alertKey === 'RPC_PRIMARY:height_lag')?.state, 'ACKNOWLEDGED');
    lag = 0;
    now = new Date(now.getTime() + 1_000);
    await worker.pollOnce();
    dashboard = await service.dashboard(actor);
    assert.equal(dashboard.alerts.find((alert) => alert.alertKey === 'RPC_PRIMARY:height_lag')?.state, 'RECOVERED');
    assert.equal((await db.query<{ evidence_profile: string }>(
      "SELECT evidence_profile FROM core.audit_outbox_events WHERE event_type = 'MonitoringAlertRecovered'",
    )).rows[0]?.evidence_profile, 'SYSTEM');

    let probeFails = true;
    const partialWorker = new OperationsMonitoringWorker({
      transactions: transactionAdapter(db),
      sources: [
        {
          name: 'failing-source',
          collect: async () => {
            if (probeFails) throw new Error('ProviderUnavailable');
            return [];
          },
        },
        {
          name: 'healthy-source',
          collect: async (at) => [{
            component: 'HTTP' as const,
            metricName: 'partial_probe_health',
            unit: 'COUNT' as const,
            value: 1,
            status: 'HEALTHY' as const,
            windowStartedAt: at,
            windowEndedAt: at,
            evidence: { sampleCount: 1 },
          }],
        },
      ],
      clock: () => now,
    });
    assert.equal(await partialWorker.pollOnce(), 1);
    assert.deepEqual(partialWorker.status(), { healthy: false, errorCode: 'failing-sourceProbeUnavailable' });
    assert.equal((await db.query<{ evidence_profile: string }>(
      "SELECT evidence_profile FROM core.audit_outbox_events WHERE event_type = 'MonitoringProbeUnavailable'",
    )).rows[0]?.evidence_profile, 'SYSTEM');
    probeFails = false;
    assert.equal(await partialWorker.pollOnce(), 1);
    assert.deepEqual(partialWorker.status(), { healthy: true, errorCode: undefined });

    const rollbackWorker = new OperationsMonitoringWorker({
      transactions: transactionAdapter(db, (sql) => {
        if (sql.includes('INSERT INTO core.audit_outbox_events')) throw new Error('InjectedMonitoringAuditFailure');
      }),
      sources: [{
        name: 'rollback-source',
        collect: async (at) => [{
          component: 'HTTP' as const,
          metricName: 'rollback_probe',
          unit: 'COUNT' as const,
          value: 1,
          status: 'CRITICAL' as const,
          windowStartedAt: at,
          windowEndedAt: at,
          evidence: { reason: 'test' },
        }],
      }],
      clock: () => now,
    });
    await assert.rejects(rollbackWorker.pollOnce(), /InjectedMonitoringAuditFailure/);
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.operations_metric_snapshots WHERE metric_name = 'rollback_probe'",
    )).rows[0]?.count, '0');
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.operations_alert_events WHERE alert_key = 'HTTP:rollback_probe'",
    )).rows[0]?.count, '0');
    await assert.rejects(
      db.query("UPDATE core.operations_metric_snapshots SET status = 'HEALTHY'"),
      /ImmutableRecord/,
    );
  } finally {
    await db.close();
  }
});

test('outbox participates in the business transaction and durable jobs lease once', async () => {
  const db = await createBusinessDatabase();
  try {
    await db.exec('BEGIN');
    await db.query(
      `INSERT INTO core.outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
       ) VALUES ('event-rollback', 'ORDER', 'order-x', 'OrderPrepared', '{}', 'outbox-rollback', 'PENDING')`,
    );
    await db.exec('ROLLBACK');
    const rolledBack = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.outbox_events WHERE event_id = 'event-rollback'",
    );
    assert.equal(rolledBack.rows[0]?.count, '0');

    for (const id of ['job-1', 'job-2']) {
      await db.query(
        `INSERT INTO core.durable_jobs (
           job_id, job_type, resource_id, payload, idempotency_key, state
         ) VALUES ($1, 'SYNC_FINALITY', $2, '{}', $3, 'READY')`,
        [id, `resource-${id}`, `idempotency-${id}`],
      );
    }
    const first = await leaseDurableJobs(adapter(db), 'worker-a', 1, 30);
    const second = await leaseDurableJobs(adapter(db), 'worker-b', 1, 30);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.notEqual(first[0]?.job_id, second[0]?.job_id);
    assert.equal(first[0]?.attempt_count, 1);
    assert.equal(second[0]?.attempt_count, 1);
  } finally {
    await db.close();
  }
});

test('audit database redacts secrets, verifies its hash chain and rejects mutation', async () => {
  const db = await PGlite.create();
  try {
    await applyMigrations(adapter(db), 'audit', AUDIT_MIGRATIONS);
    for (const index of [1, 2]) {
      await appendAuditEntry(transactionAdapter(db), {
          streamName: 'financial',
          evidenceProfile: 'CHAIN_OBSERVED',
          eventType: index === 1 ? 'PaymentIndexed' : 'PaymentFinalized',
          resourceType: 'ORDER',
          resourceId: 'order-1',
          actorWallet: BUYER,
          actorRole: 'BUYER',
          correlationId: 'correlation-1',
          requestHash: 'a'.repeat(64),
          payload: {
            state: index,
            authorization: 'Bearer secret',
            nested: {
              phone: '13800000000',
              email: 'buyer@example.invalid',
              shippingAddress: 'private location',
              private_key: 'secret-key',
              credential: 'secret-credential',
            },
          },
          signatureEvidence: {
            scheme: 'EIP712',
            signatureHash: HASH,
            signer: BUYER,
            digest: HASH_2,
            domain: 'Abu24KPaymentRouter:2:56',
            nonce: String(index),
            deadline: '1800000300',
          },
          transactionEvidence: {
            txHash: HASH_2,
            chainId: 56,
            contractAddress: MERCHANT,
            selector: '0x12345678',
            calldataHash: HASH,
            resourceId: 'order-1',
            policyVersion: 1,
          },
          createdAt: new Date(`2026-07-14T00:00:0${index}.000Z`),
      });
    }
    const result = await db.query<AuditRow>('SELECT * FROM audit.entries ORDER BY sequence');
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0]?.payload.authorization, '[REDACTED]');
    assert.deepEqual(result.rows[0]?.payload.nested, {
      phone: '[REDACTED]',
      email: '[REDACTED]',
      shippingAddress: '[REDACTED]',
      private_key: '[REDACTED]',
      credential: '[REDACTED]',
    });
    assert.deepEqual(result.rows[0]?.signature_evidence, {
      scheme: 'EIP712',
      signatureHash: HASH,
      signer: BUYER,
      digest: HASH_2,
      domain: 'Abu24KPaymentRouter:2:56',
      nonce: '1',
      deadline: '1800000300',
    });
    assert.deepEqual(result.rows[0]?.transaction_evidence, {
      txHash: HASH_2,
      chainId: 56,
      contractAddress: MERCHANT,
      selector: '0x12345678',
      calldataHash: HASH,
      resourceId: 'order-1',
      policyVersion: 1,
    });
    assert.equal(verifyAuditChain(result.rows), true);
    assert.equal(verifyAuditChain([{ ...result.rows[0]!, entry_hash: 'f'.repeat(64) }, result.rows[1]!]), false);
    assert.equal(verifyAuditChain([{
      ...result.rows[0]!,
      evidence_profile: 'CHAIN_FINAL',
    }, result.rows[1]!]), false);
    await assert.rejects(db.query("UPDATE audit.entries SET event_type = 'tampered'"), /AppendOnlyAudit/);
    await assert.rejects(db.query('DELETE FROM audit.entries'), /AppendOnlyAudit/);
    await assert.rejects(
      appendAuditEntry(transactionAdapter(db), {
        streamName: 'financial',
        evidenceProfile: 'SIGNED_OFFCHAIN',
        eventType: 'MissingEvidence',
        resourceType: 'ORDER',
        resourceId: 'order-missing-evidence',
        correlationId: 'correlation-missing-evidence',
        requestHash: 'd'.repeat(64),
        payload: {},
      }),
      /InvalidSignedOffchainAuditEvidence/,
    );
    const failingRunner = transactionAdapter(db, (sql) => {
      if (sql.startsWith('UPDATE audit.stream_heads')) throw new Error('InjectedAuditHeadFailure');
    });
    await assert.rejects(
      appendAuditEntry(failingRunner, {
        streamName: 'financial',
        evidenceProfile: 'CHAIN_OBSERVED',
        eventType: 'MustRollback',
        resourceType: 'ORDER',
        resourceId: 'order-2',
        correlationId: 'correlation-rollback',
        requestHash: 'b'.repeat(64),
        payload: {},
        signatureEvidence: {
          scheme: 'EIP712',
          signatureHash: HASH,
          signer: BUYER,
          digest: HASH_2,
          domain: 'Abu24KPaymentRouter:2:56',
          nonce: '2',
          deadline: '1800000300',
        },
        transactionEvidence: {
          txHash: HASH_2,
          chainId: 56,
          contractAddress: MERCHANT,
          selector: '0x12345678',
          calldataHash: HASH,
          resourceId: 'order-2',
          policyVersion: 1,
        },
      }),
      /InjectedAuditHeadFailure/,
    );
    const afterRollback = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM audit.entries');
    assert.equal(afterRollback.rows[0]?.count, '2');
    await assert.rejects(
      appendAuditEntry(transactionAdapter(db), {
        streamName: 'financial',
        evidenceProfile: 'SIGNED_OFFCHAIN',
        eventType: 'RejectUnknownEvidence',
        resourceType: 'ORDER',
        resourceId: 'order-3',
        correlationId: 'correlation-unknown-evidence',
        requestHash: 'c'.repeat(64),
        payload: {},
        signatureEvidence: {
          scheme: 'EIP712',
          signatureHash: HASH,
          signer: BUYER,
          digest: HASH_2,
          domain: 'Abu24KPaymentRouter:2:56',
          nonce: '3',
          deadline: '1800000300',
          private_key: 'must-not-pass',
        } as never,
      }),
      /UnknownAuditEvidenceField/,
    );
  } finally {
    await db.close();
  }
});

test('audit outbox is transactional, retries exactly once and exposes read-only filtered chain proof', async () => {
  const business = await PGlite.create();
  const audit = await PGlite.create();
  try {
    await applyMigrations(adapter(business), 'core', BUSINESS_MIGRATIONS);
    await applyMigrations(adapter(audit), 'audit', AUDIT_MIGRATIONS);
    const now = new Date('2026-07-15T02:00:00.000Z');
    const input = {
      sourceEventId: 'audit:operation:one',
      streamName: 'operational' as const,
      evidenceProfile: 'CHAIN_OBSERVED' as const,
      eventType: 'AdminActionRecorded',
      resourceType: 'CMS_VERSION',
      resourceId: 'cms-version-1',
      actorWallet: BUYER,
      actorRole: 'ADMIN',
      correlationId: 'audit-correlation-1',
      requestHash: 'a'.repeat(64),
      payload: { action: 'CREATE', apiToken: 'must-redact' },
      transactionEvidence: {
        txHash: HASH,
        chainId: 56 as const,
        contractAddress: BUYER,
        selector: '0x12345678',
        calldataHash: HASH_2,
        resourceId: 'cms-version-1',
        policyVersion: 1,
      },
      createdAt: now,
    };
    await assert.rejects(
      transactionAdapter(business).transaction(async (executor) => {
        await enqueueAudit(executor, input);
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.equal((await business.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.audit_outbox_events',
    )).rows[0]?.count, '0');
    await assert.rejects(
      transactionAdapter(business).transaction(async (executor) => {
        await executor.query(
          `INSERT INTO core.outbox_events (
             event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
           ) VALUES ('outbox:audit-validation-rollback','TEST','audit-validation','MustRollback','{}',
             'outbox:audit-validation-rollback','PENDING')`,
        );
        await enqueueAudit(executor, {
          ...input,
          sourceEventId: 'audit:operation:invalid-finality',
          evidenceProfile: 'CHAIN_FINAL',
          transactionEvidence: {
            ...input.transactionEvidence,
            blockHash: HASH,
            confirmations: 14,
          },
        });
      }),
      /MissingFinalChainAuditEvidence/,
    );
    assert.equal((await business.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.outbox_events WHERE event_id = 'outbox:audit-validation-rollback'",
    )).rows[0]?.count, '0');

    await transactionAdapter(business).transaction((executor) => enqueueAudit(executor, input));
    const storedOutbox = await business.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM core.audit_outbox_events WHERE source_event_id = 'audit:operation:one'",
    );
    const legacyContentHash = `0x${createHash('sha256').update(stableJson({
      streamName: input.streamName,
      evidenceProfile: input.evidenceProfile,
      eventType: input.eventType,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      actorWallet: input.actorWallet,
      actorRole: input.actorRole,
      correlationId: input.correlationId,
      requestHash: input.requestHash,
      payload: input.payload,
      authorizationEvidence: {},
      signatureEvidence: {},
      transactionEvidence: input.transactionEvidence,
    })).digest('hex')}`;
    assert.equal(storedOutbox.rows[0]?.payload._contentHash, legacyContentHash);
    assert.equal(
      (await transactionAdapter(business).transaction((executor) => enqueueAudit(executor, input))).existing,
      true,
    );
    await assert.rejects(
      transactionAdapter(business).transaction((executor) => enqueueAudit(executor, {
        ...input,
        payload: { action: 'DIFFERENT' },
      })),
      /Audit source event id was reused/,
    );

    const worker = new AuditOutboxWorker({
      business: transactionAdapter(business),
      audit: transactionAdapter(audit),
      workerId: 'audit-test-worker',
      clock: () => now,
    });
    assert.equal(await worker.pollOnce(), true);
    const delivered = await business.query<{ state: string }>(
      "SELECT state FROM core.audit_outbox_events WHERE source_event_id = 'audit:operation:one'",
    );
    assert.equal(delivered.rows[0]?.state, 'DELIVERED');

    const duplicate = await appendAuditEntry(transactionAdapter(audit), {
      sourceEventId: input.sourceEventId,
      streamName: input.streamName,
      evidenceProfile: input.evidenceProfile,
      eventType: input.eventType,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      actorWallet: input.actorWallet,
      actorRole: input.actorRole,
      correlationId: input.correlationId,
      requestHash: input.requestHash,
      payload: input.payload,
      transactionEvidence: input.transactionEvidence,
      createdAt: now,
    });
    const auditRows = await audit.query<AuditRow>('SELECT * FROM audit.entries ORDER BY sequence');
    assert.equal(auditRows.rows.length, 1);
    assert.equal(duplicate.entry_id, auditRows.rows[0]?.entry_id);
    assert.equal(auditRows.rows[0]?.payload.apiToken, '[REDACTED]');

    const query = new AuditQueryService(adapter(audit));
    const result = await query.list({ walletAddress: BUYER, roles: ['AUDITOR'] }, {
      streamName: 'operational',
      eventType: 'AdminActionRecorded',
      limit: 10,
    });
    assert.equal(result.entries.length, 1);
    assert.equal(result.chainProof.operational?.verified, true);
    await assert.rejects(
      query.list({ walletAddress: BUYER, roles: ['MERCHANT'], merchantId: 'merchant-1' }, {}),
      /Audit records require ADMIN or AUDITOR/,
    );
  } finally {
    await business.close();
    await audit.close();
  }
});

test('same-version physical backup restores business and audit data into new databases', async () => {
  const business = await createBusinessDatabase();
  const audit = await PGlite.create();
  let restoredBusiness: PGlite | undefined;
  let restoredAudit: PGlite | undefined;
  try {
    await seedCatalog(business, 3);
    await applyMigrations(adapter(audit), 'audit', AUDIT_MIGRATIONS);
    await appendAuditEntry(transactionAdapter(audit), {
      streamName: 'backup',
      evidenceProfile: 'SYSTEM',
      eventType: 'BackupEvidence',
      resourceType: 'DATABASE',
      resourceId: 'audit',
      correlationId: 'backup-roundtrip',
      requestHash: 'b'.repeat(64),
      payload: { verified: true, evidenceHash: HASH },
    });

    const businessDump = await business.dumpDataDir('gzip');
    const auditDump = await audit.dumpDataDir('gzip');
    restoredBusiness = await PGlite.create({ loadDataDir: businessDump });
    restoredAudit = await PGlite.create({ loadDataDir: auditDump });
    const merchantCount = await restoredBusiness.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.merchants',
    );
    const auditRows = await restoredAudit.query<AuditRow>('SELECT * FROM audit.entries ORDER BY sequence');
    assert.equal(merchantCount.rows[0]?.count, '1');
    assert.equal(verifyAuditChain(auditRows.rows), true);
  } finally {
    await restoredBusiness?.close();
    await restoredAudit?.close();
    await business.close();
    await audit.close();
  }
});

test('production backup enforces encrypted storage acknowledgement and mode 600 artifacts', () => {
  for (const path of ['../../scripts/database-backup.mjs', '../../scripts/database-restore.mjs']) {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(path, import.meta.url))]);
  }
  const directory = mkdtempSync(join(tmpdir(), 'abu24k-backup-'));
  try {
    const pgDump = join(directory, 'pg_dump');
    writeFileSync(
      pgDump,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--file" ]; then\n    shift\n    printf "test-dump" > "$1"\n    exit 0\n  fi\n  shift\ndone\nexit 1\n',
      { mode: 0o700 },
    );
    chmodSync(pgDump, 0o700);
    const output = join(directory, 'business.dump');
    execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/database-backup.mjs', import.meta.url)), 'business', output], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        DATABASE_URL: 'postgres://test:test@localhost/business',
        BACKUP_STORAGE_ENCRYPTED: 'true',
      },
      stdio: 'pipe',
    });
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(statSync(`${output}.sha256`).mode & 0o777, 0o600);
    assert.throws(
      () =>
        execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/database-backup.mjs', import.meta.url)), 'business', output], {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ''}`,
            DATABASE_URL: 'postgres://test:test@localhost/business',
            BACKUP_STORAGE_ENCRYPTED: 'true',
          },
          stdio: 'pipe',
        }),
      /Command failed/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('buyer shopping and merchant receivable statements preserve tenant-scoped order ledger evidence', async () => {
  const db = await createBusinessDatabase();
  try {
    const prepared = await prepareRequestedSettlement(db);
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES
         ($1,'BUYER',NULL,'ACTIVE',$3),
         ($2,'MERCHANT','merchant-1','ACTIVE',$3)`,
      [prepared.intent.buyer, prepared.merchantWallet.address.toLowerCase(), HASH],
    );
    const service = new OrderStatementService({ transactions: transactionAdapter(db) });
    const buyer = { walletAddress: prepared.intent.buyer, roles: ['BUYER'] as const };
    const buyerStatements = await service.listBuyerShopping(buyer, { kind: 'ORDINARY', limit: 20 });
    assert.equal(buyerStatements.buyerWallet, prepared.intent.buyer);
    assert.equal(buyerStatements.nextCursor, null);
    assert.deepEqual(buyerStatements.statements.map((statement) => ({
      orderId: statement.orderId,
      orderKind: statement.orderKind,
      paymentAmounts: statement.paymentAmounts,
      bnm: { amount: statement.bnm.amount, state: statement.bnm.state, transferable: statement.bnm.transferable },
    })), [{
      orderId: prepared.intent.orderId,
      orderKind: 'ORDINARY',
      paymentAmounts: {
        productUsdtPaymentAmount: prepared.intent.productUsdtPaymentAmount,
        platformServiceFeeUsdt: prepared.intent.platformServiceFeeUsdt,
        custodyProductUsdt: prepared.intent.custodyProductUsdt,
        freightUsdt: prepared.intent.freightUsdt,
        usdtPaymentAmount: prepared.intent.usdtPaymentAmount,
        nplPaymentAmount: prepared.intent.nplPaymentAmount,
      },
      bnm: { amount: prepared.intent.bnmAmount, state: 'AVAILABLE', transferable: false },
    }]);
    assert.ok(buyerStatements.statements[0]!.bnm.journalIds.length >= 1);
    assert.throws(
      () => service.listBuyerShopping(buyer, { kind: 'SECKILL' }),
      (error: unknown) => error instanceof CoreError && error.code === 'DecisionBlocked',
    );
    assert.throws(
      () => service.listBuyerShopping(buyer, { cursorCreatedAt: prepared.now }),
      /cursor fields must be supplied together/,
    );

    const otherBuyer = Wallet.createRandom();
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES ($1,'BUYER',NULL,'ACTIVE',$2)`,
      [otherBuyer.address.toLowerCase(), HASH_2],
    );
    assert.equal((await service.listBuyerShopping({
      walletAddress: otherBuyer.address,
      roles: ['BUYER'],
    })).statements.length, 0);

    const merchantStatements = await service.listMerchantReceivables(prepared.merchant, { limit: 20 });
    const statement = merchantStatements.statements[0]!;
    assert.equal(merchantStatements.merchantId, 'merchant-1');
    assert.equal(merchantStatements.settlementWallet, prepared.merchantWallet.address.toLowerCase());
    assert.equal(statement.orderId, prepared.intent.orderId);
    assert.equal(statement.frozenAmounts.productUsdtPaymentAmount, prepared.intent.productUsdtPaymentAmount);
    assert.equal(statement.frozenAmounts.freightUsdt, prepared.intent.freightUsdt);
    assert.equal(statement.frozenAmounts.merchantNetReceivableUsdt, prepared.intent.merchantNetReceivableUsdt);
    assert.equal(statement.currentReceivableUsdt, prepared.intent.merchantNetReceivableUsdt);
    assert.equal(statement.removedFromReceivableUsdt, '0');
    assert.deepEqual(statement.receivableLifecycle.map((balance) => ({ state: balance.state, amount: balance.amount })), [
      {
        state: 'AVAILABLE',
        amount: (BigInt(prepared.intent.merchantNetReceivableUsdt) - BigInt(prepared.requestedAmount)).toString(),
      },
      { state: 'REQUESTED', amount: prepared.requestedAmount },
    ]);
    assert.ok(statement.journalEvidence.some((journal) => journal.eventType === 'PAYMENT_LOCKED'));
    assert.ok(statement.journalEvidence.some((journal) => journal.eventType === 'SETTLEMENT_REQUESTED'));
    assert.deepEqual(statement.settlementRefs.map((settlement) => ({
      requestId: settlement.requestId,
      amount: settlement.amount,
      state: settlement.state,
      requestedJournal: settlement.journals.requested,
    })), [{
      requestId: prepared.request.request_id,
      amount: prepared.requestedAmount,
      state: 'REQUESTED',
      requestedJournal: statement.settlementRefs[0]!.journals.requested,
    }]);
    await assert.rejects(
      service.listMerchantReceivables({
        walletAddress: prepared.merchantWallet.address,
        roles: ['MERCHANT'],
        merchantId: 'merchant-other',
      }),
      /MERCHANT binding is not active/,
    );
  } finally {
    await db.close();
  }
});

test('signed settlement request executes one immutable EOA transfer and settles only after 15 confirmations', async () => {
  const db = await createBusinessDatabase();
  try {
    const prepared = await prepareRequestedSettlement(db);
    let now = prepared.now;
    const transfer = await prepared.settlements.createTransfer(prepared.operator, {
      asset: 'USDT',
      gasCap: '100000',
      idempotencyKey: 'eoa-settlement-transfer-1',
      runtime: prepared.runtime,
      correlationId: 'eoa-settlement-transfer-1',
    });
    assert.equal(transfer.state, 'PENDING');
    assert.equal(transfer.amount, prepared.requestedAmount);
    assert.equal((await prepared.settlements.createTransfer(prepared.operator, {
      asset: 'USDT',
      gasCap: '100000',
      idempotencyKey: 'eoa-settlement-transfer-1',
      runtime: prepared.runtime,
      correlationId: 'eoa-settlement-transfer-1-retry',
    })).transferId, transfer.transferId);

    const executionTxHash = `0x${'d'.repeat(64)}`;
    let receipt: EoaSettlementReceipt | undefined;
    let canonicalBlockHash = `0x${'e'.repeat(64)}`;
    let submittedInput: Parameters<ConstructorParameters<typeof SettlementWorker>[0]['broadcaster']['submit']>[0] | undefined;
    const worker = new SettlementWorker({
      transactions: transactionAdapter(db),
      broadcaster: {
        submit: async (input) => {
          submittedInput = input;
          return {
            executionTxHash,
            executorWallet: input.executorWallet,
            executorNonce: input.executorNonce,
            requestDigest: input.requestDigest,
          };
        },
        replace: async () => {
          throw new Error('unexpected replacement');
        },
      },
      chain: {
        receipt: async () => receipt,
        canonicalBlock: async (input) => ({
          canonical: canonicalBlockHash === input.blockHash,
          observedBlockHash: canonicalBlockHash,
          evidenceHash: HASH,
        }),
      },
      clock: () => now,
    });

    assert.equal(await worker.submitOnce(), 1);
    assert.ok(submittedInput);
    assert.equal(submittedInput.transferId, transfer.transferId);
    assert.equal(submittedInput.executorWallet, transfer.executorWallet);
    assert.equal(submittedInput.executorNonce, transfer.executorNonce);
    assert.equal(submittedInput.transferCalldata, transfer.transferCalldata);
    assert.equal((await worker.submitOnce()), 0);
    assert.equal((await prepared.settlements.getAdminRequest(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      prepared.request.request_id,
    )).request.state, 'SUBMITTED');

    receipt = {
      chainId: 56,
      executionTxHash,
      transactionTo: transfer.tokenAddress,
      transactionCalldata: transfer.transferCalldata,
      executorWallet: transfer.executorWallet,
      executorNonce: transfer.executorNonce,
      receiptStatus: 1,
      blockNumber: 1_010,
      blockHash: `0x${'e'.repeat(64)}`,
      confirmations: 14,
      canonicalBlock: true,
      transfers: [{
        tokenAddress: transfer.tokenAddress,
        from: transfer.executorWallet,
        to: transfer.recipientAddress,
        amount: transfer.amount,
      }],
      transactionDeltas: [
        { tokenAddress: transfer.tokenAddress, account: transfer.executorWallet, delta: `-${transfer.amount}` },
        { tokenAddress: transfer.tokenAddress, account: transfer.recipientAddress, delta: transfer.amount },
      ],
      evidenceHash: `0x${'f'.repeat(64)}`,
    };
    assert.equal(await worker.pollFinalityOnce(), 1);
    assert.equal((await prepared.settlements.getAdminTransfer(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      transfer.transferId,
    )).transfer.state, 'MINED');

    receipt = { ...receipt, confirmations: 15 };
    now = new Date(now.getTime() + 60_000);
    assert.equal(await worker.pollFinalityOnce(), 1);
    const settledRequest = await prepared.settlements.getAdminRequest(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      prepared.request.request_id,
    );
    assert.equal(settledRequest.request.state, 'SETTLED');
    assert.deepEqual(settledRequest.request.finalExecutionTxHashes, [executionTxHash]);
    assert.equal((await worker.pollFinalityOnce()), 0);
    await assertLedgerBalanced(db, 1);

    canonicalBlockHash = `0x${'a'.repeat(64)}`;
    assert.equal(await worker.reconcileSettledCanonicalityOnce(), 1);
    const reorgedTransfer = await prepared.settlements.getAdminTransfer(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      transfer.transferId,
    );
    assert.equal(reorgedTransfer.transfer.state, 'RETRYABLE');
    const reorgedRequest = await prepared.settlements.getAdminRequest(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      prepared.request.request_id,
    );
    assert.equal(reorgedRequest.request.state, 'SUBMITTED');
    assert.deepEqual(reorgedRequest.transitions.map((item) => item.type), [
      'REQUESTED',
      'SUBMITTED',
      'SETTLED',
      'FINALITY_REVERSED',
    ]);
    await assertLedgerBalanced(db, 1);
  } finally {
    await db.close();
  }
});

test('ambiguous EOA submission failure retries the original attempt and settles once', async () => {
  const db = await createBusinessDatabase();
  try {
    const prepared = await prepareRequestedSettlement(db);
    let now = prepared.now;
    const transfer = await prepared.settlements.createTransfer(prepared.operator, {
      asset: 'USDT',
      gasCap: '100000',
      idempotencyKey: 'eoa-ambiguous-transfer-1',
      runtime: prepared.runtime,
      correlationId: 'eoa-ambiguous-transfer-1',
    });
    const executionTxHash = `0x${'4'.repeat(64)}`;
    let receipt: EoaSettlementReceipt | undefined;
    const submissions: Parameters<ConstructorParameters<typeof SettlementWorker>[0]['broadcaster']['submit']>[0][] = [];
    let chainBroadcasts = 0;
    const worker = () => new SettlementWorker({
      transactions: transactionAdapter(db),
      broadcaster: {
        submit: async (input) => {
          submissions.push(input);
          if (submissions.length === 1) {
            chainBroadcasts += 1;
            throw new CoreError('ExternalBlocked', 'executor response was lost after broadcast', 503);
          }
          return {
            executionTxHash,
            executorWallet: input.executorWallet,
            executorNonce: input.executorNonce,
            requestDigest: input.requestDigest,
          };
        },
        replace: async () => {
          throw new Error('unexpected replacement');
        },
      },
      chain: {
        receipt: async () => receipt,
        canonicalBlock: async (input) => ({
          canonical: true,
          observedBlockHash: input.blockHash,
          evidenceHash: HASH,
        }),
      },
      clock: () => now,
    });

    await assert.rejects(
      worker().submitOnce(),
      (error: unknown) => error instanceof CoreError && error.code === 'ExternalBlocked',
    );
    let attempts = await db.query<{
      attempt_id: string;
      request_digest: string;
      executor_nonce: string;
      state: string;
    }>(
      `SELECT attempt_id, request_digest, executor_nonce::text, state
       FROM core.settlement_transfer_attempts WHERE transfer_id = $1 ORDER BY attempt_number`,
      [transfer.transferId],
    );
    assert.equal(attempts.rows.length, 1);
    assert.equal(attempts.rows[0]?.state, 'RETRYABLE');
    assert.equal((await prepared.settlements.getAdminTransfer(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      transfer.transferId,
    )).transfer.state, 'RETRYABLE');

    now = new Date(now.getTime() + 1_000);
    const restarted = worker();
    assert.equal(await restarted.submitOnce(), 1);
    assert.equal(submissions.length, 2);
    assert.equal(chainBroadcasts, 1);
    assert.equal(submissions[1]?.idempotencyKey, submissions[0]?.idempotencyKey);
    assert.equal(submissions[1]?.requestDigest, submissions[0]?.requestDigest);
    assert.equal(submissions[1]?.executorNonce, submissions[0]?.executorNonce);
    attempts = await db.query<{
      attempt_id: string;
      request_digest: string;
      executor_nonce: string;
      state: string;
    }>(
      `SELECT attempt_id, request_digest, executor_nonce::text, state
       FROM core.settlement_transfer_attempts WHERE transfer_id = $1 ORDER BY attempt_number`,
      [transfer.transferId],
    );
    assert.deepEqual(attempts.rows.map((row) => row.attempt_id), [submissions[0]!.idempotencyKey]);
    assert.deepEqual(attempts.rows.map((row) => row.state), ['SUBMITTED']);

    const notifications = new NotificationService({ transactions: transactionAdapter(db), clock: () => now });
    for (let projected = await notifications.projectNext(); projected > 0; projected = await notifications.projectNext()) {
      // Drain the finite source outbox so the submitted transfer projection is observable.
    }
    const submittedNotifications = await db.query<{
      source_event_type: string;
      topic: string;
      template_data: { copyKey?: string; executionTxHash?: string };
    }>(
      `SELECT source_event_type, topic, template_data
       FROM core.notification_messages
       WHERE source_event_type = 'SettlementTransferSubmitted'`,
    );
    assert.deepEqual(submittedNotifications.rows, [{
      source_event_type: 'SettlementTransferSubmitted',
      topic: 'SETTLEMENT_SUBMITTED',
      template_data: { copyKey: 'SETTLEMENT_SUBMITTED', aggregateId: transfer.transferId, executionTxHash },
    }]);

    receipt = {
      chainId: 56,
      executionTxHash,
      transactionTo: transfer.tokenAddress,
      transactionCalldata: transfer.transferCalldata,
      executorWallet: transfer.executorWallet,
      executorNonce: transfer.executorNonce,
      receiptStatus: 1,
      blockNumber: 1_030,
      blockHash: `0x${'e'.repeat(64)}`,
      confirmations: 15,
      canonicalBlock: true,
      transfers: [{
        tokenAddress: transfer.tokenAddress,
        from: transfer.executorWallet,
        to: transfer.recipientAddress,
        amount: transfer.amount,
      }],
      transactionDeltas: [
        { tokenAddress: transfer.tokenAddress, account: transfer.executorWallet, delta: `-${transfer.amount}` },
        { tokenAddress: transfer.tokenAddress, account: transfer.recipientAddress, delta: transfer.amount },
      ],
      evidenceHash: `0x${'f'.repeat(64)}`,
    };
    assert.equal(await restarted.pollFinalityOnce(), 1);
    const settled = await prepared.settlements.getAdminRequest(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      prepared.request.request_id,
    );
    assert.equal(settled.request.state, 'SETTLED');
    assert.deepEqual(settled.request.finalExecutionTxHashes, [executionTxHash]);
    await assertLedgerBalanced(db, 1);
  } finally {
    await db.close();
  }
});

test('expired EOA submission lease reuses the same attempt idempotency key', async () => {
  const db = await createBusinessDatabase();
  try {
    const prepared = await prepareRequestedSettlement(db);
    let now = prepared.now;
    const transfer = await prepared.settlements.createTransfer(prepared.operator, {
      asset: 'USDT',
      gasCap: '100000',
      idempotencyKey: 'eoa-expired-lease-transfer-1',
      runtime: prepared.runtime,
      correlationId: 'eoa-expired-lease-transfer-1',
    });
    const attemptId = `settlement-attempt:${transfer.transferId}:1`;
    const requestDigest = `0x${'6'.repeat(64)}`;
    await db.query(
      `UPDATE core.settlement_transfers SET state = 'LEASED' WHERE transfer_id = $1`,
      [transfer.transferId],
    );
    await db.query(
      `INSERT INTO core.settlement_transfer_attempts (
         attempt_id, transfer_id, attempt_number, lease_token, request_digest,
         transaction_to, transaction_calldata, executor_wallet, executor_nonce,
         gas_limit, replacement_for_attempt_id, state, leased_until,
         created_at, updated_at
       ) VALUES ($1,$2,1,'expired-lease-token',$3,$4,$5,$6,$7,$8,NULL,'LEASED',$9,$10,$10)`,
      [
        attemptId,
        transfer.transferId,
        requestDigest,
        transfer.tokenAddress,
        transfer.transferCalldata,
        transfer.executorWallet,
        transfer.executorNonce,
        transfer.gasCap,
        new Date(now.getTime() - 1),
        new Date(now.getTime() - 2 * 60 * 1000),
      ],
    );
    const submissions: Parameters<ConstructorParameters<typeof SettlementWorker>[0]['broadcaster']['submit']>[0][] = [];
    let receipt: EoaSettlementReceipt | undefined;
    const worker = new SettlementWorker({
      transactions: transactionAdapter(db),
      broadcaster: {
        submit: async (input) => {
          submissions.push(input);
          return {
            executionTxHash: `0x${'7'.repeat(64)}`,
            executorWallet: input.executorWallet,
            executorNonce: input.executorNonce,
            requestDigest: input.requestDigest,
          };
        },
        replace: async () => {
          throw new Error('unexpected replacement');
        },
      },
      chain: {
        receipt: async () => receipt,
        canonicalBlock: async (input) => ({
          canonical: true,
          observedBlockHash: input.blockHash,
          evidenceHash: HASH,
        }),
      },
      clock: () => now,
    });

    assert.equal(await worker.recoverExpiredLeaseOnce(), 1);
    now = new Date(now.getTime() + 1_000);
    assert.equal(await worker.submitOnce(), 1);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]?.idempotencyKey, attemptId);
    assert.equal(submissions[0]?.requestDigest, requestDigest);
    assert.equal(submissions[0]?.executorNonce, transfer.executorNonce);
    const attempts = await db.query<{ attempt_id: string; state: string }>(
      `SELECT attempt_id, state FROM core.settlement_transfer_attempts
       WHERE transfer_id = $1 ORDER BY attempt_number`,
      [transfer.transferId],
    );
    assert.deepEqual(attempts.rows, [{ attempt_id: attemptId, state: 'SUBMITTED' }]);
    receipt = {
      chainId: 56,
      executionTxHash: `0x${'7'.repeat(64)}`,
      transactionTo: transfer.tokenAddress,
      transactionCalldata: transfer.transferCalldata,
      executorWallet: transfer.executorWallet,
      executorNonce: transfer.executorNonce,
      receiptStatus: 1,
      blockNumber: 1_031,
      blockHash: `0x${'e'.repeat(64)}`,
      confirmations: 15,
      canonicalBlock: true,
      transfers: [{
        tokenAddress: transfer.tokenAddress,
        from: transfer.executorWallet,
        to: transfer.recipientAddress,
        amount: transfer.amount,
      }],
      transactionDeltas: [
        { tokenAddress: transfer.tokenAddress, account: transfer.executorWallet, delta: `-${transfer.amount}` },
        { tokenAddress: transfer.tokenAddress, account: transfer.recipientAddress, delta: transfer.amount },
      ],
      evidenceHash: `0x${'f'.repeat(64)}`,
    };
    assert.equal(await worker.pollFinalityOnce(), 1);
    assert.equal((await prepared.settlements.getAdminRequest(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      prepared.request.request_id,
    )).request.state, 'SETTLED');
  } finally {
    await db.close();
  }
});

test('deterministic EOA replacement rejection quarantines the submitted transfer', async () => {
  const db = await createBusinessDatabase();
  try {
    const prepared = await prepareRequestedSettlement(db);
    const transfer = await prepared.settlements.createTransfer(prepared.operator, {
      asset: 'USDT',
      gasCap: '100000',
      idempotencyKey: 'eoa-replacement-deterministic-4xx-transfer-1',
      runtime: prepared.runtime,
      correlationId: 'eoa-replacement-deterministic-4xx-transfer-1',
    });
    let now = prepared.now;
    const worker = new SettlementWorker({
      transactions: transactionAdapter(db),
      broadcaster: {
        submit: async (input) => ({
          executionTxHash: `0x${'2'.repeat(64)}`,
          executorWallet: input.executorWallet,
          executorNonce: input.executorNonce,
          requestDigest: input.requestDigest,
        }),
        replace: async () => {
          throw new CoreError('InvalidRequest', 'executor rejected exact calldata', 400, {
            deterministicExecutorFailure: true,
            executorErrorCode: 'CALLDATA_MISMATCH',
          });
        },
      },
      chain: {
        receipt: async () => undefined,
        canonicalBlock: async (input) => ({
          canonical: true,
          observedBlockHash: input.blockHash,
          evidenceHash: HASH,
        }),
      },
      replacementDelayMs: 1_000,
      clock: () => now,
    });

    assert.equal(await worker.submitOnce(), 1);
    now = new Date(now.getTime() + 1_001);
    await assert.rejects(
      worker.replaceOnce(),
      (error: unknown) => error instanceof CoreError && error.code === 'InvalidRequest',
    );
    const attempts = await db.query<{ state: string }>(
      'SELECT state FROM core.settlement_transfer_attempts WHERE transfer_id = $1 ORDER BY attempt_number',
      [transfer.transferId],
    );
    assert.deepEqual(attempts.rows.map((row) => row.state), ['SUBMITTED', 'QUARANTINED']);
    assert.equal(await worker.replaceOnce(), 0);
    assert.equal((await prepared.settlements.getAdminTransfer(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      transfer.transferId,
    )).transfer.state, 'QUARANTINED');
    assert.equal((await prepared.settlements.getAdminRequest(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      prepared.request.request_id,
    )).request.state, 'QUARANTINED');
  } finally {
    await db.close();
  }
});

test('deterministic EOA executor 4xx quarantines without creating a replacement attempt', async () => {
  const db = await createBusinessDatabase();
  try {
    const prepared = await prepareRequestedSettlement(db);
    const transfer = await prepared.settlements.createTransfer(prepared.operator, {
      asset: 'USDT',
      gasCap: '100000',
      idempotencyKey: 'eoa-deterministic-4xx-transfer-1',
      runtime: prepared.runtime,
      correlationId: 'eoa-deterministic-4xx-transfer-1',
    });
    const worker = new SettlementWorker({
      transactions: transactionAdapter(db),
      broadcaster: {
        submit: async () => {
          throw new CoreError('InvalidRequest', 'executor amount mismatch', 400, {
            deterministicExecutorFailure: true,
            executorErrorCode: 'AMOUNT_MISMATCH',
          });
        },
        replace: async () => {
          throw new Error('unexpected replacement');
        },
      },
      chain: {
        receipt: async () => undefined,
        canonicalBlock: async (input) => ({
          canonical: true,
          observedBlockHash: input.blockHash,
          evidenceHash: HASH,
        }),
      },
      clock: () => prepared.now,
    });

    await assert.rejects(
      worker.submitOnce(),
      (error: unknown) => error instanceof CoreError && error.code === 'InvalidRequest',
    );
    const attempts = await db.query<{ state: string }>(
      'SELECT state FROM core.settlement_transfer_attempts WHERE transfer_id = $1 ORDER BY attempt_number',
      [transfer.transferId],
    );
    assert.deepEqual(attempts.rows.map((row) => row.state), ['QUARANTINED']);
    assert.equal((await prepared.settlements.getAdminTransfer(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      transfer.transferId,
    )).transfer.state, 'QUARANTINED');
    assert.equal((await prepared.settlements.getAdminRequest(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      prepared.request.request_id,
    )).request.state, 'QUARANTINED');
    assert.equal(await worker.submitOnce(), 0);
  } finally {
    await db.close();
  }
});

test('Admin clearing read model exposes requests and immutable EOA transfer evidence without a write path', async () => {
  const db = await createBusinessDatabase();
  try {
    const prepared = await prepareRequestedSettlement(db);
    const transfer = await prepared.settlements.createTransfer(prepared.operator, {
      asset: 'USDT',
      gasCap: '100000',
      idempotencyKey: 'admin-eoa-transfer-1',
      runtime: prepared.runtime,
      correlationId: 'admin-eoa-transfer-1',
    });
    const admin = {
      walletAddress: '0x9999999999999999999999999999999999999998',
      roles: ['ADMIN'] as const,
    };
    const requests = await prepared.settlements.listAdminRequests(admin, {
      merchantId: 'merchant-1',
      orderId: prepared.intent.orderId,
      transferId: transfer.transferId,
      state: 'REQUESTED',
      limit: 20,
    });
    assert.equal(requests.requests.length, 1);
    assert.equal(requests.requests[0]?.requestId, prepared.request.request_id);
    assert.deepEqual(requests.requests[0]?.transferIds, [transfer.transferId]);

    const transfers = await prepared.settlements.listAdminTransfers(admin, {
      merchantId: 'merchant-1',
      executorWallet: prepared.runtime.executorWallet,
      state: 'PENDING',
      limit: 20,
    });
    assert.equal(transfers.transfers.length, 1);
    assert.equal(transfers.transfers[0]?.transferId, transfer.transferId);
    assert.equal(transfers.transfers[0]?.executorNonce, prepared.runtime.nextNonce);

    const detail = await prepared.settlements.getAdminTransfer(admin, transfer.transferId);
    assert.equal(detail.transfer.contentHash, transfer.contentHash);
    assert.equal(detail.transfer.transferCalldata, transfer.transferCalldata);
    assert.equal(detail.coverage?.covered, true);
    assert.deepEqual(detail.attempts, []);

    assert.throws(
      () => prepared.settlements.listAdminTransfers(
        { walletAddress: BUYER, roles: ['BUYER'] },
        { limit: 20 },
      ),
      /ADMIN or OPERATOR or AUDITOR role is required/,
    );
    assert.throws(
      () => prepared.settlements.listAdminRequests(admin, { cursorRequestedAt: prepared.now }),
      /cursor is incomplete/,
    );
  } finally {
    await db.close();
  }
});
test('coverage worker derives per-wallet liabilities, pauses on deficit and never auto-resumes', async () => {
  const db = await createBusinessDatabase();
  try {
    await recordFinalPayment(db);
    let observation: CoverageObservation = {
      chainId: 56,
      blockNumber: 1_000,
      blockHash: `0x${'7'.repeat(64)}`,
      canonical: true,
      evidenceHash: `0x${'8'.repeat(64)}`,
      observedAt: new Date(),
      assets: [
        {
          walletAddress: '0x3333333333333333333333333333333333333333',
          asset: 'USDT',
          tokenAddress: '0x55d398326f99059ff775485246999027b3197955',
          balance: '68',
        },
        {
          walletAddress: '0x4444444444444444444444444444444444444444',
          asset: 'NPL',
          tokenAddress: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2',
          balance: '100',
        },
      ],
    };
    const worker = new CoverageWorker({
      transactions: transactionAdapter(db),
      source: { observe: async () => observation },
      expectedAssets: observation.assets.map((item) => ({
        walletAddress: item.walletAddress,
        asset: item.asset,
        tokenAddress: item.tokenAddress,
      })),
      paymentRouterAddress: '0x9999999999999999999999999999999999999999',
      governanceWalletAddress: '0x8888888888888888888888888888888888888888',
    });
    const deficient = await worker.pollOnce();
    assert.deepEqual(Object.fromEntries(deficient.assets.map((item) => [item.asset, {
      liability: item.unsettledLiability,
      met: item.coverageMet,
    }])), {
      USDT: { liability: '69', met: false },
      NPL: { liability: '100', met: true },
    });
    const paused = await db.query<{ scope: string }>(
      'SELECT scope FROM core.circuit_breakers WHERE paused ORDER BY scope',
    );
    assert.deepEqual(paused.rows.map((row) => row.scope), ['NEW_PAYMENT', 'NEW_SETTLEMENT_BATCH']);
    const actions = await db.query<{
      action: string;
      target_paused: boolean;
      evidence_hash: string;
      router_address: string;
      state: string;
      calldata: string;
    }>('SELECT action, target_paused, evidence_hash, router_address, state, calldata FROM core.coverage_breaker_actions');
    assert.equal(actions.rows.length, 1);
    assert.deepEqual({ ...actions.rows[0], calldata: undefined }, {
      action: 'PAUSE',
      target_paused: true,
      evidence_hash: observation.evidenceHash,
      router_address: '0x9999999999999999999999999999999999999999',
      state: 'PENDING_EXECUTION',
      calldata: undefined,
    });
    assert.equal(
      actions.rows[0]?.calldata,
      new Interface(['function setNewPaymentsPaused(bool paused,bytes32 evidenceHash)'])
        .encodeFunctionData('setNewPaymentsPaused', [true, observation.evidenceHash])
        .toLowerCase(),
    );

    observation = {
      ...observation,
      blockNumber: 1_001,
      blockHash: `0x${'9'.repeat(64)}`,
      evidenceHash: `0x${'a'.repeat(64)}`,
      observedAt: new Date(observation.observedAt.getTime() + 60_000),
      assets: observation.assets.map((item) => ({ ...item, balance: item.asset === 'USDT' ? '70' : '100' })),
    };
    const recovered = await worker.pollOnce();
    assert.ok(recovered.assets.every((item) => item.coverageMet));
    assert.equal((await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.breaker_causes
       WHERE cause_type = 'COVERAGE' AND active`,
    )).rows[0]?.count, '2');
    assert.equal((await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.outbox_events
       WHERE event_type = 'CoverageRecoveryAwaitingGovernance'`,
    )).rows[0]?.count, '1');

    await worker.recordCanonicality({
      snapshotId: recovered.snapshotId,
      canonical: false,
      observedBlockHash: `0x${'b'.repeat(64)}`,
      evidenceHash: `0x${'c'.repeat(64)}`,
      observedAt: new Date(observation.observedAt.getTime() + 30_000),
    });
    const canonicality = await db.query<{ canonical: boolean }>(
      `SELECT canonical FROM core.coverage_snapshot_canonicality
       WHERE snapshot_id = $1 ORDER BY observed_at`,
      [recovered.snapshotId],
    );
    assert.deepEqual(canonicality.rows.map((row) => row.canonical), [true, false]);
  } finally {
    await db.close();
  }
});

test('coverage breaker EOA action retries, reaches finality and replaces reorged execution without reopening payments', async () => {
  const db = await createBusinessDatabase();
  try {
    await recordFinalPayment(db);
    const observation: CoverageObservation = {
      chainId: 56,
      blockNumber: 2_000,
      blockHash: `0x${'7'.repeat(64)}`,
      canonical: true,
      evidenceHash: `0x${'8'.repeat(64)}`,
      observedAt: new Date('2026-07-15T09:00:00.000Z'),
      assets: [{
        walletAddress: '0x3333333333333333333333333333333333333333',
        asset: 'USDT',
        tokenAddress: '0x55d398326f99059ff775485246999027b3197955',
        balance: '68',
      }],
    };
    const coverage = new CoverageWorker({
      transactions: transactionAdapter(db),
      source: { observe: async () => observation },
      expectedAssets: observation.assets,
      paymentRouterAddress: '0x9999999999999999999999999999999999999999',
      governanceWalletAddress: '0x8888888888888888888888888888888888888888',
    });
    await coverage.pollOnce();

    let rejectExecution = true;
    let phase: 'MINED' | 'FINAL' | 'REORGED' = 'MINED';
    let executions = 0;
    const governance = new CoverageBreakerGovernanceWorker({
      transactions: transactionAdapter(db),
      executor: {
        execute: async (input) => {
          executions += 1;
          if (rejectExecution) throw new CoreError('ExternalBlocked', 'EOA executor unavailable', 503);
          const executorNonce = String(executions);
          return {
            executorWallet: input.governanceWallet,
            executorNonce,
            submittedTxHash: keccak256(toUtf8Bytes(`coverage-execution:${input.actionId}:${executorNonce}`)),
            executionEvidenceHash: `0x${'4'.repeat(64)}`,
          };
        },
      },
      chain: {
        observe: async (candidate): Promise<CoverageBreakerObservation> => {
          const base = {
            submittedTxHash: candidate.submittedTxHash,
            executionTxHash: `0x${'5'.repeat(64)}`,
            blockNumber: 2_001,
            blockHash: `0x${'6'.repeat(64)}`,
            targetPaused: true,
            evidenceHash: candidate.evidenceHash,
          };
          if (phase === 'REORGED') return {
            state: 'REORGED',
            ...base,
            canonicalBlockHash: `0x${'9'.repeat(64)}`,
            confirmations: 0,
            canonical: false,
            observationEvidenceHash: `0x${'a'.repeat(64)}`,
          };
          const confirmations = phase === 'FINAL' ? 15 : 14;
          return {
            state: phase,
            ...base,
            confirmations,
            canonical: true,
            observationEvidenceHash: phase === 'FINAL' ? `0x${'b'.repeat(64)}` : `0x${'c'.repeat(64)}`,
          };
        },
      },
    });

    await governance.pollOnce();
    assert.equal(executions, 1);
    assert.equal((await db.query<{ state: string }>(
      'SELECT state FROM core.coverage_breaker_actions',
    )).rows[0]?.state, 'PENDING_EXECUTION');

    rejectExecution = false;
    await governance.pollOnce();
    assert.equal(executions, 2);
    assert.equal((await db.query<{ state: string }>(
      'SELECT state FROM core.coverage_breaker_actions',
    )).rows[0]?.state, 'MINED');

    phase = 'FINAL';
    await governance.pollOnce();
    assert.equal((await db.query<{ state: string; confirmations: number }>(
      'SELECT state, confirmations FROM core.coverage_breaker_actions',
    )).rows[0]?.state, 'FINAL');
    const finalEvidenceCounts = async () => ({
      transitions: (await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM core.coverage_breaker_action_transitions',
      )).rows[0]?.count,
      audits: (await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM core.audit_outbox_events WHERE resource_type = 'COVERAGE_BREAKER_ACTION'",
      )).rows[0]?.count,
    });
    const beforeRepeatedFinal = await finalEvidenceCounts();
    await governance.pollOnce();
    assert.deepEqual(await finalEvidenceCounts(), beforeRepeatedFinal);

    phase = 'REORGED';
    await governance.pollOnce();
    const afterReorg = await db.query<{ state: string; replaces_action_id: string | null }>(
      'SELECT state, replaces_action_id FROM core.coverage_breaker_actions ORDER BY created_at, action_id',
    );
    assert.deepEqual(afterReorg.rows.map((row) => row.state).sort(), ['PENDING_EXECUTION', 'REORGED']);
    assert.ok(afterReorg.rows.find((row) => row.state === 'PENDING_EXECUTION')?.replaces_action_id);
    assert.equal((await db.query<{ paused: boolean }>(
      "SELECT paused FROM core.circuit_breakers WHERE scope = 'NEW_PAYMENT'",
    )).rows[0]?.paused, true);
  } finally {
    await db.close();
  }
});

test('coverage breaker EOA nonces keep an earlier RESUME before every later PAUSE', async () => {
  const db = await createBusinessDatabase();
  try {
    await recordFinalPayment(db);
    const governanceWallet = '0x8888888888888888888888888888888888888888';
    const paymentRouter = '0x9999999999999999999999999999999999999999';
    const breaker = new Interface(['function setNewPaymentsPaused(bool paused,bytes32 evidenceHash)']);
    const resumeActionId = `0x${'d'.repeat(64)}`;
    const pauseActionId = `0x${'e'.repeat(64)}`;
    const resumeSnapshotId = `0x${'f'.repeat(64)}`;
    const pauseSnapshotId = `0x${'a'.repeat(64)}`;
    const resumeEvidenceHash = `0x${'b'.repeat(64)}`;
    const pauseEvidenceHash = `0x${'c'.repeat(64)}`;
    const resumeCalldata = breaker.encodeFunctionData(
      'setNewPaymentsPaused',
      [false, resumeEvidenceHash],
    ).toLowerCase();
    const pauseCalldata = breaker.encodeFunctionData(
      'setNewPaymentsPaused',
      [true, pauseEvidenceHash],
    ).toLowerCase();
    const resumeCreatedAt = new Date('2026-07-15T11:00:00.000Z');
    const pauseCreatedAt = new Date('2026-07-15T11:01:00.000Z');
    await db.query(
      `INSERT INTO core.coverage_snapshots (
         snapshot_id, chain_id, block_number, block_hash, canonical, evidence_hash, recorded_at
       ) VALUES
         ($1,56,4000,$2,true,$3,$4),
         ($5,56,4001,$6,true,$7,$8)`,
      [
        resumeSnapshotId,
        `0x${'1'.repeat(64)}`,
        resumeEvidenceHash,
        resumeCreatedAt,
        pauseSnapshotId,
        `0x${'2'.repeat(64)}`,
        pauseEvidenceHash,
        pauseCreatedAt,
      ],
    );
    await db.query(
      `INSERT INTO core.coverage_breaker_actions (
         action_id, snapshot_id, policy_version, action, target_paused, evidence_hash,
         governance_wallet_address, router_address, calldata, calldata_hash, state,
         actor_wallet, secondary_signer, secondary_signature_hash,
         approval_nonce, approval_deadline, created_at, updated_at
       ) VALUES (
         $1,$2,1,'RESUME',false,$3,$4,$5,$6,$7,'PENDING_EXECUTION',
         $8,$9,$10,1,$11,$12,$12
       )`,
      [
        resumeActionId,
        resumeSnapshotId,
        resumeEvidenceHash,
        governanceWallet,
        paymentRouter,
        resumeCalldata,
        keccak256(resumeCalldata).toLowerCase(),
        BUYER,
        MERCHANT,
        HASH,
        new Date('2026-07-15T11:15:00.000Z'),
        resumeCreatedAt,
      ],
    );

    let executedNonce = '20';
    const requestedMinimums: string[] = [];
    const governance = new CoverageBreakerGovernanceWorker({
      transactions: transactionAdapter(db),
      executor: {
        execute: async (input) => {
          requestedMinimums.push(input.minimumExecutorNonce);
          return {
            executorWallet: input.governanceWallet,
            executorNonce: executedNonce,
            submittedTxHash: keccak256(toUtf8Bytes(`coverage-execution:${input.actionId}:${executedNonce}`)),
            executionEvidenceHash: `0x${'3'.repeat(64)}`,
          };
        },
      },
      chain: { observe: async () => ({ state: 'NOT_FOUND' }) },
    });
    await governance.pollOnce();

    await db.query(
      `INSERT INTO core.coverage_breaker_actions (
         action_id, snapshot_id, policy_version, action, target_paused, evidence_hash,
         governance_wallet_address, router_address, calldata, calldata_hash,
         state, created_at, updated_at
       ) VALUES ($1,$2,1,'PAUSE',true,$3,$4,$5,$6,$7,'PENDING_EXECUTION',$8,$8)`,
      [
        pauseActionId,
        pauseSnapshotId,
        pauseEvidenceHash,
        governanceWallet,
        paymentRouter,
        pauseCalldata,
        keccak256(pauseCalldata).toLowerCase(),
        pauseCreatedAt,
      ],
    );

    executedNonce = '19';
    await governance.pollOnce();
    assert.deepEqual((await db.query<{ state: string; executor_nonce: string | null }>(
      'SELECT state, executor_nonce::text FROM core.coverage_breaker_actions WHERE action_id = $1',
      [pauseActionId],
    )).rows[0], { state: 'PENDING_EXECUTION', executor_nonce: null });
    assert.equal(governance.status().errorCode, 'InvalidFinality');

    executedNonce = '21';
    await governance.pollOnce();
    const actions = await db.query<{ action: string; state: string; executor_nonce: string }>(
      `SELECT action, state, executor_nonce::text
       FROM core.coverage_breaker_actions ORDER BY created_at, action_id`,
    );
    assert.deepEqual(actions.rows, [
      { action: 'RESUME', state: 'SUBMITTED', executor_nonce: '20' },
      { action: 'PAUSE', state: 'SUBMITTED', executor_nonce: '21' },
    ]);
    assert.deepEqual(requestedMinimums, ['0', '21', '21']);
    await assert.rejects(
      db.query('UPDATE core.coverage_breaker_actions SET executor_nonce = 22 WHERE action_id = $1', [pauseActionId]),
      /ImmutableRecord/,
    );
  } finally {
    await db.close();
  }
});

test('coverage recovery requires independent EIP-712 approval and EOA finality, then re-pauses on reorg', async () => {
  const db = await createBusinessDatabase();
  try {
    await recordFinalPayment(db);
    const admin = Wallet.createRandom();
    const secondary = Wallet.createRandom();
    const governanceWallet = '0x8888888888888888888888888888888888888888';
    const paymentRouter = '0x9999999999999999999999999999999999999999';
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES ($1,'ADMIN',NULL,'ACTIVE',$2)`,
      [admin.address.toLowerCase(), `0x${'1'.repeat(64)}`],
    );
    let observation: CoverageObservation = {
      chainId: 56,
      blockNumber: 3_000,
      blockHash: `0x${'2'.repeat(64)}`,
      canonical: true,
      evidenceHash: `0x${'3'.repeat(64)}`,
      observedAt: new Date('2026-07-15T10:00:00.000Z'),
      assets: [{
        walletAddress: '0x3333333333333333333333333333333333333333',
        asset: 'USDT',
        tokenAddress: '0x55d398326f99059ff775485246999027b3197955',
        balance: '68',
      }],
    };
    const coverage = new CoverageWorker({
      transactions: transactionAdapter(db),
      source: { observe: async () => observation },
      expectedAssets: observation.assets,
      paymentRouterAddress: paymentRouter,
      governanceWalletAddress: governanceWallet,
    });
    await coverage.pollOnce();

    let executionNumber = 0;
    let resumePhase: 'FINAL' | 'REORGED' = 'FINAL';
    const governance = new CoverageBreakerGovernanceWorker({
      transactions: transactionAdapter(db),
      executor: {
        execute: async (input) => {
          executionNumber += 1;
          const executorNonce = String(executionNumber);
          return {
            executorWallet: input.governanceWallet,
            executorNonce,
            submittedTxHash: keccak256(toUtf8Bytes(`coverage-execution:${input.actionId}:${executorNonce}`)),
            executionEvidenceHash: `0x${String((executionNumber % 6) + 4).repeat(64)}`,
          };
        },
      },
      chain: {
        observe: async (candidate): Promise<CoverageBreakerObservation> => {
          const executionTxHash = candidate.targetPaused ? `0x${'a'.repeat(64)}` : `0x${'b'.repeat(64)}`;
          const blockHash = candidate.targetPaused ? `0x${'c'.repeat(64)}` : `0x${'d'.repeat(64)}`;
          const base = {
            submittedTxHash: candidate.submittedTxHash,
            executionTxHash,
            blockNumber: candidate.targetPaused ? 3_001 : 3_003,
            blockHash,
            targetPaused: candidate.targetPaused,
            evidenceHash: candidate.evidenceHash,
          };
          if (!candidate.targetPaused && resumePhase === 'REORGED') return {
            state: 'REORGED',
            ...base,
            canonicalBlockHash: `0x${'e'.repeat(64)}`,
            confirmations: 0,
            canonical: false,
            observationEvidenceHash: `0x${'f'.repeat(64)}`,
          };
          return {
            state: 'FINAL',
            ...base,
            confirmations: 15,
            canonical: true,
            observationEvidenceHash: candidate.targetPaused ? `0x${'4'.repeat(64)}` : `0x${'5'.repeat(64)}`,
          };
        },
      },
    });
    await governance.pollOnce();
    assert.equal((await db.query<{ state: string }>(
      "SELECT state FROM core.coverage_breaker_actions WHERE action = 'PAUSE'",
    )).rows[0]?.state, 'FINAL');

    observation = {
      ...observation,
      blockNumber: 3_002,
      blockHash: `0x${'6'.repeat(64)}`,
      evidenceHash: `0x${'7'.repeat(64)}`,
      observedAt: new Date('2026-07-15T10:02:00.000Z'),
      assets: observation.assets.map((item) => ({ ...item, balance: '69' })),
    };
    await coverage.pollOnce();
    let clock = new Date('2026-07-15T10:03:00.000Z');
    const service = new CoverageBreakerService({
      transactions: transactionAdapter(db),
      governanceWalletAddress: governanceWallet,
      paymentRouterAddress: paymentRouter,
      secondarySignerAddress: secondary.address,
      clock: () => clock,
    });
    const actor = { walletAddress: admin.address, roles: ['ADMIN'] as const };
    const deadline = String(Math.floor(clock.getTime() / 1_000) + 600);
    await assert.rejects(
      service.resumeChallenge({ walletAddress: admin.address, roles: ['OPERATOR'] }, { nonce: '9', deadline }),
      /cannot govern coverage recovery/,
    );
    const challenge = await service.resumeChallenge(actor, { nonce: '9', deadline });
    assert.equal(challenge.signer, secondary.address.toLowerCase());
    observation = {
      ...observation,
      blockNumber: 3_003,
      blockHash: `0x${'8'.repeat(64)}`,
      evidenceHash: `0x${'9'.repeat(64)}`,
      observedAt: new Date('2026-07-15T10:02:30.000Z'),
    };
    await coverage.pollOnce();
    const wrongSignature = await admin.signTypedData(
      challenge.typedData.domain,
      challenge.typedData.types,
      challenge.typedData.message,
    );
    await assert.rejects(
      service.submitResume(actor, {
        snapshotId: challenge.snapshotId,
        nonce: '9',
        deadline,
        signature: wrongSignature,
        correlationId: 'coverage-resume-wrong-signer',
      }),
      /Secondary signer mismatch/,
    );
    const signature = await secondary.signTypedData(
      challenge.typedData.domain,
      challenge.typedData.types,
      challenge.typedData.message,
    );
    const requested = await service.submitResume(actor, {
      snapshotId: challenge.snapshotId,
      nonce: '9',
      deadline,
      signature,
      correlationId: 'coverage-resume-test',
    });
    assert.equal(requested.action, 'RESUME');
    assert.equal(requested.state, 'PENDING_EXECUTION');
    assert.equal((await service.submitResume(actor, {
      snapshotId: challenge.snapshotId,
      nonce: '9',
      deadline,
      signature,
      correlationId: 'coverage-resume-retry',
    })).actionId, requested.actionId);
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.breaker_causes WHERE cause_type = 'COVERAGE' AND active",
    )).rows[0]?.count, '2');

    observation = {
      ...observation,
      blockNumber: 3_004,
      blockHash: `0x${'a'.repeat(64)}`,
      evidenceHash: `0x${'b'.repeat(64)}`,
      observedAt: new Date('2026-07-15T10:03:10.000Z'),
      assets: observation.assets.map((item) => ({ ...item, balance: '68' })),
    };
    await coverage.pollOnce();
    await governance.pollOnce();
    assert.equal((await db.query<{ state: string }>(
      'SELECT state FROM core.coverage_breaker_actions WHERE action_id = $1',
      [requested.actionId],
    )).rows[0]?.state, 'SUPERSEDED');
    assert.equal((await db.query<{ state: string }>(
      "SELECT state FROM core.coverage_breaker_actions WHERE action = 'PAUSE' ORDER BY created_at DESC LIMIT 1",
    )).rows[0]?.state, 'FINAL');

    observation = {
      ...observation,
      blockNumber: 3_005,
      blockHash: `0x${'c'.repeat(64)}`,
      evidenceHash: `0x${'d'.repeat(64)}`,
      observedAt: new Date('2026-07-15T10:04:00.000Z'),
      assets: observation.assets.map((item) => ({ ...item, balance: '69' })),
    };
    await coverage.pollOnce();
    clock = new Date('2026-07-15T10:05:00.000Z');
    const finalDeadline = String(Math.floor(clock.getTime() / 1_000) + 600);
    const finalChallenge = await service.resumeChallenge(actor, { nonce: '10', deadline: finalDeadline });
    const finalSignature = await secondary.signTypedData(
      finalChallenge.typedData.domain,
      finalChallenge.typedData.types,
      finalChallenge.typedData.message,
    );
    const finalResume = await service.submitResume(actor, {
      snapshotId: finalChallenge.snapshotId,
      nonce: '10',
      deadline: finalDeadline,
      signature: finalSignature,
      correlationId: 'coverage-resume-after-superseded',
    });
    await governance.pollOnce();
    assert.equal((await db.query<{ state: string }>(
      'SELECT state FROM core.coverage_breaker_actions WHERE action_id = $1',
      [finalResume.actionId],
    )).rows[0]?.state, 'FINAL');
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.breaker_causes WHERE cause_type = 'COVERAGE' AND active",
    )).rows[0]?.count, '0');
    assert.deepEqual((await db.query<{ paused: boolean }>(
      'SELECT paused FROM core.circuit_breakers ORDER BY scope',
    )).rows.map((row) => row.paused), [false, false]);

    resumePhase = 'REORGED';
    clock = new Date('2026-07-15T10:06:00.000Z');
    await governance.pollOnce();
    const reorgBreakers = (await db.query<{ paused: boolean }>(
      'SELECT paused FROM core.circuit_breakers ORDER BY scope',
    )).rows.map((row) => row.paused);
    const reorgEvidence = {
      worker: governance.status(),
      actions: (await db.query<{
        action: string;
        state: string;
        replaces_action_id: string | null;
      }>(
        'SELECT action, state, replaces_action_id FROM core.coverage_breaker_actions ORDER BY created_at, action_id',
      )).rows,
      causes: (await db.query<{ scope: string; cause_id: string; active: boolean }>(
        "SELECT scope, cause_id, active FROM core.breaker_causes WHERE cause_type = 'COVERAGE' ORDER BY scope, cause_id",
      )).rows,
    };
    assert.deepEqual(reorgBreakers, [true, true], JSON.stringify(reorgEvidence));
    assert.equal((await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.coverage_breaker_actions
       WHERE action = 'RESUME' AND state = 'PENDING_EXECUTION'`,
    )).rows[0]?.count, '1');

    resumePhase = 'FINAL';
    clock = new Date('2026-07-15T10:07:00.000Z');
    await governance.pollOnce();
    assert.deepEqual((await db.query<{ paused: boolean }>(
      'SELECT paused FROM core.circuit_breakers ORDER BY scope',
    )).rows.map((row) => row.paused), [false, false]);
  } finally {
    await db.close();
  }
});

test('settlement transfer creation fails closed on the latest non-canonical coverage observation', async () => {
  const db = await createBusinessDatabase();
  try {
    const prepared = await prepareRequestedSettlement(db);
    const observedAt = new Date(prepared.now.getTime() + 60_000);
    await db.query(
      `INSERT INTO core.coverage_snapshots (
         snapshot_id, chain_id, block_number, block_hash, canonical, evidence_hash, recorded_at
       ) VALUES ('coverage:latest:1', 56, 1001, $1, true, $2, $3)`,
      [`0x${'c'.repeat(64)}`, `0x${'d'.repeat(64)}`, observedAt],
    );
    await db.query(
      `INSERT INTO core.coverage_snapshot_items (
         snapshot_id, wallet_address, asset, verified_asset_balance,
         unsettled_liability, coverage_met
       ) VALUES ('coverage:latest:1', $1, 'USDT', 70, 70, true)`,
      [prepared.runtime.executorWallet],
    );
    await db.query(
      `INSERT INTO core.coverage_snapshot_canonicality (
         observation_id, snapshot_id, canonical, observed_block_hash, evidence_hash, observed_at
       ) VALUES
         ('coverage-observation:latest:true', 'coverage:latest:1', true, $1, $2, $5),
         ('coverage-observation:latest:false', 'coverage:latest:1', false, $3, $4, $5)`,
      [
        `0x${'c'.repeat(64)}`,
        `0x${'d'.repeat(64)}`,
        `0x${'e'.repeat(64)}`,
        `0x${'f'.repeat(64)}`,
        new Date(observedAt.getTime() + 1_000),
      ],
    );
    await assert.rejects(
      prepared.settlements.createTransfer(prepared.operator, {
        asset: 'USDT',
        gasCap: '100000',
        idempotencyKey: 'eoa-settlement-latest-noncanonical',
        runtime: prepared.runtime,
        correlationId: 'eoa-settlement-latest-noncanonical',
      }),
      /coverage evidence is unavailable/,
    );
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.settlement_transfers',
    )).rows[0]?.count, '0');
  } finally {
    await db.close();
  }
});

test('payment reorg quarantines a requested settlement before an EOA transfer can be created', async () => {
  const db = await createBusinessDatabase();
  try {
    const prepared = await prepareRequestedSettlement(db);
    assert.equal((await reversePayment(db, prepared.intent)).status, 'REVERSED');
    assert.equal((await db.query<{ merchant_id: string }>(
      "SELECT merchant_id FROM core.audit_outbox_events WHERE event_type = 'PaymentFinalityReorged'",
    )).rows[0]?.merchant_id, 'merchant-1');
    const request = await db.query<{ state: string }>(
      'SELECT state FROM core.settlement_requests WHERE request_id = $1',
      [prepared.request.request_id],
    );
    assert.deepEqual(request.rows[0], { state: 'QUARANTINED' });
    const exposure = await db.query<{
      previous_request_state: string;
      previous_transfer_state: string | null;
      final_execution_tx_hash: string | null;
      resolution_state: string;
    }>(
      `SELECT previous_request_state, previous_transfer_state,
         final_execution_tx_hash, resolution_state
       FROM core.settlement_payment_reorg_exposures WHERE request_id = $1`,
      [prepared.request.request_id],
    );
    assert.deepEqual(exposure.rows[0], {
      previous_request_state: 'REQUESTED',
      previous_transfer_state: null,
      final_execution_tx_hash: null,
      resolution_state: 'OPEN',
    });
    const requested = await db.query<{ amount: string }>(
      `SELECT COALESCE(sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END),0)::text AS amount
       FROM core.ledger_lines line
       JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
       WHERE journal.order_id = $1 AND line.balance_state = 'REQUESTED'`,
      [prepared.intent.orderId],
    );
    assert.equal(requested.rows[0]?.amount, '0');
    await assert.rejects(
      prepared.settlements.createTransfer(prepared.operator, {
        asset: 'USDT',
        gasCap: '100000',
        idempotencyKey: 'reorged-request-must-not-transfer',
        runtime: prepared.runtime,
        correlationId: 'reorged-request-must-not-transfer',
      }),
      /paused/,
    );
  } finally {
    await db.close();
  }
});

test('EOA replacement preserves executor nonce and exact transfer calldata before final settlement', async () => {
  const db = await createBusinessDatabase();
  try {
    const prepared = await prepareRequestedSettlement(db);
    const transfer = await prepared.settlements.createTransfer(prepared.operator, {
      asset: 'USDT',
      gasCap: '100000',
      idempotencyKey: 'eoa-replacement-transfer-1',
      runtime: prepared.runtime,
      correlationId: 'eoa-replacement-transfer-1',
    });
    let now = prepared.now;
    const firstExecutionTxHash = `0x${'2'.repeat(64)}`;
    const replacementExecutionTxHash = `0x${'3'.repeat(64)}`;
    let replacementInput: Parameters<ConstructorParameters<typeof SettlementWorker>[0]['broadcaster']['replace']>[0] | undefined;
    let receipt: EoaSettlementReceipt | undefined;
    const worker = new SettlementWorker({
      transactions: transactionAdapter(db),
      broadcaster: {
        submit: async (input) => ({
          executionTxHash: firstExecutionTxHash,
          executorWallet: input.executorWallet,
          executorNonce: input.executorNonce,
          requestDigest: input.requestDigest,
        }),
        replace: async (input) => {
          replacementInput = input;
          return {
            executionTxHash: replacementExecutionTxHash,
            executorWallet: input.executorWallet,
            executorNonce: input.executorNonce,
            requestDigest: input.requestDigest,
            replacementForExecutionTxHash: input.replacementForExecutionTxHash,
          };
        },
      },
      chain: {
        receipt: async () => receipt,
        canonicalBlock: async (input) => ({
          canonical: true,
          observedBlockHash: input.blockHash,
          evidenceHash: HASH,
        }),
      },
      replacementDelayMs: 1_000,
      clock: () => now,
    });

    assert.equal(await worker.submitOnce(), 1);
    now = new Date(now.getTime() + 1_001);
    assert.equal(await worker.replaceOnce(), 1);
    assert.ok(replacementInput);
    assert.equal(replacementInput.executorWallet, transfer.executorWallet);
    assert.equal(replacementInput.executorNonce, transfer.executorNonce);
    assert.equal(replacementInput.transferCalldata, transfer.transferCalldata);
    assert.equal(replacementInput.replacementForExecutionTxHash, firstExecutionTxHash);

    const attempts = await db.query<{
      executor_nonce: string;
      transaction_calldata: string;
      execution_tx_hash: string;
      replacement_for_attempt_id: string | null;
    }>(
      `SELECT executor_nonce::text, transaction_calldata, execution_tx_hash,
         replacement_for_attempt_id FROM core.settlement_transfer_attempts
       WHERE transfer_id = $1 ORDER BY attempt_number`,
      [transfer.transferId],
    );
    assert.equal(attempts.rows.length, 2);
    assert.ok(attempts.rows.every((item) => item.executor_nonce === transfer.executorNonce));
    assert.ok(attempts.rows.every((item) => item.transaction_calldata === transfer.transferCalldata));
    assert.equal(attempts.rows[1]?.replacement_for_attempt_id !== null, true);

    receipt = {
      chainId: 56,
      executionTxHash: replacementExecutionTxHash,
      transactionTo: transfer.tokenAddress,
      transactionCalldata: transfer.transferCalldata,
      executorWallet: transfer.executorWallet,
      executorNonce: transfer.executorNonce,
      receiptStatus: 1,
      blockNumber: 1_020,
      blockHash: `0x${'e'.repeat(64)}`,
      confirmations: 15,
      canonicalBlock: true,
      transfers: [{
        tokenAddress: transfer.tokenAddress,
        from: transfer.executorWallet,
        to: transfer.recipientAddress,
        amount: transfer.amount,
      }],
      transactionDeltas: [
        { tokenAddress: transfer.tokenAddress, account: transfer.executorWallet, delta: `-${transfer.amount}` },
        { tokenAddress: transfer.tokenAddress, account: transfer.recipientAddress, delta: transfer.amount },
      ],
      evidenceHash: `0x${'f'.repeat(64)}`,
    };
    assert.equal(await worker.pollFinalityOnce(), 1);
    assert.equal((await prepared.settlements.getAdminRequest(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      prepared.request.request_id,
    )).request.state, 'SETTLED');
  } finally {
    await db.close();
  }
});
test('failed EOA receipt quarantines the transfer and restores the requested ledger state', async () => {
  const db = await createBusinessDatabase();
  try {
    const prepared = await prepareRequestedSettlement(db);
    const transfer = await prepared.settlements.createTransfer(prepared.operator, {
      asset: 'USDT',
      gasCap: '100000',
      idempotencyKey: 'eoa-failed-transfer-1',
      runtime: prepared.runtime,
      correlationId: 'eoa-failed-transfer-1',
    });
    const executionTxHash = `0x${'2'.repeat(64)}`;
    const receipt: EoaSettlementReceipt = {
      chainId: 56,
      executionTxHash,
      transactionTo: transfer.tokenAddress,
      transactionCalldata: transfer.transferCalldata,
      executorWallet: transfer.executorWallet,
      executorNonce: transfer.executorNonce,
      receiptStatus: 0,
      blockNumber: 1_020,
      blockHash: `0x${'e'.repeat(64)}`,
      confirmations: 15,
      canonicalBlock: true,
      transfers: [],
      transactionDeltas: [],
      evidenceHash: `0x${'f'.repeat(64)}`,
    };
    const worker = new SettlementWorker({
      transactions: transactionAdapter(db),
      broadcaster: {
        submit: async (input) => ({
          executionTxHash,
          executorWallet: input.executorWallet,
          executorNonce: input.executorNonce,
          requestDigest: input.requestDigest,
        }),
        replace: async () => {
          throw new Error('unexpected replacement');
        },
      },
      chain: {
        receipt: async () => receipt,
        canonicalBlock: async (input) => ({
          canonical: true,
          observedBlockHash: input.blockHash,
          evidenceHash: HASH,
        }),
      },
      clock: () => prepared.now,
    });

    assert.equal(await worker.submitOnce(), 1);
    assert.equal(await worker.pollFinalityOnce(), 1);
    const detail = await prepared.settlements.getAdminTransfer(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      transfer.transferId,
    );
    assert.equal(detail.transfer.state, 'QUARANTINED');
    assert.equal((await prepared.settlements.getAdminRequest(
      { walletAddress: prepared.operator.walletAddress, roles: ['AUDITOR'] },
      prepared.request.request_id,
    )).request.state, 'QUARANTINED');
    assert.deepEqual(detail.attempts.map((item) => item.state), ['FAILED']);
    const balances = await db.query<{ balance_state: string; amount: string }>(
      `SELECT line.balance_state,
         sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
       FROM core.ledger_lines line
       JOIN core.ledger_accounts account ON account.account_id = line.account_id
       WHERE account.owner_id = $1 AND account.purpose = 'MERCHANT_RECEIVABLE'
       GROUP BY line.balance_state
       HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) <> 0
       ORDER BY line.balance_state`,
      [prepared.merchantWallet.address.toLowerCase()],
    );
    assert.deepEqual(balances.rows, [
      { balance_state: 'AVAILABLE', amount: '7' },
      { balance_state: 'REQUESTED', amount: '45' },
    ]);
    await assertLedgerBalanced(db, 1);
  } finally {
    await db.close();
  }
});
test('merchant guarantee finality is policy-bound, audited and frozen across deep reorg', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const operationsSafe = '0x5555555555555555555555555555555555555555';
    const amount = (1_000n * 10n ** 18n).toString();
    let now = new Date('2026-07-15T09:00:00.000Z');
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES ($1,'MERCHANT','merchant-1','ACTIVE',$2)`,
      [MERCHANT, HASH],
    );
    const service = new GuaranteeDepositService({
      transactions: transactionAdapter(db),
      operationsWalletAddress: operationsSafe,
      clock: () => now,
    });
    const actor = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    await db.query(
      "UPDATE core.wallet_role_bindings SET status = 'REVOKED', revoked_at = $2 WHERE wallet_address = $1 AND role = 'MERCHANT'",
      [MERCHANT, now],
    );
    await assert.rejects(
      service.submit(actor, {
        policyVersion: '1',
        expectedAmountUsdt: amount,
        transactionHash: `0x${'c'.repeat(64)}`,
        idempotencyKey: 'guarantee-role-revoked',
        correlationId: 'guarantee-role-revoked',
      }),
      /Current merchant role cannot submit/,
    );
    await db.query(
      "UPDATE core.wallet_role_bindings SET status = 'ACTIVE', revoked_at = NULL WHERE wallet_address = $1 AND role = 'MERCHANT'",
      [MERCHANT],
    );
    const wrongSafeService = new GuaranteeDepositService({
      transactions: transactionAdapter(db),
      operationsWalletAddress: '0x6666666666666666666666666666666666666666',
      clock: () => now,
    });
    await assert.rejects(
      wrongSafeService.submit(actor, {
        policyVersion: '1',
        expectedAmountUsdt: amount,
        transactionHash: `0x${'c'.repeat(64)}`,
        idempotencyKey: 'guarantee-wrong-safe',
        correlationId: 'guarantee-wrong-safe',
      }),
      /Policy and runtime operations wallets do not match/,
    );
    const submission = await service.submit(actor, {
      policyVersion: '1',
      expectedAmountUsdt: amount,
      transactionHash: `0x${'c'.repeat(64)}`,
      idempotencyKey: 'guarantee-finality-1',
      correlationId: 'guarantee-finality-submit',
    });
    assert.deepEqual(await service.submit(actor, {
      policyVersion: '1',
      expectedAmountUsdt: amount,
      transactionHash: `0x${'c'.repeat(64)}`,
      idempotencyKey: 'guarantee-finality-1',
      correlationId: 'guarantee-finality-submit',
    }), submission);
    await assert.rejects(
      service.submit(actor, {
        policyVersion: '1',
        expectedAmountUsdt: (BigInt(amount) + 1n).toString(),
        transactionHash: `0x${'c'.repeat(64)}`,
        idempotencyKey: 'guarantee-finality-1',
        correlationId: 'guarantee-finality-conflict',
      }),
      /idempotency conflict/,
    );
    let observation: GuaranteeDepositChainObservation = {
      state: 'MINED',
      transactionHash: submission.transactionHash,
      tokenAddress: '0x55d398326f99059ff775485246999027b3197955',
      from: MERCHANT,
      to: operationsSafe,
      amount,
      blockNumber: 1_000,
      blockHash: `0x${'d'.repeat(64)}`,
      logIndex: 2,
      confirmations: 14,
      receiptStatus: 1 as const,
      canonicalBlock: true as const,
      transferEvidenceHash: `0x${'e'.repeat(64)}`,
      observedAt: now,
    };
    const worker = new GuaranteeDepositWorker({
      service,
      source: { observe: async () => observation },
    });
    assert.equal(await worker.pollOnce(), 1);
    assert.equal((await db.query<{ state: string }>(
      'SELECT state FROM core.merchant_guarantee_deposit_submissions WHERE deposit_id = $1',
      [submission.depositId],
    )).rows[0]?.state, 'MINED');
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.merchant_guarantees',
    )).rows[0]?.count, '0');
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.audit_outbox_events WHERE event_type = 'GuaranteeDepositFinalized'",
    )).rows[0]?.count, '0');

    await assert.rejects(
      service.recordObservation(submission.depositId, {
        ...observation,
        blockNumber: 1_001,
        blockHash: `0x${'9'.repeat(64)}`,
        transferEvidenceHash: `0x${'8'.repeat(64)}`,
      }),
      /record reorg before new chain evidence/,
    );

    now = new Date(now.getTime() + 1_000);
    observation = {
      ...observation,
      state: 'FINAL',
      confirmations: 15,
      transferEvidenceHash: `0x${'f'.repeat(64)}`,
      observedAt: now,
    };
    assert.equal(await worker.pollOnce(), 1);
    const journal = await db.query<{
      policy_version: string | number;
      source_tx_hash: string;
      source_block_hash: string;
      source_kind: string;
    }>(
      "SELECT policy_version, source_tx_hash, source_block_hash, source_kind FROM core.ledger_journals WHERE event_type = 'GUARANTEE_DEPOSITED'",
    );
    assert.equal(Number(journal.rows[0]?.policy_version), 1);
    assert.equal(journal.rows[0]?.source_tx_hash, submission.transactionHash);
    assert.equal(journal.rows[0]?.source_block_hash, observation.blockHash);
    assert.equal(journal.rows[0]?.source_kind, 'CHAIN_EVENT');
    const lineBalance = await db.query<{ debits: string; credits: string }>(
      `SELECT sum(CASE WHEN side = 'DEBIT' THEN amount ELSE 0 END)::text AS debits,
         sum(CASE WHEN side = 'CREDIT' THEN amount ELSE 0 END)::text AS credits
       FROM core.ledger_lines WHERE journal_id = (
         SELECT journal_id FROM core.ledger_journals WHERE event_type = 'GUARANTEE_DEPOSITED'
       )`,
    );
    assert.equal(lineBalance.rows[0]?.debits, amount);
    assert.equal(lineBalance.rows[0]?.credits, amount);
    const finalAudit = await db.query<{
      evidence_profile: string;
      correlation_id: string;
      merchant_id: string;
      transaction_evidence: Record<string, unknown>;
    }>(
      "SELECT evidence_profile, correlation_id, merchant_id, transaction_evidence FROM core.audit_outbox_events WHERE event_type = 'GuaranteeDepositFinalized'",
    );
    assert.equal(finalAudit.rows[0]?.evidence_profile, 'CHAIN_FINAL');
    assert.equal(finalAudit.rows[0]?.correlation_id, 'guarantee-finality-submit');
    assert.equal(finalAudit.rows[0]?.merchant_id, 'merchant-1');
    assert.equal(finalAudit.rows[0]?.transaction_evidence.txHash, submission.transactionHash);
    assert.equal(finalAudit.rows[0]?.transaction_evidence.contractAddress, '0x55d398326f99059ff775485246999027b3197955');
    assert.equal(finalAudit.rows[0]?.transaction_evidence.eventSignatureHash, id('Transfer(address,address,uint256)'));
    assert.equal(finalAudit.rows[0]?.transaction_evidence.logIndex, 2);
    assert.equal(finalAudit.rows[0]?.transaction_evidence.policyVersion, 1);
    assert.equal(finalAudit.rows[0]?.transaction_evidence.confirmations, 15);
    await assert.rejects(
      db.query(
        'UPDATE core.merchant_guarantee_deposit_submissions SET expected_amount_usdt = expected_amount_usdt + 1 WHERE deposit_id = $1',
        [submission.depositId],
      ),
      /ImmutableGuaranteeDepositSubmission/,
    );
    await assert.rejects(
      db.query(
        "UPDATE core.merchant_guarantee_deposit_transitions SET evidence_hash = $2 WHERE deposit_id = $1 AND event_type = 'FINAL'",
        [submission.depositId, `0x${'1'.repeat(64)}`],
      ),
      /ImmutableRecord/,
    );

    now = new Date(now.getTime() + 1_000);
    await service.recordReorg(submission.depositId, {
      state: 'REORGED',
      transactionHash: submission.transactionHash,
      previousBlockNumber: 1_000,
      previousBlockHash: observation.blockHash,
      previousLogIndex: 2,
      canonicalBlockHash: `0x${'a'.repeat(64)}`,
      confirmations: 15,
      evidenceHash: `0x${'b'.repeat(64)}`,
      observedAt: now,
    });
    assert.equal((await db.query<{ state: string }>(
      'SELECT state FROM core.merchant_guarantee_reorg_exposures WHERE deposit_id = $1',
      [submission.depositId],
    )).rows[0]?.state, 'OPEN');
    await assert.rejects(
      db.query(
        'UPDATE core.merchant_guarantee_reorg_exposures SET amount_usdt = amount_usdt + 1 WHERE deposit_id = $1',
        [submission.depositId],
      ),
      /ImmutableGuaranteeReorgExposure/,
    );
    assert.equal((await db.query<{ guarantee_status: string }>(
      "SELECT guarantee_status FROM core.merchants WHERE merchant_id = 'merchant-1'",
    )).rows[0]?.guarantee_status, 'FROZEN');
    assert.deepEqual((await db.query<{ scope: string; paused: boolean }>(
      'SELECT scope, paused FROM core.circuit_breakers ORDER BY scope',
    )).rows, [
      { scope: 'NEW_PAYMENT', paused: true },
      { scope: 'NEW_SETTLEMENT_BATCH', paused: true },
    ]);
    assert.equal((await db.query<{ evidence_profile: string }>(
      "SELECT evidence_profile FROM core.audit_outbox_events WHERE event_type = 'GuaranteeDepositReorged'",
    )).rows[0]?.evidence_profile, 'CHAIN_OBSERVED');
    assert.equal((await db.query<{ merchant_id: string }>(
      "SELECT merchant_id FROM core.audit_outbox_events WHERE event_type = 'GuaranteeDepositReorged'",
    )).rows[0]?.merchant_id, 'merchant-1');

    now = new Date(now.getTime() + 1_000);
    const replacementFinal = {
      ...observation,
      blockNumber: 1_001,
      blockHash: `0x${'9'.repeat(64)}`,
      confirmations: 15,
      transferEvidenceHash: `0x${'8'.repeat(64)}`,
      observedAt: now,
    };
    assert.equal((await service.recordObservation(submission.depositId, replacementFinal)).state, 'FINAL');
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.ledger_journals WHERE event_type = 'GUARANTEE_DEPOSITED'",
    )).rows[0]?.count, '1');
    assert.equal((await db.query<{ balance_usdt: string }>(
      "SELECT balance_usdt::text FROM core.merchant_guarantees WHERE merchant_id = 'merchant-1'",
    )).rows[0]?.balance_usdt, amount);
    assert.equal((await db.query<{ state: string }>(
      'SELECT state FROM core.merchant_guarantee_reorg_exposures WHERE deposit_id = $1',
      [submission.depositId],
    )).rows[0]?.state, 'RESOLVED');
    assert.equal((await db.query<{ guarantee_status: string }>(
      "SELECT guarantee_status FROM core.merchants WHERE merchant_id = 'merchant-1'",
    )).rows[0]?.guarantee_status, 'READY');
    assert.ok((await db.query<{ paused: boolean }>(
      'SELECT paused FROM core.circuit_breakers',
    )).rows.every((row) => row.paused));
    assert.ok((await db.query<{ active: boolean }>(
      "SELECT active FROM core.breaker_causes WHERE cause_type = 'SECURITY'",
    )).rows.every((row) => !row.active));

    await db.query(
      `INSERT INTO core.merchant_guarantee_deposit_submissions (
         deposit_id, merchant_id, merchant_wallet, policy_version, chain_id,
         token_address, operations_wallet_address, expected_amount_usdt,
         transaction_hash, state, idempotency_key, request_hash,
         correlation_id, submitted_by, created_at, updated_at
       )
       SELECT
         'guarantee-fairness:' || value, 'merchant-1', $1, 1, 56,
         $2, $3, 1, '0x' || lpad(to_hex(value), 64, '0'), 'SUBMITTED',
         'fairness-key-' || value, '0x' || lpad(to_hex(value + 100), 64, '0'),
         'guarantee-fairness', $1, $4, $4
       FROM generate_series(1, 25) value`,
      [MERCHANT, USDT_ADDRESS, operationsSafe.toLowerCase(), new Date('2026-07-15T08:00:00.000Z')],
    );
    const firstFinalityPage = await service.pendingFinality(25);
    assert.equal(firstFinalityPage.some((item) => item.depositId === submission.depositId), false);
    const secondFinalityPage = await service.pendingFinality(25);
    assert.equal(secondFinalityPage.some((item) => item.depositId === submission.depositId), true);

    const rollbackSubmission = await service.submit(actor, {
      policyVersion: '1',
      expectedAmountUsdt: '1',
      transactionHash: `0x${'7'.repeat(64)}`,
      idempotencyKey: 'guarantee-audit-rollback',
      correlationId: 'guarantee-audit-rollback',
    });
    const auditFailingService = new GuaranteeDepositService({
      transactions: transactionAdapter(db, (sql) => {
        if (sql.includes('INSERT INTO core.audit_outbox_events')) throw new Error('InjectedGuaranteeAuditFailure');
      }),
      operationsWalletAddress: operationsSafe,
      clock: () => now,
    });
    await assert.rejects(
      auditFailingService.recordObservation(rollbackSubmission.depositId, {
        ...replacementFinal,
        transactionHash: rollbackSubmission.transactionHash,
        amount: '1',
        blockNumber: 1_002,
        blockHash: `0x${'6'.repeat(64)}`,
        logIndex: 3,
        transferEvidenceHash: `0x${'5'.repeat(64)}`,
      }),
      /InjectedGuaranteeAuditFailure/,
    );
    assert.equal((await db.query<{ state: string }>(
      'SELECT state FROM core.merchant_guarantee_deposit_submissions WHERE deposit_id = $1',
      [rollbackSubmission.depositId],
    )).rows[0]?.state, 'SUBMITTED');
    assert.equal((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.ledger_journals WHERE event_type = 'GUARANTEE_DEPOSITED'",
    )).rows[0]?.count, '1');
    assert.equal((await db.query<{ balance_usdt: string }>(
      "SELECT balance_usdt::text FROM core.merchant_guarantees WHERE merchant_id = 'merchant-1'",
    )).rows[0]?.balance_usdt, amount);
  } finally {
    await db.close();
  }
});

test('takeover funding consumes final guarantee first and records Operations advance as merchant debt', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    await db.query(
      `UPDATE core.skus SET stock_total = stock_total + 1,
         stock_available = stock_available + 1 WHERE sku_id = 'sku-1'`,
    );
    const rotatedOperationsSafe = '0x6666666666666666666666666666666666666666';
    await db.query(
      `INSERT INTO core.policy_snapshots (
         policy_version, artifact_version, policy_hash,
         rules_content_hash, beneficiary_set_hash, payload, publication_status
       ) VALUES (2, $1, $2, $3, $4, $5, 'PUBLISHED')`,
      [
        CORE_ARTIFACT_VERSION,
        `0x${'8'.repeat(64)}`,
        `0x${'a'.repeat(64)}`,
        `0x${'b'.repeat(64)}`,
        JSON.stringify({ ...paymentPolicyPayload(), operationsWallet: rotatedOperationsSafe }),
      ],
    );
    const futureIntent = paymentIntent();
    futureIntent.policyVersion = 2;
    futureIntent.orderId = `0x${'9'.repeat(64)}`;
    futureIntent.reservationId = `0x${'7'.repeat(64)}`;
    futureIntent.reservationHash = `0x${'8'.repeat(64)}`;
    futureIntent.nonce = '2';
    await reserveInventory(adapter(db), {
      reservationId: futureIntent.reservationId,
      reservationHash: futureIntent.reservationHash,
      policyVersion: futureIntent.policyVersion,
      skuId: 'sku-1',
      buyerWallet: futureIntent.buyer,
      quantity: futureIntent.quantity,
      classification: 'ORDINARY',
      expiresAt: new Date(futureIntent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, futureIntent, 'future-proceeds-payment-quote');
    const futurePayment = paymentInput(futureIntent);
    futurePayment.event.transactionHash = `0x${'a'.repeat(64)}`;
    futurePayment.event.blockHash = `0x${'b'.repeat(64)}`;
    await new PostgresPaymentStore(transactionAdapter(db)).record(futurePayment);
    let now = new Date((intent.issuedAt + 60) * 1000);
    const takeoverSecondary = Wallet.createRandom();
    const takeoverGovernanceSafe = '0x7777777777777777777777777777777777777777';
    const funding = governedTakeoverFundingService(
      db,
      takeoverSecondary,
      takeoverGovernanceSafe,
      () => now,
    );
    const guaranteeAmount = (1_000n * 10n ** 18n).toString();
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES ($1,'MERCHANT','merchant-1','ACTIVE',$2)`,
      [MERCHANT, HASH],
    );
    const guaranteeDeposits = new GuaranteeDepositService({
      transactions: transactionAdapter(db),
      operationsWalletAddress: '0x5555555555555555555555555555555555555555',
      clock: () => now,
    });
    const deposit = await guaranteeDeposits.submit({ walletAddress: MERCHANT, roles: ['MERCHANT'], merchantId: 'merchant-1' }, {
      policyVersion: '1',
      expectedAmountUsdt: guaranteeAmount,
      transactionHash: `0x${'3'.repeat(64)}`,
      idempotencyKey: 'guarantee-deposit-1',
      correlationId: 'guarantee-deposit-submit',
    });
    const finalDeposit = {
      state: 'FINAL' as const,
      transactionHash: deposit.transactionHash,
      tokenAddress: '0x55d398326f99059ff775485246999027b3197955',
      from: MERCHANT,
      to: deposit.operationsWalletAddress,
      amount: guaranteeAmount,
      blockHash: `0x${'4'.repeat(64)}`,
      blockNumber: 500,
      logIndex: 1,
      confirmations: 15,
      receiptStatus: 1 as const,
      canonicalBlock: true as const,
      transferEvidenceHash: `0x${'5'.repeat(64)}`,
      observedAt: now,
    };
    assert.equal((await guaranteeDeposits.recordObservation(deposit.depositId, finalDeposit)).state, 'FINAL');
    assert.equal((await guaranteeDeposits.recordObservation(deposit.depositId, finalDeposit)).state, 'FINAL');
    await assert.rejects(
      async () => guaranteeDeposits.recordObservation(deposit.depositId, { ...finalDeposit, confirmations: 14 }),
      /fewer than 15 confirmations/,
    );

    now = new Date((intent.issuedAt + 42) * 1000 + 7 * 24 * 60 * 60 * 1000);
    const fulfillment = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
    const operator = {
      walletAddress: '0x9999999999999999999999999999999999999999',
      roles: ['OPERATOR'] as const,
    };
    await grantRole(db, operator.walletAddress, 'OPERATOR');
    const takeover = await fulfillment.openTakeover(operator, intent.orderId, {
      idempotencyKey: 'funded-takeover-open-1',
      evidenceHash: `0x${'6'.repeat(64)}`,
      reasonCode: 'NO_SHIPMENT',
    });
    const required = (BigInt(guaranteeAmount) + 10n).toString();
    const operationsSafe = rotatedOperationsSafe;
    const fundingApproval = await signedTakeoverFundingApproval(
      funding,
      operator,
      {
        caseId: takeover.caseId,
        requiredUsdt: required,
        operationsWalletAddress: operationsSafe,
      },
      takeoverSecondary,
      '1',
      String(Math.floor(now.getTime() / 1_000) + 300),
    );
    const fundingCommand = {
      caseId: takeover.caseId,
      requiredUsdt: required,
      operationsWalletAddress: operationsSafe,
      idempotencyKey: 'takeover-funding-command-1',
      correlationId: 'takeover-funding-correlation-1',
      approval: fundingApproval,
    };
    await db.query(
      `UPDATE core.wallet_role_bindings SET status = 'REVOKED', revoked_at = clock_timestamp()
       WHERE wallet_address = $1 AND role = 'OPERATOR'`,
      [operator.walletAddress],
    );
    await assert.rejects(funding.fundTakeover(operator, fundingCommand), /Current wallet role cannot fund takeover/);
    assert.equal((await db.query<{ state: string }>(
      'SELECT state FROM core.takeover_cases WHERE case_id = $1',
      [takeover.caseId],
    )).rows[0]?.state, 'OPEN');
    await grantRole(db, operator.walletAddress, 'OPERATOR');
    const result = await funding.fundTakeover(operator, fundingCommand);
    assert.deepEqual(result, {
      caseId: takeover.caseId,
      state: 'FUNDED',
      requiredUsdt: required,
      guaranteeUsedUsdt: guaranteeAmount,
      frozenReceivablesUsedUsdt: '0',
      futureProceedsUsedUsdt: '0',
      platformAdvanceUsdt: '10',
      merchantDebtUsdt: '10',
    });
    assert.deepEqual(await funding.fundTakeover(operator, fundingCommand), result);
    const fundingEvidence = await db.query<{
      correlation_id: string;
      approval_evidence_hash: string;
      approval_signature_hash: string;
      source_tx_hash: string | null;
      source_block_hash: string | null;
      merchant_id: string;
      evidence_profile: string;
      signature_evidence: Record<string, unknown>;
      transaction_evidence: Record<string, unknown>;
    }>(
      `SELECT command.correlation_id, command.approval_evidence_hash, command.approval_signature_hash,
         journal.source_tx_hash, journal.source_block_hash,
         audit.merchant_id, audit.evidence_profile, audit.signature_evidence, audit.transaction_evidence
       FROM core.takeover_funding_commands command
       JOIN core.ledger_journals journal
         ON journal.resource_type = 'TAKEOVER_CASE' AND journal.resource_id = command.case_id
       JOIN core.audit_outbox_events audit
         ON audit.event_type = 'TakeoverFundingApproved' AND audit.resource_id = command.case_id
       WHERE command.case_id = $1 ORDER BY journal.journal_id LIMIT 1`,
      [takeover.caseId],
    );
    assert.equal(fundingEvidence.rows[0]?.correlation_id, 'takeover-funding-correlation-1');
    assert.match(fundingEvidence.rows[0]?.approval_evidence_hash ?? '', /^0x[0-9a-f]{64}$/);
    assert.match(fundingEvidence.rows[0]?.approval_signature_hash ?? '', /^0x[0-9a-f]{64}$/);
    assert.equal(fundingEvidence.rows[0]?.source_tx_hash, null);
    assert.equal(fundingEvidence.rows[0]?.source_block_hash, null);
    assert.equal(fundingEvidence.rows[0]?.merchant_id, 'merchant-1');
    assert.equal(fundingEvidence.rows[0]?.evidence_profile, 'SIGNED_OFFCHAIN');
    assert.equal(fundingEvidence.rows[0]?.signature_evidence.scheme, 'EIP712');
    assert.deepEqual(fundingEvidence.rows[0]?.transaction_evidence, {});
    const debt = await db.query<{ outstanding_usdt: string }>(
      'SELECT outstanding_usdt::text FROM core.merchant_debts WHERE merchant_id = $1',
      ['merchant-1'],
    );
    assert.equal(debt.rows[0]?.outstanding_usdt, '10');
    const guarantee = await db.query<{ balance_usdt: string }>(
      'SELECT balance_usdt::text FROM core.merchant_guarantees WHERE merchant_id = $1',
      ['merchant-1'],
    );
    assert.equal(guarantee.rows[0]?.balance_usdt, '0');

    const merchant = {
      walletAddress: MERCHANT,
      roles: ['MERCHANT'] as const,
      merchantId: 'merchant-1',
    };
    await fulfillment.recordShipment(merchant, futureIntent.orderId, {
      idempotencyKey: 'future-proceeds-shipment-1',
      evidenceHash: `0x${'8'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'9'.repeat(64)}`,
    });
    await fulfillment.recordDelivery(operator, futureIntent.orderId, {
      idempotencyKey: 'future-proceeds-delivery-1',
      evidenceHash: `0x${'a'.repeat(64)}`,
    });
    await fulfillment.confirmReceipt(
      { walletAddress: BUYER, roles: ['BUYER'] },
      futureIntent.orderId,
      { idempotencyKey: 'future-proceeds-receipt-1', evidenceHash: `0x${'b'.repeat(64)}` },
    );
    const repaid = await db.query<{ recovered_usdt: string; outstanding_usdt: string }>(
      `SELECT recovered_usdt::text, outstanding_usdt::text
       FROM core.merchant_debts WHERE merchant_id = 'merchant-1'`,
    );
    assert.deepEqual(repaid.rows[0], { recovered_usdt: '10', outstanding_usdt: '0' });
    const futureProceedsAudit = await db.query<{
      evidence_profile: string;
      correlation_id: string;
      merchant_id: string;
      transaction_evidence: Record<string, unknown>;
    }>(
      `SELECT evidence_profile, correlation_id, merchant_id, transaction_evidence
       FROM core.audit_outbox_events
       WHERE event_type = 'MerchantFutureProceedsCaptured' AND resource_id = 'merchant-1'`,
    );
    assert.equal(futureProceedsAudit.rows[0]?.evidence_profile, 'SYSTEM');
    assert.equal(futureProceedsAudit.rows[0]?.merchant_id, 'merchant-1');
    assert.match(futureProceedsAudit.rows[0]?.correlation_id ?? '', /^fulfillment:command:/);
    assert.deepEqual(futureProceedsAudit.rows[0]?.transaction_evidence, {});
    const reimbursement = await db.query<{ owner_id: string; amount: string }>(
      `SELECT account.owner_id,
         sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
       FROM core.ledger_lines line
       JOIN core.ledger_accounts account ON account.account_id = line.account_id
       WHERE account.purpose = 'OPERATIONS_REIMBURSEMENT' AND line.balance_state = 'AVAILABLE'
       GROUP BY account.owner_id`,
    );
    assert.deepEqual(reimbursement.rows, [{ owner_id: operationsSafe, amount: '10' }]);

    await new PostgresPaymentStore(transactionAdapter(db)).reverse(
      paymentEventKey(
        futurePayment.event.transactionHash,
        futurePayment.event.logIndex,
        futurePayment.event.blockHash,
      ),
      `0x${'c'.repeat(64)}`,
    );
    const reorgedDebt = await db.query<{ recovered_usdt: string; outstanding_usdt: string }>(
      `SELECT recovered_usdt::text, outstanding_usdt::text
       FROM core.merchant_debts WHERE merchant_id = 'merchant-1'`,
    );
    assert.deepEqual(reorgedDebt.rows[0], { recovered_usdt: '0', outstanding_usdt: '10' });
    const debtReorgAudit = await db.query<{
      evidence_profile: string;
      payload: Record<string, unknown>;
      transaction_evidence: Record<string, unknown>;
    }>(
      `SELECT evidence_profile, payload, transaction_evidence
       FROM core.audit_outbox_events
       WHERE event_type = 'PaymentFinalityReorged' AND resource_id = $1`,
      [futureIntent.orderId],
    );
    assert.equal(debtReorgAudit.rows[0]?.evidence_profile, 'CHAIN_OBSERVED');
    assert.equal(debtReorgAudit.rows[0]?.payload.reversedDebtRecoveries, 1);
    assert.equal(debtReorgAudit.rows[0]?.transaction_evidence.txHash, futurePayment.event.transactionHash);
    assert.equal(debtReorgAudit.rows[0]?.transaction_evidence.eventSignatureHash, id(
      'PaymentCompleted(bytes32,address,address,uint8,uint64,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32,bytes32)',
    ));
    assert.equal(debtReorgAudit.rows[0]?.transaction_evidence.logIndex, futurePayment.event.logIndex);
    await assertLedgerBalanced(db, 1);
  } finally {
    await db.close();
  }
});

test('takeover assignment authorizes one qualified replacement merchant through receipt and closure', async () => {
  const db = await createBusinessDatabase();
  const operatorWallet = Wallet.createRandom();
  const auditorWallet = Wallet.createRandom();
  const firstWallet = Wallet.createRandom();
  const secondWallet = Wallet.createRandom();
  const ineligibleWallet = Wallet.createRandom();
  try {
    const intent = paymentIntent();
    const now = new Date((intent.issuedAt + 42) * 1000 + 7 * 24 * 60 * 60 * 1000);
    const deliveryKey = '11'.repeat(32);
    const encrypted = encryptTestPayload({
      recipientName: 'Replacement Buyer', phone: '13800138000',
      address: 'Beijing Dongcheng 1', longitude: 116.4, latitude: 39.9,
    }, Buffer.from(deliveryKey, 'hex'));
    await db.query(
      `INSERT INTO core.administrative_regions (
         region_code, province, city, district, source, source_reference_hash, status
       ) VALUES ('110101','Beijing','Beijing','Dongcheng','GOVERNED_IMPORT',$1,'ACTIVE')`,
      [HASH],
    );
    await db.query(
      `INSERT INTO core.fulfillment_targets (
         target_id, target_hash, buyer_wallet, idempotency_key, request_hash,
         fulfillment_mode, region_code, region_code_hash, encrypted_payload,
         encryption_iv, encryption_tag, expires_at, created_at
       ) VALUES ('target:replacement',$1,$2,'replacement-target-1',$1,'DELIVERY',
         '110101',$1,$3,$4,$5,$6,$7)`,
      [
        intent.fulfillmentTargetHash,
        intent.buyer,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        new Date(now.getTime() + 60_000),
        new Date(now.getTime() - 60_000),
      ],
    );
    await recordFinalPayment(db, intent);
    await grantRole(db, operatorWallet.address, 'OPERATOR');
    await grantRole(db, auditorWallet.address, 'AUDITOR');
    const operator = { walletAddress: operatorWallet.address, roles: ['OPERATOR'] as const };
    const auditor = { walletAddress: auditorWallet.address, roles: ['AUDITOR'] as const };
    const fulfillment = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
    const takeover = await fulfillment.openTakeover(operator, intent.orderId, {
      idempotencyKey: 'replacement-assignment-open-1',
      evidenceHash: `0x${'6'.repeat(64)}`,
      reasonCode: 'NO_SHIPMENT',
    });
    const secondary = Wallet.createRandom();
    const governanceWallet = '0x7777777777777777777777777777777777777777';
    const operationsSafe = '0x5555555555555555555555555555555555555555';
    const funding = governedTakeoverFundingService(db, secondary, governanceWallet, () => now);
    const fundingApproval = await signedTakeoverFundingApproval(
      funding,
      operator,
      { caseId: takeover.caseId, requiredUsdt: '20', operationsWalletAddress: operationsSafe },
      secondary,
      '1',
      String(Math.floor(now.getTime() / 1_000) + 300),
    );
    const funded = await funding.fundTakeover(operator, {
      caseId: takeover.caseId,
      requiredUsdt: '20',
      operationsWalletAddress: operationsSafe,
      idempotencyKey: 'replacement-assignment-funding-1',
      correlationId: 'replacement-assignment-funding-1',
      approval: fundingApproval,
    });
    assert.equal(funded.state, 'FUNDED');
    assert.equal(funded.platformAdvanceUsdt, '20');
    await seedEligibleReplacementMerchant(db, 'replacement-1', firstWallet.address, '1', now, true);
    await seedEligibleReplacementMerchant(db, 'replacement-2', secondWallet.address, '2', now, true);
    await seedEligibleReplacementMerchant(db, 'replacement-ineligible', ineligibleWallet.address, '3', now, false);

    const service = new TakeoverCaseService({ transactions: transactionAdapter(db), clock: () => now });
    const candidates = await service.listCandidates(operator, takeover.caseId);
    assert.deepEqual(candidates.candidates.map((candidate) => candidate.merchantId), ['replacement-1', 'replacement-2']);
    assert.equal(candidates.candidates.some((candidate) => 'level' in candidate), false);
    assert.equal((await service.listAdmin(auditor)).cases.length, 1);
    await assert.rejects(
      service.assign(auditor, takeover.caseId, {
        replacementMerchantId: 'replacement-1', reasonCode: 'WAREHOUSE_MATCH',
        evidenceHash: `0x${'7'.repeat(64)}`, idempotencyKey: 'auditor-assignment-denied', correlationId: 'auditor-denied',
      }),
      /ADMIN or OPERATOR role is required/,
    );
    await assert.rejects(
      service.assign(operator, takeover.caseId, {
        replacementMerchantId: 'replacement-ineligible', reasonCode: 'WAREHOUSE_MATCH',
        evidenceHash: `0x${'7'.repeat(64)}`, idempotencyKey: 'ineligible-assignment-denied', correlationId: 'ineligible-denied',
      }),
      /not currently eligible/,
    );
    const firstInput = {
      replacementMerchantId: 'replacement-1', reasonCode: 'WAREHOUSE_MATCH',
      evidenceHash: `0x${'7'.repeat(64)}`, idempotencyKey: 'replacement-assignment-1', correlationId: 'replacement-1',
    };
    const first = await service.assign(operator, takeover.caseId, firstInput);
    assert.equal(first.assignment.version, 1);
    assert.equal('replacementLevel' in first.assignment, false);
    assert.equal((await db.query<{ replacement_level: string | null }>(
      'SELECT replacement_level FROM core.takeover_assignments WHERE assignment_id = $1',
      [first.assignment.assignmentId],
    )).rows[0]?.replacement_level, null);
    assert.equal((await service.assign(operator, takeover.caseId, firstInput)).assignment.assignmentId, first.assignment.assignmentId);
    await db.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES ($1,'MERCHANT','merchant-1','ACTIVE',$2)
       ON CONFLICT (wallet_address, role) DO UPDATE SET merchant_id = EXCLUDED.merchant_id, status = 'ACTIVE', revoked_at = NULL`,
      [intent.merchant.toLowerCase(), HASH],
    );
    const originalActor = { walletAddress: intent.merchant, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const targets = new FulfillmentTargetService({
      transactions: transactionAdapter(db),
      regions: { reverseGeocode: async () => { throw new Error('unused'); } },
      encryptionKey: deliveryKey,
      clock: () => now,
    });
    await assert.rejects(targets.getOrderTarget(originalActor, intent.orderId), /outside the authenticated wallet scope/);
    const firstActor = { walletAddress: firstWallet.address, roles: ['MERCHANT'] as const, merchantId: 'replacement-1' };
    const secondActor = { walletAddress: secondWallet.address, roles: ['MERCHANT'] as const, merchantId: 'replacement-2' };
    assert.equal((await service.listMerchant(firstActor)).cases[0]?.caseId, takeover.caseId);
    await assert.rejects(service.getMerchant(secondActor, takeover.caseId), /outside the replacement merchant scope/);

    const second = await service.assign(operator, takeover.caseId, {
      replacementMerchantId: 'replacement-2', reasonCode: 'CAPACITY_REASSIGNMENT',
      evidenceHash: `0x${'8'.repeat(64)}`, idempotencyKey: 'replacement-assignment-2', correlationId: 'replacement-2',
    });
    assert.equal(second.assignment.version, 2);
    assert.equal(second.assignment.supersedesAssignmentId, first.assignment.assignmentId);
    await assert.rejects(service.getMerchant(firstActor, takeover.caseId), /outside the replacement merchant scope/);
    await assert.rejects(
      db.query('UPDATE core.takeover_assignments SET reason_code = $2 WHERE assignment_id = $1', [
        first.assignment.assignmentId, 'MUTATED',
      ]),
      /ImmutableRecord/,
    );

    assert.equal((await targets.getOrderTarget(secondActor, intent.orderId)).payload.recipientName, 'Replacement Buyer');
    await assert.rejects(targets.getOrderTarget(firstActor, intent.orderId), /outside the authenticated wallet scope/);
    await db.query(
      `UPDATE core.wallet_role_bindings SET status = 'REVOKED', revoked_at = clock_timestamp()
       WHERE lower(wallet_address) = $1 AND role = 'MERCHANT'`,
      [secondWallet.address.toLowerCase()],
    );
    await assert.rejects(targets.getOrderTarget(secondActor, intent.orderId), /outside the authenticated wallet scope/);
    await db.query(
      `UPDATE core.wallet_role_bindings SET status = 'ACTIVE', revoked_at = NULL
       WHERE lower(wallet_address) = $1 AND role = 'MERCHANT'`,
      [secondWallet.address.toLowerCase()],
    );

    const evidence = new EvidenceService({
      transactions: transactionAdapter(db),
      storage: {
        createUpload: async () => { throw new Error('unused'); },
        finalizeUpload: async () => { throw new Error('unused'); },
        createRead: async () => { throw new Error('unused'); },
      },
      trackingHashKey: '22'.repeat(32),
      trackingEncryptionKey: deliveryKey,
      clock: () => now,
    });
    const tracking = await evidence.createTrackingEvidence(secondActor, {
      orderId: intent.orderId,
      carrierCode: 'SF',
      trackingNumber: 'SF-REPLACEMENT-001',
      idempotencyKey: 'replacement-tracking-evidence-1',
    });
    const trackingNumberHash = tracking.trackingNumberHash;
    assert.ok(trackingNumberHash);
    await evidence.assertTrackingEvidence(secondActor, {
      orderId: intent.orderId,
      carrierCode: 'SF',
      trackingNumberHash,
      evidenceHash: tracking.evidenceHash,
    });
    const shipped = await fulfillment.recordShipment(secondActor, intent.orderId, {
      idempotencyKey: 'replacement-shipment-command-1',
      evidenceHash: tracking.evidenceHash,
      carrierCode: 'SF',
      trackingNumberHash,
    });
    assert.equal(shipped.state, 'SHIPPED');
    assert.equal((await service.getMerchant(secondActor, takeover.caseId)).case.state, 'FULFILLING');
    await assert.rejects(
      service.assign(operator, takeover.caseId, {
        replacementMerchantId: 'replacement-1', reasonCode: 'LATE_REASSIGNMENT',
        evidenceHash: `0x${'9'.repeat(64)}`, idempotencyKey: 'replacement-assignment-late', correlationId: 'late',
      }),
      /cannot be assigned from its current state/,
    );
    const delivered = await fulfillment.recordDelivery(operator, intent.orderId, {
      idempotencyKey: 'replacement-delivery-command-1',
      evidenceHash: `0x${'a'.repeat(64)}`,
    });
    assert.equal(delivered.state, 'DELIVERED');
    const received = await fulfillment.confirmReceipt(
      { walletAddress: intent.buyer, roles: ['BUYER'] },
      intent.orderId,
      {
        idempotencyKey: 'replacement-receipt-command-1',
        evidenceHash: `0x${'b'.repeat(64)}`,
      },
    );
    assert.equal(received.state, 'FULFILLED');
    const closed = await db.query<{ order_state: string; case_state: string; closed_at: Date | null }>(
      `SELECT orders.state AS order_state, takeover.state AS case_state, takeover.closed_at
       FROM core.orders orders
       JOIN core.takeover_cases takeover ON takeover.order_id = orders.order_id
       WHERE orders.order_id = $1`,
      [intent.orderId],
    );
    assert.equal(closed.rows[0]?.order_state, 'FULFILLED');
    assert.equal(closed.rows[0]?.case_state, 'CLOSED');
    assert.ok(closed.rows[0]?.closed_at);
    const closeTransition = await db.query<{ from_state: string; to_state: string; public_evidence_type: string }>(
      `SELECT from_state, to_state, public_evidence_type
       FROM core.takeover_case_transitions
       WHERE case_id = $1 AND to_state = 'CLOSED'`,
      [takeover.caseId],
    );
    assert.deepEqual(closeTransition.rows[0], {
      from_state: 'FULFILLING',
      to_state: 'CLOSED',
      public_evidence_type: 'FULFILLMENT_FINALIZED',
    });
  } finally {
    await db.close();
  }
});

test('governed takeover and Operations reimbursement bind secondary approval, frozen target and separate wallets', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    let now = new Date((intent.issuedAt + 42) * 1000 + 7 * 24 * 60 * 60 * 1000);
    const operatorWallet = Wallet.createRandom();
    const operator = { walletAddress: operatorWallet.address, roles: ['OPERATOR'] as const };
    await grantRole(db, operator.walletAddress, 'OPERATOR');
    const fulfillment = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
    const takeover = await fulfillment.openTakeover(operator, intent.orderId, {
      idempotencyKey: 'governed-takeover-open-1',
      evidenceHash: `0x${'6'.repeat(64)}`,
      reasonCode: 'NO_SHIPMENT',
    });
    const operationsSafe = '0x5555555555555555555555555555555555555555';
    const custodySafe = '0x3333333333333333333333333333333333333333';
    const secondary = Wallet.createRandom();
    const governanceWallet = '0x7777777777777777777777777777777777777777';
    const funding = governedTakeoverFundingService(db, secondary, governanceWallet, () => now);
    const fundingApproval = await signedTakeoverFundingApproval(
      funding,
      operator,
      { caseId: takeover.caseId, requiredUsdt: '20', operationsWalletAddress: operationsSafe },
      secondary,
      '9',
      String(Math.floor(now.getTime() / 1_000) + 300),
    );
    const funded = await funding.fundTakeover(operator, {
      caseId: takeover.caseId,
      requiredUsdt: '20',
      operationsWalletAddress: operationsSafe,
      idempotencyKey: 'governed-takeover-funding-1',
      correlationId: 'governed-takeover-funding-correlation-1',
      approval: fundingApproval,
    });
    assert.equal(funded?.platformAdvanceUsdt, '20');
    const replacementRecipient = '0x8888888888888888888888888888888888888888';
    await seedEligibleReplacementMerchant(db, 'governed-replacement', replacementRecipient, '4', now, true);
    await new TakeoverCaseService({ transactions: transactionAdapter(db), clock: () => now }).assign(
      operator,
      takeover.caseId,
      {
        replacementMerchantId: 'governed-replacement',
        reasonCode: 'FUNDED_REPLACEMENT',
        evidenceHash: `0x${'7'.repeat(64)}`,
        idempotencyKey: 'governed-replacement-assignment',
        correlationId: 'governed-replacement-assignment',
      },
    );

    const settlements = new SettlementService({
      transactions: transactionAdapter(db),
      secondarySignerAddress: secondary.address,
      governanceVerifyingContract: governanceWallet,
      clock: () => now,
    });
    const takeoverAccount = `takeover:${takeover.caseId}:usdt`;
    const takeoverApprovalIntent: SensitiveActionIntent = {
      action: 'CREATE_TAKEOVER_PAYOUT',
      resourceType: 'TAKEOVER_CASE',
      resourceId: takeover.caseId,
      policyVersion: 1n,
      oldValueHash: stableHash({
        accountId: takeoverAccount,
        availableAmount: '20',
        backingWalletAddress: operationsSafe,
      }),
      newValueHash: stableHash({
        rail: 'TAKEOVER_USDT',
        resourceId: takeover.caseId,
        orderId: intent.orderId,
        accountId: takeoverAccount,
        recipient: replacementRecipient,
        amount: '10',
        fulfillmentTargetHash: HASH,
      }),
      executorWallet: operationsSafe,
      nonce: 1n,
      deadline: BigInt(Math.floor(now.getTime() / 1000) + 300),
    };
    const takeoverApproval = await signedGovernedApproval(secondary, governanceWallet, takeoverApprovalIntent);
    const takeoverChallenge = await settlements.createGovernedIntent(operator, {
      rail: 'TAKEOVER_USDT',
      resourceId: takeover.caseId,
      orderId: intent.orderId,
      accountId: takeoverAccount,
      recipient: replacementRecipient,
      fulfillmentTargetHash: HASH,
      amount: '10',
      idempotencyKey: 'governed-takeover-intent-1',
      approval: takeoverApproval,
    });
    const alternateRecipient = '0x9999999999999999999999999999999999999998';
    await seedEligibleReplacementMerchant(db, 'alternate-replacement', alternateRecipient, '5', now, true);
    await assert.rejects(
      new TakeoverCaseService({ transactions: transactionAdapter(db), clock: () => now }).assign(
        operator,
        takeover.caseId,
        {
          replacementMerchantId: 'alternate-replacement',
          reasonCode: 'PAYOUT_ALREADY_FROZEN',
          evidenceHash: `0x${'8'.repeat(64)}`,
          idempotencyKey: 'governed-replacement-reassign',
          correlationId: 'governed-replacement-reassign',
        },
      ),
      /payout recipient is frozen/,
    );
    assert.equal((await settlements.createGovernedIntent(operator, {
      rail: 'TAKEOVER_USDT',
      resourceId: takeover.caseId,
      orderId: intent.orderId,
      accountId: takeoverAccount,
      recipient: replacementRecipient,
      fulfillmentTargetHash: HASH,
      amount: '10',
      idempotencyKey: 'governed-takeover-intent-1',
      approval: takeoverApproval,
    })).digest, takeoverChallenge.digest);
    await assert.rejects(
      settlements.createGovernedIntent(operator, {
        rail: 'TAKEOVER_USDT',
        resourceId: takeover.caseId,
        orderId: intent.orderId,
        accountId: takeoverAccount,
        recipient: replacementRecipient,
        fulfillmentTargetHash: HASH,
        amount: '10',
        idempotencyKey: 'governed-takeover-intent-replay',
        approval: takeoverApproval,
      }),
      /already consumed/,
    );
    const changedRecipient = '0x9999999999999999999999999999999999999999';
    const changedRecipientApprovalIntent: SensitiveActionIntent = {
      ...takeoverApprovalIntent,
      nonce: 99n,
      newValueHash: stableHash({
        rail: 'TAKEOVER_USDT',
        resourceId: takeover.caseId,
        orderId: intent.orderId,
        accountId: takeoverAccount,
        recipient: changedRecipient,
        amount: '10',
        fulfillmentTargetHash: HASH,
      }),
    };
    await assert.rejects(
      settlements.createGovernedIntent(operator, {
        rail: 'TAKEOVER_USDT',
        resourceId: takeover.caseId,
        orderId: intent.orderId,
        accountId: takeoverAccount,
        recipient: changedRecipient,
        fulfillmentTargetHash: HASH,
        amount: '10',
        idempotencyKey: 'governed-takeover-recipient-change',
        approval: await signedGovernedApproval(secondary, governanceWallet, changedRecipientApprovalIntent),
      }),
      /not authoritative/,
    );
    const takeoverWalletSignature = await operatorWallet.signTypedData(
      takeoverChallenge.typedData.domain,
      takeoverChallenge.typedData.types,
      takeoverChallenge.typedData.message,
    );
    await assert.rejects(
      settlements.submitRequest(
        { walletAddress: operatorWallet.address, roles: ['BUYER'] },
        { intentId: takeoverChallenge.intent.intentId, signature: takeoverWalletSignature },
      ),
      /ADMIN or OPERATOR or ARBITRATOR role is required/,
    );
    const takeoverRequest = await settlements.submitRequest(operator, {
      intentId: takeoverChallenge.intent.intentId,
      signature: takeoverWalletSignature,
    });
    assert.equal(takeoverRequest.state, 'REQUESTED');
    assert.equal((takeoverRequest as Record<string, unknown>).recipient_address, replacementRecipient);
    const remainingTakeoverApprovalIntent: SensitiveActionIntent = {
      ...takeoverApprovalIntent,
      nonce: 100n,
      oldValueHash: stableHash({
        accountId: takeoverAccount,
        availableAmount: '10',
        backingWalletAddress: operationsSafe,
      }),
    };
    const remainingTakeoverChallenge = await settlements.createGovernedIntent(operator, {
      rail: 'TAKEOVER_USDT',
      resourceId: takeover.caseId,
      orderId: intent.orderId,
      accountId: takeoverAccount,
      recipient: replacementRecipient,
      fulfillmentTargetHash: HASH,
      amount: '10',
      idempotencyKey: 'governed-takeover-remaining-intent',
      approval: await signedGovernedApproval(secondary, governanceWallet, remainingTakeoverApprovalIntent),
    });
    assert.equal(remainingTakeoverChallenge.intent.amount, '10');
    await db.query(
      "UPDATE core.settlement_intents SET state = 'CANCELLED' WHERE intent_id = $1",
      [remainingTakeoverChallenge.intent.intentId],
    );
    await assert.rejects(
      db.query(
        "UPDATE core.settlement_intents SET state = 'ISSUED' WHERE intent_id = $1",
        [remainingTakeoverChallenge.intent.intentId],
      ),
      /InvalidSettlementIntentTransition/,
    );
    await assert.rejects(
      db.query(
        `UPDATE core.takeover_replacement_fulfillment_snapshots
         SET recipient_address = $1 WHERE case_id = $2`,
        ['0x9999999999999999999999999999999999999999', takeover.caseId],
      ),
      /ImmutableRecord/,
    );
    await assert.rejects(
      db.query('UPDATE core.settlement_intents SET amount = 11 WHERE intent_id = $1', [takeoverChallenge.intent.intentId]),
      /ImmutableSettlementIntent/,
    );
    await assert.rejects(
      db.query(
        'UPDATE core.settlement_intent_items SET amount = 11 WHERE intent_id = $1',
        [takeoverChallenge.intent.intentId],
      ),
      /ImmutableRecord/,
    );
    await assert.rejects(
      db.query(
        'UPDATE core.settlement_requests SET recipient_address = $1 WHERE request_id = $2',
        [operationsSafe, takeoverRequest.request_id],
      ),
      /ImmutableSettlementRequest/,
    );

    await db.query(
      `UPDATE core.skus SET stock_total = stock_total + 1,
         stock_available = stock_available + 1 WHERE sku_id = 'sku-1'`,
    );
    const futureIntent = paymentIntent();
    futureIntent.orderId = `0x${'9'.repeat(64)}`;
    futureIntent.reservationId = `0x${'a'.repeat(64)}`;
    futureIntent.reservationHash = `0x${'b'.repeat(64)}`;
    futureIntent.nonce = '2';
    await reserveInventory(adapter(db), {
      reservationId: futureIntent.reservationId,
      reservationHash: futureIntent.reservationHash,
      policyVersion: futureIntent.policyVersion,
      skuId: 'sku-1',
      buyerWallet: futureIntent.buyer,
      quantity: futureIntent.quantity,
      classification: 'ORDINARY',
      expiresAt: new Date(futureIntent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, futureIntent, 'governed-future-proceeds-quote');
    const futurePayment = paymentInput(futureIntent);
    futurePayment.event.transactionHash = `0x${'c'.repeat(64)}`;
    futurePayment.event.blockHash = `0x${'d'.repeat(64)}`;
    await new PostgresPaymentStore(transactionAdapter(db)).record(futurePayment);
    const merchant = {
      walletAddress: MERCHANT,
      roles: ['MERCHANT'] as const,
      merchantId: 'merchant-1',
    };
    await fulfillment.recordShipment(merchant, futureIntent.orderId, {
      idempotencyKey: 'governed-future-shipment-1',
      evidenceHash: `0x${'e'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'f'.repeat(64)}`,
    });
    await fulfillment.recordDelivery(operator, futureIntent.orderId, {
      idempotencyKey: 'governed-future-delivery-1',
      evidenceHash: `0x${'1'.repeat(64)}`,
    });
    await fulfillment.confirmReceipt(
      { walletAddress: BUYER, roles: ['BUYER'] },
      futureIntent.orderId,
      { idempotencyKey: 'governed-future-receipt-1', evidenceHash: `0x${'2'.repeat(64)}` },
    );
    const recovery = (await db.query<{
      recovery_id: string;
      amount_usdt: string;
      operations_wallet_address: string;
      backing_wallet_address: string;
    }>(
      `SELECT recovery_id, amount_usdt::text, operations_wallet_address, backing_wallet_address
       FROM core.merchant_debt_recoveries WHERE order_id = $1`,
      [futureIntent.orderId],
    )).rows[0]!;
    assert.deepEqual(
      { amount: recovery.amount_usdt, recipient: recovery.operations_wallet_address, backing: recovery.backing_wallet_address },
      { amount: '20', recipient: operationsSafe, backing: custodySafe },
    );
    await assert.rejects(
      db.query('UPDATE core.merchant_debt_recoveries SET amount_usdt = 19 WHERE recovery_id = $1', [recovery.recovery_id]),
      /ImmutableMerchantDebtRecovery/,
    );
    const reimbursementAccount = `operations-reimbursement:${operationsSafe}:usdt`;
    const reimbursementApprovalIntent: SensitiveActionIntent = {
      action: 'CREATE_OPERATIONS_REIMBURSEMENT',
      resourceType: 'MERCHANT_DEBT_RECOVERY',
      resourceId: recovery.recovery_id,
      policyVersion: 1n,
      oldValueHash: stableHash({
        accountId: reimbursementAccount,
        availableAmount: '20',
        backingWalletAddress: custodySafe,
      }),
      newValueHash: stableHash({
        rail: 'OPERATIONS_REIMBURSEMENT_USDT',
        resourceId: recovery.recovery_id,
        orderId: futureIntent.orderId,
        accountId: reimbursementAccount,
        recipient: operationsSafe,
        amount: '20',
        fulfillmentTargetHash: null,
      }),
      executorWallet: custodySafe,
      nonce: 2n,
      deadline: BigInt(Math.floor(now.getTime() / 1000) + 300),
    };
    const wrongRecipientApprovalIntent: SensitiveActionIntent = {
      ...reimbursementApprovalIntent,
      newValueHash: stableHash({
        rail: 'OPERATIONS_REIMBURSEMENT_USDT',
        resourceId: recovery.recovery_id,
        orderId: futureIntent.orderId,
        accountId: reimbursementAccount,
        recipient: custodySafe,
        amount: '20',
        fulfillmentTargetHash: null,
      }),
    };
    await assert.rejects(
      settlements.createGovernedIntent(operator, {
        rail: 'OPERATIONS_REIMBURSEMENT_USDT',
        resourceId: recovery.recovery_id,
        orderId: futureIntent.orderId,
        accountId: reimbursementAccount,
        recipient: custodySafe,
        amount: '20',
        idempotencyKey: 'governed-reimbursement-wrong-recipient',
        approval: await signedGovernedApproval(secondary, governanceWallet, wrongRecipientApprovalIntent),
      }),
      /must return to the Operations Wallet/,
    );
    const reimbursementChallenge = await settlements.createGovernedIntent(operator, {
      rail: 'OPERATIONS_REIMBURSEMENT_USDT',
      resourceId: recovery.recovery_id,
      orderId: futureIntent.orderId,
      accountId: reimbursementAccount,
      recipient: operationsSafe,
      amount: '20',
      idempotencyKey: 'governed-reimbursement-intent-1',
      approval: await signedGovernedApproval(secondary, governanceWallet, reimbursementApprovalIntent),
    });
    const reimbursementWalletSignature = await operatorWallet.signTypedData(
      reimbursementChallenge.typedData.domain,
      reimbursementChallenge.typedData.types,
      reimbursementChallenge.typedData.message,
    );
    const reimbursementRequest = await settlements.submitRequest(operator, {
      intentId: reimbursementChallenge.intent.intentId,
      signature: reimbursementWalletSignature,
    });
    assert.equal(reimbursementRequest.state, 'REQUESTED');
    assert.equal((reimbursementRequest as Record<string, unknown>).recipient_address, operationsSafe);

    await db.query(
      `INSERT INTO core.coverage_snapshots (
         snapshot_id, chain_id, block_number, block_hash, canonical, evidence_hash, recorded_at
       ) VALUES ('coverage:governed:1', 56, 1000, $1, true, $2, $3)`,
      [`0x${'3'.repeat(64)}`, `0x${'4'.repeat(64)}`, now],
    );
    for (const [walletAddress, liability] of [[operationsSafe, '10'], [custodySafe, '20']] as const) {
      await db.query(
        `INSERT INTO core.coverage_snapshot_items (
           snapshot_id, wallet_address, asset, verified_asset_balance,
           unsettled_liability, coverage_met
         ) VALUES ('coverage:governed:1', $1, 'USDT', $2, $2, true)`,
        [walletAddress, liability],
      );
    }
    await db.query(
      `INSERT INTO core.coverage_snapshot_canonicality (
         observation_id, snapshot_id, canonical, observed_block_hash, evidence_hash, observed_at
       ) VALUES ('coverage-observation:governed:1', 'coverage:governed:1', true, $1, $2, $3)`,
      [`0x${'3'.repeat(64)}`, `0x${'4'.repeat(64)}`, now],
    );
    const runtime = (executorWallet: string, nextNonce: string) => ({
      executorWallet,
      nextNonce,
      tokenAddress: USDT_ADDRESS,
      tokenCodeHash: `0x${'5'.repeat(64)}`,
      tokenTransferConformanceEvidenceHash: `0x${'6'.repeat(64)}`,
      evidenceHash: `0x${'7'.repeat(64)}`,
      checkedAt: now,
    });
    const operationsTransfer = await settlements.createTransfer(operator, {
      asset: 'USDT',
      gasCap: '100000',
      idempotencyKey: 'governed-operations-eoa-transfer-1',
      runtime: runtime(operationsSafe, '1'),
      correlationId: 'governed-operations-eoa-transfer-1',
    });
    const custodyTransfer = await settlements.createTransfer(operator, {
      asset: 'USDT',
      gasCap: '100000',
      idempotencyKey: 'governed-custody-eoa-transfer-1',
      runtime: runtime(custodySafe, '1'),
      correlationId: 'governed-custody-eoa-transfer-1',
    });
    assert.equal(operationsTransfer.recipientAddress, replacementRecipient);
    assert.equal(custodyTransfer.recipientAddress, operationsSafe);
    assert.notEqual(operationsTransfer.transferId, custodyTransfer.transferId);
    await assertLedgerBalanced(db, 2);
  } finally {
    await db.close();
  }
});

test('evidence and media stay scoped, idempotent, hashed and immutable', async () => {
  const db = await createBusinessDatabase();
  const now = new Date('2026-07-15T04:00:00.000Z');
  const contentSha256 = `0x${'7'.repeat(64)}`;
  const providerReferenceHash = `0x${'8'.repeat(64)}`;
  const providerEvidenceHash = `0x${'9'.repeat(64)}`;
  const objectVersionHash = `0x${'c'.repeat(64)}`;
  const uploadLimits = { maxIntentsPerWalletHour: 20, maxBytesPerWalletHour: 100_000_000n };
  let createCalls = 0;
  let verifyCalls = 0;
  let readCalls = 0;
  let objectWritten = false;
  let objectSealed = false;
  const putObject = async () => {
    if (objectWritten || objectSealed) throw new Error('WriteOnceObjectAlreadyExists');
    objectWritten = true;
  };
  const storage: MediaStorageAdapter = {
    createUpload: async (input) => {
      createCalls += 1;
      assert.equal(input.contentSha256, contentSha256);
      return {
        method: 'PUT',
        uploadUrl: 'https://uploads.example.invalid/signed-object',
        headers: { 'if-none-match': '*', 'x-upload-token': 'opaque-test-token' },
        providerReferenceHash,
        writeOnce: true,
      };
    },
    finalizeUpload: async (input) => {
      verifyCalls += 1;
      assert.equal(input.contentSha256, contentSha256);
      assert.equal(objectWritten, true);
      objectSealed = true;
      return { providerEvidenceHash, objectVersionHash, sealed: true };
    },
    createRead: async (input) => {
      readCalls += 1;
      return {
        method: 'GET',
        readUrl: 'https://media.example.invalid/signed-object',
        expiresAt: input.expiresAt.toISOString(),
        providerReferenceHash,
        assetId: input.assetId,
        contentSha256: input.contentSha256,
        objectVersionHash: input.objectVersionHash,
      };
    },
  };
  try {
    const intent = await recordFinalPayment(db);
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const evidence = new EvidenceService({
      transactions: transactionAdapter(db),
      storage,
      trackingHashKey: 'ab'.repeat(32),
      trackingEncryptionKey: 'cd'.repeat(32),
      uploadLimits,
      clock: () => now,
    });

    const invalidMediaCombinations = [
      ['PRODUCT_IMAGE', 'PRODUCT', 'video/mp4'],
      ['PRODUCT_VIDEO', 'PRODUCT', 'image/jpeg'],
      ['CATEGORY_ICON', 'CATEGORY', 'application/pdf'],
      ['STORE_IMAGE', 'STORE', 'video/mp4'],
      ['FULFILLMENT_EVIDENCE', 'ORDER', 'video/mp4'],
    ] as const;
    for (const [purpose, resourceType, contentType] of invalidMediaCombinations) {
      await assert.rejects(
        evidence.createUploadIntent(buyer, {
          purpose,
          resourceType,
          resourceId: intent.orderId,
          contentType,
          sizeBytes: 64,
          contentSha256,
          idempotencyKey: `invalid-media-${purpose.toLowerCase()}`,
        }),
        /Media content type does not match its purpose/,
      );
    }
    assert.equal(createCalls, 0);

    const upload = await evidence.createUploadIntent(buyer, {
      purpose: 'FULFILLMENT_EVIDENCE',
      resourceType: 'ORDER',
      resourceId: intent.orderId,
      contentType: 'image/webp',
      sizeBytes: 512,
      contentSha256,
      idempotencyKey: 'evidence-upload-1',
    });
    assert.equal(upload.state, 'UPLOADED');
    assert.equal(upload.ownerWallet, BUYER);
    assert.equal(upload.purpose, 'FULFILLMENT_EVIDENCE');
    assert.equal(upload.resourceType, 'ORDER');
    assert.equal(upload.resourceId, intent.orderId);
    assert.equal(upload.contentType, 'image/webp');
    assert.equal(upload.sizeBytes, '512');
    assert.equal(upload.writeOnce, true);
    assert.equal(upload.headers['if-none-match'], '*');
    assert.equal(upload.providerReferenceHash, providerReferenceHash);
    assert.equal(createCalls, 1);
    const storedIntent = await db.query<{
      state: string;
      provider_reference_hash: string;
      object_key: string;
    }>(
      `SELECT state, provider_reference_hash, object_key
       FROM core.media_upload_intents WHERE upload_intent_id = $1`,
      [upload.uploadIntentId],
    );
    assert.equal(storedIntent.rows[0]?.state, 'UPLOADED');
    assert.equal(storedIntent.rows[0]?.provider_reference_hash, providerReferenceHash);
    assert.equal(storedIntent.rows[0]?.object_key.includes(intent.orderId), false);

    await putObject();
    const asset = await evidence.completeUpload(buyer, upload.uploadIntentId);
    assert.equal(asset.contentSha256, contentSha256);
    assert.equal(asset.providerEvidenceHash, providerEvidenceHash);
    assert.equal(asset.objectVersionHash, objectVersionHash);
    const authenticatedRead = await evidence.createReadAccess(buyer, String(asset.assetId));
    assert.equal(authenticatedRead.accessScope, 'AUTHENTICATED');
    assert.equal(authenticatedRead.readUrl, 'https://media.example.invalid/signed-object');
    assert.equal(readCalls, 1);
    await assert.rejects(
      evidence.createReadAccess(
        { walletAddress: '0x9999999999999999999999999999999999999998', roles: ['BUYER'] },
        String(asset.assetId),
      ),
      /outside the actor scope/,
    );
    assert.equal(readCalls, 1);
    const mismatchedRead = new EvidenceService({
      transactions: transactionAdapter(db),
      storage: {
        ...storage,
        createRead: async (input) => ({
          method: 'GET',
          readUrl: 'https://media.example.invalid/wrong-object',
          expiresAt: input.expiresAt.toISOString(),
          providerReferenceHash,
          assetId: HASH,
          contentSha256: input.contentSha256,
          objectVersionHash: input.objectVersionHash,
        }),
      },
      clock: () => now,
    });
    await assert.rejects(
      mismatchedRead.createReadAccess(buyer, String(asset.assetId)),
      /Media provider returned an invalid read target/,
    );
    await assert.rejects(putObject(), /WriteOnceObjectAlreadyExists/);
    assert.equal(verifyCalls, 1);
    await assert.rejects(
      db.query(
        `INSERT INTO core.media_upload_intents (
           upload_intent_id, owner_wallet, purpose, resource_type, resource_id,
           object_key, content_type, size_bytes, content_sha256, idempotency_key,
           request_hash, state, expires_at, created_at, updated_at
         ) VALUES ($1,$2,'PRODUCT_IMAGE','PRODUCT','invalid-product-media',
           'abu24k-v2/product-image/invalid-video','video/mp4',64,$3,
           'invalid-media-sql-1',$4,'PENDING',$5,$6,$6)`,
        [`0x${'d'.repeat(64)}`, BUYER, `0x${'e'.repeat(64)}`, `0x${'f'.repeat(64)}`,
          new Date(now.getTime() + 60_000), now],
      ),
      /violates check constraint/,
    );
    const constraintIntentId = `0x${'6'.repeat(64)}`;
    const constraintOwner = '0x9999999999999999999999999999999999999996';
    await db.query(
      `INSERT INTO core.media_upload_intents (
         upload_intent_id, owner_wallet, purpose, resource_type, resource_id,
         object_key, content_type, size_bytes, content_sha256, idempotency_key,
         request_hash, state, expires_at, created_at, updated_at
       ) VALUES ($1,$2,'PRODUCT_VIDEO','PRODUCT','constraint-product-media',
         'abu24k-v2/product-video/constraint-video','video/mp4',64,$3,
         'valid-video-sql-1',$4,'PENDING',$5,$6,$6)`,
      [constraintIntentId, constraintOwner, `0x${'5'.repeat(64)}`, `0x${'4'.repeat(64)}`,
        new Date(now.getTime() + 60_000), now],
    );
    await assert.rejects(
      db.query(
        `INSERT INTO core.media_assets (
           asset_id, upload_intent_id, owner_wallet, purpose, resource_type,
           resource_id, object_key, content_type, size_bytes, content_sha256,
           provider_evidence_hash, object_version_hash, created_at
         ) VALUES ($1,$2,$3,'PRODUCT_VIDEO','PRODUCT','constraint-product-media',
           'abu24k-v2/product-video/constraint-video','image/jpeg',64,$4,$5,$6,$7)`,
        [`0x${'3'.repeat(64)}`, constraintIntentId, constraintOwner, `0x${'5'.repeat(64)}`,
          `0x${'2'.repeat(64)}`, `0x${'1'.repeat(64)}`, now],
      ),
      /violates check constraint/,
    );
    assert.deepEqual(await evidence.completeUpload(buyer, upload.uploadIntentId), asset);
    assert.equal(verifyCalls, 1);
    await assert.rejects(
      evidence.completeUpload(
        { walletAddress: '0x9999999999999999999999999999999999999998', roles: ['BUYER'] },
        upload.uploadIntentId,
      ),
      /belongs to another wallet/,
    );
    await assert.rejects(
      evidence.createUploadIntent(buyer, {
        purpose: 'FULFILLMENT_EVIDENCE',
        resourceType: 'ORDER',
        resourceId: intent.orderId,
        contentType: 'image/webp',
        sizeBytes: 513,
        contentSha256,
        idempotencyKey: 'evidence-upload-1',
      }),
      /Upload intent changed/,
    );

    const action = await evidence.createActionEvidence(buyer, {
      orderId: intent.orderId,
      action: 'REQUEST_EXCHANGE',
      reasonCode: 'DAMAGED_PACKAGE',
      mediaAssetIds: [String(asset.assetId)],
      idempotencyKey: 'action-evidence-1',
    });
    assert.deepEqual(await evidence.createActionEvidence(buyer, {
      orderId: intent.orderId,
      action: 'REQUEST_EXCHANGE',
      reasonCode: 'DAMAGED_PACKAGE',
      mediaAssetIds: [String(asset.assetId)],
      idempotencyKey: 'action-evidence-1',
    }), action);
    await evidence.assertActionEvidence(buyer, {
      orderId: intent.orderId,
      action: 'REQUEST_EXCHANGE',
      evidenceHash: action.evidenceHash,
      reasonCode: 'DAMAGED_PACKAGE',
    });
    await assert.rejects(
      evidence.assertActionEvidence(buyer, {
        orderId: intent.orderId,
        action: 'REQUEST_DELAY',
        evidenceHash: action.evidenceHash,
      }),
      /does not match the command/,
    );
    await assert.rejects(
      evidence.assertActionEvidence(buyer, {
        orderId: intent.orderId,
        action: 'REQUEST_EXCHANGE',
        evidenceHash: action.evidenceHash,
        reasonCode: 'WRONG_ITEM',
      }),
      /does not match the command/,
    );
    await assert.rejects(
      evidence.createActionEvidence(buyer, {
        orderId: intent.orderId,
        action: 'REQUEST_EXCHANGE',
        reasonCode: 'WRONG_ITEM',
        mediaAssetIds: [String(asset.assetId)],
        idempotencyKey: 'action-evidence-1',
      }),
      /Evidence input changed/,
    );
    await assert.rejects(
      evidence.createActionEvidence(merchant, {
        orderId: intent.orderId,
        action: 'VERIFY_PICKUP',
        reasonCode: 'PICKUP_PROOF',
        mediaAssetIds: [String(asset.assetId)],
        idempotencyKey: 'merchant-foreign-media-1',
      }),
      /Media evidence is unverified or outside the resource/,
    );

    const tracking = await evidence.createTrackingEvidence(merchant, {
      orderId: intent.orderId,
      carrierCode: 'SF',
      trackingNumber: ' sf-123 456 ',
      idempotencyKey: 'tracking-evidence-1',
    });
    assert.equal(tracking.carrierCode, 'SF');
    assert.deepEqual(await evidence.createTrackingEvidence(merchant, {
      orderId: intent.orderId,
      carrierCode: 'SF',
      trackingNumber: 'SF123456',
      idempotencyKey: 'tracking-evidence-1',
    }), tracking);
    await evidence.assertTrackingEvidence(merchant, {
      orderId: intent.orderId,
      carrierCode: 'SF',
      trackingNumberHash: String(tracking.trackingNumberHash),
      evidenceHash: tracking.evidenceHash,
    });
    await assert.rejects(
      evidence.assertTrackingEvidence(merchant, {
        orderId: intent.orderId,
        carrierCode: 'SF',
        trackingNumberHash: HASH,
        evidenceHash: tracking.evidenceHash,
      }),
      /does not match the command/,
    );
    await assert.rejects(
      evidence.createTrackingEvidence(merchant, {
        orderId: intent.orderId,
        carrierCode: 'SF',
        trackingNumber: 'SF999999',
        idempotencyKey: 'tracking-evidence-1',
      }),
      /Evidence input changed/,
    );
    const trackingStorage = await db.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM core.evidence_envelopes
       WHERE evidence_hash = $1`,
      [tracking.evidenceHash],
    );
    assert.equal(JSON.stringify(trackingStorage.rows).includes('SF123456'), false);
    assert.equal(JSON.stringify(trackingStorage.rows).includes('sf-123 456'), false);
    assert.throws(
      () => evidence.createTrackingEvidence(merchant, {
        orderId: intent.orderId,
        carrierCode: 'SF',
        trackingNumber: 'SF123456',
        idempotencyKey: 'tracking-SF123456',
      }),
      /must not contain a tracking number/,
    );
    assert.throws(
      () => new EvidenceService({ transactions: transactionAdapter(db), storage }).createTrackingEvidence(merchant, {
        orderId: intent.orderId,
        carrierCode: 'SF',
        trackingNumber: 'SF123456',
        idempotencyKey: 'tracking-no-key-1',
      }),
      /Tracking hash key is unavailable/,
    );

    await assert.rejects(
      evidence.createActionEvidence(
        { walletAddress: '0x9999999999999999999999999999999999999998', roles: ['BUYER'] },
        {
          orderId: intent.orderId,
          action: 'REQUEST_DELAY',
          reasonCode: 'BUYER_REQUEST',
          idempotencyKey: 'foreign-order-evidence-1',
        },
      ),
      /outside the actor order scope/,
    );
    await assert.rejects(
      evidence.createActionEvidence(
        {
          walletAddress: '0x9999999999999999999999999999999999999998',
          roles: ['BUYER', 'ADMIN'],
        },
        {
          orderId: intent.orderId,
          action: 'REQUEST_EXCHANGE',
          reasonCode: 'BUYER_REQUEST',
          idempotencyKey: 'multi-role-buyer-evidence-1',
        },
      ),
      /outside the actor order scope/,
    );
    const platformTracking = await evidence.createTrackingEvidence(
      {
        walletAddress: '0x9999999999999999999999999999999999999997',
        roles: ['MERCHANT', 'ADMIN'],
        merchantId: 'merchant-other',
      },
      {
        orderId: intent.orderId,
        carrierCode: 'JD',
        trackingNumber: 'JD123456',
        idempotencyKey: 'platform-tracking-evidence-1',
      },
    );
    assert.equal(platformTracking.actorRole, 'ADMIN');
    await assert.rejects(
      evidence.createTrackingEvidence(
        { walletAddress: '0x9999999999999999999999999999999999999997', roles: ['ADMIN'] },
        {
          orderId: 'missing-order',
          carrierCode: 'SF',
          trackingNumber: 'SF123456',
          idempotencyKey: 'missing-order-evidence-1',
        },
      ),
      /Order was not found/,
    );
    await assert.rejects(
      db.query('UPDATE core.media_assets SET size_bytes = 513 WHERE asset_id = $1', [asset.assetId]),
      /ImmutableRecord/,
    );
    await assert.rejects(
      db.query('DELETE FROM core.evidence_envelopes WHERE evidence_hash = $1', [action.evidenceHash]),
      /ImmutableRecord/,
    );

    const limited = new EvidenceService({
      transactions: transactionAdapter(db),
      storage,
      uploadLimits: { maxIntentsPerWalletHour: 1, maxBytesPerWalletHour: 1_000_000n },
      clock: () => now,
    });
    await assert.rejects(
      limited.createUploadIntent(buyer, {
        purpose: 'FULFILLMENT_EVIDENCE',
        resourceType: 'ORDER',
        resourceId: intent.orderId,
        contentType: 'image/png',
        sizeBytes: 128,
        contentSha256: `0x${'d'.repeat(64)}`,
        idempotencyKey: 'upload-quota-exceeded-1',
      }),
      /Media upload quota exceeded/,
    );
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.media_upload_intents WHERE owner_wallet = $1',
      [BUYER],
    )).rows[0]?.count, '1');
    assert.equal((await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.media_upload_wallet_locks WHERE owner_wallet = $1',
      [BUYER],
    )).rows[0]?.count, '1');

    const unavailable = new EvidenceService({
      transactions: transactionAdapter(db),
      storage: new HttpMediaStorageAdapter({}),
      uploadLimits,
      clock: () => now,
    });
    await assert.rejects(
      unavailable.createUploadIntent(buyer, {
        purpose: 'FULFILLMENT_EVIDENCE',
        resourceType: 'ORDER',
        resourceId: intent.orderId,
        contentType: 'image/png',
        sizeBytes: 128,
        contentSha256: `0x${'a'.repeat(64)}`,
        idempotencyKey: 'provider-unavailable-1',
      }),
      /Media storage signer is not configured/,
    );
    const pending = await db.query<{ state: string; provider_reference_hash: string | null }>(
      `SELECT state, provider_reference_hash FROM core.media_upload_intents
       WHERE idempotency_key = 'provider-unavailable-1'`,
    );
    assert.deepEqual(pending.rows[0], { state: 'PENDING', provider_reference_hash: null });

    await assert.rejects(
      evidence.createUploadIntent(
        { walletAddress: '0x9999999999999999999999999999999999999997', roles: ['ADMIN'] },
        {
          purpose: 'PRODUCT_IMAGE',
          resourceType: 'PRODUCT',
          resourceId: 'missing-product',
          contentType: 'image/jpeg',
          sizeBytes: 64,
          contentSha256: `0x${'b'.repeat(64)}`,
          idempotencyKey: 'missing-product-upload-1',
        },
      ),
      /Product was not found/,
    );
    assert.equal(createCalls, 1);
  } finally {
    await db.close();
  }
});

async function prepareRequestedSettlement(db: PGlite) {
  const merchantWallet = Wallet.createRandom();
  const intent = paymentIntent();
  intent.merchant = merchantWallet.address.toLowerCase();
  await recordFinalPayment(db, intent);
  let now = new Date((intent.issuedAt + 60) * 1000);
  const fulfillment = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
  const merchant = {
    walletAddress: merchantWallet.address,
    roles: ['MERCHANT'] as const,
    merchantId: 'merchant-1',
  };
  await fulfillment.recordShipment(merchant, intent.orderId, {
    idempotencyKey: 'retry-shipment-1',
    evidenceHash: `0x${'3'.repeat(64)}`,
    carrierCode: 'SF',
    trackingNumberHash: `0x${'4'.repeat(64)}`,
  });
  await fulfillment.recordDelivery(
    { walletAddress: '0x3333333333333333333333333333333333333333', roles: ['OPERATOR'] },
    intent.orderId,
    { idempotencyKey: 'retry-delivery-1', evidenceHash: `0x${'5'.repeat(64)}` },
  );
  await fulfillment.confirmReceipt(
    { walletAddress: BUYER, roles: ['BUYER'] },
    intent.orderId,
    { idempotencyKey: 'retry-receipt-1', evidenceHash: `0x${'6'.repeat(64)}` },
  );
  now = new Date(now.getTime() + 60_000);
  const settlements = new SettlementService({ transactions: transactionAdapter(db), clock: () => now });
  const challenge = await settlements.createIntent(merchant, {
    rail: 'MERCHANT_USDT',
    amount: '45',
    idempotencyKey: 'retry-settlement-intent-1',
  });
  const signature = await merchantWallet.signTypedData(
    challenge.typedData.domain,
    challenge.typedData.types,
    challenge.typedData.message,
  );
  const request = await settlements.submitRequest(merchant, {
    intentId: challenge.intent.intentId,
    signature,
  });
  await db.query(
    `INSERT INTO core.coverage_snapshots (
       snapshot_id, chain_id, block_number, block_hash, canonical, evidence_hash, recorded_at
     ) VALUES ('coverage:retry:1', 56, 1000, $1, true, $2, $3)`,
    [`0x${'7'.repeat(64)}`, `0x${'8'.repeat(64)}`, now],
  );
  await db.query(
    `INSERT INTO core.coverage_snapshot_items (
       snapshot_id, wallet_address, asset, verified_asset_balance,
       unsettled_liability, coverage_met
     ) VALUES ('coverage:retry:1', $1, 'USDT', 70, 70, true)`,
    ['0x3333333333333333333333333333333333333333'],
  );
  await db.query(
    `INSERT INTO core.coverage_snapshot_canonicality (
       observation_id, snapshot_id, canonical, observed_block_hash, evidence_hash, observed_at
     ) VALUES ('coverage-observation:retry:1', 'coverage:retry:1', true, $1, $2, $3)`,
    [`0x${'7'.repeat(64)}`, `0x${'8'.repeat(64)}`, now],
  );
  const operator = {
    walletAddress: '0x9999999999999999999999999999999999999999',
    roles: ['OPERATOR'] as const,
  };
  const runtime = {
    executorWallet: '0x3333333333333333333333333333333333333333',
    nextNonce: '7',
    tokenAddress: USDT_ADDRESS,
    tokenCodeHash: `0x${'9'.repeat(64)}`,
    tokenTransferConformanceEvidenceHash: `0x${'a'.repeat(64)}`,
    evidenceHash: `0x${'b'.repeat(64)}`,
    checkedAt: now,
  };
  return {
    merchantWallet,
    intent,
    now,
    settlements,
    merchant,
    operator,
    runtime,
    request,
    requestedAmount: challenge.intent.amount,
  };
}

async function recordFinalPayment(db: PGlite, intent = paymentIntent()) {
  await seedCatalog(db, 1, intent.merchant);
  await reserveInventory(adapter(db), {
    reservationId: intent.reservationId,
    reservationHash: intent.reservationHash,
    policyVersion: intent.policyVersion,
    skuId: 'sku-1',
    buyerWallet: intent.buyer,
    quantity: intent.quantity,
    classification: 'ORDINARY',
    expiresAt: new Date(intent.reservationDeadline * 1000),
  });
  await insertPaymentQuote(db, intent, `fulfillment-${intent.orderId}`);
  await new PostgresPaymentStore(transactionAdapter(db)).record(paymentInput(intent));
  return intent;
}

async function completeDeliveryForBnm(db: PGlite) {
  const intent = await recordFinalPayment(db);
  const now = new Date((intent.issuedAt + 60) * 1000);
  const fulfillment = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
  await fulfillment.recordShipment(
    { walletAddress: MERCHANT, roles: ['MERCHANT'], merchantId: 'merchant-1' },
    intent.orderId,
    {
      idempotencyKey: 'bnm-in-flight-shipment',
      evidenceHash: `0x${'3'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'4'.repeat(64)}`,
    },
  );
  await fulfillment.recordDelivery(
    { walletAddress: '0x3333333333333333333333333333333333333333', roles: ['OPERATOR'] },
    intent.orderId,
    { idempotencyKey: 'bnm-in-flight-delivery', evidenceHash: `0x${'5'.repeat(64)}` },
  );
  await fulfillment.confirmReceipt(
    { walletAddress: BUYER, roles: ['BUYER'] },
    intent.orderId,
    { idempotencyKey: 'bnm-in-flight-receipt', evidenceHash: `0x${'6'.repeat(64)}` },
  );
  return { intent, now };
}

async function reversePayment(db: PGlite, intent: CanonicalPaymentIntent) {
  const payment = paymentInput(intent);
  return new PostgresPaymentStore(transactionAdapter(db)).reverse(
    paymentEventKey(payment.event.transactionHash, payment.event.logIndex, payment.event.blockHash),
    `0x${'9'.repeat(64)}`,
  );
}

async function liabilityStates(db: PGlite, orderId: string, state: string) {
  const result = await db.query<{ asset: string; amount: string }>(
    `SELECT account.asset,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
     FROM core.ledger_journals journal
     JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE journal.order_id = $1 AND line.balance_state = $2
     GROUP BY account.asset
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) <> 0
     ORDER BY account.asset`,
    [orderId, state],
  );
  return Object.fromEntries(result.rows.map((row) => [row.asset, row.amount]));
}

async function purposeBalances(db: PGlite, orderId: string, purpose: string) {
  const result = await db.query<{ balance_state: string; amount: string }>(
    `SELECT line.balance_state,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
     FROM core.ledger_journals journal
     JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE journal.order_id = $1 AND account.purpose = $2
     GROUP BY line.balance_state
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) <> 0
     ORDER BY line.balance_state`,
    [orderId, purpose],
  );
  return Object.fromEntries(result.rows.map((row) => [row.balance_state, row.amount]));
}

function paymentIntent(): CanonicalPaymentIntent {
  const now = Math.floor(Date.now() / 1000);
  return {
    orderId: `0x${'a'.repeat(64)}`,
    policyVersion: 1,
    buyer: BUYER,
    merchant: MERCHANT,
    productId: `0x${'b'.repeat(64)}`,
    skuId: `0x${'c'.repeat(64)}`,
    quantity: 1,
    fulfillmentMode: 'DELIVERY',
    fulfillmentTargetHash: HASH,
    regionCodeHash: HASH,
    productPolicyHash: HASH,
    reservationId: `0x${'d'.repeat(64)}`,
    reservationHash: `0x${'e'.repeat(64)}`,
    reservationDeadline: now + 600,
    issuedAt: now,
    deadline: now + 300,
    nonce: '1',
    listPriceUsdt: '100',
    productUsdtPaymentAmount: '70',
    platformServiceFeeUsdt: '1',
    custodyProductUsdt: '69',
    freightUsdt: '0',
    usdtPaymentAmount: '70',
    nplQuoteAmount: '1000',
    nplPaymentAmount: '300',
    nplBurnAmount: '200',
    nplRewardAmount: '100',
    merchantBaseReceivableUsdt: '69',
    merchantConcessionBps: 2_500,
    merchantConcessionAmount: '17',
    merchantNetReceivableUsdt: '52',
    concessionAllocationHash: paymentAllocationSetHash(),
    bnmAmount: '100',
    seckill: false,
    sessionId: `0x${'0'.repeat(64)}`,
    beneficiaries: {
      genesis: '0x0000000000000000000000000000000000000000',
      directReferral: '0x5000000000000000000000000000000000000002',
      district: '0x5000000000000000000000000000000000000003',
      city: '0x5000000000000000000000000000000000000004',
      province: '0x5000000000000000000000000000000000000005',
      region: '0x5000000000000000000000000000000000000006',
    },
    merchantConcessionAllocations: [
      { pool: 'SECKILL_PRIZE', amount: '7', balanceState: 'LOCKED' },
      { pool: 'NODE_REWARD', amount: '7', balanceState: 'LOCKED' },
      { pool: 'REWARD_RESERVE', amount: '3', balanceState: 'LOCKED' },
    ],
    nplRewardAllocations: [
      { role: 'genesis', account: '0x5000000000000000000000000000000000000011', amount: '20' },
      { role: 'directReferral', account: '0x5000000000000000000000000000000000000002', amount: '10' },
      { role: 'district', account: '0x5000000000000000000000000000000000000003', amount: '12' },
      { role: 'city', account: '0x5000000000000000000000000000000000000004', amount: '8' },
      { role: 'province', account: '0x5000000000000000000000000000000000000005', amount: '6' },
      { role: 'region', account: '0x5000000000000000000000000000000000000006', amount: '4' },
      { role: 'operations', account: '0x5000000000000000000000000000000000000007', amount: '10' },
      { role: 'operations', account: '0x5000000000000000000000000000000000000008', amount: '10' },
      { role: 'operations', account: '0x5000000000000000000000000000000000000009', amount: '10' },
      { role: 'operations', account: '0x5000000000000000000000000000000000000010', amount: '10' },
    ],
    requiredConfirmations: 15,
  };
}

function paymentInput(
  intent: CanonicalPaymentIntent,
  classification: 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL' = 'ORDINARY',
): RecordPaymentInput {
  return {
    event: {
      artifactVersion: CORE_ARTIFACT_VERSION,
      orderId: intent.orderId,
      transactionHash: `0x${'6'.repeat(64)}`,
      logIndex: 0,
      blockNumber: 100,
      blockHash: `0x${'5'.repeat(64)}`,
      blockTimestamp: new Date(intent.issuedAt * 1000),
      finalizedAt: new Date((intent.issuedAt + 42) * 1000),
      contractAddress: '0x9999999999999999999999999999999999999999',
      eventHash: HASH,
      snapshotHash: paymentIntentHash(intent),
      classification,
      buyer: intent.buyer,
      merchant: intent.merchant,
      policyVersion: intent.policyVersion,
      listPriceUsdt: intent.listPriceUsdt,
      productUsdtPaid: intent.productUsdtPaymentAmount,
      platformServiceFeeUsdt: intent.platformServiceFeeUsdt,
      custodyProductUsdt: intent.custodyProductUsdt,
      freightUsdt: intent.freightUsdt,
      usdtPaid: intent.usdtPaymentAmount,
      nplPaid: intent.nplPaymentAmount,
      nplBurned: intent.nplBurnAmount,
      nplRewarded: intent.nplRewardAmount,
      bnmLocked: intent.bnmAmount,
      reservationId: intent.reservationId,
      confirmations: 15,
    },
  };
}

async function assertLedgerBalanced(
  db: PGlite,
  expectedPaymentMultiple: number,
  expected: { usdt: bigint; serviceFee?: bigint; nplReward: bigint; bnm: bigint } = {
    usdt: 69n,
    serviceFee: 1n,
    nplReward: 100n,
    bnm: 100n,
  },
) {
  const balances = await db.query<{ asset: string; delta: string }>(
    `SELECT account.asset,
       sum(CASE WHEN line.side = 'DEBIT' THEN line.amount ELSE -line.amount END)::text AS delta
     FROM core.ledger_lines line
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     GROUP BY account.asset ORDER BY account.asset`,
  );
  assert.ok(balances.rows.every((row) => row.delta === '0'));
  const safeBalances = await db.query<{ account_id: string; delta: string }>(
    `SELECT line.account_id,
       sum(CASE WHEN line.side = 'DEBIT' THEN line.amount ELSE -line.amount END)::text AS delta
     FROM core.ledger_lines line
     WHERE line.account_id IN (
       'wallet:platform-service-fee:0x2222222222222222222222222222222222222223:usdt',
       'wallet:usdt-custody:0x3333333333333333333333333333333333333333:usdt',
       'wallet:npl-reward:0x4444444444444444444444444444444444444444:npl',
       'buyer:${BUYER}:bnm')
     GROUP BY line.account_id ORDER BY line.account_id`,
  );
  const values = new Map(safeBalances.rows.map((row) => [row.account_id, BigInt(row.delta)]));
  assert.equal(
    values.get('wallet:platform-service-fee:0x2222222222222222222222222222222222222223:usdt') ?? 0n,
    (expected.serviceFee ?? 0n) * BigInt(expectedPaymentMultiple),
  );
  assert.equal(
    values.get('wallet:usdt-custody:0x3333333333333333333333333333333333333333:usdt') ?? 0n,
    expected.usdt * BigInt(expectedPaymentMultiple),
  );
  assert.equal(
    values.get('wallet:npl-reward:0x4444444444444444444444444444444444444444:npl') ?? 0n,
    expected.nplReward * BigInt(expectedPaymentMultiple),
  );
  assert.equal(values.get(`buyer:${BUYER}:bnm`) ?? 0n, -expected.bnm * BigInt(expectedPaymentMultiple));
}

function chainBlock(number: number, hash: string, parentHash: string, timestamp: number): IndexedChainBlock {
  return { block: { number, hash, parentHash, timestamp }, events: [] };
}

function blockHash(value: number) {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function decodedPaymentEvent(intent: CanonicalPaymentIntent, canonicalBlockHash: string) {
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    contract: 'PaymentRouterV2',
    eventName: 'PaymentCompleted',
    eventSignature: 'PaymentCompleted(bytes32,address,address,uint8,uint64,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32,bytes32)',
    resourceId: intent.orderId,
    contractAddress: '0x9999999999999999999999999999999999999999',
    eventHash: HASH,
    transactionHash: `0x${'6'.repeat(64)}`,
    blockHash: canonicalBlockHash,
    blockNumber: 100,
    logIndex: 0,
    values: {
      orderId: intent.orderId,
      buyer: intent.buyer,
      merchant: intent.merchant,
      classification: '0',
      policyVersion: String(intent.policyVersion),
      listPriceUsdt: intent.listPriceUsdt,
      productUsdtPaid: intent.productUsdtPaymentAmount,
      platformServiceFeeUsdt: intent.platformServiceFeeUsdt,
      custodyProductUsdt: intent.custodyProductUsdt,
      freightUsdt: intent.freightUsdt,
      usdtPaid: intent.usdtPaymentAmount,
      nplPaid: intent.nplPaymentAmount,
      nplBurned: intent.nplBurnAmount,
      nplRewarded: intent.nplRewardAmount,
      bnmLocked: intent.bnmAmount,
      reservationId: intent.reservationId,
      snapshotHash: paymentIntentHash(intent),
    },
  };
}

function decodedSeckillRelayEvent(
  sessionId: string,
  orderId: string,
  canonicalBlockHash: string,
  relayDeadline: number,
) {
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    contract: 'PaymentRouterV2',
    eventName: 'SeckillRelayExtended',
    eventSignature: 'SeckillRelayExtended(bytes32,bytes32,uint64)',
    resourceId: sessionId,
    contractAddress: '0x9999999999999999999999999999999999999999',
    eventHash: HASH_2,
    transactionHash: `0x${'6'.repeat(64)}`,
    blockHash: canonicalBlockHash,
    blockNumber: 100,
    logIndex: 1,
    values: {
      sessionId,
      orderId,
      relayDeadline: String(relayDeadline),
    },
  };
}

async function createBusinessDatabase() {
  const db = await PGlite.create();
  await applyMigrations(adapter(db), 'core', BUSINESS_MIGRATIONS);
  return db;
}

function governedTakeoverFundingService(
  db: PGlite,
  secondary: { address: string },
  governanceWallet: string,
  clock: () => Date,
) {
  return new TakeoverFundingService({
    transactions: transactionAdapter(db),
    secondarySigner: secondary.address,
    governanceWallet,
    verifyingContract: governanceWallet,
    auditReady: () => true,
    clock,
  });
}

async function signedTakeoverFundingApproval(
  service: TakeoverFundingService,
  actor: { walletAddress: string; roles: readonly ['OPERATOR'] },
  input: { caseId: string; requiredUsdt: string; operationsWalletAddress: string },
  secondary: Signer,
  nonce: string,
  deadline: string,
): Promise<TakeoverFundingApprovalInput> {
  const challenge = await service.fundingApprovalChallenge(actor, { ...input, nonce, deadline });
  const signature = await secondary.signTypedData(
    challenge.typedData.domain,
    challenge.typedData.types,
    challenge.typedData.message,
  );
  return { ...challenge.typedData.message, signature };
}

async function grantRole(
  db: PGlite,
  walletAddress: string,
  role: 'ADMIN' | 'OPERATOR' | 'ARBITRATOR' | 'AUDITOR',
) {
  await db.query(
    `INSERT INTO core.wallet_role_bindings (
       wallet_address, role, merchant_id, status, evidence_hash
     ) VALUES ($1,$2,NULL,'ACTIVE',$3)
     ON CONFLICT (wallet_address, role) DO UPDATE SET status = 'ACTIVE', revoked_at = NULL`,
    [walletAddress.toLowerCase(), role, HASH],
  );
}

function adapter(db: PGlite): SqlExecutor {
  return {
    exec: (sql) => db.exec(sql),
    query: async <Row extends object>(sql: string, params: unknown[] = []) => {
      const result = await db.query<Row>(sql, params);
      return { rows: result.rows };
    },
  };
}

function transactionAdapter(db: PGlite, beforeQuery?: (sql: string) => void): SqlTransactionRunner {
  return {
    transaction: async (operation) => {
      await db.exec('BEGIN');
      try {
        const executor: SqlExecutor = {
          exec: (sql) => db.exec(sql),
          query: async <Row extends object>(sql: string, params: unknown[] = []) => {
            beforeQuery?.(sql);
            const result = await db.query<Row>(sql, params);
            return { rows: result.rows };
          },
        };
        const result = await operation(executor);
        await db.exec('COMMIT');
        return result;
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function concurrentTransactionAdapter(db: PGlite): SqlTransactionRunner {
  return {
    transaction: (operation) => db.transaction(async (transaction) => operation({
      exec: (sql) => transaction.exec(sql),
      query: async <Row extends object>(sql: string, params: unknown[] = []) => {
        const result = await transaction.query<Row>(sql, params);
        return { rows: result.rows };
      },
    })),
  };
}

async function seedCatalog(
  db: PGlite,
  stock: number,
  settlementWallet = MERCHANT,
  options: {
    buyerWallet?: string;
    policyPayload?: Record<string, unknown>;
    listPriceUsdt?: string;
    merchantCostUsdt?: string;
    fulfillmentTargetHash?: string;
    regionCodeHash?: string;
  } = {},
) {
  const buyerWallet = options.buyerWallet ?? BUYER;
  const policyPayload = options.policyPayload ?? paymentPolicyPayload();
  const listPriceUsdt = options.listPriceUsdt ?? '100';
  const merchantCostUsdt = options.merchantCostUsdt ?? '60';
  const fulfillmentTargetHash = options.fulfillmentTargetHash ?? HASH;
  const regionCodeHash = options.regionCodeHash ?? HASH;
  await db.query(
    `INSERT INTO core.policy_snapshots (
       policy_version, artifact_version, policy_hash,
       rules_content_hash, beneficiary_set_hash, payload, publication_status
     ) VALUES (1, '${CORE_ARTIFACT_VERSION}', $1, $1, $1, $2, 'PUBLISHED')`,
    [HASH, JSON.stringify(policyPayload)],
  );
  await db.query(
    `INSERT INTO core.policy_publication_transitions (
       transition_id, policy_version, event_type, submitted_execution_tx_hash, execution_tx_hash,
       block_number, block_hash, confirmations, canonical, evidence_hash, evidence, observed_at
     ) VALUES (
       'seed:policy-final:1', 1, 'FINAL', $1, $2, 1, $1, 15, true, $3,
       $4::jsonb,
       clock_timestamp()
     )
     ON CONFLICT (policy_version, evidence_hash) DO NOTHING`,
    [
      HASH,
      HASH_2,
      `0x${'0'.repeat(63)}1`,
      JSON.stringify({
        source: 'test-seed',
        policyVersion: 1,
        safeTxHash: HASH,
        executionTxHash: HASH_2,
        blockNumber: 1,
        blockHash: HASH,
        confirmations: 15,
        canonical: true,
      }),
    ],
  );
  await db.query(
    `INSERT INTO core.merchants (
       merchant_id, settlement_wallet, status, level, guarantee_status
     ) VALUES ('merchant-1', $1, 'APPROVED', 'V1', 'READY')`,
    [settlementWallet],
  );
  await db.query(
    `INSERT INTO core.administrative_regions (
       region_code, province, city, district, source, source_reference_hash, status
     ) VALUES ('110101', 'Beijing', 'Beijing', 'Dongcheng', 'GOVERNED_IMPORT', $1, 'ACTIVE')
     ON CONFLICT (region_code) DO NOTHING`,
    [HASH],
  );
  await db.query(
     `INSERT INTO core.fulfillment_targets (
       target_id, target_hash, buyer_wallet, idempotency_key, request_hash,
       fulfillment_mode, region_code, region_code_hash, encrypted_payload,
       encryption_iv, encryption_tag, expires_at, created_at
     ) VALUES ('target:test', $1, $2, 'seed-target-test', $1, 'DELIVERY',
       '110101', $3, $4, $5, $6, clock_timestamp() + interval '1 day', clock_timestamp())
     ON CONFLICT (target_hash) DO NOTHING`,
    [
      fulfillmentTargetHash,
      buyerWallet,
      regionCodeHash,
      Buffer.from('00', 'hex'),
      Buffer.alloc(12),
      Buffer.alloc(16),
    ],
  );
  await db.query(
    `INSERT INTO core.products (
       product_id, chain_product_id, merchant_id, version, title, lifecycle_state,
       product_policy_hash, merchant_concession_bps, metadata, subtitle,
       rich_detail, default_freight_usdt, fulfillment_modes
     ) VALUES ('product-1', $1, 'merchant-1', 1, 'Product', 'ACTIVE', $2, 2500,
       '{}', 'Authoritative catalog product', '{"blocks":[]}', 5,
       '["DELIVERY","PICKUP"]')`,
    [`0x${'b'.repeat(64)}`, HASH],
  );
  await db.query(
     `INSERT INTO core.skus (
       sku_id, chain_sku_id, product_id, sku_version, attributes, list_price_usdt,
       merchant_cost_usdt, stock_total, stock_available, lifecycle_state
     ) VALUES ('sku-1', $1, 'product-1', 1, '{}', $2, $3, $4, $4, 'ACTIVE')`,
    [`0x${'c'.repeat(64)}`, listPriceUsdt, merchantCostUsdt, stock],
  );
}

async function seedEligibleReplacementMerchant(
  db: PGlite,
  merchantId: string,
  settlementWallet: string,
  hashDigit: string,
  now: Date,
  eligible: boolean,
) {
  const uploadIntentId = `0x${hashDigit.repeat(64)}`;
  const assetId = `0x${((Number.parseInt(hashDigit, 16) + 8) % 16).toString(16).repeat(64)}`;
  await db.query(
    `INSERT INTO core.merchants (
       merchant_id, settlement_wallet, status, level, profile, guarantee_status,
       application_version, reviewed_at, reviewed_by
     ) VALUES ($1,$2,'APPROVED','V2',$3,$4,1,$5,$6)`,
    [
      merchantId,
      settlementWallet.toLowerCase(),
      JSON.stringify({ shopName: merchantId }),
      eligible ? 'READY' : 'BELOW_MINIMUM',
      now,
      '0x4444444444444444444444444444444444444444',
    ],
  );
  await db.query(
    `INSERT INTO core.wallet_role_bindings (
       wallet_address, role, merchant_id, status, evidence_hash
     ) VALUES ($1,'MERCHANT',$2,'ACTIVE',$3)`,
    [settlementWallet.toLowerCase(), merchantId, HASH],
  );
  await db.query(
    `INSERT INTO core.media_upload_intents (
       upload_intent_id, owner_wallet, purpose, resource_type, resource_id,
       object_key, content_type, size_bytes, content_sha256, idempotency_key,
       request_hash, state, expires_at, provider_reference_hash,
       provider_evidence_hash, verified_at, created_at, updated_at
     ) VALUES ($1,$2,'MERCHANT_LICENSE','MERCHANT',$3,$4,'application/pdf',100,$5,$6,
       $5,'VERIFIED',$7,$5,$5,$8,$8,$8)`,
    [
      uploadIntentId,
      settlementWallet.toLowerCase(),
      merchantId,
      `merchant-license/${merchantId}/${hashDigit.repeat(32)}`,
      `0x${hashDigit.repeat(64)}`,
      `replacement-license-${merchantId}`,
      new Date(now.getTime() + 60_000),
      now,
    ],
  );
  await db.query(
    `INSERT INTO core.media_assets (
       asset_id, upload_intent_id, owner_wallet, purpose, resource_type, resource_id,
       object_key, content_type, size_bytes, content_sha256, provider_evidence_hash,
       object_version_hash, created_at
     ) VALUES ($1,$2,$3,'MERCHANT_LICENSE','MERCHANT',$4,$5,'application/pdf',100,$6,$6,$6,$7)`,
    [
      assetId,
      uploadIntentId,
      settlementWallet.toLowerCase(),
      merchantId,
      `merchant-license/${merchantId}/${hashDigit.repeat(32)}`,
      `0x${hashDigit.repeat(64)}`,
      now,
    ],
  );
  await db.query(
    `INSERT INTO core.merchant_application_versions (
       merchant_id, version, encrypted_payload, encryption_iv, encryption_tag,
       payload_hash, license_asset_id, actor_wallet, idempotency_key, request_hash, created_at
     ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$5,$9)`,
    [
      merchantId,
      Buffer.from(hashDigit.repeat(2), 'hex'),
      Buffer.alloc(12, Number.parseInt(hashDigit, 16)),
      Buffer.alloc(16, Number.parseInt(hashDigit, 16)),
      `0x${hashDigit.repeat(64)}`,
      assetId,
      settlementWallet.toLowerCase(),
      `replacement-application-${merchantId}`,
      now,
    ],
  );
}

function encryptTestPayload(payload: Record<string, unknown>, key: Buffer) {
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

async function publishTestPolicy(db: PGlite, policyVersion: number) {
  const hash = (offset: number) => (
    `0x${(BigInt(policyVersion) * 10n + BigInt(offset)).toString(16).padStart(64, '0')}`
  );
  await db.query(
    `INSERT INTO core.policy_snapshots (
       policy_version, artifact_version, policy_hash,
       rules_content_hash, beneficiary_set_hash, payload, publication_status
     ) VALUES ($1,$2,$3,$4,$5,$6,'PUBLISHED')`,
    [policyVersion, CORE_ARTIFACT_VERSION, hash(1), hash(3), hash(4),
      JSON.stringify(paymentPolicyPayload())],
  );
  await db.query(
    `INSERT INTO core.policy_publication_transitions (
       transition_id, policy_version, event_type, submitted_execution_tx_hash, execution_tx_hash,
       block_number, block_hash, confirmations, canonical, evidence_hash, evidence, observed_at
     ) VALUES ($1,$2,'FINAL',$3,$4,$2,$5,15,true,$6,$7,clock_timestamp())`,
    [`test:policy-final:${policyVersion}`, policyVersion, hash(5), hash(6), hash(7), hash(8),
      JSON.stringify({ source: 'catalog-policy-drift-test', policyVersion })],
  );
}

async function insertLiveSeckillSession(db: PGlite, sessionId: string, now: Date, unitPrice: number) {
  await db.query(
    `INSERT INTO core.seckill_sessions (
       session_id, policy_version, merchant_id, product_id, sku_id,
       product_policy_hash, starts_at, main_deadline, relay_deadline,
       inventory, seckill_list_price_usdt, phase, snapshot
     ) VALUES ($1, 1, 'merchant-1', 'product-1', 'sku-1', $2,
       $3, $4, $5, 1, $6, 'LIVE', '{}')`,
    [
      sessionId,
      HASH,
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() + 59 * 60_000),
      new Date(now.getTime() + 60_000),
      unitPrice,
    ],
  );
}

function paymentPolicyPayload() {
  return {
    usdtPaymentBps: 7_000,
    nplPaymentBps: 3_000,
    nplBurnListPriceBps: 2_000,
    nplRewardListPriceBps: 1_000,
    genesisBps: 200,
    directReferralBps: 100,
    districtBps: 120,
    cityBps: 80,
    provinceBps: 60,
    regionBps: 40,
    operationsBps: 400,
    platformFeeBps: 100,
    seckillPrizeBps: 0,
    seckillMainDuration: 3_600,
    relayInitial: 60,
    relayIncrement: 30,
    relayCap: 60,
    requiredConfirmations: 15,
    merchantGuaranteeMinimumUsdt: (1_000n * 10n ** 18n).toString(),
    platformServiceFeeWallet: '0x2222222222222222222222222222222222222223',
    usdtSettlementWallet: '0x3333333333333333333333333333333333333333',
    nplRewardWallet: '0x4444444444444444444444444444444444444444',
    operationsWallet: '0x5555555555555555555555555555555555555555',
    circulationPool: '0x6000000000000000000000000000000000000001',
    concessionDestinationSetHash: paymentAllocationSetHash(),
    decisionEvidenceHash: HASH_2,
    genesisNodeDestinations: [
      { account: '0x5000000000000000000000000000000000000011', weightBps: 10_000 },
    ],
    operationsDestinations: [
      { account: '0x5000000000000000000000000000000000000007', weightBps: 2_500 },
      { account: '0x5000000000000000000000000000000000000008', weightBps: 2_500 },
      { account: '0x5000000000000000000000000000000000000009', weightBps: 2_500 },
      { account: '0x5000000000000000000000000000000000000010', weightBps: 2_500 },
    ],
  };
}

async function signedGovernedApproval(
  secondary: ReturnType<typeof Wallet.createRandom>,
  governanceVerifyingContract: string,
  intent: SensitiveActionIntent,
) {
  return {
    action: intent.action,
    resourceType: intent.resourceType,
    resourceId: intent.resourceId,
    policyVersion: intent.policyVersion.toString(),
    oldValueHash: intent.oldValueHash,
    newValueHash: intent.newValueHash,
    executorWallet: intent.executorWallet,
    nonce: intent.nonce.toString(),
    deadline: intent.deadline.toString(),
    signature: await secondary.signTypedData(
      sensitiveActionDomain(governanceVerifyingContract),
      sensitiveActionTypes,
      intent,
    ),
  };
}

function stableHash(value: unknown) {
  return keccak256(toUtf8Bytes(stableJson(value))).toLowerCase();
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function insertPaymentQuote(
  db: PGlite,
  intent: CanonicalPaymentIntent,
  idempotencyKey = 'test-payment-quote',
) {
  const snapshotHash = paymentIntentHash(intent);
  await db.query(
     `INSERT INTO core.payment_quotes (
       order_id, idempotency_key, artifact_version, buyer_wallet, merchant_id, merchant_wallet,
       product_id, sku_id, chain_product_id, chain_sku_id, product_policy_hash,
       list_price_usdt, merchant_cost_usdt, merchant_concession_bps,
       policy_version, quote_kind, authorization_digest, quote_signature, deadline, state
     ) VALUES ($1, $2, $3, $4, 'merchant-1', $5, 'product-1', 'sku-1', $6, $7, $8,
       $9, $10, $11, $12, 'ORDINARY', $13, $14, $15, 'QUOTED')`,
    [
      intent.orderId,
      idempotencyKey,
      CORE_ARTIFACT_VERSION,
      intent.buyer,
      intent.merchant,
      intent.productId,
      intent.skuId,
      intent.productPolicyHash,
      intent.listPriceUsdt,
      intent.merchantBaseReceivableUsdt,
      intent.merchantConcessionBps,
      intent.policyVersion,
      snapshotHash,
      `0x${'1'.repeat(130)}`,
      new Date(intent.deadline * 1000),
    ],
  );
  await db.query(
    `INSERT INTO core.payment_quote_legs (
       order_id, classification, reservation_id, snapshot_hash, intent,
       product_usdt_payment_amount, platform_service_fee_usdt,
       custody_product_usdt, freight_usdt, usdt_payment_amount
     ) VALUES ($1, 'ORDINARY', $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      intent.orderId,
      intent.reservationId,
      snapshotHash,
      JSON.stringify(intent),
      intent.productUsdtPaymentAmount,
      intent.platformServiceFeeUsdt,
      intent.custodyProductUsdt,
      intent.freightUsdt,
      intent.usdtPaymentAmount,
    ],
  );
}

async function insertOrder(
  db: PGlite,
  orderId: string,
  reservationId: string,
  fulfillmentTargetHash = HASH,
  regionCodeHash = HASH,
) {
  await db.query(
    `INSERT INTO core.orders (
       order_id, artifact_version, policy_version, buyer_wallet,
       merchant_id, merchant_wallet, product_id, sku_id, quantity, fulfillment_mode,
       fulfillment_target_hash, region_code_hash, product_policy_hash, reservation_id,
       quote_snapshot, allocation_snapshot, exact_amounts, buyer_nonce, quote_deadline,
       state, finality_status
     ) VALUES (
       $1, '${CORE_ARTIFACT_VERSION}', 1, $3, 'merchant-1', $4,
       'product-1', 'sku-1', 1, 'DELIVERY', $6, $7, $2, $5,
       '{}', '{}', '{"usdt":"50","npl":"500"}', 1,
       clock_timestamp() + interval '1 hour', 'QUOTED', 'NOT_SUBMITTED'
     )`,
    [orderId, HASH, BUYER, MERCHANT, reservationId, fulfillmentTargetHash, regionCodeHash],
  );
}
