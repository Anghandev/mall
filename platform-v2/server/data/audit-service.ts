import { createHash, randomUUID } from 'node:crypto';
import { CoreError } from '../api/errors.ts';
import {
  normalizeAuditEvidence,
  verifyAuditChain,
  type AuditInput,
  type AuditRow,
  type AuthorizationAuditEvidence,
  type SignatureAuditEvidence,
  type TransactionAuditEvidence,
} from './audit-chain.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor } from './migrations.ts';

export interface AuditOutboxInput {
  sourceEventId: string;
  streamName: AuditInput['streamName'];
  evidenceProfile: AuditInput['evidenceProfile'];
  eventType: string;
  resourceType: string;
  resourceId: string;
  merchantId?: string;
  actorWallet?: string;
  actorRole?: string;
  correlationId: string;
  requestHash: string;
  payload: Record<string, unknown>;
  authorizationEvidence?: AuthorizationAuditEvidence;
  signatureEvidence?: SignatureAuditEvidence;
  transactionEvidence?: TransactionAuditEvidence;
  createdAt: Date;
}

export async function enqueueAudit(executor: SqlExecutor, input: AuditOutboxInput) {
  validateAuditOutboxInput(input);
  const { authorizationEvidence, signatureEvidence, transactionEvidence } = normalizeAuditEvidence(input);
  const contentHash = hashJson({
    streamName: input.streamName,
    evidenceProfile: input.evidenceProfile,
    eventType: input.eventType,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    ...(input.merchantId ? { merchantId: input.merchantId } : {}),
    actorWallet: input.actorWallet ?? null,
    actorRole: input.actorRole ?? null,
    correlationId: input.correlationId,
    requestHash: input.requestHash,
    payload: input.payload,
    authorizationEvidence,
    signatureEvidence,
    transactionEvidence,
  });
  const existing = await executor.query<{ request_hash: string; payload: Record<string, unknown> }>(
    'SELECT request_hash, payload FROM core.audit_outbox_events WHERE source_event_id = $1',
    [input.sourceEventId],
  );
  if (existing.rows[0]) {
    const existingHash = String((existing.rows[0].payload as Record<string, unknown>)._contentHash ?? '');
    if (existing.rows[0].request_hash !== input.requestHash || existingHash !== contentHash) {
      throw new CoreError('IdempotencyConflict', 'Audit source event id was reused with different content', 409);
    }
    return { sourceEventId: input.sourceEventId, existing: true };
  }
  await executor.query(
    `INSERT INTO core.audit_outbox_events (
       source_event_id, stream_name, evidence_profile, event_type, resource_type, resource_id, merchant_id,
       actor_wallet, actor_role, correlation_id, request_hash, payload,
       authorization_evidence, signature_evidence, transaction_evidence,
       state, available_at, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'PENDING',$16,$16)`,
    [
      input.sourceEventId,
      input.streamName,
      input.evidenceProfile,
      input.eventType,
      input.resourceType,
      input.resourceId,
      input.merchantId ?? null,
      input.actorWallet ?? null,
      input.actorRole ?? null,
      input.correlationId,
      input.requestHash,
      JSON.stringify({ ...input.payload, _contentHash: contentHash }),
      JSON.stringify(authorizationEvidence),
      JSON.stringify(signatureEvidence),
      JSON.stringify(transactionEvidence),
      input.createdAt,
    ],
  );
  return { sourceEventId: input.sourceEventId, existing: false };
}

export interface AuditQuery {
  streamName?: AuditInput['streamName'];
  eventType?: string;
  resourceType?: string;
  resourceId?: string;
  merchantId?: string;
  actorWallet?: string;
  correlationId?: string;
  from?: Date;
  to?: Date;
  cursorCreatedAt?: Date;
  cursorEntryId?: string;
  limit?: number;
}

export class AuditQueryService {
  readonly #audit: SqlExecutor;

  constructor(audit: SqlExecutor) {
    this.#audit = audit;
  }

  async list(actor: FulfillmentActor, query: AuditQuery) {
    requireAuditRead(actor);
    validateQuery(query);
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (query.streamName) add('stream_name = ?', query.streamName);
    if (query.eventType) add('event_type = ?', query.eventType);
    if (query.resourceType) add('resource_type = ?', query.resourceType);
    if (query.resourceId) add('resource_id = ?', query.resourceId);
    if (query.merchantId) add('merchant_id = ?', query.merchantId);
    if (query.actorWallet) add('actor_wallet = ?', normalizedAddress(query.actorWallet));
    if (query.correlationId) add('correlation_id = ?', query.correlationId);
    if (query.from) add('created_at >= ?', query.from);
    if (query.to) add('created_at <= ?', query.to);
    if (query.cursorCreatedAt && query.cursorEntryId) {
      params.push(query.cursorCreatedAt, query.cursorEntryId);
      clauses.push(`(created_at, entry_id) < ($${params.length - 1}, $${params.length})`);
    }
    const limit = query.limit ?? 50;
    params.push(limit + 1);
    const result = await this.#audit.query<AuditRow>(
      `SELECT * FROM audit.entries
       ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY created_at DESC, entry_id DESC LIMIT $${params.length}`,
      params,
    );
    const hasMore = result.rows.length > limit;
    const entries = result.rows.slice(0, limit).map(publicAuditRow);
    const last = result.rows[Math.min(result.rows.length, limit) - 1];
    return {
      entries,
      chainProof: await this.chainProof(actor, query.streamName),
      nextCursor: hasMore && last
        ? { createdAt: new Date(last.created_at).toISOString(), entryId: last.entry_id }
        : null,
    };
  }

  async chainProof(actor: FulfillmentActor, streamName?: AuditInput['streamName']) {
    requireAuditRead(actor);
    const streams = streamName
      ? [streamName]
      : ['financial', 'governance', 'authentication', 'operational', 'backup'] as const;
    const proof: Record<string, { verified: boolean; entries: number; headHash: string | null }> = {};
    for (const stream of streams) {
      const rows = await this.#audit.query<AuditRow>(
        'SELECT * FROM audit.entries WHERE stream_name = $1 ORDER BY sequence',
        [stream],
      );
      proof[stream] = {
        verified: verifyAuditChain(rows.rows),
        entries: rows.rows.length,
        headHash: rows.rows.at(-1)?.entry_hash ?? null,
      };
    }
    return proof;
  }

  async listMerchant(actor: FulfillmentActor, query: Omit<AuditQuery, 'actorWallet' | 'merchantId'>) {
    const merchantId = requireMerchantAuditScope(actor);
    validateQuery(query);
    const result = await this.merchantRows(merchantId, query, query.limit ?? 50);
    const limit = query.limit ?? 50;
    const hasMore = result.length > limit;
    const rows = result.slice(0, limit);
    const last = rows.at(-1);
    return {
      entries: rows.map(publicMerchantAuditRow),
      proofScope: 'MERCHANT_SCOPED_ENTRY_HASHES' as const,
      historyStatus: 'PARTIAL_PRE_MERCHANT_SCOPE' as const,
      chainProof: {
        merchantId,
        entries: rows.length,
      },
      nextCursor: hasMore && last
        ? { createdAt: new Date(last.created_at).toISOString(), entryId: last.entry_id }
        : null,
    };
  }

  async exportMerchant(actor: FulfillmentActor, query: Omit<AuditQuery, 'actorWallet' | 'merchantId' | 'limit'>) {
    const merchantId = requireMerchantAuditScope(actor);
    validateMerchantExportQuery(query);
    const rows = await this.merchantRows(merchantId, query, 1_000);
    const entries = rows.map(publicMerchantAuditRow);
    return {
      merchantId,
      contentType: 'text/csv; charset=utf-8' as const,
      filename: `merchant-audit-${query.from!.toISOString().slice(0, 10)}-${query.to!.toISOString().slice(0, 10)}.csv`,
      entryCount: entries.length,
      csv: merchantAuditCsv(entries),
    };
  }

  private async merchantRows(
    merchantId: string,
    query: Omit<AuditQuery, 'actorWallet' | 'merchantId'>,
    limit: number,
  ) {
    const clauses = ['merchant_id = $1'];
    const params: unknown[] = [merchantId];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (query.streamName) add('stream_name = ?', query.streamName);
    if (query.eventType) add('event_type = ?', query.eventType);
    if (query.resourceType) add('resource_type = ?', query.resourceType);
    if (query.resourceId) add('resource_id = ?', query.resourceId);
    if (query.correlationId) add('correlation_id = ?', query.correlationId);
    if (query.from) add('created_at >= ?', query.from);
    if (query.to) add('created_at <= ?', query.to);
    if (query.cursorCreatedAt && query.cursorEntryId) {
      params.push(query.cursorCreatedAt, query.cursorEntryId);
      clauses.push(`(created_at, entry_id) < ($${params.length - 1}, $${params.length})`);
    }
    params.push(limit + 1);
    const result = await this.#audit.query<AuditRow>(
      `SELECT * FROM audit.entries WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, entry_id DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  }

}

export function auditSourceId(prefix: string, value: Record<string, unknown>) {
  return `${prefix}:${hashJson(value).slice(2)}`;
}

export function auditCorrelationId(value?: string) {
  return value && value.length <= 128 ? value : randomUUID();
}

function validateAuditOutboxInput(input: AuditOutboxInput) {
  if (!/^[A-Za-z0-9:_-]{8,256}$/.test(input.sourceEventId)) throw new Error('InvalidAuditSourceEventId');
  if (!/^[0-9a-f]{64}$/.test(input.requestHash)) throw new Error('InvalidAuditRequestHash');
  if (!input.correlationId || input.correlationId.length > 128) throw new Error('InvalidAuditCorrelationId');
}

function validateQuery(query: AuditQuery) {
  if ((query.cursorCreatedAt === undefined) !== (query.cursorEntryId === undefined)) {
    throw new CoreError('InvalidRequest', 'Audit cursor is incomplete');
  }
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200)) {
    throw new CoreError('InvalidRequest', 'Audit page limit must be between 1 and 200');
  }
  if (query.from && query.to && query.from > query.to) throw new CoreError('InvalidRequest', 'Audit time range is invalid');
}

function publicAuditRow(row: AuditRow) {
  return Object.freeze({
    entryId: row.entry_id,
    sourceEventId: row.source_event_id,
    streamName: row.stream_name,
    evidenceProfile: row.evidence_profile,
    sequence: String(row.sequence),
    eventType: row.event_type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    merchantId: row.merchant_id,
    actorWallet: row.actor_wallet,
    actorRole: row.actor_role,
    correlationId: row.correlation_id,
    requestHash: row.request_hash,
    payload: row.payload,
    signatureEvidence: row.signature_evidence,
    authorizationEvidence: row.authorization_evidence,
    transactionEvidence: row.transaction_evidence,
    previousHash: row.previous_hash,
    entryHash: row.entry_hash,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

function publicMerchantAuditRow(row: AuditRow) {
  const signatureHash = typeof row.signature_evidence.signatureHash === 'string'
    ? row.signature_evidence.signatureHash
    : null;
  const safeOrChainTxHash = typeof row.transaction_evidence.txHash === 'string'
    ? row.transaction_evidence.txHash
    : null;
  return Object.freeze({
    entryId: row.entry_id,
    operationTime: new Date(row.created_at).toISOString(),
    operationType: row.event_type,
    module: row.resource_type,
    detail: `${row.event_type} / ${row.resource_type} / ${row.resource_id}`,
    signatureHash,
    safeOrChainTxHash,
    entryHash: row.entry_hash,
  });
}

function requireAuditRead(actor: FulfillmentActor) {
  if (!actor.roles.some((role) => role === 'ADMIN' || role === 'AUDITOR')) {
    throw new CoreError('Forbidden', 'Audit records require ADMIN or AUDITOR role', 403);
  }
}

function requireMerchantAuditScope(actor: FulfillmentActor) {
  if (!actor.roles.includes('MERCHANT') || !actor.merchantId || !/^[A-Za-z0-9:_-]{1,128}$/.test(actor.merchantId)) {
    throw new CoreError('Forbidden', 'Merchant audit scope is unavailable', 403);
  }
  return actor.merchantId;
}

function validateMerchantExportQuery(query: Omit<AuditQuery, 'actorWallet' | 'merchantId' | 'limit'>) {
  validateQuery(query);
  if (!query.from || !query.to) throw new CoreError('InvalidRequest', 'Merchant audit export requires a bounded time range');
  if (query.to.getTime() - query.from.getTime() > 31 * 24 * 60 * 60 * 1_000) {
    throw new CoreError('InvalidRequest', 'Merchant audit export range cannot exceed 31 days');
  }
}

function merchantAuditCsv(entries: ReturnType<typeof publicMerchantAuditRow>[]) {
  const header = ['operationTime', 'operationType', 'module', 'detail', 'signatureHash', 'safeOrChainTxHash', 'entryHash'];
  const rows = entries.map((entry) => header.map((name) => csvCell(entry[name as keyof typeof entry])).join(','));
  return `\uFEFF${header.join(',')}\n${rows.join('\n')}${rows.length > 0 ? '\n' : ''}`;
}

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function normalizedAddress(value: string) {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new CoreError('InvalidRequest', 'Invalid audit wallet filter');
  return normalized;
}

function hashJson(value: unknown) {
  return `0x${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
