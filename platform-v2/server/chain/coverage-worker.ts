import { Interface, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { CoreError } from '../api/errors.ts';
import type { SqlExecutor, SqlTransactionRunner } from '../data/migrations.ts';

export interface CoverageAssetObservation {
  walletAddress: string;
  asset: 'USDT' | 'NPL';
  tokenAddress: string;
  balance: string;
}

export interface CoverageObservation {
  chainId: 56;
  blockNumber: number;
  blockHash: string;
  canonical: boolean;
  evidenceHash: string;
  observedAt: Date;
  assets: readonly CoverageAssetObservation[];
}

export interface CoverageSource {
  observe(): Promise<CoverageObservation>;
}

type ExpectedCoverageAssets = ReadonlyMap<
  string,
  { walletAddress: string; asset: 'USDT' | 'NPL'; tokenAddress: string }
>;

export class CoverageWorker {
  readonly #transactions: SqlTransactionRunner;
  readonly #source: CoverageSource;
  readonly #expected: ExpectedCoverageAssets;
  readonly #paymentRouterAddress: string;
  readonly #governanceWalletAddress: string;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;
  #running = false;

  constructor(input: {
    transactions: SqlTransactionRunner;
    source: CoverageSource;
    expectedAssets: readonly { walletAddress: string; asset: 'USDT' | 'NPL'; tokenAddress: string }[];
    paymentRouterAddress: string;
    governanceWalletAddress: string;
  }) {
    this.#transactions = input.transactions;
    this.#source = input.source;
    this.#expected = expectedAssets(input.expectedAssets);
    this.#paymentRouterAddress = address(input.paymentRouterAddress, 'PaymentRouter');
    this.#governanceWalletAddress = address(input.governanceWalletAddress, 'governance wallet');
  }

  start(intervalMs = 30_000) {
    if (this.#running) return;
    this.#running = true;
    const poll = async () => {
      if (!this.#running) return;
      this.#inFlight = this.pollOnce().then(() => undefined).catch(() => undefined);
      await this.#inFlight;
      this.#inFlight = undefined;
      if (this.#running) this.#timer = setTimeout(poll, intervalMs);
    };
    this.#timer = setTimeout(poll, intervalMs);
  }

  async stop() {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#inFlight;
  }

  async pollOnce() {
    const observed = validateObservation(await this.#source.observe(), this.#expected);
    const result = await this.#transactions.transaction(async (executor) => {
      const snapshotId = hashJson({
        chainId: observed.chainId,
        blockNumber: observed.blockNumber,
        blockHash: observed.blockHash,
        evidenceHash: observed.evidenceHash,
        assets: observed.assets,
      });
      const existing = await executor.query<{ evidence_hash: string }>(
        'SELECT evidence_hash FROM core.coverage_snapshots WHERE snapshot_id = $1',
        [snapshotId],
      );
      if (existing.rows[0] && existing.rows[0].evidence_hash !== observed.evidenceHash) {
        throw new CoreError('IdempotencyConflict', 'Coverage snapshot identity conflict', 409);
      }
      await executor.query(
        `INSERT INTO core.coverage_snapshots (
           snapshot_id, chain_id, block_number, block_hash, canonical, evidence_hash, recorded_at
         ) VALUES ($1,56,$2,$3,$4,$5,$6)
         ON CONFLICT (snapshot_id) DO NOTHING`,
        [
          snapshotId,
          observed.blockNumber,
          observed.blockHash,
          observed.canonical,
          observed.evidenceHash,
          observed.observedAt,
        ],
      );
      const results: Array<CoverageAssetObservation & {
        unsettledLiability: string;
        coverageMet: boolean;
      }> = [];
      for (const asset of observed.assets) {
        const liability = await unsettledLiability(executor, asset.walletAddress, asset.asset);
        const assetCoverageMet = BigInt(asset.balance) >= BigInt(liability);
        await executor.query(
          `INSERT INTO core.coverage_snapshot_items (
             snapshot_id, wallet_address, asset, verified_asset_balance,
             unsettled_liability, coverage_met
           ) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (snapshot_id, wallet_address, asset) DO NOTHING`,
          [snapshotId, asset.walletAddress, asset.asset, asset.balance, liability, assetCoverageMet],
        );
        results.push({
          ...asset,
          unsettledLiability: liability,
          coverageMet: observed.canonical && assetCoverageMet,
        });
      }
      await appendCanonicality(executor, snapshotId, observed);
      for (const item of results) {
        const causeId = `coverage:${item.walletAddress}:${item.asset}`;
        if (!item.coverageMet) {
          await activateCoverageBreaker(executor, causeId, observed.evidenceHash, observed.observedAt);
        } else {
          await publishRecoveryPending(executor, causeId, snapshotId, observed.evidenceHash, observed.observedAt);
        }
      }
      return { snapshotId, canonical: observed.canonical, assets: results };
    });
    if (result.assets.some((item) => !item.coverageMet)) {
      await this.#transactions.transaction((executor) => ensurePaymentPauseAction(executor, {
        snapshotId: result.snapshotId,
        evidenceHash: observed.evidenceHash,
        paymentRouterAddress: this.#paymentRouterAddress,
        governanceWalletAddress: this.#governanceWalletAddress,
        at: observed.observedAt,
      }));
    }
    return result;
  }

  async recordCanonicality(input: {
    snapshotId: string;
    canonical: boolean;
    observedBlockHash: string;
    evidenceHash: string;
    observedAt: Date;
  }) {
    if (!isHash(input.snapshotId) || !isHash(input.observedBlockHash) || !isHash(input.evidenceHash)) {
      throw new CoreError('InvalidFinality', 'Coverage canonicality evidence is invalid');
    }
    const result = await this.#transactions.transaction(async (executor) => {
      const snapshot = await executor.query<{ snapshot_id: string }>(
        'SELECT snapshot_id FROM core.coverage_snapshots WHERE snapshot_id = $1',
        [input.snapshotId],
      );
      if (!snapshot.rows[0]) throw new CoreError('InvalidFinality', 'Coverage snapshot is unavailable', 404);
      await appendCanonicality(executor, input.snapshotId, {
        blockHash: input.observedBlockHash,
        canonical: input.canonical,
        evidenceHash: input.evidenceHash,
        observedAt: input.observedAt,
      });
      if (!input.canonical) {
        const assets = await executor.query<{ wallet_address: string; asset: string }>(
          `SELECT wallet_address, asset FROM core.coverage_snapshot_items
           WHERE snapshot_id = $1 ORDER BY wallet_address, asset`,
          [input.snapshotId],
        );
        for (const asset of assets.rows) {
          await activateCoverageBreaker(
            executor,
            `coverage:${asset.wallet_address}:${asset.asset}`,
            input.evidenceHash,
            input.observedAt,
          );
        }
      }
      return { snapshotId: input.snapshotId, canonical: input.canonical };
    });
    if (!input.canonical) {
      await this.#transactions.transaction((executor) => ensurePaymentPauseAction(executor, {
        snapshotId: input.snapshotId,
        evidenceHash: input.evidenceHash,
        paymentRouterAddress: this.#paymentRouterAddress,
        governanceWalletAddress: this.#governanceWalletAddress,
        at: input.observedAt,
      }));
    }
    return result;
  }
}

const PAYMENT_ROUTER_BREAKER = new Interface([
  'function setNewPaymentsPaused(bool paused,bytes32 evidenceHash)',
]);

async function ensurePaymentPauseAction(executor: SqlExecutor, input: {
  snapshotId: string;
  evidenceHash: string;
  paymentRouterAddress: string;
  governanceWalletAddress: string;
  at: Date;
}) {
  const existing = await executor.query<{ action_id: string; target_paused: boolean }>(
    `SELECT action_id, target_paused FROM core.coverage_breaker_actions
     WHERE state IN ('PENDING_EXECUTION','SUBMITTED','MINED','FINAL')
     ORDER BY created_at DESC, action_id DESC LIMIT 1`,
  );
  if (existing.rows[0]?.target_paused) return existing.rows[0].action_id;
  const replaced = await executor.query<{ action_id: string }>(
    `SELECT action_id FROM core.coverage_breaker_actions
     WHERE target_paused AND state IN ('REORGED','FAILED')
     ORDER BY updated_at DESC, action_id DESC LIMIT 1`,
  );
  const calldata = PAYMENT_ROUTER_BREAKER.encodeFunctionData(
    'setNewPaymentsPaused',
    [true, input.evidenceHash],
  ).toLowerCase();
  const policy = await executor.query<{ policy_version: string | number }>(
    `SELECT policy_version FROM core.policy_snapshots
     WHERE publication_status = 'PUBLISHED' ORDER BY policy_version DESC LIMIT 1`,
  );
  if (!policy.rows[0]) throw new CoreError('ExternalBlocked', 'Published policy is unavailable for breaker governance', 503);
  const actionId = hashJson({
    domain: 'ABU24K_COVERAGE_BREAKER_ACTION_V1',
    action: 'PAUSE',
    snapshotId: input.snapshotId,
    evidenceHash: input.evidenceHash,
    routerAddress: input.paymentRouterAddress,
    replacesActionId: replaced.rows[0]?.action_id ?? null,
  });
  await executor.query(
    `INSERT INTO core.coverage_breaker_actions (
       action_id, snapshot_id, policy_version, action, target_paused, evidence_hash,
       governance_wallet_address, router_address, calldata, calldata_hash,
       state, replaces_action_id, created_at, updated_at
     ) VALUES ($1,$2,$3,'PAUSE',true,$4,$5,$6,$7,$8,'PENDING_EXECUTION',$9,$10,$10)
     ON CONFLICT (action_id) DO NOTHING`,
    [
      actionId,
      input.snapshotId,
      policy.rows[0].policy_version,
      input.evidenceHash,
      input.governanceWalletAddress,
      input.paymentRouterAddress,
      calldata,
      keccak256(calldata).toLowerCase(),
      replaced.rows[0]?.action_id ?? null,
      input.at,
    ],
  );
  const transitionId = hashJson({ actionId, state: 'PENDING_EXECUTION' });
  await executor.query(
    `INSERT INTO core.coverage_breaker_action_transitions (
       transition_id, action_id, from_state, to_state, evidence, recorded_at
     ) VALUES ($1,$2,NULL,'PENDING_EXECUTION',$3,$4)
     ON CONFLICT (transition_id) DO NOTHING`,
    [transitionId, actionId, JSON.stringify({ snapshotId: input.snapshotId, evidenceHash: input.evidenceHash }), input.at],
  );
  return actionId;
}

function expectedAssets(input: readonly { walletAddress: string; asset: 'USDT' | 'NPL'; tokenAddress: string }[]) {
  const result = new Map<string, { walletAddress: string; asset: 'USDT' | 'NPL'; tokenAddress: string }>();
  for (const item of input) {
    const value = {
      walletAddress: address(item.walletAddress, 'coverage wallet'),
      asset: item.asset,
      tokenAddress: address(item.tokenAddress, 'coverage token'),
    };
    const key = `${value.walletAddress}:${value.asset}`;
    if (result.has(key)) throw new CoreError('ExternalBlocked', 'Duplicate coverage asset configuration', 503);
    result.set(key, value);
  }
  if (result.size === 0) throw new CoreError('ExternalBlocked', 'Coverage assets are not configured', 503);
  return result;
}

function validateObservation(value: CoverageObservation, expected: ExpectedCoverageAssets) {
  if (
    value.chainId !== 56
    || !Number.isSafeInteger(value.blockNumber)
    || value.blockNumber < 0
    || !isHash(value.blockHash)
    || !isHash(value.evidenceHash)
    || !Number.isFinite(new Date(value.observedAt).getTime())
    || value.assets.length !== expected.size
  ) throw new CoreError('InvalidFinality', 'Coverage observation is invalid');
  const seen = new Set<string>();
  const assets = value.assets.map((item) => {
    const walletAddress = address(item.walletAddress, 'coverage wallet');
    const tokenAddress = address(item.tokenAddress, 'coverage token');
    const key = `${walletAddress}:${item.asset}`;
    const configured = expected.get(key);
    if (
      !configured
      || configured.tokenAddress !== tokenAddress
      || !/^(0|[1-9][0-9]*)$/.test(item.balance)
      || seen.has(key)
    ) throw new CoreError('InvalidFinality', 'Coverage observation does not match configured assets');
    seen.add(key);
    return { ...item, walletAddress, tokenAddress };
  });
  return {
    ...value,
    blockHash: value.blockHash.toLowerCase(),
    evidenceHash: value.evidenceHash.toLowerCase(),
    observedAt: new Date(value.observedAt),
    assets: assets.sort((left, right) =>
      left.walletAddress.localeCompare(right.walletAddress) || left.asset.localeCompare(right.asset)),
  };
}

async function unsettledLiability(executor: SqlExecutor, walletAddress: string, asset: 'USDT' | 'NPL') {
  const result = await executor.query<{ amount: string }>(
    `SELECT COALESCE(sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END), 0)::text AS amount
     FROM core.ledger_lines line
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE line.backing_wallet_address = $1 AND account.asset = $2
       AND line.balance_state IN ('LOCKED','AVAILABLE','REQUESTED','SUBMITTED','DISPUTED')`,
    [walletAddress, asset],
  );
  const amount = result.rows[0]?.amount ?? '0';
  if (BigInt(amount) < 0n) throw new CoreError('InvalidFinality', 'Unsettled liability cannot be negative', 409);
  return amount;
}

async function appendCanonicality(
  executor: SqlExecutor,
  snapshotId: string,
  observation: Pick<CoverageObservation, 'canonical' | 'blockHash' | 'evidenceHash' | 'observedAt'>,
) {
  const observationId = hashJson({
    snapshotId,
    canonical: observation.canonical,
    observedBlockHash: observation.blockHash,
    evidenceHash: observation.evidenceHash,
  });
  await executor.query(
    `INSERT INTO core.coverage_snapshot_canonicality (
       observation_id, snapshot_id, canonical, observed_block_hash, evidence_hash, observed_at
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (observation_id) DO NOTHING`,
    [
      observationId,
      snapshotId,
      observation.canonical,
      observation.blockHash,
      observation.evidenceHash,
      observation.observedAt,
    ],
  );
}

async function activateCoverageBreaker(
  executor: SqlExecutor,
  causeId: string,
  evidenceHash: string,
  at: Date,
) {
  for (const scope of ['NEW_PAYMENT', 'NEW_SETTLEMENT_BATCH'] as const) {
    await executor.query(
      `INSERT INTO core.breaker_causes (
         scope, cause_type, cause_id, active, evidence_hash, updated_at
       ) VALUES ($1,'COVERAGE',$2,true,$3,$4)
       ON CONFLICT (scope, cause_type, cause_id) DO UPDATE
         SET active = true, evidence_hash = EXCLUDED.evidence_hash, updated_at = EXCLUDED.updated_at`,
      [scope, causeId, evidenceHash, at],
    );
    const eventId = hashJson({ scope, causeId, action: 'PAUSE', evidenceHash });
    await executor.query(
      `INSERT INTO core.breaker_events (
         breaker_event_id, scope, action, cause_type, cause_id,
         evidence_hash, policy_version, changed_by, changed_at
       ) VALUES ($1,$2,'PAUSE','COVERAGE',$3,$4,NULL,'COVERAGE_MONITOR',$5)
       ON CONFLICT (breaker_event_id) DO NOTHING`,
      [eventId, scope, causeId, evidenceHash, at],
    );
    await executor.query(
      `INSERT INTO core.circuit_breakers (
         scope, paused, evidence_hash, policy_version, changed_by, changed_at
       ) VALUES ($1,true,$2,NULL,'COVERAGE_MONITOR',$3)
       ON CONFLICT (scope) DO UPDATE SET paused = true, evidence_hash = EXCLUDED.evidence_hash,
         policy_version = NULL, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
      [scope, evidenceHash, at],
    );
  }
}

async function publishRecoveryPending(
  executor: SqlExecutor,
  causeId: string,
  snapshotId: string,
  evidenceHash: string,
  at: Date,
) {
  const active = await executor.query<{ scope: string }>(
    `SELECT scope FROM core.breaker_causes
     WHERE cause_type = 'COVERAGE' AND cause_id = $1 AND active ORDER BY scope`,
    [causeId],
  );
  if (active.rows.length === 0) return;
  const eventId = `outbox:coverage-recovery:${hashJson({ causeId, snapshotId }).slice(2)}`;
  await executor.query(
    `INSERT INTO core.outbox_events (
       event_id, aggregate_type, aggregate_id, event_type, payload,
       idempotency_key, state, available_at
     ) VALUES ($1,'COVERAGE',$2,'CoverageRecoveryAwaitingGovernance',$3,$1,'PENDING',$4)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [eventId, causeId, JSON.stringify({ causeId, snapshotId, evidenceHash }), at],
  );
}

function address(value: string, name: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', `${name} is invalid`);
  }
}

function hashJson(value: unknown) {
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

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
