import { createHash, randomUUID } from 'node:crypto';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

const GENESIS_HASH = '0'.repeat(64);

export interface AuditInput {
  streamName: 'financial' | 'governance' | 'authentication' | 'operational' | 'backup';
  eventType: string;
  resourceType: string;
  resourceId: string;
  actorWallet?: string;
  actorRole?: string;
  correlationId: string;
  requestHash: string;
  payload: Record<string, unknown>;
  signatureEvidence?: SignatureAuditEvidence;
  transactionEvidence?: TransactionAuditEvidence;
  createdAt?: Date;
}

export interface SignatureAuditEvidence {
  scheme: 'EIP712' | 'SIWE' | 'ERC1271';
  signatureHash: string;
  signer: string;
  digest: string;
  domain: string;
  nonce: string;
  deadline: string;
}

export interface TransactionAuditEvidence {
  txHash: string;
  chainId: 56;
  contractAddress: string;
  selector: string;
  calldataHash: string;
  resourceId: string;
  policyVersion: number;
  blockHash?: string;
  confirmations?: number;
  replacementForTxHash?: string;
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

export async function appendAuditEntry(runner: SqlTransactionRunner, input: AuditInput): Promise<AuditRow> {
  return runner.transaction((executor) => appendAuditEntryInTransaction(executor, input));
}

async function appendAuditEntryInTransaction(executor: SqlExecutor, input: AuditInput): Promise<AuditRow> {
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
  const signatureEvidence = sanitizeSignatureEvidence(input.signatureEvidence);
  const transactionEvidence = sanitizeTransactionEvidence(input.transactionEvidence);
  assertRequiredEvidence(input, signatureEvidence, transactionEvidence);
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
    output[key] = isSensitiveField(key)
      ? '[REDACTED]'
      : redact(child);
  }
  return output;
}

function isSensitiveField(key: string) {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (/(?:hash|digest)$/.test(normalized)) return false;
  return /^(?:authorization|auth|bearer|cookie|setcookie|password|passphrase|secret|credential|apikey|accesskey(?:id|secret)?|ukey|token|accesstoken|refreshtoken|sessiontoken|privatekey|mnemonic|seed|seedphrase|signature|rawsignature|rawtransaction|signedtransaction|calldata|transactiondata|phone|email|legalname|legalid|shippingaddress|billingaddress|deliveryaddress|streetaddress|recipientname|contactname)$/.test(
    normalized,
  );
}

function sanitizeSignatureEvidence(evidence: SignatureAuditEvidence | undefined): Record<string, unknown> {
  if (!evidence) return {};
  assertAllowedKeys(evidence, ['scheme', 'signatureHash', 'signer', 'digest', 'domain', 'nonce', 'deadline']);
  if (
    !['EIP712', 'SIWE', 'ERC1271'].includes(evidence.scheme) ||
    !isHash(evidence.signatureHash) ||
    !isAddress(evidence.signer) ||
    !isHash(evidence.digest) ||
    typeof evidence.domain !== 'string' ||
    evidence.domain.length === 0 ||
    evidence.domain.length > 256 ||
    !isUint(evidence.nonce) ||
    !isUint(evidence.deadline)
  ) {
    throw new Error('InvalidSignatureAuditEvidence');
  }
  return { ...evidence, signer: evidence.signer.toLowerCase() };
}

function sanitizeTransactionEvidence(evidence: TransactionAuditEvidence | undefined): Record<string, unknown> {
  if (!evidence) return {};
  assertAllowedKeys(evidence, [
    'txHash',
    'chainId',
    'contractAddress',
    'selector',
    'calldataHash',
    'resourceId',
    'policyVersion',
    'blockHash',
    'confirmations',
    'replacementForTxHash',
  ]);
  if (
    !isHash(evidence.txHash) ||
    evidence.chainId !== 56 ||
    !isAddress(evidence.contractAddress) ||
    !/^0x[0-9a-fA-F]{8}$/.test(evidence.selector) ||
    !isHash(evidence.calldataHash) ||
    typeof evidence.resourceId !== 'string' ||
    evidence.resourceId.length === 0 ||
    evidence.resourceId.length > 256 ||
    !Number.isSafeInteger(evidence.policyVersion) ||
    evidence.policyVersion <= 0 ||
    (evidence.blockHash !== undefined && !isHash(evidence.blockHash)) ||
    (evidence.confirmations !== undefined &&
      (!Number.isSafeInteger(evidence.confirmations) || evidence.confirmations < 0)) ||
    (evidence.replacementForTxHash !== undefined && !isHash(evidence.replacementForTxHash))
  ) {
    throw new Error('InvalidTransactionAuditEvidence');
  }
  return { ...evidence, contractAddress: evidence.contractAddress.toLowerCase() };
}

function assertRequiredEvidence(
  input: AuditInput,
  signatureEvidence: Record<string, unknown>,
  transactionEvidence: Record<string, unknown>,
) {
  if (!['financial', 'governance', 'authentication', 'operational', 'backup'].includes(input.streamName)) {
    throw new Error('UnknownAuditStream');
  }
  const hasSignature = Object.keys(signatureEvidence).length > 0;
  const hasTransaction = Object.keys(transactionEvidence).length > 0;
  if ((input.streamName === 'financial' || input.streamName === 'governance') && (!hasSignature || !hasTransaction)) {
    throw new Error('MissingSensitiveAuditEvidence');
  }
  if (input.streamName === 'authentication' && !hasSignature) throw new Error('MissingAuthenticationAuditEvidence');
  if (input.streamName === 'operational' && !hasSignature && !hasTransaction) throw new Error('MissingAuditEvidence');
  if (input.streamName === 'backup' && input.eventType !== 'BackupEvidence' && !hasSignature && !hasTransaction) {
    throw new Error('MissingAuditEvidence');
  }
}

function assertAllowedKeys(value: object, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('UnknownAuditEvidenceField');
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isUint(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value);
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
