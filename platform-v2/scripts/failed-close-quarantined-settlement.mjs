#!/usr/bin/env node
import { createPostgresPool, postgresTransactionRunner } from '../server/data/connections.ts';
import { SettlementService } from '../server/data/settlement-service.ts';

const requestId = option('--request-id');
const reasonCode = option('--reason-code');
const evidenceHash = option('--evidence-hash');
const idempotencyKey = option('--idempotency-key');
const actorWallet = option('--actor-wallet') ?? process.env.FAILED_CLOSE_ACTOR_WALLET;
const actorRole = (option('--actor-role') ?? process.env.FAILED_CLOSE_ACTOR_ROLE ?? 'OPERATOR').toUpperCase();
const databaseUrl = process.env.DATABASE_URL;

if (!requestId || !reasonCode || !evidenceHash || !idempotencyKey || !actorWallet) {
  throw new Error(
    'usage: failed-close-quarantined-settlement --request-id <0x...> --reason-code <CODE>'
    + ' --evidence-hash <0x...> --idempotency-key <key> --actor-wallet <0x...> [--actor-role ADMIN|OPERATOR]',
  );
}
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!['ADMIN', 'OPERATOR'].includes(actorRole)) throw new Error('actor role must be ADMIN or OPERATOR');

const pool = createPostgresPool(databaseUrl);
try {
  const service = new SettlementService({ transactions: postgresTransactionRunner(pool) });
  const result = await service.failedCloseUnbroadcastQuarantinedRequest(
    { walletAddress: actorWallet, roles: [actorRole] },
    { requestId, reasonCode, evidenceHash, idempotencyKey },
  );
  console.log(JSON.stringify({
    artifactVersion: result.artifactVersion,
    requestId: result.request.requestId,
    rail: result.request.rail,
    asset: result.request.asset,
    amount: result.request.amount,
    state: result.request.state,
    transferIds: result.request.transferIds,
    finalExecutionTxHashes: result.request.finalExecutionTxHashes,
  }, null, 2));
} finally {
  await pool.end();
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
