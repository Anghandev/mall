import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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

export interface AdministrativeRegionResult {
  regionCode: string;
  province: string;
  city: string;
  district: string;
  formattedAddress: string;
  sourceReferenceHash: string;
}

export interface AdministrativeRegionResolver {
  reverseGeocode(input: { longitude: number; latitude: number }): Promise<AdministrativeRegionResult>;
}

export class AmapAdministrativeRegionResolver implements AdministrativeRegionResolver {
  readonly #key: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(input: { key?: string; fetch?: typeof fetch }) {
    this.#key = input.key;
    this.#fetch = input.fetch ?? globalThis.fetch;
  }

  async reverseGeocode(input: { longitude: number; latitude: number }) {
    if (
      !Number.isFinite(input.longitude)
      || input.longitude < -180
      || input.longitude > 180
      || !Number.isFinite(input.latitude)
      || input.latitude < -90
      || input.latitude > 90
    ) throw new CoreError('InvalidRequest', 'Invalid coordinates');
    if (!this.#key) throw new CoreError('ConfigurationRequired', 'AMAP is not configured', 503, { provider: 'AMAP' });
    const url = new URL('https://restapi.amap.com/v3/geocode/regeo');
    url.searchParams.set('key', this.#key);
    url.searchParams.set('location', `${input.longitude},${input.latitude}`);
    url.searchParams.set('extensions', 'base');
    url.searchParams.set('output', 'JSON');
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => {
      throw new CoreError('ExternalBlocked', 'AMAP reverse geocoding failed', 503, { provider: 'AMAP' });
    });
    if (!response.ok) {
      throw new CoreError('ExternalBlocked', 'AMAP reverse geocoding was rejected', 503, {
        provider: 'AMAP',
        status: response.status,
      });
    }
    const body = await response.json().catch(() => undefined) as
      | {
        status?: unknown;
        regeocode?: {
          formatted_address?: unknown;
          addressComponent?: { adcode?: unknown; province?: unknown; city?: unknown; district?: unknown };
        };
      }
      | undefined;
    const component = body?.regeocode?.addressComponent;
    const regionCode = stringValue(component?.adcode);
    const province = stringValue(component?.province);
    const district = stringValue(component?.district);
    const city = stringValue(component?.city) || province;
    const formattedAddress = stringValue(body?.regeocode?.formatted_address);
    if (
      body?.status !== '1'
      || !/^[0-9]{6}$/.test(regionCode)
      || !province
      || !city
      || !district
      || !formattedAddress
    ) throw new CoreError('ExternalBlocked', 'AMAP returned an incomplete six-digit administrative region', 503, {
      provider: 'AMAP',
    });
    return {
      regionCode,
      province,
      city,
      district,
      formattedAddress,
      sourceReferenceHash: `0x${createHash('sha256')
        .update(JSON.stringify({ regionCode, province, city, district, formattedAddress }))
        .digest('hex')}`,
    };
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}
