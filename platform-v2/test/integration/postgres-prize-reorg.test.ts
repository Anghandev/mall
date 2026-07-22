import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Wallet, keccak256 } from 'ethers';
import { Client } from 'pg';
import { CORE_ARTIFACT_VERSION, USDT_ADDRESS } from '../../server/api/enums.ts';
import {
  settlementIntentDigest,
  settlementItemHash,
  settlementItemsHash,
  settlementRequestDomain,
  settlementRequestId,
  settlementRequestTypes,
  type SettlementRequestIntent,
} from '../../server/api/settlement-signing.ts';
import { applyMigrations } from '../../server/data/migrations.ts';
import { reversePaymentProjection } from '../../server/data/payment-store.ts';
import { SeckillOperationsService } from '../../server/data/seckill-operations-service.ts';
import {
  lockSeckillPrizeFundingMutation,
  reconcileSeckillPrizeFundingReorgOnce,
  reverseFinalizedSeckillPrizeInjection,
  settleMaturedSeckillPrizes,
} from '../../server/data/seckill-prize-service.ts';
import {
  SettlementWorker,
  type EoaSettlementReceipt,
} from '../../server/chain/settlement-worker.ts';
import { requiredPostgresAdminUrl } from './postgres-env.ts';

const MIGRATIONS = fileURLToPath(new URL('../../server/data/migrations/business/', import.meta.url));
const HASH_1 = `0x${'1'.repeat(64)}`;
const HASH_2 = `0x${'2'.repeat(64)}`;
const HASH_3 = `0x${'3'.repeat(64)}`;
const SESSION_ID = `0x${'4'.repeat(64)}`;
const ACTION_ID = `0x${'5'.repeat(64)}`;
const INJECTION_ID = `0x${'6'.repeat(64)}`;
const SECOND_ACTION_ID = `0x${'5'.repeat(63)}6`;
const SECOND_INJECTION_ID = `0x${'6'.repeat(63)}7`;
const ORDER_ID = `0x${'7'.repeat(64)}`;
const TRANSFER_ID = `0x${'9'.repeat(64)}`;
const PAYMENT_ORDER_ID = `0x${'a'.repeat(64)}`;
const PAYMENT_TX_HASH = `0x${'b'.repeat(64)}`;
const PAYMENT_BLOCK_HASH = `0x${'c'.repeat(64)}`;
const PAYOUT_TX_HASH = `0x${'d'.repeat(64)}`;
const PAYOUT_REPLACEMENT_TX_HASH = `0x${'d'.repeat(63)}e`;
const RETAINED_FUNDING_HASH = `0x${'e'.repeat(64)}`;
const PAYMENT_REPLACEMENT_HASH = `0x${'f'.repeat(64)}`;
const ATTEMPT_ID = 'settlement-attempt:postgres-prize:1';
const REPLACEMENT_ATTEMPT_ID = 'settlement-attempt:postgres-prize:2';
const PAYMENT_EVENT_KEY = 'payment:postgres-lock-order';
const SETTLEMENT_WALLET = '0x3333333333333333333333333333333333333333';
const INJECTION_AMOUNT = '50';
const RETAINED_AMOUNT = '30';
const TOTAL_PRIZE_AMOUNT = '80';
const BUYER_SIGNER = Wallet.createRandom();
const BUYER = BUYER_SIGNER.address.toLowerCase();
const SETTLEMENT_INTENT_ID = `0x${'8'.repeat(64)}`;
const SETTLEMENT_ITEM = Object.freeze({
  itemIndex: 0,
  orderId: ORDER_ID,
  accountId: `buyer:${BUYER}:prize:usdt`,
  backingWalletAddress: SETTLEMENT_WALLET,
  amount: TOTAL_PRIZE_AMOUNT,
  itemHash: settlementItemHash(SETTLEMENT_INTENT_ID, {
    itemIndex: 0,
    orderId: ORDER_ID,
    accountId: `buyer:${BUYER}:prize:usdt`,
    backingWalletAddress: SETTLEMENT_WALLET,
    amount: TOTAL_PRIZE_AMOUNT,
  }),
});
const SETTLEMENT_INTENT: SettlementRequestIntent = Object.freeze({
  intentId: SETTLEMENT_INTENT_ID,
  artifactVersion: CORE_ARTIFACT_VERSION,
  wallet: BUYER,
  recipient: BUYER,
  rail: 'PRIZE_USDT',
  asset: USDT_ADDRESS,
  executorWallet: SETTLEMENT_WALLET,
  amount: TOTAL_PRIZE_AMOUNT,
  itemsHash: settlementItemsHash([SETTLEMENT_ITEM]),
  nonce: '1',
  deadline: 1_893_456_000,
});
const REQUEST_ID = settlementRequestId(SETTLEMENT_INTENT);

test('real PostgreSQL serializes leased payout reorg, terminal recovery and payment reversal lock order', {
  timeout: 600_000,
}, async () => {
  const adminConnectionString = requiredPostgresAdminUrl('prize reorg');
  const databaseName = `abu24k_prize_reorg_${randomBytes(6).toString('hex')}`;
  const databaseConnectionString = connectionForDatabase(adminConnectionString, databaseName);
  const admin = new Client({ connectionString: connectionForDatabase(adminConnectionString, 'postgres') });
  const clients: Client[] = [];
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const client = await connected(databaseConnectionString, clients);
    await applyMigrations(client, 'core', MIGRATIONS);
    await seedAwardedInjection(client);

    const at = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const payout = await connected(databaseConnectionString, clients);
    await payout.query('BEGIN');
    await lockSeckillPrizeFundingMutation(payout);
    await payout.query(
      'SELECT attempt_id FROM core.settlement_transfer_attempts WHERE attempt_id = $1 FOR UPDATE',
      [ATTEMPT_ID],
    );
    const reorg = await connected(databaseConnectionString, clients);
    let reorgCompleted = false;
    const reorgMutation = (async () => {
      await reorg.query('BEGIN');
      const startedAt = Date.now();
      try {
        await lockSeckillPrizeFundingMutation(reorg);
        await reverseFinalizedSeckillPrizeInjection(reorg, {
          actionId: ACTION_ID,
          sessionId: SESSION_ID,
          policyVersion: 1,
          evidenceHash: HASH_3,
          sourceTxHash: HASH_1,
          sourceBlockHash: HASH_2,
          canonicalBlockHash: HASH_3,
          at,
        });
        await reorg.query('COMMIT');
        reorgCompleted = true;
        return Date.now() - startedAt;
      } catch (error) {
        await reorg.query('ROLLBACK');
        throw error;
      }
    })();
    // Preserve the primary SQL failure if cleanup closes the waiting connection.
    void reorgMutation.catch(() => undefined);
    await delay(100);
    assert.equal(reorgCompleted, false);
    await payout.query('COMMIT');
    assert.ok(await reorgMutation >= 80);

    assert.deepEqual((await client.query<{
      prize_pool_usdt: string;
      settlement_state: string;
      reversal_journal_id: string;
      transfer_state: string;
      attempt_state: string;
      resolution_mode: string;
    }>(
      `SELECT session.prize_pool_usdt::text, settlement.state AS settlement_state,
         injection.reversal_journal_id, transfer.state AS transfer_state,
         attempt.state AS attempt_state, exposure.resolution_mode
       FROM core.seckill_sessions session
       JOIN core.seckill_prize_settlements settlement ON settlement.session_id = session.session_id
       JOIN core.seckill_prize_injections injection
         ON injection.session_id = session.session_id AND injection.action_id = $3
       JOIN core.settlement_transfers transfer ON transfer.transfer_id = $2
       JOIN core.settlement_transfer_attempts attempt ON attempt.transfer_id = transfer.transfer_id
       JOIN core.seckill_prize_reorg_exposures exposure ON exposure.funding_id = $3
       WHERE session.session_id = $1`,
      [SESSION_ID, TRANSFER_ID, ACTION_ID],
    )).rows[0], {
      prize_pool_usdt: RETAINED_AMOUNT,
      settlement_state: 'QUARANTINED',
      reversal_journal_id: `journal:seckill-prize-reversal:${ACTION_ID}`,
      transfer_state: 'LEASED',
      attempt_state: 'LEASED',
      resolution_mode: 'DEFICIT_MONITORING',
    });
    assert.deepEqual((await client.query<{
      account_id: string;
      balance_state: string;
      amount: string;
    }>(
      `SELECT line.account_id, line.balance_state,
         sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
       FROM core.ledger_lines line
       JOIN core.ledger_accounts account ON account.account_id = line.account_id
       WHERE account.purpose = 'SECKILL_PRIZE_LIABILITY'
       GROUP BY line.account_id, line.balance_state, line.backing_wallet_address
       HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) <> 0
       ORDER BY line.account_id, line.balance_state`,
    )).rows, [{
      account_id: `buyer:${BUYER}:prize:usdt`,
      balance_state: 'REQUESTED',
      amount: TOTAL_PRIZE_AMOUNT,
    }]);
    assert.equal((await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.ledger_journals
       WHERE event_type IN ('SECKILL_PRIZE_AWARD_REVERSED','SECKILL_PRIZE_INJECTION_REVERSED')`,
    )).rows[0]?.count, '1');
    assert.equal((await client.query<{ paused: boolean }>(
      "SELECT paused FROM core.circuit_breakers WHERE scope = 'NEW_SETTLEMENT_BATCH'",
    )).rows[0]?.paused, true);
    assert.deepEqual((await client.query<{ transition_type: string }>(
      `SELECT transition_type FROM core.seckill_prize_reorg_transitions
       ORDER BY transition_type`,
    )).rows, [
      { transition_type: 'FUNDING_REVERSED' },
      { transition_type: 'QUARANTINED' },
    ]);

    await client.query('BEGIN');
    try {
      await client.query(
        `UPDATE core.settlement_transfer_attempts
         SET execution_tx_hash = $2, state = 'SUBMITTED', submitted_at = $3, updated_at = $3
         WHERE attempt_id = $1 AND state = 'LEASED'`,
        [ATTEMPT_ID, PAYOUT_TX_HASH, new Date(at.getTime() + 1_000)],
      );
      await client.query(
        `UPDATE core.settlement_transfer_attempts SET state = 'REPLACED', updated_at = $2
         WHERE attempt_id = $1 AND state = 'SUBMITTED'`,
        [ATTEMPT_ID, new Date(at.getTime() + 2_000)],
      );
      await client.query(
        `UPDATE core.settlement_transfers
         SET state = 'SUBMITTED', nonce_state = 'BROADCAST', submitted_at = $2
         WHERE transfer_id = $1 AND state = 'LEASED'`,
        [TRANSFER_ID, new Date(at.getTime() + 1_000)],
      );
      await client.query(
        `INSERT INTO core.settlement_transfer_attempts (
           attempt_id, transfer_id, attempt_number, lease_token, request_digest,
           transaction_to, transaction_calldata, execution_tx_hash,
           executor_wallet, executor_nonce, gas_limit, replacement_for_attempt_id,
           state, leased_until, created_at, submitted_at, updated_at
         ) SELECT $1, transfer_id, 2, 'postgres-prize-replacement-lease', request_digest,
           transaction_to, transaction_calldata, $2, executor_wallet, executor_nonce,
           gas_limit, attempt_id, 'FAILED', $3, $4, $4, $4
         FROM core.settlement_transfer_attempts WHERE attempt_id = $5`,
        [
          REPLACEMENT_ATTEMPT_ID,
          PAYOUT_REPLACEMENT_TX_HASH,
          new Date(at.getTime() + 120_000),
          new Date(at.getTime() + 2_000),
          ATTEMPT_ID,
        ],
      );
      await client.query(
        "UPDATE core.settlement_transfers SET state = 'QUARANTINED' WHERE transfer_id = $1",
        [TRANSFER_ID],
      );
      await client.query(
        `INSERT INTO core.transaction_finality (
           transaction_id, resource_type, resource_id, chain_id, contract_address,
           expected_event_hash, tx_hash, block_number, block_hash, confirmations,
           required_confirmations, receipt_status, state, evidence, submitted_at, updated_at
         ) VALUES ($1,'SETTLEMENT_TRANSFER',$2,56,$3,$4,$5,200,$6,14,15,0,'FAILED','{}',$7,$7)`,
        [
          `settlement-finality:${REPLACEMENT_ATTEMPT_ID}`,
          TRANSFER_ID,
          USDT_ADDRESS,
          HASH_1,
          PAYOUT_REPLACEMENT_TX_HASH,
          HASH_2,
          new Date(at.getTime() + 1_000),
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    const firstReconcileAt = new Date(Date.now() + 60_000);
    assert.equal(await inTransaction(client, (executor) => (
      reconcileSeckillPrizeFundingReorgOnce(executor, firstReconcileAt)
    )), 1);
    assert.deepEqual((await client.query<{
      job_state: string;
      last_error_code: string;
      award_reversals: string;
    }>(
      `SELECT job.state AS job_state, job.last_error_code,
         (SELECT count(*)::text FROM core.ledger_journals
          WHERE event_type = 'SECKILL_PRIZE_AWARD_REVERSED') AS award_reversals
       FROM core.durable_jobs job
       WHERE job.job_type = 'RECONCILE' AND job.resource_id = $1`,
      [SESSION_ID],
    )).rows[0], {
      job_state: 'RETRY',
      last_error_code: 'PAYOUT_TERMINAL_EVIDENCE_INCOMPLETE',
      award_reversals: '0',
    });
    await client.query(
      `UPDATE core.transaction_finality SET confirmations = 15, updated_at = $2
       WHERE transaction_id = $1`,
      [`settlement-finality:${REPLACEMENT_ATTEMPT_ID}`, new Date(firstReconcileAt.getTime() + 5_000)],
    );
    assert.equal(await inTransaction(client, (executor) => (
      reconcileSeckillPrizeFundingReorgOnce(executor, new Date(firstReconcileAt.getTime() + 6_000))
    )), 1);
    assert.deepEqual((await client.query<{
      prize_pool_usdt: string;
      job_state: string;
      remainder_amount: string;
      remainder_state: string;
    }>(
      `SELECT session.prize_pool_usdt::text, job.state AS job_state,
         remainder.amount_usdt::text AS remainder_amount, remainder.state AS remainder_state
       FROM core.seckill_sessions session
       JOIN core.durable_jobs job ON job.resource_id = session.session_id AND job.job_type = 'RECONCILE'
       JOIN core.seckill_prize_reorg_remainders remainder
         ON remainder.exposure_id = job.payload ->> 'exposureId'
       WHERE session.session_id = $1`,
      [SESSION_ID],
    )).rows[0], {
      prize_pool_usdt: RETAINED_AMOUNT,
      job_state: 'SUCCEEDED',
      remainder_amount: RETAINED_AMOUNT,
      remainder_state: 'PENDING',
    });
    assert.deepEqual((await client.query<{
      account_id: string;
      balance_state: string;
      amount: string;
    }>(
      `SELECT line.account_id, line.balance_state,
         sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
       FROM core.ledger_lines line
       JOIN core.ledger_accounts account ON account.account_id = line.account_id
       WHERE account.purpose IN ('SECKILL_PRIZE_LIABILITY','SECKILL_PRIZE_REORG_DEFICIT')
       GROUP BY line.account_id, line.balance_state, line.backing_wallet_address
       HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) <> 0
       ORDER BY line.account_id, line.balance_state`,
    )).rows, [{
      account_id: `seckill-prize:${SESSION_ID}:usdt`,
      balance_state: 'LOCKED',
      amount: RETAINED_AMOUNT,
    }]);
    assert.deepEqual((await client.query<{ transition_type: string }>(
      `SELECT transition_type FROM core.seckill_prize_reorg_transitions
       ORDER BY transition_type`,
    )).rows, [
      { transition_type: 'FUNDING_REVERSED' },
      { transition_type: 'PAYOUT_FAILED' },
      { transition_type: 'QUARANTINED' },
      { transition_type: 'REMAINDER_RECOVERABLE' },
      { transition_type: 'RESOLVED' },
    ]);

    await inTransaction(client, (executor) => reverseFinalizedSeckillPrizeInjection(executor, {
      actionId: ACTION_ID,
      sessionId: SESSION_ID,
      policyVersion: 1,
      evidenceHash: HASH_3,
      sourceTxHash: HASH_1,
      sourceBlockHash: HASH_2,
      canonicalBlockHash: HASH_3,
      at,
    }));
    assert.equal((await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.ledger_journals
       WHERE event_type IN ('SECKILL_PRIZE_AWARD_REVERSED','SECKILL_PRIZE_INJECTION_REVERSED')`,
    )).rows[0]?.count, '2');

    await inTransaction(client, (executor) => reverseFinalizedSeckillPrizeInjection(executor, {
      actionId: SECOND_ACTION_ID,
      sessionId: SESSION_ID,
      policyVersion: 1,
      evidenceHash: PAYMENT_REPLACEMENT_HASH,
      sourceTxHash: RETAINED_FUNDING_HASH,
      sourceBlockHash: PAYMENT_REPLACEMENT_HASH,
      canonicalBlockHash: HASH_1,
      at: new Date(at.getTime() + 10_000),
    }));
    assert.deepEqual((await client.query<{
      prize_pool_usdt: string;
      pending_remainders: string;
      superseded_remainders: string;
    }>(
      `SELECT session.prize_pool_usdt::text,
         (SELECT count(*)::text FROM core.seckill_prize_reorg_remainders
          WHERE session_id = session.session_id AND state = 'PENDING') AS pending_remainders,
         (SELECT count(*)::text FROM core.seckill_prize_reorg_remainders
          WHERE session_id = session.session_id AND state = 'SUPERSEDED') AS superseded_remainders
       FROM core.seckill_sessions session WHERE session.session_id = $1`,
      [SESSION_ID],
    )).rows[0], {
      prize_pool_usdt: '0',
      pending_remainders: '0',
      superseded_remainders: '1',
    });
    assert.deepEqual((await client.query<{ account_id: string; amount: string }>(
      `SELECT line.account_id,
         sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
       FROM core.ledger_lines line
       JOIN core.ledger_accounts account ON account.account_id = line.account_id
       WHERE account.purpose IN ('SECKILL_PRIZE_LIABILITY','SECKILL_PRIZE_REORG_DEFICIT')
       GROUP BY line.account_id, line.balance_state, line.backing_wallet_address
       HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) <> 0`,
    )).rows, []);

    await seedPaymentProjection(client);
    const lockHolder = await connected(databaseConnectionString, clients);
    await lockHolder.query('BEGIN');
    await lockSeckillPrizeFundingMutation(lockHolder);
    const paymentReverser = await connected(databaseConnectionString, clients);
    let paymentReversalCompleted = false;
    const paymentReversal = (async () => {
      await paymentReverser.query('BEGIN');
      const startedAt = Date.now();
      try {
        const result = await reversePaymentProjection(
          paymentReverser,
          PAYMENT_EVENT_KEY,
          PAYMENT_REPLACEMENT_HASH,
        );
        await paymentReverser.query('COMMIT');
        paymentReversalCompleted = true;
        return { result, waitedMs: Date.now() - startedAt };
      } catch (error) {
        await paymentReverser.query('ROLLBACK');
        throw error;
      }
    })();
    void paymentReversal.catch(() => undefined);
    await delay(100);
    assert.equal(paymentReversalCompleted, false);
    await lockHolder.query("SET LOCAL lock_timeout = '1s'");
    await lockHolder.query(
      'SELECT event_key FROM core.payment_events WHERE event_key = $1 FOR UPDATE',
      [PAYMENT_EVENT_KEY],
    );
    await lockHolder.query('COMMIT');
    const paymentReversed = await paymentReversal;
    assert.ok(paymentReversed.waitedMs >= 80);
    assert.deepEqual(paymentReversed.result, { status: 'REVERSED', orderId: PAYMENT_ORDER_ID });
    assert.deepEqual((await client.query<{ canonical: boolean; state: string; finality_status: string }>(
      `SELECT payment.canonical, orders.state, orders.finality_status
       FROM core.payment_events payment
       JOIN core.orders orders ON orders.order_id = payment.order_id
       WHERE payment.event_key = $1`,
      [PAYMENT_EVENT_KEY],
    )).rows[0], { canonical: false, state: 'REORG_PENDING', finality_status: 'REORGED' });
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});

test('real PostgreSQL re-pauses after recovered payout reorg and completes a second recovery episode', {
  timeout: 600_000,
}, async () => {
  const adminConnectionString = requiredPostgresAdminUrl();
  const databaseName = `abu24k_prize_recovery_${randomBytes(6).toString('hex')}`;
  const databaseConnectionString = connectionForDatabase(adminConnectionString, databaseName);
  const adminClient = new Client({ connectionString: connectionForDatabase(adminConnectionString, 'postgres') });
  const clients: Client[] = [];
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE DATABASE ${databaseName}`);
    const client = await connected(databaseConnectionString, clients);
    await applyMigrations(client, 'core', MIGRATIONS);
    await seedAwardedInjection(client, 'PENDING');
    const transactions = { transaction: <Result>(operation: (executor: Client) => Promise<Result>) => (
      inTransaction(client, operation)
    ) };
    let workerNow = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    let payoutCanonical = true;
    let payoutReceipt: EoaSettlementReceipt = successfulPayoutReceipt();
    const worker = new SettlementWorker({
      transactions,
      broadcaster: {
        submit: async (input) => ({
          executionTxHash: PAYOUT_TX_HASH,
          executorWallet: input.executorWallet,
          executorNonce: input.executorNonce,
          requestDigest: input.requestDigest,
        }),
        replace: async () => { throw new Error('replacement is not expected'); },
      },
      chain: {
        receipt: async () => payoutReceipt,
        canonicalBlock: async (input) => ({
          canonical: payoutCanonical,
          observedBlockHash: payoutCanonical ? input.blockHash : HASH_3,
          evidenceHash: payoutCanonical ? HASH_1 : HASH_3,
        }),
      },
      clock: () => workerNow,
    });
    assert.equal(await worker.submitOnce(), 1);
    workerNow = new Date(workerNow.getTime() + 1_000);
    assert.equal(await worker.pollFinalityOnce(), 1);
    assert.deepEqual((await client.query<{ request_state: string; transfer_state: string; attempt_state: string }>(
      `SELECT request.state AS request_state, transfer.state AS transfer_state,
         attempt.state AS attempt_state
       FROM core.settlement_requests request
       JOIN core.settlement_transfers transfer ON transfer.request_id = request.request_id
       JOIN core.settlement_transfer_attempts attempt ON attempt.transfer_id = transfer.transfer_id
       WHERE request.request_id = $1`,
      [REQUEST_ID],
    )).rows[0], { request_state: 'SETTLED', transfer_state: 'SETTLED', attempt_state: 'SETTLED' });

    workerNow = new Date(workerNow.getTime() + 1_000);
    await inTransaction(client, (executor) => reverseFinalizedSeckillPrizeInjection(executor, {
      actionId: ACTION_ID,
      sessionId: SESSION_ID,
      policyVersion: 1,
      evidenceHash: HASH_3,
      sourceTxHash: HASH_1,
      sourceBlockHash: HASH_2,
      canonicalBlockHash: HASH_3,
      at: workerNow,
    }));
    const firstJobAvailableAt = (await client.query<{ available_at: Date }>(
      "SELECT available_at FROM core.durable_jobs WHERE payload ->> 'fundingId' = $1",
      [ACTION_ID],
    )).rows[0]!.available_at;
    if (workerNow <= firstJobAvailableAt) {
      workerNow = new Date(firstJobAvailableAt.getTime() + 1);
    }
    assert.equal(await worker.reconcilePrizeFundingOnce(), 1);
    const exposureId = (await client.query<{ exposure_id: string }>(
      'SELECT exposure_id FROM core.seckill_prize_reorg_exposures WHERE funding_id = $1',
      [ACTION_ID],
    )).rows[0]!.exposure_id;
    const admin = Wallet.createRandom();
    const secondary = Wallet.createRandom();
    await client.query(
      `INSERT INTO core.wallet_role_bindings (
         wallet_address, role, merchant_id, status, evidence_hash
       ) VALUES ($1,'ADMIN',NULL,'ACTIVE',$2)`,
      [admin.address.toLowerCase(), HASH_1],
    );
    const operations = new SeckillOperationsService({
      transactions,
      governanceWalletAddress: SETTLEMENT_WALLET,
      operationsWalletAddress: '0x5555555555555555555555555555555555555555',
      settlementWalletAddress: SETTLEMENT_WALLET,
      paymentRouterAddress: '0x6666666666666666666666666666666666666666',
      secondarySignerAddress: secondary.address,
      clock: () => workerNow,
    });
    workerNow = new Date(workerNow.getTime() + 1_000);
    await seedCoverage(client, 'coverage:postgres-prize-recovery:1', workerNow, HASH_1, HASH_2);
    const firstDeadline = String(Math.floor(workerNow.getTime() / 1_000) + 300);
    const firstChallenge = await operations.prizeRecoveryChallenge(
      { walletAddress: admin.address, roles: ['ADMIN'] },
      exposureId,
      { nonce: '200', deadline: firstDeadline },
    );
    assert.equal(firstChallenge.recoveryEpisode, 1);
    const firstRecovery = await operations.submitPrizeRecovery(
      { walletAddress: admin.address, roles: ['ADMIN'] },
      exposureId,
      {
        snapshotId: firstChallenge.snapshotId,
        nonce: '200',
        deadline: firstDeadline,
        signature: await secondary.signTypedData(
          firstChallenge.typedData.domain,
          firstChallenge.typedData.types,
          firstChallenge.typedData.message,
        ),
        correlationId: 'postgres-prize-recovery-1',
      },
    );
    assert.equal(firstRecovery.recoveryEpisode, 1);
    assert.equal((await client.query<{ paused: boolean }>(
      "SELECT paused FROM core.circuit_breakers WHERE scope = 'NEW_SETTLEMENT_BATCH'",
    )).rows[0]?.paused, false);

    payoutCanonical = false;
    workerNow = new Date(workerNow.getTime() + 1_000);
    assert.equal(await worker.reconcileSettledCanonicalityOnce(), 1);
    assert.deepEqual((await client.query<{ active: boolean; paused: boolean; job_state: string }>(
      `SELECT cause.active, breaker.paused, job.state AS job_state
       FROM core.breaker_causes cause
       JOIN core.circuit_breakers breaker ON breaker.scope = cause.scope
       JOIN core.durable_jobs job ON job.payload ->> 'exposureId' = $1
       WHERE cause.cause_id = $2`,
      [exposureId, `seckill-prize-funding-reorg:${ACTION_ID}`],
    )).rows[0], { active: true, paused: true, job_state: 'RETRY' });

    payoutCanonical = true;
    payoutReceipt = failedPayoutReceipt(14, HASH_2);
    workerNow = new Date(workerNow.getTime() + 1_000);
    assert.equal(await worker.pollFinalityOnce(), 1);
    assert.equal(await worker.reconcilePrizeFundingOnce(), 1);
    assert.equal((await client.query<{ state: string }>(
      "SELECT state FROM core.durable_jobs WHERE payload ->> 'exposureId' = $1",
      [exposureId],
    )).rows[0]?.state, 'RETRY');
    payoutReceipt = failedPayoutReceipt(15, HASH_3);
    workerNow = new Date(workerNow.getTime() + 6_000);
    assert.equal(await worker.pollFinalityOnce(), 1);
    assert.equal(await worker.reconcilePrizeFundingOnce(), 1);
    const failedPayoutAttemptId = (await client.query<{ attempt_id: string }>(
      `SELECT attempt_id FROM core.settlement_transfer_attempts
       WHERE transfer_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
      [TRANSFER_ID],
    )).rows[0]!.attempt_id;
    const failedCanonicalityBefore = (await client.query<{ updated_at: Date }>(
      'SELECT updated_at FROM core.transaction_finality WHERE transaction_id = $1',
      [`settlement-finality:${failedPayoutAttemptId}`],
    )).rows[0]!.updated_at;
    workerNow = new Date(workerNow.getTime() + 1_000);
    assert.equal(await worker.reconcileSettledCanonicalityOnce(), 1);
    const failedCanonicalityAfter = (await client.query<{ updated_at: Date }>(
      'SELECT updated_at FROM core.transaction_finality WHERE transaction_id = $1',
      [`settlement-finality:${failedPayoutAttemptId}`],
    )).rows[0]!.updated_at;
    assert.ok(failedCanonicalityAfter > failedCanonicalityBefore);

    workerNow = new Date(workerNow.getTime() + 1_000);
    await seedCoverage(client, 'coverage:postgres-prize-recovery:2', workerNow, HASH_2, HASH_3);
    const secondDeadline = String(Math.floor(workerNow.getTime() / 1_000) + 300);
    const secondChallenge = await operations.prizeRecoveryChallenge(
      { walletAddress: admin.address, roles: ['ADMIN'] },
      exposureId,
      { nonce: '201', deadline: secondDeadline },
    );
    assert.equal(secondChallenge.recoveryEpisode, 2);
    const secondRecovery = await operations.submitPrizeRecovery(
      { walletAddress: admin.address, roles: ['ADMIN'] },
      exposureId,
      {
        snapshotId: secondChallenge.snapshotId,
        nonce: '201',
        deadline: secondDeadline,
        signature: await secondary.signTypedData(
          secondChallenge.typedData.domain,
          secondChallenge.typedData.types,
          secondChallenge.typedData.message,
        ),
        correlationId: 'postgres-prize-recovery-2',
      },
    );
    assert.equal(secondRecovery.recoveryEpisode, 2);
    assert.deepEqual((await client.query<{ episodes: number[]; cause_active: boolean; paused: boolean }>(
      `SELECT ARRAY(
           SELECT recovery_episode::int FROM core.seckill_prize_reorg_recoveries
           WHERE exposure_id = $1 ORDER BY recovery_episode
         ) AS episodes, cause.active AS cause_active, breaker.paused
       FROM core.breaker_causes cause
       JOIN core.circuit_breakers breaker ON breaker.scope = cause.scope
       WHERE cause.cause_id = $2`,
      [exposureId, `seckill-prize-funding-reorg:${ACTION_ID}`],
    )).rows[0], { episodes: [1, 2], cause_active: false, paused: false });
    const detail = await operations.getPrizeReorgExposure(
      { walletAddress: admin.address, roles: ['ADMIN'] },
      exposureId,
    );
    assert.equal(detail.state, 'RECOVERED');
    assert.equal(detail.recoveryEpisode, 2);
    assert.equal(detail.recoveries.length, 2);

    payoutCanonical = false;
    workerNow = new Date(workerNow.getTime() + 1_000);
    assert.equal(await worker.reconcileSettledCanonicalityOnce(), 1);
    const payoutAttemptId = (await client.query<{ attempt_id: string }>(
      'SELECT attempt_id FROM core.settlement_transfer_attempts WHERE transfer_id = $1',
      [TRANSFER_ID],
    )).rows[0]!.attempt_id;
    assert.deepEqual((await client.query<{
      finality_state: string;
      remainder_state: string;
      prize_pool_usdt: string;
      paused: boolean;
    }>(
      `SELECT finality.state AS finality_state, remainder.state AS remainder_state,
         session.prize_pool_usdt::text, breaker.paused
       FROM core.transaction_finality finality
       JOIN core.seckill_prize_reorg_remainders remainder
         ON remainder.exposure_id = $1 AND remainder.recovery_episode = 2
       JOIN core.seckill_sessions session ON session.session_id = remainder.session_id
       JOIN core.circuit_breakers breaker ON breaker.scope = 'NEW_SETTLEMENT_BATCH'
       WHERE finality.transaction_id = $2`,
      [exposureId, `settlement-finality:${payoutAttemptId}`],
    )).rows[0], {
      finality_state: 'REORGED',
      remainder_state: 'SUPERSEDED',
      prize_pool_usdt: '0',
      paused: true,
    });
    const payoutRecoveryExposureId = (await client.query<{ exposure_id: string }>(
      `SELECT exposure_id FROM core.seckill_prize_reorg_exposures
       WHERE funding_kind = 'PAYOUT_RECOVERY'`,
    )).rows[0]!.exposure_id;
    const pendingPayoutRecovery = await operations.getPrizeReorgExposure(
      { walletAddress: admin.address, roles: ['ADMIN'] },
      payoutRecoveryExposureId,
    );
    assert.equal(pendingPayoutRecovery.state, 'RECONCILING');
    assert.equal(
      pendingPayoutRecovery.transitions.filter((transition) => transition.type === 'RESOLVED').length,
      0,
    );
    payoutCanonical = true;
    payoutReceipt = {
      ...successfulPayoutReceipt(),
      blockNumber: 1_202,
      blockHash: PAYMENT_REPLACEMENT_HASH,
      confirmations: 14,
      evidenceHash: HASH_2,
    };
    workerNow = new Date(workerNow.getTime() + 1_000);
    assert.equal(await worker.pollFinalityOnce(), 1);
    assert.equal(await worker.reconcilePrizeFundingOnce(), 1);
    payoutReceipt = { ...payoutReceipt, confirmations: 15, evidenceHash: HASH_3 };
    workerNow = new Date(workerNow.getTime() + 6_000);
    assert.equal(await worker.pollFinalityOnce(), 1);
    assert.equal(await worker.reconcilePrizeFundingOnce(), 1);
    assert.deepEqual((await client.query<{
      finality_state: string;
      settled_amount: string;
      pool_amount: string;
      deficit_amount: string;
    }>(
      `SELECT finality.state AS finality_state,
         COALESCE((SELECT sum(CASE WHEN side = 'CREDIT' THEN amount ELSE -amount END)::text
           FROM core.ledger_lines WHERE account_id = $2 AND balance_state = 'SETTLED'),'0') AS settled_amount,
         COALESCE((SELECT sum(CASE WHEN side = 'CREDIT' THEN amount ELSE -amount END)::text
           FROM core.ledger_lines WHERE account_id = $3 AND balance_state = 'LOCKED'),'0') AS pool_amount,
         COALESCE((SELECT sum(CASE WHEN side = 'CREDIT' THEN amount ELSE -amount END)::text
           FROM core.ledger_lines
           WHERE account_id = 'system:seckill-prize-reorg-deficit:usdt'
             AND balance_state = 'POSTED'),'0') AS deficit_amount
       FROM core.transaction_finality finality WHERE finality.transaction_id = $1`,
      [
        `settlement-finality:${payoutAttemptId}`,
        `buyer:${BUYER}:prize:usdt`,
        `seckill-prize:${SESSION_ID}:usdt`,
      ],
    )).rows[0], {
      finality_state: 'FINAL',
      settled_amount: TOTAL_PRIZE_AMOUNT,
      pool_amount: '0',
      deficit_amount: `-${INJECTION_AMOUNT}`,
    });
    const terminalPayoutRecovery = await operations.getPrizeReorgExposure(
      { walletAddress: admin.address, roles: ['ADMIN'] },
      payoutRecoveryExposureId,
    );
    assert.equal(terminalPayoutRecovery.state, 'RECOVERY_REQUIRED');
    assert.equal(
      terminalPayoutRecovery.transitions.filter((transition) => transition.type === 'RESOLVED').length,
      1,
    );
    payoutCanonical = false;
    workerNow = new Date(workerNow.getTime() + 1_000);
    assert.equal(await worker.reconcileSettledCanonicalityOnce(), 1);
    payoutCanonical = true;
    payoutReceipt = {
      ...payoutReceipt,
      receiptStatus: 0,
      blockNumber: 1_203,
      blockHash: `0x${'2'.repeat(63)}3`,
      confirmations: 14,
      transfers: [],
      transactionDeltas: [],
      evidenceHash: `0x${'3'.repeat(63)}4`,
    };
    workerNow = new Date(workerNow.getTime() + 1_000);
    assert.equal(await worker.pollFinalityOnce(), 1);
    assert.equal(await worker.reconcilePrizeFundingOnce(), 1);
    payoutReceipt = {
      ...payoutReceipt,
      confirmations: 15,
      evidenceHash: `0x${'4'.repeat(63)}5`,
    };
    workerNow = new Date(workerNow.getTime() + 6_000);
    assert.equal(await worker.pollFinalityOnce(), 1);
    assert.equal(await worker.reconcilePrizeFundingOnce(), 1);
    assert.deepEqual((await client.query<{
      finality_state: string;
      settled_amount: string;
      pool_amount: string;
      deficit_amount: string;
      remainder_episode: string;
      remainder_amount: string;
      remainder_state: string;
    }>(
      `SELECT finality.state AS finality_state,
         COALESCE((SELECT sum(CASE WHEN side = 'CREDIT' THEN amount ELSE -amount END)::text
           FROM core.ledger_lines WHERE account_id = $2 AND balance_state = 'SETTLED'),'0') AS settled_amount,
         COALESCE((SELECT sum(CASE WHEN side = 'CREDIT' THEN amount ELSE -amount END)::text
           FROM core.ledger_lines WHERE account_id = $3 AND balance_state = 'LOCKED'),'0') AS pool_amount,
         COALESCE((SELECT sum(CASE WHEN side = 'CREDIT' THEN amount ELSE -amount END)::text
           FROM core.ledger_lines
           WHERE account_id = 'system:seckill-prize-reorg-deficit:usdt'
             AND balance_state = 'POSTED'),'0') AS deficit_amount,
         remainder.recovery_episode::text AS remainder_episode,
         remainder.amount_usdt::text AS remainder_amount,
         remainder.state AS remainder_state
       FROM core.transaction_finality finality
       JOIN core.seckill_prize_reorg_remainders remainder
         ON remainder.exposure_id = $4 AND remainder.recovery_episode = 4
       WHERE finality.transaction_id = $1`,
      [
        `settlement-finality:${payoutAttemptId}`,
        `buyer:${BUYER}:prize:usdt`,
        `seckill-prize:${SESSION_ID}:usdt`,
        exposureId,
      ],
    )).rows[0], {
      finality_state: 'FAILED',
      settled_amount: '0',
      pool_amount: RETAINED_AMOUNT,
      deficit_amount: '0',
      remainder_episode: '4',
      remainder_amount: RETAINED_AMOUNT,
      remainder_state: 'PENDING',
    });
    const restoredPayoutRecovery = await operations.getPrizeReorgExposure(
      { walletAddress: admin.address, roles: ['ADMIN'] },
      payoutRecoveryExposureId,
    );
    assert.equal(restoredPayoutRecovery.state, 'RECOVERY_REQUIRED');
    assert.equal(
      restoredPayoutRecovery.transitions.filter((transition) => transition.type === 'PAYOUT_REORGED').length,
      1,
    );
    assert.equal(
      restoredPayoutRecovery.transitions.filter((transition) => transition.type === 'RESOLVED').length,
      2,
    );
    workerNow = new Date(workerNow.getTime() + 1_000);
    await seedCoverage(client, 'coverage:postgres-prize-recovery:3', workerNow, HASH_3, HASH_1);
    const recoverExposure = async (targetExposureId: string, nonce: string) => {
      const deadline = String(Math.floor(workerNow.getTime() / 1_000) + 300);
      const recoveryChallenge = await operations.prizeRecoveryChallenge(
        { walletAddress: admin.address, roles: ['ADMIN'] },
        targetExposureId,
        { nonce, deadline },
      );
      return operations.submitPrizeRecovery(
        { walletAddress: admin.address, roles: ['ADMIN'] },
        targetExposureId,
        {
          snapshotId: recoveryChallenge.snapshotId,
          nonce,
          deadline,
          signature: await secondary.signTypedData(
            recoveryChallenge.typedData.domain,
            recoveryChallenge.typedData.types,
            recoveryChallenge.typedData.message,
          ),
          correlationId: `postgres-prize-recovery-${nonce}`,
        },
      );
    };
    assert.equal((await recoverExposure(exposureId, '202')).recoveryEpisode, 4);
    assert.equal((await client.query<{ paused: boolean }>(
      "SELECT paused FROM core.circuit_breakers WHERE scope = 'NEW_SETTLEMENT_BATCH'",
    )).rows[0]?.paused, true);
    assert.equal((await recoverExposure(payoutRecoveryExposureId, '203')).recoveryEpisode, 2);
    assert.equal((await client.query<{ paused: boolean }>(
      "SELECT paused FROM core.circuit_breakers WHERE scope = 'NEW_SETTLEMENT_BATCH'",
    )).rows[0]?.paused, false);
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
    await adminClient.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await adminClient.end();
  }
});

test('real PostgreSQL serializes prize injection creation against empty-session settlement', {
  timeout: 600_000,
}, async () => {
  const adminConnectionString = requiredPostgresAdminUrl();
  const databaseName = `abu24k_late_prize_${randomBytes(6).toString('hex')}`;
  const databaseConnectionString = connectionForDatabase(adminConnectionString, databaseName);
  const admin = new Client({ connectionString: connectionForDatabase(adminConnectionString, 'postgres') });
  const clients: Client[] = [];
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const client = await connected(databaseConnectionString, clients);
    await applyMigrations(client, 'core', MIGRATIONS);
    const sourceSessionId = `0x${'1'.repeat(64)}`;
    const blockHash = `0x${'6'.repeat(64)}`;
    const operationsWallet = '0x5555555555555555555555555555555555555555';
    const adminWallet = '0x9999999999999999999999999999999999999999';
    const sourceAccountId = `seckill-prize:${sourceSessionId}:usdt`;
    const walletAccountId = `wallet:usdt-custody:${SETTLEMENT_WALLET}:usdt`;
    const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const cutoffAt = new Date(now.getTime() + 60_000);
    const settlementAt = new Date(cutoffAt.getTime() + 5 * 60_000);
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        `INSERT INTO core.policy_snapshots (
           policy_version, artifact_version, policy_hash, rules_content_hash,
           beneficiary_set_hash, payload, publication_status
         ) VALUES (1,$1,$2,$3,$4,$5,'PUBLISHED')`,
        [CORE_ARTIFACT_VERSION, HASH_1, HASH_2, HASH_3, JSON.stringify({ usdtSettlementWallet: SETTLEMENT_WALLET })],
      );
      await client.query(
        `INSERT INTO core.merchants (
           merchant_id, settlement_wallet, status, level, profile, guarantee_status
         ) VALUES ('merchant:late',$1,'APPROVED','V1','{}','READY')`,
        [SETTLEMENT_WALLET],
      );
      await client.query(
        `INSERT INTO core.products (
           product_id, chain_product_id, merchant_id, version, title, lifecycle_state,
           product_policy_hash, merchant_concession_bps, metadata, subtitle,
           rich_detail, default_freight_usdt, fulfillment_modes
         ) VALUES ('product:late',$1,'merchant:late',1,'Late prize','ACTIVE',$2,0,
           '{}','Late prize','{"blocks":[]}',0,'["DELIVERY"]')`,
        [`0x${'7'.repeat(64)}`, HASH_1],
      );
      await client.query(
        `INSERT INTO core.skus (
           sku_id, chain_sku_id, product_id, sku_version, attributes, list_price_usdt,
           merchant_cost_usdt, stock_total, stock_available, lifecycle_state
         ) VALUES ('sku:late',$1,'product:late',1,'{}',1,1,2,2,'ACTIVE')`,
        [`0x${'8'.repeat(64)}`],
      );
      await client.query(
        `INSERT INTO core.seckill_sessions (
           session_id, policy_version, merchant_id, product_id, sku_id,
           product_policy_hash, starts_at, main_deadline, relay_deadline,
           inventory, seckill_list_price_usdt, phase, prize_pool_usdt, snapshot
         ) VALUES ($1,1,'merchant:late','product:late','sku:late',$2,$3,$4,$4,1,1,'LIVE',0,'{}')`,
        [sourceSessionId, HASH_1, now, cutoffAt],
      );
      await client.query(
        `INSERT INTO core.ledger_accounts (
           account_id, owner_type, owner_id, asset, purpose, wallet_address
         ) VALUES
           ($1,'WALLET',$2,'USDT','WALLET_ASSET',$2),
           ($3,'BENEFICIARY',$4,'USDT','SECKILL_PRIZE_LIABILITY',NULL)`,
        [walletAccountId, SETTLEMENT_WALLET, sourceAccountId, sourceSessionId],
      );
      await client.query(
        `INSERT INTO core.wallet_role_bindings (
           wallet_address, role, merchant_id, status, evidence_hash
         ) VALUES ($1,'ADMIN',NULL,'ACTIVE',$2)`,
        [adminWallet, HASH_1],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    await seedCoverage(client, 'coverage:postgres-late-prize:1', settlementAt, blockHash, HASH_3);
    await client.query(
      `INSERT INTO core.coverage_snapshot_items (
         snapshot_id, wallet_address, asset, verified_asset_balance,
         unsettled_liability, coverage_met
       ) VALUES ('coverage:postgres-late-prize:1',$1,'USDT',20,0,true)`,
      [operationsWallet],
    );
    const lockHolder = await connected(databaseConnectionString, clients);
    const creator = await connected(databaseConnectionString, clients);
    await lockHolder.query('BEGIN');
    await lockSeckillPrizeFundingMutation(lockHolder);
    const service = new SeckillOperationsService({
      transactions: { transaction: <Result>(operation: (executor: Client) => Promise<Result>) => inTransaction(creator, operation) },
      governanceWalletAddress: adminWallet,
      operationsWalletAddress: operationsWallet,
      settlementWalletAddress: SETTLEMENT_WALLET,
      paymentRouterAddress: '0x6666666666666666666666666666666666666666',
      secondarySignerAddress: '0x7777777777777777777777777777777777777777',
      clock: () => settlementAt,
    });
    let creationCompleted = false;
    const creation = service.createPrizeInjection(
      { walletAddress: adminWallet, roles: ['ADMIN'] },
      sourceSessionId,
      {
        amountUsdt: '20',
        idempotencyKey: 'postgres-injection-settlement-race',
        correlationId: 'postgres-injection-settlement-race',
      },
    ).finally(() => { creationCompleted = true; });
    void creation.catch(() => undefined);
    await delay(100);
    assert.equal(creationCompleted, false);
    assert.deepEqual(await settleMaturedSeckillPrizes(lockHolder, settlementAt), [sourceSessionId]);
    await lockHolder.query('COMMIT');
    await assert.rejects(
      creation,
      (error: unknown) => (error as { code?: string }).code === 'InvalidRequest',
    );
    assert.deepEqual((await client.query<{
      phase: string;
      outcome_state: string;
      action_count: string;
    }>(
      `SELECT session.phase, outcome.state AS outcome_state,
         (SELECT count(*)::text FROM core.seckill_governance_actions action
          WHERE action.session_id = session.session_id
            AND action.action_kind = 'PRIZE_INJECTION') AS action_count
       FROM core.seckill_sessions session
       JOIN core.seckill_prize_settlements outcome ON outcome.session_id = session.session_id
       WHERE session.session_id = $1`,
      [sourceSessionId],
    )).rows[0], { phase: 'SETTLED', outcome_state: 'ROLLED_OVER', action_count: '0' });
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});

async function seedAwardedInjection(
  client: Client,
  initialTransferState: 'PENDING' | 'LEASED' = 'LEASED',
) {
  const sourceAccountId = `seckill-prize:${SESSION_ID}:usdt`;
  const awardAccountId = `buyer:${BUYER}:prize:usdt`;
  const walletAccountId = `wallet:usdt-custody:${SETTLEMENT_WALLET}:usdt`;
  const injectionJournalId = `journal:seckill-prize:${ACTION_ID}`;
  const secondInjectionJournalId = `journal:seckill-prize:${SECOND_ACTION_ID}`;
  const awardJournalId = `journal:seckill-prize-award:${SESSION_ID}`;
  const requestedJournalId = `journal:settlement-requested:${REQUEST_ID}`;
  const at = new Date('2026-07-21T23:00:00.000Z');
  const settlementSignature = await BUYER_SIGNER.signTypedData(
    settlementRequestDomain(SETTLEMENT_INTENT.executorWallet),
    settlementRequestTypes,
    SETTLEMENT_INTENT,
  );
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(
      `INSERT INTO core.policy_snapshots (
         policy_version, artifact_version, policy_hash, rules_content_hash,
         beneficiary_set_hash, payload, publication_status
       ) VALUES (1,$1,$2,$3,$4,$5,'PUBLISHED')`,
      [
        CORE_ARTIFACT_VERSION,
        HASH_1,
        HASH_2,
        HASH_3,
        JSON.stringify({ usdtSettlementWallet: SETTLEMENT_WALLET }),
      ],
    );
    await client.query(
      `INSERT INTO core.merchants (
         merchant_id, settlement_wallet, status, level, profile, guarantee_status
       ) VALUES ('merchant:postgres',$1,'APPROVED','V1','{}','READY')`,
      [SETTLEMENT_WALLET],
    );
    await client.query(
      `INSERT INTO core.seckill_sessions (
         session_id, policy_version, merchant_id, product_id, sku_id,
         product_policy_hash, starts_at, main_deadline, relay_deadline,
         inventory, seckill_list_price_usdt, phase, prize_pool_usdt, snapshot
       ) VALUES ($1,1,'merchant:postgres','product:postgres','sku:postgres',$2,
         $3,$4,$4,1,1,'SETTLED',80,'{}')`,
      [SESSION_ID, HASH_1, new Date(at.getTime() - 3_600_000), at],
    );
    await client.query(
      `INSERT INTO core.orders (
         order_id, artifact_version, policy_version, buyer_wallet,
         merchant_id, merchant_wallet, product_id, sku_id, quantity,
         fulfillment_mode, fulfillment_target_hash, region_code_hash,
         product_policy_hash, reservation_id, quote_snapshot,
         allocation_snapshot, exact_amounts, buyer_nonce, quote_deadline,
         state, finality_status, payment_tx_hash, payment_block_hash, paid_at
       ) VALUES (
         $1,$2,1,$3,'merchant:postgres',$4,'product:postgres','sku:postgres',1,
         'DELIVERY',$5,$6,$5,'reservation:postgres-prize','{}','{}',
         '{"usdt":"80","npl":"0","bnmAmount":"0"}',1,$7,'PAID','FINAL',$8,$9,$7
       )`,
      [ORDER_ID, CORE_ARTIFACT_VERSION, BUYER, SETTLEMENT_WALLET, HASH_1, HASH_2, at, HASH_1, HASH_2],
    );
    await client.query(
      `INSERT INTO core.ledger_accounts (
         account_id, owner_type, owner_id, asset, purpose, wallet_address
       ) VALUES
         ($1,'BENEFICIARY',$4,'USDT','SECKILL_PRIZE_LIABILITY',NULL),
         ($2,'BUYER',$5,'USDT','SECKILL_PRIZE_LIABILITY',NULL),
         ($3,'WALLET',$6,'USDT','WALLET_ASSET',$6)`,
      [sourceAccountId, awardAccountId, walletAccountId, SESSION_ID, BUYER, SETTLEMENT_WALLET],
    );
    await client.query(
      'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [
        injectionJournalId,
        `seckill-prize:${ACTION_ID}:final`,
        'SECKILL_PRIZE_INJECTED',
        'SECKILL_SESSION',
        SESSION_ID,
        null,
        1,
        HASH_1,
        HASH_1,
        HASH_2,
        'CHAIN_EVENT',
        HASH_1,
        null,
        JSON.stringify({ actionId: ACTION_ID, sessionId: SESSION_ID, amountUsdt: INJECTION_AMOUNT }),
        JSON.stringify([
          {
            account_id: walletAccountId,
            side: 'DEBIT',
            amount: INJECTION_AMOUNT,
            balance_state: 'POSTED',
            backing_wallet_address: SETTLEMENT_WALLET,
          },
          {
            account_id: sourceAccountId,
            side: 'CREDIT',
            amount: INJECTION_AMOUNT,
            balance_state: 'LOCKED',
            backing_wallet_address: SETTLEMENT_WALLET,
          },
        ]),
      ],
    );
    await client.query(
      'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [
        secondInjectionJournalId,
        `seckill-prize:${SECOND_ACTION_ID}:final`,
        'SECKILL_PRIZE_INJECTED',
        'SECKILL_SESSION',
        SESSION_ID,
        null,
        1,
        RETAINED_FUNDING_HASH,
        RETAINED_FUNDING_HASH,
        RETAINED_FUNDING_HASH,
        'CHAIN_EVENT',
        RETAINED_FUNDING_HASH,
        null,
        JSON.stringify({ actionId: SECOND_ACTION_ID, sessionId: SESSION_ID, amountUsdt: RETAINED_AMOUNT }),
        JSON.stringify([
          {
            account_id: walletAccountId,
            side: 'DEBIT',
            amount: RETAINED_AMOUNT,
            balance_state: 'POSTED',
            backing_wallet_address: SETTLEMENT_WALLET,
          },
          {
            account_id: sourceAccountId,
            side: 'CREDIT',
            amount: RETAINED_AMOUNT,
            balance_state: 'LOCKED',
            backing_wallet_address: SETTLEMENT_WALLET,
          },
        ]),
      ],
    );
    await client.query(
      'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [
        awardJournalId,
        `seckill-prize-award:${SESSION_ID}`,
        'SECKILL_PRIZE_AWARDED',
        'SECKILL_SESSION',
        SESSION_ID,
        ORDER_ID,
        1,
        HASH_2,
        null,
        null,
        'GOVERNED_EVIDENCE',
        HASH_2,
        null,
        JSON.stringify({ winner: BUYER }),
        JSON.stringify([
          {
            account_id: sourceAccountId,
            side: 'DEBIT',
            amount: TOTAL_PRIZE_AMOUNT,
            balance_state: 'LOCKED',
            backing_wallet_address: SETTLEMENT_WALLET,
          },
          {
            account_id: awardAccountId,
            side: 'CREDIT',
            amount: TOTAL_PRIZE_AMOUNT,
            balance_state: 'AVAILABLE',
            backing_wallet_address: SETTLEMENT_WALLET,
          },
        ]),
      ],
    );
    await client.query(
      `INSERT INTO core.seckill_prize_settlements (
         session_id, cutoff_at, state, candidate_order_id, candidate_buyer_wallet,
         candidate_payment_event_key, candidate_block_number, candidate_log_index,
         candidate_evidence_hash, pool_amount_usdt, pool_snapshot_hash,
         review_decision, review_reason_code, review_evidence_hash, reviewed_by,
         reviewed_at, review_idempotency_key, review_request_hash,
         award_account_id, award_journal_id, created_at, updated_at
       ) VALUES ($1,$2,'APPROVED',$3,$4,$5,100,0,$6,80,$7,'APPROVED','ORDER_VALID',
         $8,$9,$2,'postgres-prize-approval',$10,$11,$12,$2,$2)`,
      [
        SESSION_ID,
        at,
        ORDER_ID,
        BUYER,
        `payment:${ORDER_ID}`,
        HASH_1,
        HASH_2,
        HASH_3,
        SETTLEMENT_WALLET,
        HASH_1,
        awardAccountId,
        awardJournalId,
      ],
    );
    await client.query(
      `INSERT INTO core.seckill_prize_injections (
         injection_id, action_id, session_id, amount_usdt, operations_wallet_address,
         settlement_wallet_address, token_address, final_journal_id, created_at, updated_at
       ) VALUES
         ($1,$2,$3,50,$6,$6,$7,$4,$8,$8),
         ($5,$9,$3,30,$6,$6,$7,$10,$8,$8)`,
      [
        INJECTION_ID,
        ACTION_ID,
        SESSION_ID,
        injectionJournalId,
        SECOND_INJECTION_ID,
        SETTLEMENT_WALLET,
        USDT_ADDRESS,
        at,
        SECOND_ACTION_ID,
        secondInjectionJournalId,
      ],
    );
    await client.query(
      `INSERT INTO core.settlement_intents (
         intent_id, artifact_version, wallet_address, recipient_address,
         rail, asset, asset_address, executor_wallet, amount, items_hash,
         intent_digest, nonce, deadline, state, idempotency_key, request_hash,
         created_at, consumed_at
       ) VALUES ($1,$2,$3,$3,'PRIZE_USDT','USDT',$4,$5,$6,$7,$8,1,$9,
         'CONSUMED','postgres-prize-intent',$10,$11,$11)`,
      [
        SETTLEMENT_INTENT_ID,
        CORE_ARTIFACT_VERSION,
        BUYER,
        USDT_ADDRESS,
        SETTLEMENT_WALLET,
        TOTAL_PRIZE_AMOUNT,
        SETTLEMENT_INTENT.itemsHash,
        settlementIntentDigest(SETTLEMENT_INTENT),
        new Date(SETTLEMENT_INTENT.deadline * 1_000),
        HASH_1,
        at,
      ],
    );
    await client.query(
      `INSERT INTO core.settlement_intent_items (
         intent_id, item_index, order_id, account_id,
         backing_wallet_address, amount, item_hash
       ) VALUES ($1,0,$2,$3,$4,$5,$6)`,
      [
        SETTLEMENT_INTENT_ID,
        ORDER_ID,
        SETTLEMENT_ITEM.accountId,
        SETTLEMENT_WALLET,
        TOTAL_PRIZE_AMOUNT,
        SETTLEMENT_ITEM.itemHash,
      ],
    );
    await client.query(
      'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [
        requestedJournalId,
        `settlement-requested:${REQUEST_ID}`,
        'SETTLEMENT_REQUESTED',
        'SETTLEMENT_REQUEST',
        REQUEST_ID,
        ORDER_ID,
        1,
        HASH_1,
        null,
        null,
        'SIGNED_REQUEST',
        settlementIntentDigest(SETTLEMENT_INTENT),
        null,
        JSON.stringify({ requestId: REQUEST_ID }),
        JSON.stringify([
          {
            account_id: awardAccountId,
            side: 'DEBIT',
            amount: TOTAL_PRIZE_AMOUNT,
            balance_state: 'AVAILABLE',
            backing_wallet_address: SETTLEMENT_WALLET,
          },
          {
            account_id: awardAccountId,
            side: 'CREDIT',
            amount: TOTAL_PRIZE_AMOUNT,
            balance_state: 'REQUESTED',
            backing_wallet_address: SETTLEMENT_WALLET,
          },
        ]),
      ],
    );
    await client.query(
      `INSERT INTO core.settlement_requests (
         request_id, intent_id, artifact_version, wallet_address, recipient_address,
         rail, asset, asset_address, executor_wallet, amount, items_hash,
         intent_digest, signature, signature_hash, state, requested_at
       ) VALUES ($1,$2,$3,$4,$4,'PRIZE_USDT','USDT',$5,$6,$7,$8,$9,$10,$11,
         'REQUESTED',$12)`,
      [
        REQUEST_ID,
        SETTLEMENT_INTENT_ID,
        CORE_ARTIFACT_VERSION,
        BUYER,
        USDT_ADDRESS,
        SETTLEMENT_WALLET,
        TOTAL_PRIZE_AMOUNT,
        SETTLEMENT_INTENT.itemsHash,
        settlementIntentDigest(SETTLEMENT_INTENT),
        settlementSignature,
        keccak256(settlementSignature),
        at,
      ],
    );
    await client.query(
      `INSERT INTO core.settlement_request_items (
         request_id, item_index, order_id, account_id, backing_wallet_address,
         amount, requested_journal_id
       ) VALUES ($1,0,$2,$3,$4,$5,$6)`,
      [REQUEST_ID, ORDER_ID, awardAccountId, SETTLEMENT_WALLET, TOTAL_PRIZE_AMOUNT, requestedJournalId],
    );
    await client.query(
      `INSERT INTO core.settlement_transfers (
         transfer_id, artifact_version, chain_id, request_id, request_item_index,
         order_id, account_id, asset, token_address, executor_wallet, executor_nonce,
         recipient_address, amount, transfer_calldata, content_hash, idempotency_key,
         gas_cap, token_code_hash, token_transfer_conformance_evidence_hash,
         runtime_evidence_hash, runtime_checked_at, state, created_by, created_at
       ) VALUES ($1,$2,56,$3,0,$4,$5,'USDT',$6,$7,7,$8,$9,'0xa9059cbb',$10,
         'postgres-prize-transfer',100000,$11,$12,$13,$14,$15,$7,$14)`,
      [
        TRANSFER_ID,
        CORE_ARTIFACT_VERSION,
        REQUEST_ID,
        ORDER_ID,
        awardAccountId,
        USDT_ADDRESS,
        SETTLEMENT_WALLET,
        BUYER,
        TOTAL_PRIZE_AMOUNT,
        RETAINED_FUNDING_HASH,
        HASH_1,
        HASH_2,
        HASH_3,
        at,
        initialTransferState,
      ],
    );
    if (initialTransferState === 'LEASED') {
      await client.query(
        `INSERT INTO core.settlement_transfer_attempts (
           attempt_id, transfer_id, attempt_number, lease_token, request_digest,
           transaction_to, transaction_calldata, executor_wallet, executor_nonce,
           gas_limit, state, leased_until, created_at, updated_at
         ) VALUES ($1,$2,1,'postgres-prize-lease',$3,$4,'0xa9059cbb',$5,7,100000,
           'LEASED',$6,$7,$7)`,
        [ATTEMPT_ID, TRANSFER_ID, HASH_3, USDT_ADDRESS, SETTLEMENT_WALLET,
          new Date(at.getTime() + 120_000), at],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function seedPaymentProjection(client: Client) {
  const walletAccountId = `wallet:usdt-custody:${SETTLEMENT_WALLET}:usdt`;
  const merchantAccountId = 'merchant:postgres:receivable:usdt';
  const paymentJournalId = 'journal:payment:postgres-lock-order';
  const at = new Date('2026-07-22T00:10:00.000Z');
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(
      `INSERT INTO core.orders (
         order_id, artifact_version, policy_version, buyer_wallet,
         merchant_id, merchant_wallet, product_id, sku_id, quantity,
         fulfillment_mode, fulfillment_target_hash, region_code_hash,
         product_policy_hash, reservation_id, quote_snapshot,
         allocation_snapshot, exact_amounts, buyer_nonce, quote_deadline,
         state, finality_status, payment_tx_hash, payment_block_hash, paid_at
       ) VALUES (
         $1,$2,1,$3,'merchant:postgres',$4,'product:postgres','sku:postgres',1,
         'DELIVERY',$5,$6,$5,'reservation:postgres-payment','{}','{}',
         '{"usdt":"10","npl":"0","bnmAmount":"0"}',2,$7,
         'PAID','FINAL',$8,$9,$7
       )`,
      [
        PAYMENT_ORDER_ID,
        CORE_ARTIFACT_VERSION,
        BUYER,
        SETTLEMENT_WALLET,
        HASH_1,
        HASH_2,
        at,
        PAYMENT_TX_HASH,
        PAYMENT_BLOCK_HASH,
      ],
    );
    await client.query(
      `INSERT INTO core.ledger_accounts (
         account_id, owner_type, owner_id, asset, purpose, wallet_address
       ) VALUES ($1,'MERCHANT','merchant:postgres','USDT','MERCHANT_RECEIVABLE',NULL)`,
      [merchantAccountId],
    );
    await client.query(
      'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [
        paymentJournalId,
        PAYMENT_EVENT_KEY,
        'PAYMENT_LOCKED',
        'ORDER',
        PAYMENT_ORDER_ID,
        PAYMENT_ORDER_ID,
        1,
        HASH_1,
        PAYMENT_TX_HASH,
        PAYMENT_BLOCK_HASH,
        'CHAIN_EVENT',
        PAYMENT_TX_HASH,
        null,
        JSON.stringify({ orderId: PAYMENT_ORDER_ID }),
        JSON.stringify([
          {
            account_id: walletAccountId,
            side: 'DEBIT',
            amount: '10',
            balance_state: 'POSTED',
            backing_wallet_address: SETTLEMENT_WALLET,
          },
          {
            account_id: merchantAccountId,
            side: 'CREDIT',
            amount: '10',
            balance_state: 'LOCKED',
            backing_wallet_address: SETTLEMENT_WALLET,
          },
        ]),
      ],
    );
    await client.query(
      `INSERT INTO core.payment_events (
         event_key, order_id, journal_id, transaction_hash, log_index, block_number,
         block_hash, snapshot_hash, classification, confirmations, canonical, observed_at
       ) VALUES ($1,$2,$3,$4,0,300,$5,$6,'ORDINARY',15,true,$7)`,
      [PAYMENT_EVENT_KEY, PAYMENT_ORDER_ID, paymentJournalId, PAYMENT_TX_HASH,
        PAYMENT_BLOCK_HASH, HASH_2, at],
    );
    await client.query(
      `INSERT INTO core.transaction_finality (
         transaction_id, resource_type, resource_id, chain_id, contract_address,
         expected_event_hash, tx_hash, block_number, block_hash, confirmations,
         required_confirmations, receipt_status, state, evidence, submitted_at, finalized_at
       ) VALUES ($1,'ORDER_PAYMENT',$2,56,$3,$4,$5,300,$6,15,15,1,'FINAL','{}',$7,$7)`,
      [
        `payment:${PAYMENT_EVENT_KEY}`,
        PAYMENT_ORDER_ID,
        '0x9999999999999999999999999999999999999999',
        HASH_1,
        PAYMENT_TX_HASH,
        PAYMENT_BLOCK_HASH,
        at,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function successfulPayoutReceipt(): EoaSettlementReceipt {
  return {
    chainId: 56,
    executionTxHash: PAYOUT_TX_HASH,
    transactionTo: USDT_ADDRESS,
    transactionCalldata: '0xa9059cbb',
    executorWallet: SETTLEMENT_WALLET,
    executorNonce: '7',
    receiptStatus: 1,
    blockNumber: 1_200,
    blockHash: HASH_2,
    confirmations: 15,
    canonicalBlock: true,
    transfers: [{
      tokenAddress: USDT_ADDRESS,
      from: SETTLEMENT_WALLET,
      to: BUYER,
      amount: TOTAL_PRIZE_AMOUNT,
    }],
    transactionDeltas: [
      { tokenAddress: USDT_ADDRESS, account: SETTLEMENT_WALLET, delta: `-${TOTAL_PRIZE_AMOUNT}` },
      { tokenAddress: USDT_ADDRESS, account: BUYER, delta: TOTAL_PRIZE_AMOUNT },
    ],
    evidenceHash: HASH_1,
  };
}

function failedPayoutReceipt(confirmations: number, evidenceHash: string): EoaSettlementReceipt {
  return {
    ...successfulPayoutReceipt(),
    receiptStatus: 0,
    blockNumber: 1_201,
    blockHash: HASH_3,
    confirmations,
    transfers: [],
    transactionDeltas: [],
    evidenceHash,
  };
}

async function seedCoverage(
  client: Client,
  snapshotId: string,
  at: Date,
  blockHash: string,
  evidenceHash: string,
) {
  await client.query(
    `INSERT INTO core.coverage_snapshots (
       snapshot_id, chain_id, block_number, block_hash, canonical, evidence_hash, recorded_at
     ) VALUES ($1,56,1202,$2,true,$3,$4)`,
    [snapshotId, blockHash, evidenceHash, at],
  );
  await client.query(
    `INSERT INTO core.coverage_snapshot_items (
       snapshot_id, wallet_address, asset, verified_asset_balance,
       unsettled_liability, coverage_met
     ) VALUES ($1,$2,'USDT',100000,0,true)`,
    [snapshotId, SETTLEMENT_WALLET],
  );
  await client.query(
    `INSERT INTO core.coverage_snapshot_canonicality (
       observation_id, snapshot_id, canonical, observed_block_hash, evidence_hash, observed_at
     ) VALUES ($1,$2,true,$3,$4,$5)`,
    [`coverage-observation:${snapshotId}`, snapshotId, blockHash, evidenceHash, at],
  );
}

async function inTransaction<Result>(
  client: Client,
  operation: (executor: Client) => Promise<Result>,
) {
  await client.query('BEGIN');
  try {
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function connected(connectionString: string, clients: Client[]) {
  const client = new Client({ connectionString });
  await client.connect();
  await client.query("SET statement_timeout = '15s'");
  await client.query("SET lock_timeout = '5s'");
  clients.push(client);
  return client;
}

function connectionForDatabase(connectionString: string, database: string) {
  const value = new URL(connectionString);
  value.pathname = `/${database}`;
  return value.href;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
