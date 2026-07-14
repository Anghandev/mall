import { createHash, randomUUID } from 'node:crypto';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

const GENESIS_HASH = '0'.repeat(64);

export const auditEvidenceProfiles = [
  'RBAC',
  'AUTHORIZATION',
  'SIGNED_OFFCHAIN',
  'SAFE_APPROVED',
  'CHAIN_OBSERVED',
  'CHAIN_FINAL',
  'SYSTEM',
] as const;
export type AuditEvidenceProfile = (typeof auditEvidenceProfiles)[number];

export interface AuditInput {
  sourceEventId?: string;
  streamName: 'financial' | 'governance' | 'authentication' | 'operational' | 'backup';
  evidenceProfile: AuditEvidenceProfile;
  eventType: string;
  resourceType: string;
  resourceId: string;
  actorWallet?: string;
  actorRole?: string;
  correlationId: string;
  requestHash: string;
  payload: Record<string, unknown>;
  authorizationEvidence?: AuthorizationAuditEvidence;
  signatureEvidence?: SignatureAuditEvidence;
  transactionEvidence?: TransactionAuditEvidence;
  createdAt?: Date;
}

export interface SignatureAuditEvidence {
  scheme: 'EIP712' | 'SIWE' | 'ERC1271' | 'SAFE_OWNER_SET';
  signatureHash: string;
  signer: string;
  digest: string;
  domain: string;
  nonce: string;
  deadline: string;
}

export interface AuthorizationAuditEvidence {
  scheme: 'RBAC_ROLE_REVALIDATION' | 'SESSION_RESOURCE_OWNERSHIP';
  subject: string;
  roles: string[];
  evidenceHash: string;
  checkedAt: string;
}

export interface TransactionAuditEvidence {
  txHash: string;
  chainId: 56;
  contractAddress: string;
  selector?: string;
  calldataHash?: string;
  eventSignatureHash?: string;
  logIndex?: number;
  resourceId: string;
  policyVersion?: number;
  policyVersions?: number[];
  blockHash?: string;
  confirmations?: number;
  replacementForTxHash?: string;
}

export interface AuditRow {
  entry_id: string;
  stream_name: string;
  evidence_profile: AuditEvidenceProfile;
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
  authorization_evidence: Record<string, unknown>;
  previous_hash: string;
  entry_hash: string;
  created_at: Date | string;
  source_event_id: string | null;
}

export async function appendAuditEntry(runner: SqlTransactionRunner, input: AuditInput): Promise<AuditRow> {
  return runner.transaction((executor) => appendAuditEntryInTransaction(executor, input));
}

async function appendAuditEntryInTransaction(executor: SqlExecutor, input: AuditInput): Promise<AuditRow> {
  const redactedPayload = redact(input.payload) as Record<string, unknown>;
  const createdAt = input.createdAt ?? new Date();
  const { authorizationEvidence, signatureEvidence, transactionEvidence } = normalizeAuditEvidence(input);
  if (input.sourceEventId) {
    const existing = await executor.query<AuditRow>(
      'SELECT * FROM audit.entries WHERE source_event_id = $1',
      [input.sourceEventId],
    );
    if (existing.rows[0]) {
      assertSameSource(existing.rows[0], input, redactedPayload, authorizationEvidence, signatureEvidence, transactionEvidence);
      return existing.rows[0];
    }
  }
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
  const entryHash = hashAuditEntry({
    entryId,
    sourceEventId: input.sourceEventId ?? null,
    streamName: input.streamName,
    evidenceProfile: input.evidenceProfile,
    sequence,
    eventType: input.eventType,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    actorWallet: input.actorWallet ?? null,
    actorRole: input.actorRole ?? null,
    correlationId: input.correlationId,
    requestHash: input.requestHash,
    payload: redactedPayload,
    authorizationEvidence,
    signatureEvidence,
    transactionEvidence,
    previousHash: head.last_hash,
    createdAt: createdAt.toISOString(),
  });
  const inserted = await executor.query<AuditRow>(
    `INSERT INTO audit.entries (
       entry_id, stream_name, evidence_profile, sequence, event_type, resource_type, resource_id,
       actor_wallet, actor_role, correlation_id, request_hash, payload,
       authorization_evidence, signature_evidence, transaction_evidence,
       previous_hash, entry_hash, created_at, source_event_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING *`,
    [
      entryId,
      input.streamName,
      input.evidenceProfile,
      sequence,
      input.eventType,
      input.resourceType,
      input.resourceId,
      input.actorWallet ?? null,
      input.actorRole ?? null,
      input.correlationId,
      input.requestHash,
      redactedPayload,
      authorizationEvidence,
      signatureEvidence,
      transactionEvidence,
      head.last_hash,
      entryHash,
      createdAt,
      input.sourceEventId ?? null,
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

export function normalizeAuditEvidence(input: Pick<
  AuditInput,
  | 'streamName'
  | 'evidenceProfile'
  | 'payload'
  | 'authorizationEvidence'
  | 'signatureEvidence'
  | 'transactionEvidence'
>) {
  const authorizationEvidence = sanitizeAuthorizationEvidence(input.authorizationEvidence);
  const signatureEvidence = sanitizeSignatureEvidence(input.signatureEvidence);
  const transactionEvidence = sanitizeTransactionEvidence(input.transactionEvidence);
  assertRequiredEvidence(input, authorizationEvidence, signatureEvidence, transactionEvidence);
  return { authorizationEvidence, signatureEvidence, transactionEvidence };
}

export function verifyAuditChain(rows: AuditRow[]) {
  let previousHash = GENESIS_HASH;
  let expectedSequence = 1;
  for (const row of rows) {
    const actual = hashAuditEntry({
      entryId: row.entry_id,
      sourceEventId: row.source_event_id,
      streamName: row.stream_name,
      evidenceProfile: row.evidence_profile,
      sequence: Number(row.sequence),
      eventType: row.event_type,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      actorWallet: row.actor_wallet,
      actorRole: row.actor_role,
      correlationId: row.correlation_id,
      requestHash: row.request_hash,
      payload: row.payload,
      authorizationEvidence: row.authorization_evidence,
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

function assertSameSource(
  row: AuditRow,
  input: AuditInput,
  payload: Record<string, unknown>,
  authorizationEvidence: Record<string, unknown>,
  signatureEvidence: Record<string, unknown>,
  transactionEvidence: Record<string, unknown>,
) {
  if (
    row.stream_name !== input.streamName
    || row.evidence_profile !== input.evidenceProfile
    || row.event_type !== input.eventType
    || row.resource_type !== input.resourceType
    || row.resource_id !== input.resourceId
    || row.actor_wallet !== (input.actorWallet ?? null)
    || row.actor_role !== (input.actorRole ?? null)
    || row.correlation_id !== input.correlationId
    || row.request_hash !== input.requestHash
    || canonicalJson(row.payload) !== canonicalJson(payload)
    || canonicalJson(row.authorization_evidence) !== canonicalJson(authorizationEvidence)
    || canonicalJson(row.signature_evidence) !== canonicalJson(signatureEvidence)
    || canonicalJson(row.transaction_evidence) !== canonicalJson(transactionEvidence)
  ) throw new Error('AuditSourceConflict');
}

function sanitizeAuthorizationEvidence(evidence: AuthorizationAuditEvidence | undefined): Record<string, unknown> {
  if (!evidence) return {};
  assertAllowedKeys(evidence, ['scheme', 'subject', 'roles', 'evidenceHash', 'checkedAt']);
  const subject = evidence.subject.toLowerCase();
  const roles = [...evidence.roles].sort();
  if (
    !['RBAC_ROLE_REVALIDATION', 'SESSION_RESOURCE_OWNERSHIP'].includes(evidence.scheme)
    || !isAddress(subject)
    || roles.length === 0
    || roles.some((role, index) => !/^[A-Z_]{2,32}$/.test(role) || role === roles[index - 1])
    || !isHash(evidence.evidenceHash)
    || Number.isNaN(new Date(evidence.checkedAt).getTime())
  ) throw new Error('InvalidAuthorizationAuditEvidence');
  return { ...evidence, subject, roles, checkedAt: new Date(evidence.checkedAt).toISOString() };
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
  return /^(?:authorization|auth|bearer|cookie|setcookie|password|passphrase|secret|credential|apikey|accesskey(?:id|secret)?|ukey|(?:api|access|refresh|session)?token|privatekey|mnemonic|seed|seedphrase|signature|rawsignature|rawtransaction|signedtransaction|calldata|transactiondata|phone|email|legalname|legalid|shippingaddress|billingaddress|deliveryaddress|streetaddress|recipientname|contactname)$/.test(
    normalized,
  );
}

function sanitizeSignatureEvidence(evidence: SignatureAuditEvidence | undefined): Record<string, unknown> {
  if (!evidence) return {};
  assertAllowedKeys(evidence, ['scheme', 'signatureHash', 'signer', 'digest', 'domain', 'nonce', 'deadline']);
  if (
    !['EIP712', 'SIWE', 'ERC1271', 'SAFE_OWNER_SET'].includes(evidence.scheme) ||
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
    'eventSignatureHash',
    'logIndex',
    'resourceId',
    'policyVersion',
    'policyVersions',
    'blockHash',
    'confirmations',
    'replacementForTxHash',
  ]);
  if (
    !isHash(evidence.txHash) ||
    evidence.chainId !== 56 ||
    !isAddress(evidence.contractAddress) ||
    !validTransactionLocator(evidence) ||
    typeof evidence.resourceId !== 'string' ||
    evidence.resourceId.length === 0 ||
    evidence.resourceId.length > 256 ||
    !validPolicyVersions(evidence) ||
    (evidence.blockHash !== undefined && !isHash(evidence.blockHash)) ||
    (evidence.confirmations !== undefined &&
      (!Number.isSafeInteger(evidence.confirmations) || evidence.confirmations < 0)) ||
    (evidence.replacementForTxHash !== undefined && !isHash(evidence.replacementForTxHash))
  ) {
    throw new Error('InvalidTransactionAuditEvidence');
  }
  return {
    ...evidence,
    contractAddress: evidence.contractAddress.toLowerCase(),
    ...(evidence.policyVersions ? { policyVersions: [...evidence.policyVersions].sort((left, right) => left - right) } : {}),
  };
}

function validTransactionLocator(evidence: TransactionAuditEvidence) {
  const hasCall = evidence.selector !== undefined || evidence.calldataHash !== undefined;
  const hasEvent = evidence.eventSignatureHash !== undefined || evidence.logIndex !== undefined;
  if (hasCall === hasEvent) return false;
  if (hasCall) {
    return typeof evidence.selector === 'string'
      && /^0x[0-9a-fA-F]{8}$/.test(evidence.selector)
      && isHash(evidence.calldataHash);
  }
  return isHash(evidence.eventSignatureHash)
    && Number.isSafeInteger(evidence.logIndex)
    && Number(evidence.logIndex) >= 0;
}

function validPolicyVersions(evidence: TransactionAuditEvidence) {
  const single = evidence.policyVersion;
  const multiple = evidence.policyVersions;
  if ((single === undefined) === (multiple === undefined)) return false;
  if (single !== undefined) return Number.isSafeInteger(single) && single > 0;
  return Array.isArray(multiple)
    && multiple.length > 0
    && multiple.length <= 256
    && multiple.every((value, index) =>
      Number.isSafeInteger(value) && value > 0 && (index === 0 || value > multiple[index - 1]!));
}

function assertRequiredEvidence(
  input: Pick<AuditInput, 'streamName' | 'evidenceProfile' | 'payload'>,
  authorizationEvidence: Record<string, unknown>,
  signatureEvidence: Record<string, unknown>,
  transactionEvidence: Record<string, unknown>,
) {
  if (!['financial', 'governance', 'authentication', 'operational', 'backup'].includes(input.streamName)) {
    throw new Error('UnknownAuditStream');
  }
  if (!auditEvidenceProfiles.includes(input.evidenceProfile)) throw new Error('UnknownAuditEvidenceProfile');
  const hasSignature = Object.keys(signatureEvidence).length > 0;
  const hasTransaction = Object.keys(transactionEvidence).length > 0;
  const hasAuthorization = Object.keys(authorizationEvidence).length > 0;
  if (input.evidenceProfile === 'RBAC' && (!hasAuthorization || hasTransaction)) throw new Error('InvalidRbacAuditEvidence');
  if (input.evidenceProfile === 'AUTHORIZATION' && (!hasAuthorization || hasTransaction)) {
    throw new Error('InvalidAuthorizationAuditEvidence');
  }
  if (input.evidenceProfile === 'SIGNED_OFFCHAIN' && (!hasSignature || hasTransaction)) {
    throw new Error('InvalidSignedOffchainAuditEvidence');
  }
  if (input.evidenceProfile === 'SAFE_APPROVED' && (!hasSignature || hasTransaction)) {
    throw new Error('InvalidSafeApprovedAuditEvidence');
  }
  if (input.evidenceProfile === 'CHAIN_OBSERVED' && !hasTransaction) throw new Error('MissingChainAuditEvidence');
  if (input.evidenceProfile === 'CHAIN_FINAL') {
    const confirmations = transactionEvidence.confirmations;
    if (!hasTransaction || !isHash(transactionEvidence.blockHash)
        || !Number.isSafeInteger(confirmations) || Number(confirmations) < 15) {
      throw new Error('MissingFinalChainAuditEvidence');
    }
  }
  if (input.evidenceProfile === 'SYSTEM') {
    if (hasAuthorization || hasSignature || hasTransaction || !isHash(input.payload.evidenceHash)) {
      throw new Error('InvalidSystemAuditEvidence');
    }
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
