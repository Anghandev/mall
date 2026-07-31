import { randomUUID } from 'node:crypto';
import { keccak256, toUtf8Bytes } from 'ethers';
import { normalizeAddress } from '../api/auth.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

const CONTENT_TYPES = [
  'BANNER',
  'RECOMMENDATION',
  'SPLASH',
  'CAMPAIGN_POPUP',
  'SECKILL_RULES',
  'FAQ',
  'SERVICE_AGREEMENT',
  'PRIVACY',
  'ABOUT',
  'RELEASE_ANNOUNCEMENT',
  'UPDATE_NOTICE',
  'CONTRACT_NOTICE',
] as const;

type ContentType = (typeof CONTENT_TYPES)[number];

interface CmsVersionRow {
  version_id: string;
  entry_id: string;
  version: number;
  locale: string;
  content_format: 'STRUCTURED_RICH_TEXT' | 'STRUCTURED_CAMPAIGN';
  source_content: Record<string, unknown>;
  sanitized_content: Record<string, unknown>;
  content_hash: string;
  audience: CmsAudience;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  frequency_cap: number | null;
  policy_version: number | string | null;
  idempotency_key: string;
  request_hash: string;
  created_by: string;
  created_at: Date | string;
}

type CmsAudience =
  | { type: 'ALL' }
  | { type: 'REGION'; regionCodes: string[] }
  | { type: 'MERCHANT'; merchantIds: string[] }
  | { type: 'WALLET'; wallets: string[] };

export class CmsService {
  readonly #transactions: SqlTransactionRunner;
  readonly #clock: () => Date;

  constructor(input: { transactions: SqlTransactionRunner; clock?: () => Date }) {
    this.#transactions = input.transactions;
    this.#clock = input.clock ?? (() => new Date());
  }

  createVersion(actor: FulfillmentActor, input: {
    entryId?: string;
    slug: string;
    contentType: ContentType;
    placement: string;
    locale: string;
    contentFormat: 'STRUCTURED_RICH_TEXT' | 'STRUCTURED_CAMPAIGN';
    content: unknown;
    audience: unknown;
    startsAt?: string;
    endsAt?: string;
    frequencyCap?: number;
    policyVersion?: string;
    idempotencyKey: string;
    correlationId: string;
  }) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR');
    const wallet = normalizeAddress(actor.walletAddress);
    validateCreateInput(input);
    const sanitizedContent = sanitizeStructuredContent(input.content);
    const audience = cmsAudience(input.audience);
    const contentHash = hashContent(sanitizedContent);
    const startsAt = optionalDate(input.startsAt, 'CMS startsAt');
    const endsAt = optionalDate(input.endsAt, 'CMS endsAt');
    if (endsAt && (!startsAt || endsAt <= startsAt)) throw new CoreError('InvalidRequest', 'CMS schedule is invalid');
    const policyVersion = input.policyVersion === undefined ? null : positiveInteger(input.policyVersion, 'CMS policyVersion');
    const requestHash = hashJson({
      wallet,
      ...input,
      content: sanitizedContent,
      audience,
      policyVersion,
    });
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN', 'OPERATOR']);
      const existing = await executor.query<CmsVersionRow>(
        'SELECT * FROM core.cms_versions WHERE created_by = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new CoreError('IdempotencyConflict', 'CMS version idempotency conflict', 409);
        }
        return versionProjection(executor, existing.rows[0]);
      }
      const entryId = input.entryId ?? `cms-entry:${randomUUID()}`;
      const entry = await executor.query<{
        entry_id: string;
        slug: string;
        content_type: ContentType;
        placement: string;
      }>('SELECT * FROM core.cms_entries WHERE entry_id = $1 OR slug = $2 FOR UPDATE', [entryId, input.slug]);
      if (entry.rows[0]) {
        if (
          entry.rows[0].entry_id !== entryId
          || entry.rows[0].slug !== input.slug
          || entry.rows[0].content_type !== input.contentType
          || entry.rows[0].placement !== input.placement
        ) throw new CoreError('IdempotencyConflict', 'CMS entry identity conflicts with immutable metadata', 409);
      } else {
        await executor.query(
          `INSERT INTO core.cms_entries (
             entry_id, slug, content_type, placement, created_by, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [entryId, input.slug, input.contentType, input.placement, wallet, this.#clock()],
        );
      }
      const next = await executor.query<{ version: number }>(
        'SELECT COALESCE(max(version), 0)::integer + 1 AS version FROM core.cms_versions WHERE entry_id = $1',
        [entryId],
      );
      const version = Number(next.rows[0]?.version ?? 1);
      const versionId = `cms-version:${randomUUID()}`;
      const now = this.#clock();
      await executor.query(
        `INSERT INTO core.cms_versions (
           version_id, entry_id, version, locale, content_format, source_content,
           sanitized_content, content_hash, audience, starts_at, ends_at,
           frequency_cap, policy_version, idempotency_key, request_hash,
           created_by, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          versionId,
          entryId,
          version,
          input.locale,
          input.contentFormat,
          JSON.stringify(input.content),
          JSON.stringify(sanitizedContent),
          contentHash,
          JSON.stringify(audience),
          startsAt,
          endsAt,
          input.frequencyCap ?? null,
          policyVersion,
          input.idempotencyKey,
          requestHash,
          wallet,
          now,
        ],
      );
      await enqueueOperationalAudit(executor, {
        eventType: 'CmsVersionCreated',
        resourceType: 'CMS_VERSION',
        resourceId: versionId,
        actorWallet: wallet,
        roles,
        correlationId: input.correlationId,
        requestHash,
        payload: { entryId, version, contentHash, audience, policyVersion },
        now,
      });
      return this.getVersionInTransaction(executor, versionId);
    });
  }

  publish(actor: FulfillmentActor, versionId: string, input: { evidenceHash: string; correlationId: string }) {
    return this.recordPublication(actor, versionId, 'PUBLISHED', input);
  }

  rollback(actor: FulfillmentActor, versionId: string, input: { evidenceHash: string; correlationId: string }) {
    return this.recordPublication(actor, versionId, 'ROLLED_BACK', input);
  }

  getVersion(actor: FulfillmentActor, versionId: string) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, normalizeAddress(actor.walletAddress), ['ADMIN', 'OPERATOR', 'AUDITOR']);
      return this.getVersionInTransaction(executor, versionId);
    });
  }

  listPublished(context: { actor?: FulfillmentActor; now?: Date } = {}) {
    const now = context.now ?? this.#clock();
    return this.#transactions.transaction(async (executor) => {
      const audienceContext = await publishedAudienceContext(executor, context.actor, now);
      const result = await executor.query<CmsVersionRow & {
        slug: string;
        content_type: ContentType;
        placement: string;
        event_type: string;
        active_version_id: string;
      }>(
        `SELECT publication.*, entry.slug, entry.content_type, entry.placement,
           version.source_content, version.created_by, version.created_at,
           version.idempotency_key, version.request_hash, version.entry_id, version.version_id
         FROM core.current_cms_publications publication
         JOIN core.cms_entries entry ON entry.entry_id = publication.entry_id
         JOIN core.cms_versions version ON version.version_id = publication.active_version_id
         WHERE (publication.starts_at IS NULL OR publication.starts_at <= $1)
           AND (publication.ends_at IS NULL OR publication.ends_at > $1)
         ORDER BY entry.placement, entry.slug`,
        [now],
      );
      return result.rows
        .filter((row) => audienceMatches(row.audience, audienceContext))
        .map((row) => Object.freeze({
          entryId: row.entry_id,
          versionId: row.active_version_id,
          version: row.version,
          slug: row.slug,
          contentType: row.content_type,
          placement: row.placement,
          locale: row.locale,
          content: row.sanitized_content,
          contentHash: row.content_hash,
          audience: Object.freeze({ type: row.audience.type }),
          startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
          endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
          frequencyCap: row.frequency_cap,
          policyVersion: row.policy_version === null ? null : String(row.policy_version),
        }));
    });
  }

  private recordPublication(
    actor: FulfillmentActor,
    versionId: string,
    eventType: 'PUBLISHED' | 'ROLLED_BACK',
    input: { evidenceHash: string; correlationId: string },
  ) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR');
    const wallet = normalizeAddress(actor.walletAddress);
    if (!isHash(input.evidenceHash)) throw new CoreError('InvalidRequest', 'CMS publication evidence hash is invalid');
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN', 'OPERATOR']);
      const version = await loadVersion(executor, versionId);
      const entry = await executor.query<{ content_type: ContentType }>(
        'SELECT content_type FROM core.cms_entries WHERE entry_id = $1',
        [version.entry_id],
      );
      if (!entry.rows[0]) throw new CoreError('InvalidRequest', 'CMS entry not found', 404);
      if (eventType === 'ROLLED_BACK') {
        const publishedBefore = await executor.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM core.cms_publication_events WHERE active_version_id = $1',
          [versionId],
        );
        if (publishedBefore.rows[0]?.count === '0') {
          throw new CoreError('InvalidRequest', 'CMS rollback target was never published', 409);
        }
      }
      if (entry.rows[0].content_type === 'SECKILL_RULES') await assertRulesBinding(executor, version);
      const current = await executor.query<{ active_version_id: string }>(
        'SELECT active_version_id FROM core.current_cms_publications WHERE entry_id = $1',
        [version.entry_id],
      );
      if (current.rows[0]?.active_version_id === versionId) {
        if (eventType === 'ROLLED_BACK') {
          throw new CoreError('InvalidRequest', 'CMS rollback target is already the active published version', 409);
        }
        return this.getVersionInTransaction(executor, versionId);
      }
      const now = this.#clock();
      const eventId = `cms-publication:${randomUUID()}`;
      await executor.query(
        `INSERT INTO core.cms_publication_events (
           event_id, entry_id, active_version_id, event_type, previous_version_id,
           evidence_hash, actor_wallet, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          eventId,
          version.entry_id,
          versionId,
          eventType,
          current.rows[0]?.active_version_id ?? null,
          input.evidenceHash.toLowerCase(),
          wallet,
          now,
        ],
      );
      const requestHash = hashJson({ versionId, eventType, evidenceHash: input.evidenceHash.toLowerCase() });
      await enqueueOperationalAudit(executor, {
        eventType: `Cms${eventType === 'PUBLISHED' ? 'Published' : 'RolledBack'}`,
        resourceType: 'CMS_PUBLICATION',
        resourceId: eventId,
        actorWallet: wallet,
        roles,
        correlationId: input.correlationId,
        requestHash,
        payload: {
          entryId: version.entry_id,
          activeVersionId: versionId,
          previousVersionId: current.rows[0]?.active_version_id ?? null,
          contentHash: version.content_hash,
        },
        now,
      });
      return this.getVersionInTransaction(executor, versionId);
    });
  }

  private async getVersionInTransaction(executor: SqlExecutor, versionId: string) {
    return versionProjection(executor, await loadVersion(executor, versionId));
  }
}

export function sanitizeStructuredContent(value: unknown) {
  const counter = { value: 0 };
  const result = sanitizeNode(value, 0, counter);
  if (result.type !== 'doc') throw new CoreError('InvalidRequest', 'CMS content root must be a doc node');
  if (Buffer.byteLength(canonicalJson(result)) > 200_000) throw new CoreError('InvalidRequest', 'CMS content is too large');
  return result;
}

function sanitizeNode(value: unknown, depth: number, counter: { value: number }): Record<string, unknown> {
  if (depth > 12 || ++counter.value > 500) throw new CoreError('InvalidRequest', 'CMS content exceeds structural limits');
  const node = record(value, 'CMS node');
  const type = text(node.type, 'CMS node type');
  if (type === 'doc') {
    exactKeys(node, ['type', 'children']);
    return { type, children: children(node.children, depth, counter) };
  }
  if (type === 'paragraph' || type === 'blockquote' || type === 'listItem') {
    exactKeys(node, ['type', 'children']);
    return { type, children: children(node.children, depth, counter) };
  }
  if (type === 'heading') {
    exactKeys(node, ['type', 'level', 'children']);
    const level = Number(node.level);
    if (!Number.isSafeInteger(level) || level < 1 || level > 4) throw new CoreError('InvalidRequest', 'CMS heading level is invalid');
    return { type, level, children: children(node.children, depth, counter) };
  }
  if (type === 'bulletList' || type === 'orderedList') {
    exactKeys(node, ['type', 'children']);
    const nested = children(node.children, depth, counter);
    if (nested.some((child) => child.type !== 'listItem')) throw new CoreError('InvalidRequest', 'CMS list accepts list items only');
    return { type, children: nested };
  }
  if (type === 'text') {
    exactKeys(node, ['type', 'text', 'marks']);
    const valueText = text(node.text, 'CMS text').normalize('NFC');
    if (valueText.length > 10_000) throw new CoreError('InvalidRequest', 'CMS text node is too long');
    if (!Array.isArray(node.marks)) throw new CoreError('InvalidRequest', 'CMS text marks must be an array');
    const marks = [...new Set(node.marks.map((mark) => text(mark, 'CMS mark')))].sort();
    if (marks.some((mark) => !['bold', 'code', 'italic', 'underline'].includes(mark))) {
      throw new CoreError('InvalidRequest', 'CMS text mark is not allowed');
    }
    return { type, text: valueText, marks };
  }
  if (type === 'link') {
    exactKeys(node, ['type', 'href', 'children']);
    const href = text(node.href, 'CMS link');
    if (!isSafeLink(href)) throw new CoreError('InvalidRequest', 'CMS link protocol is not allowed');
    const nested = children(node.children, depth, counter);
    if (nested.some((child) => !['text'].includes(String(child.type)))) {
      throw new CoreError('InvalidRequest', 'CMS link accepts text only');
    }
    return { type, href, children: nested };
  }
  if (type === 'image') {
    exactKeys(node, ['type', 'assetId', 'alt']);
    const assetId = text(node.assetId, 'CMS image assetId');
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(assetId)) throw new CoreError('InvalidRequest', 'CMS image assetId is invalid');
    return { type, assetId, alt: text(node.alt, 'CMS image alt').normalize('NFC') };
  }
  throw new CoreError('InvalidRequest', `CMS node type ${type} is not allowed`);
}

function children(value: unknown, depth: number, counter: { value: number }) {
  if (!Array.isArray(value)) throw new CoreError('InvalidRequest', 'CMS children must be an array');
  return value.map((child) => sanitizeNode(child, depth + 1, counter));
}

function cmsAudience(value: unknown): CmsAudience {
  const audience = record(value, 'CMS audience');
  const type = text(audience.type, 'CMS audience type');
  if (type === 'ALL') {
    exactKeys(audience, ['type']);
    return { type };
  }
  if (type === 'REGION') {
    exactKeys(audience, ['type', 'regionCodes']);
    return { type, regionCodes: sortedStrings(audience.regionCodes, /^\d{6}$/, 'region code') };
  }
  if (type === 'MERCHANT') {
    exactKeys(audience, ['type', 'merchantIds']);
    return { type, merchantIds: sortedStrings(audience.merchantIds, /^[A-Za-z0-9:_-]{3,128}$/, 'merchant id') };
  }
  if (type === 'WALLET') {
    exactKeys(audience, ['type', 'wallets']);
    return { type, wallets: sortedStrings(audience.wallets, /^0x[0-9a-fA-F]{40}$/, 'wallet').map(normalizeAddress) };
  }
  throw new CoreError('InvalidRequest', 'CMS audience type is invalid');
}

async function assertRulesBinding(executor: SqlExecutor, version: CmsVersionRow) {
  if (version.policy_version === null) throw new CoreError('DecisionBlocked', 'Seckill rules require a policyVersion', 409);
  const binding = await executor.query<{ source: string }>(
    `SELECT 'PUBLISHED' AS source FROM core.policy_snapshots
     WHERE policy_version = $1 AND lower(rules_content_hash) = $2
     UNION ALL
     SELECT 'DRAFT' AS source FROM core.policy_drafts
     WHERE next_policy_version = $1
       AND lower(payload->>'rulesContentHash') = $2
       AND state NOT IN ('REJECTED', 'REORGED')
     LIMIT 1`,
    [version.policy_version, version.content_hash.toLowerCase()],
  );
  if (!binding.rows[0]) throw new CoreError('DecisionBlocked', 'Seckill rules hash does not match policyVersion', 409);
}

async function loadVersion(executor: SqlExecutor, versionId: string) {
  const result = await executor.query<CmsVersionRow>('SELECT * FROM core.cms_versions WHERE version_id = $1', [versionId]);
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'CMS version not found', 404);
  return result.rows[0];
}

async function versionProjection(executor: SqlExecutor, row: CmsVersionRow) {
  const entry = await executor.query<{ slug: string; content_type: ContentType; placement: string }>(
    'SELECT slug, content_type, placement FROM core.cms_entries WHERE entry_id = $1',
    [row.entry_id],
  );
  const publication = await executor.query<{ active_version_id: string; event_type: string; created_at: Date | string }>(
    'SELECT active_version_id, event_type, created_at FROM core.current_cms_publications WHERE entry_id = $1',
    [row.entry_id],
  );
  return Object.freeze({
    entryId: row.entry_id,
    versionId: row.version_id,
    version: row.version,
    slug: entry.rows[0]?.slug,
    contentType: entry.rows[0]?.content_type,
    placement: entry.rows[0]?.placement,
    locale: row.locale,
    contentFormat: row.content_format,
    content: row.sanitized_content,
    contentHash: row.content_hash,
    audience: row.audience,
    startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
    frequencyCap: row.frequency_cap,
    policyVersion: row.policy_version === null ? null : String(row.policy_version),
    published: publication.rows[0]?.active_version_id === row.version_id,
    publicationType: publication.rows[0]?.active_version_id === row.version_id ? publication.rows[0].event_type : null,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

async function enqueueOperationalAudit(executor: SqlExecutor, input: {
  eventType: string;
  resourceType: string;
  resourceId: string;
  actorWallet: string;
  roles: string[];
  correlationId: string;
  requestHash: string;
  payload: Record<string, unknown>;
  now: Date;
}) {
  const evidenceHash = hashJson({ wallet: input.actorWallet, roles: input.roles, checkedAt: input.now.toISOString() });
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:cms', { eventType: input.eventType, resourceId: input.resourceId, requestHash: input.requestHash }),
    streamName: 'operational',
    evidenceProfile: 'RBAC',
    eventType: input.eventType,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    actorWallet: input.actorWallet,
    actorRole: input.roles[0]!,
    correlationId: input.correlationId,
    requestHash: input.requestHash.slice(2),
    payload: input.payload,
    authorizationEvidence: {
      scheme: 'RBAC_ROLE_REVALIDATION',
      subject: input.actorWallet,
      roles: input.roles,
      evidenceHash,
      checkedAt: input.now.toISOString(),
    },
    createdAt: input.now,
  });
}

async function requireCurrentRole(executor: SqlExecutor, wallet: string, allowed: readonly string[]) {
  const result = await executor.query<{ role: string }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE lower(wallet_address) = $1 AND status = 'ACTIVE' AND role = ANY($2::text[])
     ORDER BY role`,
    [wallet, [...allowed]],
  );
  if (result.rows.length === 0) throw new CoreError('Forbidden', 'Current wallet role cannot manage CMS', 403);
  return result.rows.map((row) => row.role);
}

function requireSessionRole(actor: FulfillmentActor, ...allowed: string[]) {
  if (!actor.roles.some((role) => allowed.includes(role))) throw new CoreError('Forbidden', 'Wallet session cannot manage CMS', 403);
}

interface PublishedAudienceContext {
  walletAddress?: string;
  merchantIds: ReadonlySet<string>;
  regionCodes: ReadonlySet<string>;
}

async function publishedAudienceContext(
  executor: SqlExecutor,
  actor: FulfillmentActor | undefined,
  now: Date,
): Promise<PublishedAudienceContext> {
  if (!actor) return { merchantIds: new Set(), regionCodes: new Set() };
  const walletAddress = normalizeAddress(actor.walletAddress);
  const merchantIds = new Set<string>();
  if (actor.roles.includes('MERCHANT') && actor.merchantId) {
    const binding = await executor.query<{ merchant_id: string }>(
      `SELECT merchant_id FROM core.wallet_role_bindings
       WHERE lower(wallet_address) = $1 AND role = 'MERCHANT' AND status = 'ACTIVE'
         AND merchant_id = $2`,
      [walletAddress, actor.merchantId],
    );
    if (binding.rows[0]) merchantIds.add(binding.rows[0].merchant_id);
  }
  const regions = await executor.query<{ region_code: string }>(
    `SELECT DISTINCT region_code FROM (
       SELECT region_code FROM core.fulfillment_targets
       WHERE buyer_wallet = $1 AND expires_at > $2
       UNION
       SELECT store.region_code FROM core.merchant_stores store
       WHERE store.merchant_id = ANY($3::text[]) AND store.status = 'ACTIVE'
     ) audience_regions ORDER BY region_code`,
    [walletAddress, now, [...merchantIds]],
  );
  return {
    walletAddress,
    merchantIds,
    regionCodes: new Set(regions.rows.map((row) => row.region_code)),
  };
}

function audienceMatches(audience: CmsAudience, context: PublishedAudienceContext) {
  if (audience.type === 'ALL') return true;
  if (audience.type === 'REGION') return audience.regionCodes.some((regionCode) => context.regionCodes.has(regionCode));
  if (audience.type === 'MERCHANT') return audience.merchantIds.some((merchantId) => context.merchantIds.has(merchantId));
  return context.walletAddress !== undefined && audience.wallets.includes(normalizeAddress(context.walletAddress));
}

function validateCreateInput(input: {
  slug: string;
  contentType: string;
  placement: string;
  locale: string;
  contentFormat: string;
  frequencyCap?: number;
  idempotencyKey: string;
  correlationId: string;
}) {
  if (!/^[a-z0-9][a-z0-9-]{1,95}$/.test(input.slug)) throw new CoreError('InvalidRequest', 'CMS slug is invalid');
  if (!CONTENT_TYPES.includes(input.contentType as ContentType)) throw new CoreError('InvalidRequest', 'CMS content type is invalid');
  if (input.placement.length < 1 || input.placement.length > 96) throw new CoreError('InvalidRequest', 'CMS placement is invalid');
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(input.locale)) throw new CoreError('InvalidRequest', 'CMS locale is invalid');
  if (!['STRUCTURED_RICH_TEXT', 'STRUCTURED_CAMPAIGN'].includes(input.contentFormat)) {
    throw new CoreError('InvalidRequest', 'CMS content format is invalid');
  }
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(input.idempotencyKey)) throw new CoreError('InvalidRequest', 'CMS idempotency key is invalid');
  if (!input.correlationId || input.correlationId.length > 128) throw new CoreError('InvalidRequest', 'CMS correlation ID is invalid');
  if (input.frequencyCap !== undefined && (!Number.isSafeInteger(input.frequencyCap) || input.frequencyCap < 1 || input.frequencyCap > 1_000)) {
    throw new CoreError('InvalidRequest', 'CMS frequency cap is invalid');
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('InvalidRequest', `${name} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0) throw new CoreError('InvalidRequest', `${name} is required`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new CoreError('InvalidRequest', 'CMS content contains unknown fields');
}

function sortedStrings(value: unknown, pattern: RegExp, name: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5_000) throw new CoreError('InvalidRequest', `CMS ${name} audience is invalid`);
  const items = [...new Set(value.map((item) => text(item, name)))].sort();
  if (items.some((item) => !pattern.test(item))) throw new CoreError('InvalidRequest', `CMS ${name} audience is invalid`);
  return items;
}

function isSafeLink(value: string) {
  if (value.startsWith('/')) return !value.startsWith('//');
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function optionalDate(value: string | undefined, name: string) {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return parsed;
}

function positiveInteger(value: string, name: string) {
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CoreError('InvalidRequest', `${name} is invalid`);
  }
  return Number(value);
}

function hashContent(value: unknown) {
  return keccak256(toUtf8Bytes(canonicalJson(value))).toLowerCase();
}

function hashJson(value: unknown) {
  return hashContent(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
