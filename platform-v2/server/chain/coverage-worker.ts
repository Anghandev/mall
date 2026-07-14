import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { CoreError } from '../api/errors.ts';
import type { SqlExecutor, SqlTransactionRunner } from '../data/migrations.ts';

export interface CoverageAssetObservation {
  safeAddress: string;
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
  { safeAddress: string; asset: 'USDT' | 'NPL'; tokenAddress: string }
>;

export class CoverageWorker {
  readonly #transactions: SqlTransactionRunner;
  readonly #source: CoverageSource;
  readonly #expected: ExpectedCoverageAssets;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;
  #running = false;

  constructor(input: {
    transactions: SqlTransactionRunner;
    source: CoverageSource;
    expectedAssets: readonly { safeAddress: string; asset: 'USDT' | 'NPL'; tokenAddress: string }[];
  }) {
    this.#transactions = input.transactions;
    this.#source = input.source;
    this.#expected = expectedAssets(input.expectedAssets);
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
    return this.#transactions.transaction(async (executor) => {
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
        const liability = await unsettledLiability(executor, asset.safeAddress, asset.asset);
        const assetCoverageMet = BigInt(asset.balance) >= BigInt(liability);
        await executor.query(
          `INSERT INTO core.coverage_snapshot_items (
             snapshot_id, safe_address, asset, verified_asset_balance,
             unsettled_liability, coverage_met
           ) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (snapshot_id, safe_address, asset) DO NOTHING`,
          [snapshotId, asset.safeAddress, asset.asset, asset.balance, liability, assetCoverageMet],
        );
        results.push({
          ...asset,
          unsettledLiability: liability,
          coverageMet: observed.canonical && assetCoverageMet,
        });
      }
      await appendCanonicality(executor, snapshotId, observed);
      for (const item of results) {
        const causeId = `coverage:${item.safeAddress}:${item.asset}`;
        if (!item.coverageMet) {
          await activateCoverageBreaker(executor, causeId, observed.evidenceHash, observed.observedAt);
        } else {
          await publishRecoveryPending(executor, causeId, snapshotId, observed.evidenceHash, observed.observedAt);
        }
      }
      return { snapshotId, canonical: observed.canonical, assets: results };
    });
  }

  recordCanonicality(input: {
    snapshotId: string;
    canonical: boolean;
    observedBlockHash: string;
    evidenceHash: string;
    observedAt: Date;
  }) {
    if (!isHash(input.snapshotId) || !isHash(input.observedBlockHash) || !isHash(input.evidenceHash)) {
      throw new CoreError('InvalidFinality', 'Coverage canonicality evidence is invalid');
    }
    return this.#transactions.transaction(async (executor) => {
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
        const assets = await executor.query<{ safe_address: string; asset: string }>(
          `SELECT safe_address, asset FROM core.coverage_snapshot_items
           WHERE snapshot_id = $1 ORDER BY safe_address, asset`,
          [input.snapshotId],
        );
        for (const asset of assets.rows) {
          await activateCoverageBreaker(
            executor,
            `coverage:${asset.safe_address}:${asset.asset}`,
            input.evidenceHash,
            input.observedAt,
          );
        }
      }
      return { snapshotId: input.snapshotId, canonical: input.canonical };
    });
  }
}

function expectedAssets(input: readonly { safeAddress: string; asset: 'USDT' | 'NPL'; tokenAddress: string }[]) {
  const result = new Map<string, { safeAddress: string; asset: 'USDT' | 'NPL'; tokenAddress: string }>();
  for (const item of input) {
    const value = {
      safeAddress: address(item.safeAddress, 'coverage Safe'),
      asset: item.asset,
      tokenAddress: address(item.tokenAddress, 'coverage token'),
    };
    const key = `${value.safeAddress}:${value.asset}`;
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
    const safeAddress = address(item.safeAddress, 'coverage Safe');
    const tokenAddress = address(item.tokenAddress, 'coverage token');
    const key = `${safeAddress}:${item.asset}`;
    const configured = expected.get(key);
    if (
      !configured
      || configured.tokenAddress !== tokenAddress
      || !/^(0|[1-9][0-9]*)$/.test(item.balance)
      || seen.has(key)
    ) throw new CoreError('InvalidFinality', 'Coverage observation does not match configured assets');
    seen.add(key);
    return { ...item, safeAddress, tokenAddress };
  });
  return {
    ...value,
    blockHash: value.blockHash.toLowerCase(),
    evidenceHash: value.evidenceHash.toLowerCase(),
    observedAt: new Date(value.observedAt),
    assets: assets.sort((left, right) =>
      left.safeAddress.localeCompare(right.safeAddress) || left.asset.localeCompare(right.asset)),
  };
}

async function unsettledLiability(executor: SqlExecutor, safeAddress: string, asset: 'USDT' | 'NPL') {
  const result = await executor.query<{ amount: string }>(
    `SELECT COALESCE(sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END), 0)::text AS amount
     FROM core.ledger_lines line
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE line.backing_safe_address = $1 AND account.asset = $2
       AND line.balance_state IN ('LOCKED','AVAILABLE','REQUESTED','BATCHED','DISPUTED')`,
    [safeAddress, asset],
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
