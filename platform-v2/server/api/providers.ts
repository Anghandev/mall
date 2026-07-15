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

export interface ParsedPostalAddress {
  recipientName: string | null;
  phone: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  detailAddress: string | null;
  regionCode: string | null;
  longitude: number | null;
  latitude: number | null;
  sourceReferenceHash: string | null;
}

export interface PostalAddressParser {
  parse(input: { rawText: string }): Promise<ParsedPostalAddress>;
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

export class AmapPostalAddressParser implements PostalAddressParser {
  readonly #key: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(input: { key?: string; fetch?: typeof fetch }) {
    this.#key = input.key;
    this.#fetch = input.fetch ?? globalThis.fetch;
  }

  async parse(input: { rawText: string }) {
    const rawText = input.rawText.trim();
    if (rawText.length < 5 || rawText.length > 1_000) {
      throw new CoreError('InvalidRequest', 'Address text must contain 5-1000 characters');
    }
    if (!this.#key) throw new CoreError('ConfigurationRequired', 'AMAP is not configured', 503, { provider: 'AMAP' });
    const phoneMatch = rawText.match(/(?:^|\D)(1[3-9][0-9]{9})(?:\D|$)/);
    const phone = phoneMatch?.[1] ?? null;
    const recipientName = extractRecipientName(rawText, phone);
    const addressQuery = rawText
      .replace(phone ?? '', ' ')
      .replace(recipientName ?? '', ' ')
      .replace(/[\s,，;；|]+/g, ' ')
      .trim();
    if (addressQuery.length < 4) return emptyParsedAddress(recipientName, phone);
    const url = new URL('https://restapi.amap.com/v3/geocode/geo');
    url.searchParams.set('key', this.#key);
    url.searchParams.set('address', addressQuery);
    url.searchParams.set('output', 'JSON');
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => {
      throw new CoreError('ExternalBlocked', 'AMAP address parsing failed', 503, { provider: 'AMAP' });
    });
    if (!response.ok) {
      throw new CoreError('ExternalBlocked', 'AMAP address parsing was rejected', 503, {
        provider: 'AMAP',
        status: response.status,
      });
    }
    const body = await response.json().catch(() => undefined) as
      | {
        status?: unknown;
        geocodes?: Array<{
          formatted_address?: unknown;
          province?: unknown;
          city?: unknown;
          district?: unknown;
          adcode?: unknown;
          location?: unknown;
        }>;
      }
      | undefined;
    const geocode = body?.geocodes?.[0];
    const province = stringValue(geocode?.province);
    const city = stringValue(geocode?.city) || province;
    const district = stringValue(geocode?.district);
    const regionCode = stringValue(geocode?.adcode);
    const detailAddress = stringValue(geocode?.formatted_address) || addressQuery;
    const [longitudeText, latitudeText] = stringValue(geocode?.location).split(',');
    const longitude = Number(longitudeText);
    const latitude = Number(latitudeText);
    if (
      body?.status !== '1'
      || !province
      || !city
      || !district
      || !/^[0-9]{6}$/.test(regionCode)
      || !Number.isFinite(longitude)
      || !Number.isFinite(latitude)
    ) return emptyParsedAddress(recipientName, phone, { detailAddress: addressQuery });
    const sourceReferenceHash = `0x${createHash('sha256').update(JSON.stringify({
      province,
      city,
      district,
      regionCode,
      detailAddress,
      longitude,
      latitude,
    })).digest('hex')}`;
    return {
      recipientName,
      phone,
      province,
      city,
      district,
      detailAddress,
      regionCode,
      longitude,
      latitude,
      sourceReferenceHash,
    };
  }
}

function extractRecipientName(rawText: string, phone: string | null) {
  const beforePhone = phone ? rawText.slice(0, rawText.indexOf(phone)) : rawText;
  const candidates = beforePhone
    .split(/[\s,，;；|]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const candidate = candidates.find((value) => (
    value.length >= 2
    && value.length <= 32
    && !/[省市区县镇乡路街道号栋室]/.test(value)
    && !/[0-9]/.test(value)
  ));
  return candidate ?? null;
}

function emptyParsedAddress(
  recipientName: string | null,
  phone: string | null,
  partial: Partial<ParsedPostalAddress> = {},
): ParsedPostalAddress {
  return {
    recipientName,
    phone,
    province: null,
    city: null,
    district: null,
    detailAddress: null,
    regionCode: null,
    longitude: null,
    latitude: null,
    sourceReferenceHash: null,
    ...partial,
  };
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}
