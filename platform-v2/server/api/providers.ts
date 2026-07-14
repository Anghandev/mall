import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CoreConfig, ProviderName } from './config.ts';
import { requireProvider } from './config.ts';
import { CoreError } from './errors.ts';

export interface ProviderRequest {
  provider: ProviderName;
  operation: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface ProviderAdapter {
  execute(request: ProviderRequest): Promise<{ providerReference: string; acceptedAt: string }>;
}

export async function executeProvider(
  config: CoreConfig,
  adapters: Readonly<Partial<Record<ProviderName, ProviderAdapter>>>,
  request: ProviderRequest,
) {
  requireProvider(config, request.provider);
  const adapter = adapters[request.provider];
  if (!adapter) throw new CoreError('ExternalBlocked', `${request.provider} adapter is unavailable`, 503);
  return adapter.execute(request);
}

export function verifyWebhookHmac(rawBody: Buffer, signatureHex: string, secret: string) {
  if (!secret) throw new CoreError('ConfigurationRequired', 'Webhook secret is unavailable', 503);
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const received = Buffer.from(signatureHex.toLowerCase());
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new CoreError('ProviderSignatureInvalid', 'Webhook signature mismatch', 401);
  }
  return true;
}
