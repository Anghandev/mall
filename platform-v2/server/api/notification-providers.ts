import { CoreError } from './errors.ts';

export type ExternalNotificationProvider = 'ALIYUN_SMS' | 'TENCENT_SMS' | 'SMTP' | 'FIREBASE' | 'JPUSH';

export interface NotificationSendInput {
  deliveryId: string;
  provider: ExternalNotificationProvider;
  endpointReference: string;
  topic: string;
  templateData: Record<string, unknown>;
}

export interface NotificationSendResult {
  providerMessageId: string;
  acceptedAt: string;
}

export interface NotificationProviderAdapter {
  readonly provider: ExternalNotificationProvider;
  send(input: NotificationSendInput): Promise<NotificationSendResult>;
}

export interface SecretReferenceResolver {
  resolve(reference: string): Promise<string | undefined>;
}

export class HttpSecretReferenceResolver implements SecretReferenceResolver {
  readonly #url: string | undefined;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(input: { url?: string; token?: string; fetchImpl?: typeof fetch }) {
    this.#url = input.url;
    this.#token = input.token;
    this.#fetch = input.fetchImpl ?? fetch;
  }

  async resolve(reference: string) {
    if (!this.#url || !this.#token) return undefined;
    const url = new URL(this.#url);
    if (url.protocol !== 'https:') throw new CoreError('ExternalBlocked', 'Secret resolver requires HTTPS', 503);
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({ reference }),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Secret resolver request failed', 503);
    const body = await response.json() as Record<string, unknown>;
    if (body.reference !== reference || typeof body.value !== 'string' || body.value.length === 0) {
      throw new CoreError('InvalidFinality', 'Secret resolver response is not reference-bound', 502);
    }
    return body.value;
  }
}

export class HttpNotificationProviderAdapter implements NotificationProviderAdapter {
  readonly provider: ExternalNotificationProvider;
  readonly #gatewayUrl: string | undefined;
  readonly #credentialReference: string | undefined;
  readonly #resolver: SecretReferenceResolver;
  readonly #fetch: typeof fetch;

  constructor(input: {
    provider: ExternalNotificationProvider;
    gatewayUrl?: string;
    credentialReference?: string;
    resolver: SecretReferenceResolver;
    fetchImpl?: typeof fetch;
  }) {
    this.provider = input.provider;
    this.#gatewayUrl = input.gatewayUrl;
    this.#credentialReference = input.credentialReference;
    this.#resolver = input.resolver;
    this.#fetch = input.fetchImpl ?? fetch;
  }

  async send(input: NotificationSendInput) {
    if (input.provider !== this.provider) throw new CoreError('InvalidRequest', 'Notification provider adapter mismatch');
    if (!this.#gatewayUrl || !this.#credentialReference) {
      throw new CoreError('ConfigurationRequired', `${this.provider} notification adapter is not configured`, 503);
    }
    let url: URL;
    try {
      url = new URL(this.#gatewayUrl);
    } catch {
      throw new CoreError('ConfigurationRequired', `${this.provider} gateway URL is invalid`, 503);
    }
    if (url.protocol !== 'https:') throw new CoreError('ExternalBlocked', `${this.provider} gateway requires HTTPS`, 503);
    const [credential, recipient] = await Promise.all([
      this.#resolver.resolve(this.#credentialReference),
      this.#resolver.resolve(input.endpointReference),
    ]);
    if (!credential || !recipient) {
      throw new CoreError('ConfigurationRequired', `${this.provider} secret reference is unavailable`, 503);
    }
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: JSON.stringify({
        provider: this.provider,
        idempotencyKey: input.deliveryId,
        recipient,
        topic: input.topic,
        templateData: input.templateData,
      }),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', `${this.provider} notification delivery failed`, 503);
    const body = await response.json() as Record<string, unknown>;
    if (
      body.idempotencyKey !== input.deliveryId
      || typeof body.providerMessageId !== 'string'
      || body.providerMessageId.length < 1
      || body.providerMessageId.length > 256
      || typeof body.acceptedAt !== 'string'
      || Number.isNaN(new Date(body.acceptedAt).getTime())
    ) throw new CoreError('InvalidFinality', `${this.provider} response is not idempotency-bound`, 502);
    return { providerMessageId: body.providerMessageId, acceptedAt: new Date(body.acceptedAt).toISOString() };
  }
}
