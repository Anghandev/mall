import { randomUUID } from 'node:crypto';
import { keccak256, toUtf8Bytes } from 'ethers';
import { normalizeAddress } from '../api/auth.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

const SOURCE_EVENT_TYPES = [
  'PaymentFinalized',
  'PaymentReorged',
  'ShipmentRecorded',
  'LogisticsUpdated',
  'FulfillmentFinalized',
  'TakeoverOpened',
  'SettlementRequested',
  'SettlementBatchApprovalRequested',
  'SettlementBatchFinalized',
  'SettlementFinalityReorged',
  'BnmStateFinalized',
  'NotificationCampaignPublished',
] as const;

type NotificationProvider = 'CORE' | 'ALIYUN_SMS' | 'TENCENT_SMS' | 'SMTP' | 'FIREBASE' | 'JPUSH';
type NotificationChannel = 'IN_APP' | 'SMS' | 'EMAIL' | 'PUSH';

interface SourceEventRow {
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date | string;
}

interface EndpointRow {
  endpoint_id: string;
  wallet_address: string;
  merchant_id: string | null;
  region_code: string | null;
  channel: NotificationChannel;
  provider: NotificationProvider;
  endpoint_reference: string;
  topics: string[];
  state: 'ACTIVE' | 'PAUSED' | 'REVOKED';
}

interface CampaignRow {
  campaign_id: string;
  topic: string;
  audience: CampaignAudience;
  message: Record<string, unknown>;
  content_hash: string;
  cms_version_id: string | null;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  state: 'DRAFT' | 'PUBLISHED' | 'CANCELLED';
  created_by: string;
  created_at: Date | string;
  published_at: Date | string | null;
}

type NotificationCampaignAction = 'PUBLISH' | 'RETRY_FAILED';

export class NotificationService {
  readonly #transactions: SqlTransactionRunner;
  readonly #clock: () => Date;

  constructor(input: { transactions: SqlTransactionRunner; clock?: () => Date }) {
    this.#transactions = input.transactions;
    this.#clock = input.clock ?? (() => new Date());
  }

  registerEndpoint(actor: FulfillmentActor, input: {
    channel: NotificationChannel;
    provider: NotificationProvider;
    endpointReference: string;
    topics: string[];
    regionCode?: string;
    correlationId: string;
  }) {
    const wallet = normalizeAddress(actor.walletAddress);
    validateEndpointInput(input);
    if (!input.correlationId || input.correlationId.length > 128) throw new CoreError('InvalidRequest', 'Notification correlation id is invalid');
    return this.#transactions.transaction(async (executor) => {
      const endpointId = `notification-endpoint:${hashJson({ wallet, channel: input.channel, provider: input.provider }).slice(2)}`;
      const now = this.#clock();
      const topics = canonicalTopics(input.topics);
      const roles = [...new Set(actor.roles)].sort();
      if (roles.length === 0) throw new CoreError('Forbidden', 'Notification endpoint requires an authenticated wallet role', 403);
      const endpointReferenceHash = keccak256(toUtf8Bytes(input.endpointReference)).toLowerCase();
      const existing = await executor.query<EndpointRow>(
        'SELECT * FROM core.notification_endpoints WHERE wallet_address = $1 AND channel = $2 AND provider = $3 FOR UPDATE',
        [wallet, input.channel, input.provider],
      );
      if (existing.rows[0]) {
        await executor.query(
          `UPDATE core.notification_endpoints SET endpoint_reference = $2,
             topics = $3, region_code = $4, merchant_id = $5,
             state = 'ACTIVE', updated_at = $6 WHERE endpoint_id = $1`,
          [endpointId, input.endpointReference, JSON.stringify(topics), input.regionCode ?? null, actor.merchantId ?? null, now],
        );
      } else {
        await executor.query(
          `INSERT INTO core.notification_endpoints (
             endpoint_id, wallet_address, merchant_id, region_code, channel,
             provider, endpoint_reference, topics, state, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,$9)`,
          [
            endpointId,
            wallet,
            actor.merchantId ?? null,
            input.regionCode ?? null,
            input.channel,
            input.provider,
            input.endpointReference,
            JSON.stringify(topics),
            now,
          ],
        );
      }
      const eventType = existing.rows[0] ? 'NotificationEndpointUpdated' : 'NotificationEndpointRegistered';
      const requestHash = hashJson({
        endpointId,
        endpointReferenceHash,
        channel: input.channel,
        provider: input.provider,
        topics,
        regionCode: input.regionCode ?? null,
        merchantId: actor.merchantId ?? null,
      });
      const authorizationEvidenceHash = hashJson({
        wallet,
        endpointId,
        roles,
        checkedAt: now.toISOString(),
      });
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:notification-endpoint', {
          eventType,
          endpointId,
          requestHash,
          correlationId: input.correlationId,
          createdAt: now.toISOString(),
        }),
        streamName: 'operational',
        evidenceProfile: 'AUTHORIZATION',
        eventType,
        resourceType: 'NOTIFICATION_ENDPOINT',
        resourceId: endpointId,
        actorWallet: wallet,
        actorRole: roles[0]!,
        correlationId: input.correlationId,
        requestHash: requestHash.slice(2),
        payload: { endpointReferenceHash },
        authorizationEvidence: {
          scheme: 'SESSION_RESOURCE_OWNERSHIP',
          subject: wallet,
          roles,
          evidenceHash: authorizationEvidenceHash,
          checkedAt: now.toISOString(),
        },
        createdAt: now,
      });
      return { endpointId, channel: input.channel, provider: input.provider, topics, state: 'ACTIVE' as const };
    });
  }

  createCampaign(actor: FulfillmentActor, input: {
    topic: 'ANNOUNCEMENT' | 'MAINTENANCE' | 'ACTIVITY';
    audience: unknown;
    message: unknown;
    cmsVersionId?: string;
    startsAt?: string;
    endsAt?: string;
    idempotencyKey: string;
    correlationId: string;
  }) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR');
    const wallet = normalizeAddress(actor.walletAddress);
    const audience = campaignAudience(input.audience);
    const message = campaignMessage(input.message);
    const startsAt = optionalDate(input.startsAt, 'notification startsAt');
    const endsAt = optionalDate(input.endsAt, 'notification endsAt');
    if (endsAt && (!startsAt || endsAt <= startsAt)) throw new CoreError('InvalidRequest', 'Notification campaign schedule is invalid');
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(input.idempotencyKey)) {
      throw new CoreError('InvalidRequest', 'Notification campaign idempotency key is invalid');
    }
    const requestHash = hashJson({ wallet, ...input, audience, message });
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN', 'OPERATOR']);
      const existing = await executor.query<{
        campaign_id: string;
        request_hash: string;
        state: string;
        content_hash: string;
      }>('SELECT campaign_id, request_hash, state, content_hash FROM core.notification_campaigns WHERE created_by = $1 AND idempotency_key = $2', [wallet, input.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw new CoreError('IdempotencyConflict', 'Notification campaign idempotency conflict', 409);
        return {
          campaignId: existing.rows[0].campaign_id,
          state: existing.rows[0].state,
          contentHash: existing.rows[0].content_hash,
        };
      }
      if (input.cmsVersionId) {
        const cms = await executor.query<{ version_id: string }>('SELECT version_id FROM core.cms_versions WHERE version_id = $1', [input.cmsVersionId]);
        if (!cms.rows[0]) throw new CoreError('InvalidRequest', 'Notification CMS version not found', 404);
      }
      const campaignId = `notification-campaign:${randomUUID()}`;
      const now = this.#clock();
      const contentHash = hashJson({ topic: input.topic, audience, message, cmsVersionId: input.cmsVersionId ?? null });
      await executor.query(
        `INSERT INTO core.notification_campaigns (
           campaign_id, topic, audience, message, content_hash, cms_version_id,
           starts_at, ends_at, state, idempotency_key, request_hash,
           created_by, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10,$11,$12)`,
        [
          campaignId,
          input.topic,
          JSON.stringify(audience),
          JSON.stringify(message),
          contentHash,
          input.cmsVersionId ?? null,
          startsAt,
          endsAt,
          input.idempotencyKey,
          requestHash,
          wallet,
          now,
        ],
      );
      await executor.query(
        `INSERT INTO core.notification_campaign_events (
           campaign_event_id, campaign_id, event_type, evidence_hash,
           actor_wallet, created_at
         ) VALUES ($1,$2,'CREATED',$3,$4,$5)`,
        [`notification-campaign-event:${randomUUID()}`, campaignId, requestHash, wallet, now],
      );
      await campaignAudit(executor, {
        eventType: 'NotificationCampaignCreated',
        campaignId,
        actorWallet: wallet,
        roles,
        correlationId: input.correlationId,
        requestHash,
        payload: { topic: input.topic, audience, contentHash },
        now,
      });
      return { campaignId, state: 'DRAFT' as const, contentHash };
    });
  }

  publishCampaign(actor: FulfillmentActor, campaignId: string, input: { evidenceHash: string; correlationId: string }) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR');
    const wallet = normalizeAddress(actor.walletAddress);
    if (!isHash(input.evidenceHash)) throw new CoreError('InvalidRequest', 'Notification campaign evidence hash is invalid');
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN', 'OPERATOR']);
      const result = await executor.query<{
        campaign_id: string;
        topic: string;
        state: string;
        starts_at: Date | string | null;
        ends_at: Date | string | null;
      }>('SELECT * FROM core.notification_campaigns WHERE campaign_id = $1 FOR UPDATE', [campaignId]);
      const campaign = result.rows[0];
      if (!campaign) throw new CoreError('InvalidRequest', 'Notification campaign not found', 404);
      if (campaign.state === 'PUBLISHED') return { campaignId, state: 'PUBLISHED' as const };
      if (campaign.state !== 'DRAFT') throw new CoreError('InvalidRequest', 'Notification campaign is not publishable', 409);
      const now = this.#clock();
      if (campaign.ends_at && new Date(campaign.ends_at) <= now) throw new CoreError('InvalidRequest', 'Notification campaign already ended', 409);
      await executor.query(
        "UPDATE core.notification_campaigns SET state = 'PUBLISHED', published_at = $2 WHERE campaign_id = $1",
        [campaignId, now],
      );
      await executor.query(
        `INSERT INTO core.notification_campaign_events (
           campaign_event_id, campaign_id, event_type, evidence_hash,
           actor_wallet, created_at
         ) VALUES ($1,$2,'PUBLISHED',$3,$4,$5)`,
        [`notification-campaign-event:${randomUUID()}`, campaignId, input.evidenceHash.toLowerCase(), wallet, now],
      );
      await executor.query(
        `INSERT INTO core.outbox_events (
           event_id, aggregate_type, aggregate_id, event_type, payload,
           idempotency_key, state, available_at
         ) VALUES ($1,'NOTIFICATION_CAMPAIGN',$2,'NotificationCampaignPublished',$3,$1,'PENDING',$4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          `outbox:notification-campaign:${campaignId}`,
          campaignId,
          JSON.stringify({ campaignId, topic: campaign.topic }),
          campaign.starts_at ? new Date(campaign.starts_at) : now,
        ],
      );
      const requestHash = hashJson({ campaignId, evidenceHash: input.evidenceHash.toLowerCase() });
      await campaignAudit(executor, {
        eventType: 'NotificationCampaignPublished',
        campaignId,
        actorWallet: wallet,
        roles,
        correlationId: input.correlationId,
        requestHash,
        payload: { topic: campaign.topic, evidenceHash: input.evidenceHash.toLowerCase() },
        now,
      });
      return { campaignId, state: 'PUBLISHED' as const };
    });
  }

  listCampaigns(actor: FulfillmentActor, limit = 50) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    const wallet = normalizeAddress(actor.walletAddress);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new CoreError('InvalidRequest', 'Notification campaign limit is invalid');
    }
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN', 'OPERATOR', 'AUDITOR']);
      const campaigns = await executor.query<CampaignRow>(
        `SELECT campaign_id, topic, audience, message, content_hash, cms_version_id,
           starts_at, ends_at, state, created_by, created_at, published_at
         FROM core.notification_campaigns
         ORDER BY created_at DESC, campaign_id DESC LIMIT $1`,
        [limit],
      );
      const canWrite = roles.some((role) => role === 'ADMIN' || role === 'OPERATOR');
      return Promise.all(campaigns.rows.map(async (campaign) => {
        const counts = await campaignDeliveryCounts(executor, campaign.campaign_id);
        const failed = (counts.RETRY ?? 0) + (counts.CONFIGURATION_REQUIRED ?? 0) + (counts.DEAD_LETTER ?? 0);
        const allowedActions: NotificationCampaignAction[] = [];
        if (canWrite && campaign.state === 'DRAFT') allowedActions.push('PUBLISH');
        if (canWrite && campaign.state === 'PUBLISHED' && failed > 0) allowedActions.push('RETRY_FAILED');
        return campaignProjection(campaign, counts, allowedActions);
      }));
    });
  }

  retryCampaignDeliveries(actor: FulfillmentActor, campaignId: string, input: { correlationId: string }) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR');
    const wallet = normalizeAddress(actor.walletAddress);
    if (!input.correlationId || input.correlationId.length > 128) {
      throw new CoreError('InvalidRequest', 'Notification retry correlation id is invalid');
    }
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN', 'OPERATOR']);
      const campaigns = await executor.query<{ campaign_id: string; state: string }>(
        'SELECT campaign_id, state FROM core.notification_campaigns WHERE campaign_id = $1 FOR UPDATE',
        [campaignId],
      );
      const campaign = campaigns.rows[0];
      if (!campaign) throw new CoreError('InvalidRequest', 'Notification campaign not found', 404);
      if (campaign.state !== 'PUBLISHED') throw new CoreError('InvalidRequest', 'Notification campaign is not published', 409);
      const now = this.#clock();
      const retried = await executor.query<{ delivery_id: string }>(
        `UPDATE core.notification_deliveries delivery
         SET state = 'RETRY', attempt_count = 0, available_at = $2,
           locked_by = NULL, locked_until = NULL, last_error_code = NULL
         FROM core.notification_messages message, core.outbox_events source
         WHERE delivery.message_id = message.message_id
           AND message.source_event_id = source.event_id
           AND source.aggregate_type = 'NOTIFICATION_CAMPAIGN'
           AND source.aggregate_id = $1
           AND delivery.state IN ('RETRY', 'CONFIGURATION_REQUIRED', 'DEAD_LETTER')
         RETURNING delivery.delivery_id`,
        [campaignId, now],
      );
      if (retried.rows.length === 0) throw new CoreError('InvalidRequest', 'Notification campaign has no failed deliveries', 409);
      const deliveryIds = retried.rows.map((row) => row.delivery_id).sort();
      const requestHash = hashJson({ campaignId, deliveryIds });
      await campaignAudit(executor, {
        eventType: 'NotificationCampaignRetryRequested',
        campaignId,
        actorWallet: wallet,
        roles,
        correlationId: input.correlationId,
        requestHash,
        payload: { deliveryCount: deliveryIds.length },
        now,
      });
      return { campaignId, state: 'RETRY_SCHEDULED' as const, retriedDeliveries: deliveryIds.length };
    });
  }

  projectNext(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('InvalidNotificationProjectionLimit');
    return this.#transactions.transaction(async (executor) => {
      const events = await executor.query<SourceEventRow>(
        `SELECT event.* FROM core.outbox_events event
         LEFT JOIN core.notification_source_consumptions consumed
           ON consumed.source_event_id = event.event_id
         WHERE consumed.source_event_id IS NULL
           AND event.event_type = ANY($1::text[])
           AND event.available_at <= $2
         ORDER BY event.created_at, event.event_id
         FOR UPDATE OF event SKIP LOCKED LIMIT $3`,
        [[...SOURCE_EVENT_TYPES], this.#clock(), limit],
      );
      for (const event of events.rows) {
        const projection = await projectEvent(executor, event, this.#clock());
        for (const message of projection.messages) {
          const recipient = message.recipient;
          await ensureInAppEndpoint(executor, recipient, this.#clock());
          const endpoints = await activeEndpoints(executor, recipient, projection.topic);
          const messageId = `notification-message:${hashJson({ sourceEventId: event.event_id, recipient, topic: projection.topic }).slice(2)}`;
          await executor.query(
            `INSERT INTO core.notification_messages (
               message_id, source_event_id, source_event_type, recipient_wallet,
               topic, template_data, created_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (source_event_id, recipient_wallet, topic) DO NOTHING`,
            [messageId, event.event_id, event.event_type, recipient, projection.topic, JSON.stringify(message.templateData), this.#clock()],
          );
          for (const endpoint of endpoints) {
            await executor.query(
              `INSERT INTO core.notification_deliveries (
                 delivery_id, message_id, endpoint_id, channel, provider,
                 endpoint_reference, state, available_at
               ) VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7)
               ON CONFLICT (message_id, endpoint_id) DO NOTHING`,
              [
                `notification-delivery:${hashJson({ messageId, endpointId: endpoint.endpoint_id }).slice(2)}`,
                messageId,
                endpoint.endpoint_id,
                endpoint.channel,
                endpoint.provider,
                endpoint.endpoint_reference,
                this.#clock(),
              ],
            );
          }
        }
        await executor.query(
          `INSERT INTO core.notification_source_consumptions (
             source_event_id, source_event_type, consumed_at
           ) VALUES ($1,$2,$3)`,
          [event.event_id, event.event_type, this.#clock()],
        );
      }
      return events.rows.length;
    });
  }

  listInbox(actor: FulfillmentActor, limit = 100) {
    const wallet = normalizeAddress(actor.walletAddress);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new CoreError('InvalidRequest', 'Notification inbox limit is invalid');
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<{
        message_id: string;
        source_event_type: string;
        topic: string;
        template_data: Record<string, unknown>;
        created_at: Date | string;
        state: string;
      }>(
        `SELECT message.message_id, message.source_event_type, message.topic,
           message.template_data, message.created_at, delivery.state
         FROM core.notification_messages message
         JOIN core.notification_deliveries delivery ON delivery.message_id = message.message_id
         WHERE message.recipient_wallet = $1 AND delivery.channel = 'IN_APP'
         ORDER BY message.created_at DESC, message.message_id DESC LIMIT $2`,
        [wallet, limit],
      );
      return result.rows.map((row) => Object.freeze({
        messageId: row.message_id,
        sourceEventType: row.source_event_type,
        topic: row.topic,
        templateData: row.template_data,
        deliveryState: row.state,
        createdAt: new Date(row.created_at).toISOString(),
      }));
    });
  }
}

async function projectEvent(executor: SqlExecutor, event: SourceEventRow, now: Date) {
  if (event.event_type === 'NotificationCampaignPublished') return projectCampaign(executor, event, now);
  const topic = topicForEvent(event);
  const recipients = await eventRecipients(executor, event);
  return {
    topic,
    messages: await Promise.all(recipients.map(async (recipient) => ({
      recipient,
      templateData: await controlledTemplate(executor, event, topic, recipient),
    }))),
  };
}

async function projectCampaign(executor: SqlExecutor, event: SourceEventRow, now: Date) {
  const result = await executor.query<{
    topic: string;
    audience: CampaignAudience;
    message: Record<string, unknown>;
    starts_at: Date | string | null;
    ends_at: Date | string | null;
  }>('SELECT topic, audience, message, starts_at, ends_at FROM core.notification_campaigns WHERE campaign_id = $1 AND state = \'PUBLISHED\'', [event.aggregate_id]);
  const campaign = result.rows[0];
  if (!campaign) throw new CoreError('InvalidRequest', 'Published notification campaign is unavailable', 409);
  if ((campaign.starts_at && new Date(campaign.starts_at) > now) || (campaign.ends_at && new Date(campaign.ends_at) <= now)) {
    throw new CoreError('InvalidRequest', 'Notification campaign is outside its schedule', 409);
  }
  return {
    topic: campaign.topic,
    messages: (await campaignRecipients(executor, campaign.audience)).map((recipient) => ({
      recipient,
      templateData: Object.freeze({ copyKey: 'CAMPAIGN_MESSAGE', ...campaign.message, campaignId: event.aggregate_id }),
    })),
  };
}

function topicForEvent(event: SourceEventRow) {
  if (event.event_type === 'BnmStateFinalized') {
    if (event.payload.state === 'LOCKED') return 'BNM_LOCKED';
    if (event.payload.state === 'AVAILABLE') return 'BNM_AVAILABLE';
    throw new CoreError('InvalidRequest', 'BNM notification state must be Locked or Available', 409);
  }
  const topics: Record<string, string> = {
    PaymentFinalized: 'PAYMENT_FINALIZED',
    PaymentReorged: 'PAYMENT_REORGED',
    ShipmentRecorded: 'SHIPMENT_UPDATED',
    LogisticsUpdated: 'SHIPMENT_UPDATED',
    FulfillmentFinalized: 'FULFILLMENT_FINALIZED',
    TakeoverOpened: 'TAKEOVER_OPENED',
    SettlementRequested: 'SETTLEMENT_REQUESTED',
    SettlementBatchApprovalRequested: 'SETTLEMENT_BATCHED',
    SettlementBatchFinalized: 'SETTLEMENT_SETTLED',
    SettlementFinalityReorged: 'SETTLEMENT_REORGED',
  };
  const topic = topics[event.event_type];
  if (!topic) throw new CoreError('InvalidRequest', 'Notification source event is unsupported', 409);
  return topic;
}

async function eventRecipients(executor: SqlExecutor, event: SourceEventRow) {
  if (event.aggregate_type === 'ORDER') {
    const order = await executor.query<{ buyer_wallet: string; merchant_wallet: string }>(
      'SELECT buyer_wallet, merchant_wallet FROM core.orders WHERE order_id = $1',
      [event.aggregate_id],
    );
    if (!order.rows[0]) throw new CoreError('InvalidRequest', 'Notification order is unavailable', 409);
    const buyerOnly = ['ShipmentRecorded', 'LogisticsUpdated', 'BnmStateFinalized'].includes(event.event_type);
    const recipients = buyerOnly
      ? [order.rows[0].buyer_wallet]
      : [order.rows[0].buyer_wallet, order.rows[0].merchant_wallet];
    const state = event.event_type === 'PaymentFinalized'
      ? 'LOCKED'
      : event.event_type === 'FulfillmentFinalized' ? 'AVAILABLE' : undefined;
    if (state) recipients.push(...await orderPayableWallets(executor, event.aggregate_id, state));
    return canonicalWallets(recipients);
  }
  if (event.aggregate_type === 'SETTLEMENT_REQUEST') {
    const request = await executor.query<{ wallet_address: string }>(
      'SELECT wallet_address FROM core.settlement_requests WHERE request_id = $1',
      [event.aggregate_id],
    );
    return canonicalWallets(request.rows.map((row) => row.wallet_address));
  }
  if (event.aggregate_type === 'SETTLEMENT_BATCH') {
    const requests = await executor.query<{ wallet_address: string }>(
      `SELECT DISTINCT request.wallet_address FROM core.settlement_requests request
       WHERE request.batch_id = $1 ORDER BY request.wallet_address`,
      [event.aggregate_id],
    );
    return canonicalWallets(requests.rows.map((row) => row.wallet_address));
  }
  throw new CoreError('InvalidRequest', 'Notification source aggregate is unsupported', 409);
}

const CAMPAIGN_DELIVERY_STATES = [
  'PENDING',
  'PROCESSING',
  'DELIVERED',
  'RETRY',
  'CONFIGURATION_REQUIRED',
  'DEAD_LETTER',
] as const;

async function campaignDeliveryCounts(executor: SqlExecutor, campaignId: string) {
  const result = await executor.query<{ state: typeof CAMPAIGN_DELIVERY_STATES[number]; count: string }>(
    `SELECT delivery.state, count(*)::text AS count
     FROM core.outbox_events source
     JOIN core.notification_messages message ON message.source_event_id = source.event_id
     JOIN core.notification_deliveries delivery ON delivery.message_id = message.message_id
     WHERE source.aggregate_type = 'NOTIFICATION_CAMPAIGN' AND source.aggregate_id = $1
     GROUP BY delivery.state ORDER BY delivery.state`,
    [campaignId],
  );
  return Object.freeze(Object.fromEntries(result.rows.map((row) => [row.state, Number(row.count)]))) as Readonly<Partial<Record<
    typeof CAMPAIGN_DELIVERY_STATES[number],
    number
  >>>;
}

function campaignProjection(
  campaign: CampaignRow,
  deliveryCounts: Readonly<Partial<Record<typeof CAMPAIGN_DELIVERY_STATES[number], number>>>,
  allowedActions: readonly NotificationCampaignAction[],
) {
  return Object.freeze({
    campaignId: campaign.campaign_id,
    topic: campaign.topic,
    audience: campaign.audience,
    message: campaign.message,
    contentHash: campaign.content_hash,
    cmsVersionId: campaign.cms_version_id,
    startsAt: campaign.starts_at ? new Date(campaign.starts_at).toISOString() : null,
    endsAt: campaign.ends_at ? new Date(campaign.ends_at).toISOString() : null,
    state: campaign.state,
    createdBy: campaign.created_by,
    createdAt: new Date(campaign.created_at).toISOString(),
    publishedAt: campaign.published_at ? new Date(campaign.published_at).toISOString() : null,
    deliveryCounts: Object.freeze(Object.fromEntries(CAMPAIGN_DELIVERY_STATES.map((state) => [state, deliveryCounts[state] ?? 0]))),
    allowedActions: Object.freeze([...allowedActions]),
  });
}

async function campaignRecipients(executor: SqlExecutor, audience: CampaignAudience) {
  if (audience.type === 'WALLET') return canonicalWallets(audience.wallets);
  if (audience.type === 'MERCHANT') {
    const merchants = await executor.query<{ settlement_wallet: string }>(
      'SELECT settlement_wallet FROM core.merchants WHERE merchant_id = ANY($1::text[]) AND status = \'APPROVED\'',
      [audience.merchantIds],
    );
    return canonicalWallets(merchants.rows.map((row) => row.settlement_wallet));
  }
  if (audience.type === 'REGION') {
    const endpoints = await executor.query<{ wallet_address: string }>(
      "SELECT DISTINCT wallet_address FROM core.notification_endpoints WHERE region_code = ANY($1::text[]) AND state = 'ACTIVE'",
      [audience.regionCodes],
    );
    return canonicalWallets(endpoints.rows.map((row) => row.wallet_address));
  }
  const wallets = await executor.query<{ wallet_address: string }>(
    `SELECT wallet_address FROM core.wallet_role_bindings WHERE status = 'ACTIVE'
     UNION SELECT buyer_wallet FROM core.orders
     UNION SELECT merchant_wallet FROM core.orders`,
  );
  return canonicalWallets(wallets.rows.map((row) => row.wallet_address));
}

async function controlledTemplate(executor: SqlExecutor, event: SourceEventRow, topic: string, recipient: string) {
  const allowed = ['orderId', 'trackingNumber', 'carrier', 'status', 'requestId', 'rail', 'safeTxHash', 'executionTxHash', 'state', 'amount', 'stateVersion', 'method'];
  const values = Object.fromEntries(Object.entries(event.payload).filter(([key, value]) => allowed.includes(key) && isTemplatePrimitive(value)));
  const state = event.event_type === 'PaymentFinalized'
    ? 'LOCKED'
    : event.event_type === 'FulfillmentFinalized' ? 'AVAILABLE' : undefined;
  const balances = state ? await recipientPayableSummary(executor, event.aggregate_id, recipient, state) : {};
  return Object.freeze({
    copyKey: topic === 'BNM_LOCKED' || topic === 'BNM_AVAILABLE' ? `BNM_POINTS_${event.payload.state}` : topic,
    aggregateId: event.aggregate_id,
    ...values,
    ...balances,
  });
}

async function orderPayableWallets(executor: SqlExecutor, orderId: string, state: 'LOCKED' | 'AVAILABLE') {
  const result = await executor.query<{ owner_id: string }>(
    `SELECT account.owner_id
     FROM core.ledger_journals journal
     JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE journal.order_id = $1 AND line.balance_state = $2
       AND account.owner_type IN ('BUYER', 'MERCHANT', 'BENEFICIARY')
       AND account.owner_id ~ '^0x[0-9a-f]{40}$'
       AND account.asset IN ('USDT', 'NPL')
     GROUP BY account.owner_id
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0
     ORDER BY account.owner_id`,
    [orderId, state],
  );
  return result.rows.map((row) => row.owner_id);
}

async function recipientPayableSummary(
  executor: SqlExecutor,
  orderId: string,
  recipient: string,
  state: 'LOCKED' | 'AVAILABLE',
) {
  const result = await executor.query<{ asset: string; subtype: string | null; amount: string }>(
    `SELECT account.asset, account.subtype,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
     FROM core.ledger_journals journal
     JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE journal.order_id = $1 AND account.owner_id = $2
       AND line.balance_state = $3 AND account.asset IN ('USDT', 'NPL')
     GROUP BY account.asset, account.subtype
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0
     ORDER BY account.asset, account.subtype`,
    [orderId, recipient, state],
  );
  const totals = new Map<string, bigint>();
  const rewardSubtypes = new Set<string>();
  for (const row of result.rows) {
    totals.set(row.asset, (totals.get(row.asset) ?? 0n) + BigInt(row.amount));
    if (row.subtype) rewardSubtypes.add(row.subtype);
  }
  const prefix = state === 'LOCKED' ? 'locked' : 'available';
  return Object.freeze({
    ...(totals.has('USDT') ? { [`${prefix}UsdtAmount`]: totals.get('USDT')!.toString() } : {}),
    ...(totals.has('NPL') ? { [`${prefix}NplAmount`]: totals.get('NPL')!.toString() } : {}),
    ...(rewardSubtypes.size > 0 ? { rewardSubtypes: [...rewardSubtypes].sort().join(',') } : {}),
  });
}

async function ensureInAppEndpoint(executor: SqlExecutor, wallet: string, now: Date) {
  const endpointId = `notification-endpoint:in-app:${wallet.slice(2)}`;
  await executor.query(
    `INSERT INTO core.notification_endpoints (
       endpoint_id, wallet_address, channel, provider, endpoint_reference,
       topics, state, created_at, updated_at
     ) VALUES ($1,$2,'IN_APP','CORE',$3,'["*"]','ACTIVE',$4,$4)
     ON CONFLICT (wallet_address, channel, provider) DO NOTHING`,
    [endpointId, wallet, `recipient://wallet/${wallet}`, now],
  );
}

async function activeEndpoints(executor: SqlExecutor, wallet: string, topic: string) {
  const result = await executor.query<EndpointRow>(
    "SELECT * FROM core.notification_endpoints WHERE wallet_address = $1 AND state = 'ACTIVE' ORDER BY channel, provider",
    [wallet],
  );
  return result.rows.filter((endpoint) => endpoint.topics.includes('*') || endpoint.topics.includes(topic));
}

type CampaignAudience =
  | { type: 'ALL' }
  | { type: 'REGION'; regionCodes: string[] }
  | { type: 'MERCHANT'; merchantIds: string[] }
  | { type: 'WALLET'; wallets: string[] };

function campaignAudience(value: unknown): CampaignAudience {
  const input = record(value, 'notification audience');
  const type = stringValue(input.type, 'notification audience type');
  if (type === 'ALL') {
    exactKeys(input, ['type']);
    return { type };
  }
  if (type === 'REGION') {
    exactKeys(input, ['type', 'regionCodes']);
    return { type, regionCodes: stringList(input.regionCodes, /^\d{6}$/, 'region code') };
  }
  if (type === 'MERCHANT') {
    exactKeys(input, ['type', 'merchantIds']);
    return { type, merchantIds: stringList(input.merchantIds, /^[A-Za-z0-9:_-]{3,128}$/, 'merchant id') };
  }
  if (type === 'WALLET') {
    exactKeys(input, ['type', 'wallets']);
    return { type, wallets: canonicalWallets(stringList(input.wallets, /^0x[0-9a-fA-F]{40}$/, 'wallet')) };
  }
  throw new CoreError('InvalidRequest', 'Notification audience type is invalid');
}

function campaignMessage(value: unknown) {
  const input = record(value, 'notification message');
  exactKeys(input, ['titleKey', 'bodyKey', 'variables']);
  const titleKey = stringValue(input.titleKey, 'notification title key');
  const bodyKey = stringValue(input.bodyKey, 'notification body key');
  if (!/^[A-Z][A-Z0-9_]{2,95}$/.test(titleKey) || !/^[A-Z][A-Z0-9_]{2,95}$/.test(bodyKey)) {
    throw new CoreError('InvalidRequest', 'Notification copy key is invalid');
  }
  const variables = record(input.variables, 'notification variables');
  if (Object.keys(variables).length > 32 || Object.values(variables).some((item) => !isTemplatePrimitive(item))) {
    throw new CoreError('InvalidRequest', 'Notification variables are invalid');
  }
  return { titleKey, bodyKey, variables };
}

async function campaignAudit(executor: SqlExecutor, input: {
  eventType: string;
  campaignId: string;
  actorWallet: string;
  roles: string[];
  correlationId: string;
  requestHash: string;
  payload: Record<string, unknown>;
  now: Date;
}) {
  const evidenceHash = hashJson({ wallet: input.actorWallet, roles: input.roles, checkedAt: input.now.toISOString() });
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:notification', { eventType: input.eventType, campaignId: input.campaignId, requestHash: input.requestHash }),
    streamName: 'operational',
    evidenceProfile: 'RBAC',
    eventType: input.eventType,
    resourceType: 'NOTIFICATION_CAMPAIGN',
    resourceId: input.campaignId,
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
     WHERE lower(wallet_address) = $1 AND status = 'ACTIVE' AND role = ANY($2::text[]) ORDER BY role`,
    [wallet, [...allowed]],
  );
  if (result.rows.length === 0) throw new CoreError('Forbidden', 'Current wallet role cannot manage notifications', 403);
  return result.rows.map((row) => row.role);
}

function requireSessionRole(actor: FulfillmentActor, ...allowed: string[]) {
  if (!actor.roles.some((role) => allowed.includes(role))) throw new CoreError('Forbidden', 'Wallet session cannot manage notifications', 403);
}

function validateEndpointInput(input: {
  channel: NotificationChannel;
  provider: NotificationProvider;
  endpointReference: string;
  topics: string[];
  regionCode?: string;
  correlationId: string;
}) {
  const providers: Record<NotificationChannel, readonly NotificationProvider[]> = {
    IN_APP: ['CORE'],
    SMS: ['ALIYUN_SMS', 'TENCENT_SMS'],
    EMAIL: ['SMTP'],
    PUSH: ['FIREBASE', 'JPUSH'],
  };
  if (!providers[input.channel]?.includes(input.provider)) throw new CoreError('InvalidRequest', 'Notification provider does not match channel');
  if (!/^(?:vault|secret|recipient):\/\/[^\s]+$/.test(input.endpointReference)) {
    throw new CoreError('InvalidRequest', 'Notification endpoint must be a secret reference');
  }
  if (input.regionCode !== undefined && !/^\d{6}$/.test(input.regionCode)) throw new CoreError('InvalidRequest', 'Notification region code is invalid');
  canonicalTopics(input.topics);
}

function canonicalTopics(value: string[]) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new CoreError('InvalidRequest', 'Notification topics are invalid');
  const topics = [...new Set(value)].sort();
  if (topics.some((topic) => topic !== '*' && !/^[A-Z][A-Z0-9_]{2,95}$/.test(topic))) {
    throw new CoreError('InvalidRequest', 'Notification topic is invalid');
  }
  return topics;
}

function canonicalWallets(values: string[]) {
  return [...new Set(values.map(normalizeAddress))].sort();
}

function stringList(value: unknown, pattern: RegExp, name: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5_000) throw new CoreError('InvalidRequest', `Notification ${name} list is invalid`);
  const list = [...new Set(value.map((item) => stringValue(item, name)))].sort();
  if (list.some((item) => !pattern.test(item))) throw new CoreError('InvalidRequest', `Notification ${name} list is invalid`);
  return list;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('InvalidRequest', `${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new CoreError('InvalidRequest', 'Notification payload contains unknown fields');
}

function stringValue(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return value;
}

function optionalDate(value: string | undefined, name: string) {
  if (value === undefined) return null;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return result;
}

function isTemplatePrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(canonicalJson(value))).toLowerCase();
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
