import { randomUUID } from 'node:crypto';
import { keccak256, toUtf8Bytes } from 'ethers';
import { CoreError } from '../api/errors.ts';
import type {
  ExternalNotificationProvider,
  NotificationProviderAdapter,
} from '../api/notification-providers.ts';
import type { NotificationService } from '../data/notification-service.ts';
import { auditSourceId, enqueueAudit } from '../data/audit-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from '../data/migrations.ts';

const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 8;

interface DeliveryRow {
  delivery_id: string;
  message_id: string;
  channel: 'IN_APP' | 'SMS' | 'EMAIL' | 'PUSH';
  provider: 'CORE' | ExternalNotificationProvider;
  endpoint_reference: string;
  attempt_count: number;
  locked_by: string;
  topic: string;
  template_data: Record<string, unknown>;
}

export class NotificationWorker {
  readonly #transactions: SqlTransactionRunner;
  readonly #service: NotificationService;
  readonly #adapters: ReadonlyMap<ExternalNotificationProvider, NotificationProviderAdapter>;
  readonly #workerId: string;
  readonly #clock: () => Date;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #lastErrorCode: string | undefined;

  constructor(input: {
    transactions: SqlTransactionRunner;
    service: NotificationService;
    adapters?: readonly NotificationProviderAdapter[];
    workerId?: string;
    clock?: () => Date;
    intervalMs?: number;
  }) {
    this.#transactions = input.transactions;
    this.#service = input.service;
    this.#adapters = new Map((input.adapters ?? []).map((adapter) => [adapter.provider, adapter]));
    this.#workerId = input.workerId ?? `notification:${randomUUID()}`;
    this.#clock = input.clock ?? (() => new Date());
    this.#intervalMs = input.intervalMs ?? 2_000;
  }

  async pollOnce() {
    await this.#service.projectNext(20);
    const deliveries = await this.#transactions.transaction((executor) => leaseDeliveries(executor, this.#workerId, this.#clock(), 20));
    for (const delivery of deliveries) {
      try {
        let providerMessageId: string;
        let deliveredAt = this.#clock();
        if (delivery.provider === 'CORE') {
          providerMessageId = delivery.delivery_id;
        } else {
          const adapter = this.#adapters.get(delivery.provider);
          if (!adapter) throw new CoreError('ConfigurationRequired', `${delivery.provider} adapter is unavailable`, 503);
          const result = await adapter.send({
            deliveryId: delivery.delivery_id,
            provider: delivery.provider,
            endpointReference: delivery.endpoint_reference,
            topic: delivery.topic,
            templateData: delivery.template_data,
          });
          providerMessageId = result.providerMessageId;
          deliveredAt = new Date(result.acceptedAt);
        }
        await this.#transactions.transaction((executor) => markDelivered(
          executor,
          delivery,
          this.#workerId,
          providerMessageId,
          deliveredAt,
        ));
        this.#lastErrorCode = undefined;
      } catch (error) {
        const code = errorCode(error);
        this.#lastErrorCode = code;
        await this.#transactions.transaction((executor) => markFailed(
          executor,
          delivery,
          this.#workerId,
          code,
          error instanceof CoreError && error.code === 'ConfigurationRequired',
          this.#clock(),
        ));
      }
    }
    return deliveries.length;
  }

  start() {
    if (this.#timer || this.#running) return;
    const tick = () => {
      this.#running = this.pollOnce()
        .then(() => undefined)
        .catch((error) => { this.#lastErrorCode = errorCode(error); })
        .finally(() => {
          this.#running = undefined;
          if (this.#timer) this.#timer = setTimeout(tick, this.#intervalMs);
        });
    };
    this.#timer = setTimeout(tick, 0);
  }

  async stop() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }

  status() {
    return Object.freeze({ healthy: this.#lastErrorCode === undefined, errorCode: this.#lastErrorCode });
  }

  retryConfigured(provider: ExternalNotificationProvider) {
    if (!this.#adapters.has(provider)) throw new CoreError('ConfigurationRequired', `${provider} adapter is unavailable`, 503);
    return this.#transactions.transaction(async (executor) => {
      const now = this.#clock();
      const result = await executor.query<DeliveryAuditRow>(
        `UPDATE core.notification_deliveries SET state = 'RETRY', available_at = $2,
           last_error_code = NULL WHERE provider = $1 AND state = 'CONFIGURATION_REQUIRED'
         RETURNING delivery_id, message_id, channel, provider, endpoint_reference, attempt_count`,
        [provider, now],
      );
      for (const delivery of result.rows) {
        await enqueueDeliveryAudit(executor, delivery, {
          eventType: 'NotificationDeliveryRetryScheduled',
          state: 'RETRY',
          createdAt: now,
        });
      }
      return result.rows.length;
    });
  }
}

async function leaseDeliveries(
  executor: SqlExecutor,
  workerId: string,
  now: Date,
  limit: number,
) {
  const result = await executor.query<DeliveryRow>(
    `WITH candidates AS (
       SELECT delivery.delivery_id FROM core.notification_deliveries delivery
       WHERE (delivery.state IN ('PENDING', 'RETRY') AND delivery.available_at <= $1)
          OR (delivery.state = 'PROCESSING' AND delivery.locked_until <= $1)
       ORDER BY delivery.available_at, delivery.delivery_id
       FOR UPDATE SKIP LOCKED LIMIT $2
     )
     UPDATE core.notification_deliveries delivery
     SET state = 'PROCESSING', locked_by = $3, locked_until = $4,
         attempt_count = delivery.attempt_count + 1
     FROM candidates, core.notification_messages message
     WHERE delivery.delivery_id = candidates.delivery_id
       AND message.message_id = delivery.message_id
     RETURNING delivery.*, message.topic, message.template_data`,
    [now, limit, workerId, new Date(now.getTime() + LEASE_MS)],
  );
  return result.rows;
}

async function markDelivered(
  executor: SqlExecutor,
  delivery: DeliveryRow,
  workerId: string,
  providerMessageId: string,
  deliveredAt: Date,
) {
  const result = await executor.query(
    `UPDATE core.notification_deliveries SET state = 'DELIVERED',
       provider_message_id = $4, delivered_at = $5, locked_by = NULL,
       locked_until = NULL, last_error_code = NULL
     WHERE delivery_id = $1 AND state = 'PROCESSING' AND locked_by = $2
       AND attempt_count = $3 RETURNING delivery_id`,
    [delivery.delivery_id, workerId, delivery.attempt_count, providerMessageId, deliveredAt],
  );
  if (!result.rows[0]) throw new Error('NotificationLeaseLost');
  await enqueueDeliveryAudit(executor, delivery, {
    eventType: 'NotificationDeliveryDelivered',
    state: 'DELIVERED',
    providerMessageId,
    createdAt: deliveredAt,
  });
}

async function markFailed(
  executor: SqlExecutor,
  delivery: DeliveryRow,
  workerId: string,
  code: string,
  configurationRequired: boolean,
  now: Date,
) {
  const state = configurationRequired
    ? 'CONFIGURATION_REQUIRED'
    : delivery.attempt_count >= MAX_ATTEMPTS ? 'DEAD_LETTER' : 'RETRY';
  const result = await executor.query(
    `UPDATE core.notification_deliveries SET state = $4, available_at = $5,
       locked_by = NULL, locked_until = NULL, last_error_code = $6
     WHERE delivery_id = $1 AND state = 'PROCESSING' AND locked_by = $2
       AND attempt_count = $3 RETURNING delivery_id`,
    [
      delivery.delivery_id,
      workerId,
      delivery.attempt_count,
      state,
      new Date(now.getTime() + Math.min(300_000, 2 ** Math.min(delivery.attempt_count, 8) * 1_000)),
      code,
    ],
  );
  if (!result.rows[0]) throw new Error('NotificationLeaseLost');
  await enqueueDeliveryAudit(executor, delivery, {
    eventType: state === 'RETRY'
      ? 'NotificationDeliveryRetryScheduled'
      : state === 'CONFIGURATION_REQUIRED'
        ? 'NotificationDeliveryConfigurationRequired'
        : 'NotificationDeliveryDeadLettered',
    state,
    errorCode: code,
    createdAt: now,
  });
}

interface DeliveryAuditRow {
  delivery_id: string;
  message_id: string;
  channel: DeliveryRow['channel'];
  provider: DeliveryRow['provider'];
  endpoint_reference: string;
  attempt_count: number;
}

async function enqueueDeliveryAudit(executor: SqlExecutor, delivery: DeliveryAuditRow, input: {
  eventType:
    | 'NotificationDeliveryDelivered'
    | 'NotificationDeliveryRetryScheduled'
    | 'NotificationDeliveryConfigurationRequired'
    | 'NotificationDeliveryDeadLettered';
  state: 'DELIVERED' | 'RETRY' | 'CONFIGURATION_REQUIRED' | 'DEAD_LETTER';
  errorCode?: string;
  providerMessageId?: string;
  createdAt: Date;
}) {
  const endpointReferenceHash = keccak256(toUtf8Bytes(delivery.endpoint_reference)).toLowerCase();
  const providerMessageIdHash = input.providerMessageId
    ? keccak256(toUtf8Bytes(input.providerMessageId)).toLowerCase()
    : undefined;
  const evidenceHash = hashJson({
    deliveryId: delivery.delivery_id,
    messageId: delivery.message_id,
    channel: delivery.channel,
    provider: delivery.provider,
    state: input.state,
    attemptCount: delivery.attempt_count,
    endpointReferenceHash,
    errorCode: input.errorCode ?? null,
    providerMessageIdHash: providerMessageIdHash ?? null,
    createdAt: input.createdAt.toISOString(),
  });
  const sourceEventId = auditSourceId('audit:notification-delivery', {
    eventType: input.eventType,
    deliveryId: delivery.delivery_id,
    attemptCount: delivery.attempt_count,
    evidenceHash,
  });
  await enqueueAudit(executor, {
    sourceEventId,
    streamName: 'operational',
    evidenceProfile: 'SYSTEM',
    eventType: input.eventType,
    resourceType: 'NOTIFICATION_DELIVERY',
    resourceId: delivery.delivery_id,
    actorRole: 'NOTIFICATION_WORKER',
    correlationId: sourceEventId,
    requestHash: evidenceHash.slice(2),
    payload: {
      deliveryId: delivery.delivery_id,
      messageId: delivery.message_id,
      channel: delivery.channel,
      provider: delivery.provider,
      state: input.state,
      attemptCount: delivery.attempt_count,
      endpointReferenceHash,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(providerMessageIdHash ? { providerMessageIdHash } : {}),
      evidenceHash,
    },
    createdAt: input.createdAt,
  });
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

function errorCode(error: unknown) {
  if (error instanceof CoreError) return error.code;
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.message)) return error.message;
  return 'NotificationDeliveryFailed';
}
