import { createHash, randomUUID } from 'node:crypto';
import type { SqlExecutor } from './migrations.ts';

const GENESIS_HASH = '0'.repeat(64);

export interface AuditInput {
  streamName: string;
  eventType: string;
  resourceType: string;
  resourceId: string;
  actorWallet?: string;
  actorRole?: string;
  correlationId: string;
  requestHash: string;
  payload: Record<string, unknown>;
  signatureEvidence?: Record<string, unknown>;
  transactionEvidence?: Record<string, unknown>;
  createdAt?: Date;
}

export interface AuditRow {
  entry_id: string;
  stream_name: string;
  sequence: string | number;
  event_type: string;
  resource_type: string;
  resource_id: string;
  actor_wallet: string | null;
  actor_role: string | null;
  correlation_id: string;
  request_hash: string;
  payload: Record<string, unknown>;
  signature_evidence: Record<string, unknown>;
  transaction_evidence: Record<string, unknown>;
  previous_hash: string;
  entry_hash: string;
  created_at: Date | string;
}

export async function appendAuditEntry(executor: SqlExecutor, input: AuditInput): Promise<AuditRow> {
  const redactedPayload = redact(input.payload) as Record<string, unknown>;
  const createdAt = input.createdAt ?? new Date();
  await executor.query(
    `INSERT INTO audit.stream_heads (stream_name, last_sequence, last_hash)
     VALUES ($1, 0, $2)
     ON CONFLICT (stream_name) DO NOTHING`,
    [input.streamName, GENESIS_HASH],
  );
  const headResult = await executor.query<{ last_sequence: string | number; last_hash: string }>(
    'SELECT last_sequence, last_hash FROM audit.stream_heads WHERE stream_name = $1 FOR UPDATE',
    [input.streamName],
  );
  const head = headResult.rows[0];
  if (!head) throw new Error('AuditHeadUnavailable');
  const sequence = Number(head.last_sequence) + 1;
  const entryId = randomUUID();
  const signatureEvidence = input.signatureEvidence ?? {};
  const transactionEvidence = input.transactionEvidence ?? {};
  const entryHash = hashAuditEntry({
    entryId,
    streamName: input.streamName,
    sequence,
    eventType: input.eventType,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    actorWallet: input.actorWallet ?? null,
    actorRole: input.actorRole ?? null,
    correlationId: input.correlationId,
    requestHash: input.requestHash,
    payload: redactedPayload,
    signatureEvidence,
    transactionEvidence,
    previousHash: head.last_hash,
    createdAt: createdAt.toISOString(),
  });
  const inserted = await executor.query<AuditRow>(
    `INSERT INTO audit.entries (
       entry_id, stream_name, sequence, event_type, resource_type, resource_id,
       actor_wallet, actor_role, correlation_id, request_hash, payload,
       signature_evidence, transaction_evidence, previous_hash, entry_hash, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    [
      entryId,
      input.streamName,
      sequence,
      input.eventType,
      input.resourceType,
      input.resourceId,
      input.actorWallet ?? null,
      input.actorRole ?? null,
      input.correlationId,
      input.requestHash,
      redactedPayload,
      signatureEvidence,
      transactionEvidence,
      head.last_hash,
      entryHash,
      createdAt,
    ],
  );
  await executor.query(
    `UPDATE audit.stream_heads
     SET last_sequence = $2, last_hash = $3, updated_at = clock_timestamp()
     WHERE stream_name = $1`,
    [input.streamName, sequence, entryHash],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('AuditAppendFailed');
  return row;
}

export function verifyAuditChain(rows: AuditRow[]) {
  let previousHash = GENESIS_HASH;
  let expectedSequence = 1;
  for (const row of rows) {
    const actual = hashAuditEntry({
      entryId: row.entry_id,
      streamName: row.stream_name,
      sequence: Number(row.sequence),
      eventType: row.event_type,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      actorWallet: row.actor_wallet,
      actorRole: row.actor_role,
      correlationId: row.correlation_id,
      requestHash: row.request_hash,
      payload: row.payload,
      signatureEvidence: row.signature_evidence,
      transactionEvidence: row.transaction_evidence,
      previousHash: row.previous_hash,
      createdAt: new Date(row.created_at).toISOString(),
    });
    if (Number(row.sequence) !== expectedSequence || row.previous_hash !== previousHash || row.entry_hash !== actual) {
      return false;
    }
    previousHash = row.entry_hash;
    expectedSequence += 1;
  }
  return true;
}

export function hashAuditEntry(value: Record<string, unknown>) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = /(authorization|cookie|password|secret|token|private|mnemonic|phone|legalName|legalId)/i.test(key)
      ? '[REDACTED]'
      : redact(child);
  }
  return output;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
