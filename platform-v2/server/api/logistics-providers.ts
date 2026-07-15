import { createHash, randomUUID } from 'node:crypto';
import { CoreError } from './errors.ts';
import {
  AmbiguousProviderResultError,
  type PostalParty,
  type PrintAdapter,
  type WaybillAdapter,
} from '../data/logistics-printing-service.ts';

const KUAIDI100_CARRIERS = {
  SF: 'shunfeng',
  JD: 'jd',
  YTO: 'yuantong',
  ZTO: 'zhongtong',
  STO: 'shentong',
  EMS: 'ems',
} as const;

export class FeiePrintAdapter implements PrintAdapter {
  readonly #user: string | undefined;
  readonly #ukey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(input: { user?: string; ukey?: string; fetch?: typeof fetch }) {
    this.#user = input.user;
    this.#ukey = input.ukey;
    this.#fetch = input.fetch ?? globalThis.fetch;
  }

  async print(input: { printJobId: string; deviceId: string; content: string; copyCount: 1 | 2 }) {
    if (!this.#user || !this.#ukey) throw configurationRequired('FEIE');
    if (Buffer.byteLength(input.content, 'utf8') > 5_000) {
      throw new CoreError('InvalidRequest', 'FEIE print content exceeds 5000 bytes');
    }
    const stime = Math.floor(Date.now() / 1_000).toString();
    const body = new URLSearchParams({
      user: this.#user,
      stime,
      sig: sha1(`${this.#user}${this.#ukey}${stime}`),
      apiname: 'Open_printMsg',
      sn: input.deviceId,
      content: input.content,
      times: String(input.copyCount),
    });
    const response = await postForm(this.#fetch, 'https://api.feieyun.cn/Api/Open/', body, 'FEIE');
    const payload = await jsonObject(response, 'FEIE');
    if (Number(payload.ret) !== 0 || typeof payload.data !== 'string' || !payload.data.trim()) {
      throw new CoreError('ExternalBlocked', 'FEIE rejected the print job', 503, {
        provider: 'FEIE',
        providerCode: String(payload.ret ?? 'UNKNOWN'),
      });
    }
    return { providerReference: payload.data.trim() };
  }
}

export class YilianyunPrintAdapter implements PrintAdapter {
  readonly #clientId: string | undefined;
  readonly #clientSecret: string | undefined;
  readonly #accessToken: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(input: {
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    fetch?: typeof fetch;
  }) {
    this.#clientId = input.clientId;
    this.#clientSecret = input.clientSecret;
    this.#accessToken = input.accessToken;
    this.#fetch = input.fetch ?? globalThis.fetch;
  }

  async print(input: { printJobId: string; deviceId: string; content: string; copyCount: 1 | 2 }) {
    if (!this.#clientId || !this.#clientSecret || !this.#accessToken) throw configurationRequired('YILIANYUN');
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const body = new URLSearchParams({
      client_id: this.#clientId,
      timestamp,
      sign: md5(`${this.#clientId}${timestamp}${this.#clientSecret}`),
      id: randomUUID(),
      access_token: this.#accessToken,
      machine_code: input.deviceId,
      origin_id: providerId(input.printJobId).slice(0, 64),
      idempotence: '1',
      content: input.content,
      copies: String(input.copyCount),
    });
    const response = await postForm(this.#fetch, 'https://open-api.10ss.net/v2/print/index', body, 'YILIANYUN');
    const payload = await jsonObject(response, 'YILIANYUN');
    const result = objectValue(payload.body);
    if (Number(payload.error) !== 0 || !result || !String(result.id ?? '').trim()) {
      throw new CoreError('ExternalBlocked', 'YILIANYUN rejected the print job', 503, {
        provider: 'YILIANYUN',
        providerCode: String(payload.error ?? 'UNKNOWN'),
      });
    }
    return { providerReference: String(result.id) };
  }
}

export class Kuaidi100WaybillAdapter implements WaybillAdapter {
  readonly #key: string | undefined;
  readonly #secret: string | undefined;
  readonly #customer: string | undefined;
  readonly #siid: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(input: { key?: string; secret?: string; customer?: string; siid?: string; fetch?: typeof fetch }) {
    this.#key = input.key;
    this.#secret = input.secret;
    this.#customer = input.customer;
    this.#siid = input.siid;
    this.#fetch = input.fetch ?? globalThis.fetch;
  }

  async createWaybill(input: Parameters<WaybillAdapter['createWaybill']>[0]) {
    if (!this.#key || !this.#secret || !this.#customer || !this.#siid) throw configurationRequired('KUAIDI100');
    const timestamp = Date.now().toString();
    const param = JSON.stringify({
      orderId: providerId(input.requestId),
      kuaidicom: KUAIDI100_CARRIERS[input.carrierCode],
      partnerId: this.#customer,
      recMan: input.recipient.name,
      recMobile: input.recipient.phone,
      recAddr: input.recipient.address,
      sendMan: input.sender.name,
      sendMobile: input.sender.phone,
      sendAddr: input.sender.address,
      cargo: `ABU24K-${input.orderId}`,
      count: input.quantity,
      printType: 'CLOUD',
      siid: this.#siid,
      reorder: false,
    });
    const body = new URLSearchParams({
      method: 'order',
      key: this.#key,
      t: timestamp,
      param,
      sign: md5(`${param}${timestamp}${this.#key}${this.#secret}`).toUpperCase(),
    });
    const response = await postForm(this.#fetch, 'https://api.kuaidi100.com/label/order', body, 'KUAIDI100');
    const payload = await jsonObject(response, 'KUAIDI100');
    const data = objectValue(payload.data);
    const trackingNumber = String(data?.kuaidinum ?? '').trim();
    const providerReference = String(data?.taskId ?? '').trim();
    if (payload.success !== true || !['200', '30011'].includes(String(payload.code)) || !trackingNumber || !providerReference) {
      throw new CoreError('ExternalBlocked', 'KUAIDI100 rejected the waybill request', 503, {
        provider: 'KUAIDI100',
        providerCode: String(payload.code ?? 'UNKNOWN'),
      });
    }
    return { providerReference, trackingNumber };
  }
}

export interface CainiaoDigestSigner {
  sign(logisticsInterface: string): Promise<string>;
}

export class HttpCainiaoDigestSigner implements CainiaoDigestSigner {
  readonly #url: string | undefined;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(input: { url?: string; token?: string; fetch?: typeof fetch }) {
    this.#url = input.url;
    this.#token = input.token;
    this.#fetch = input.fetch ?? globalThis.fetch;
  }

  async sign(logisticsInterface: string) {
    if (!this.#url || !this.#token) throw configurationRequired('CAINIAO');
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ apiId: 'TMS_WAYBILL_GET', logisticsInterface }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      throw new CoreError('ExternalBlocked', 'Cainiao digest signer is unavailable', 503, { provider: 'CAINIAO' });
    });
    const payload = await jsonObject(response, 'CAINIAO');
    const digest = String(payload.dataDigest ?? '').trim();
    if (!response.ok || !digest) throw new CoreError('ExternalBlocked', 'Cainiao digest signer rejected the request', 503);
    return digest;
  }
}

export class CainiaoWaybillAdapter implements WaybillAdapter {
  readonly #logisticProviderId: string | undefined;
  readonly #signer: CainiaoDigestSigner;
  readonly #fetch: typeof fetch;

  constructor(input: { logisticProviderId?: string; signer: CainiaoDigestSigner; fetch?: typeof fetch }) {
    this.#logisticProviderId = input.logisticProviderId;
    this.#signer = input.signer;
    this.#fetch = input.fetch ?? globalThis.fetch;
  }

  async createWaybill(input: Parameters<WaybillAdapter['createWaybill']>[0]) {
    if (!this.#logisticProviderId) throw configurationRequired('CAINIAO');
    const objectId = input.requestId;
    const logisticsInterface = JSON.stringify({
      cpCode: input.carrierCode,
      sender: party(input.sender),
      recipient: party(input.recipient),
      tradeOrderInfoDtos: [{
        objectId,
        orderInfo: { tradeOrderList: [input.orderId] },
        packageInfo: { id: objectId, itemCount: input.quantity },
      }],
    });
    const dataDigest = await this.#signer.sign(logisticsInterface);
    const body = new URLSearchParams({
      msg_type: 'TMS_WAYBILL_GET',
      logistic_provider_id: this.#logisticProviderId,
      data_digest: dataDigest,
      logistics_interface: logisticsInterface,
    });
    const response = await postForm(
      this.#fetch,
      'https://link.cainiao.com/gateway/link.do',
      body,
      'CAINIAO',
    );
    const payload = await jsonObject(response, 'CAINIAO');
    const items = Array.isArray(payload.waybillCloudPrintResponseList)
      ? payload.waybillCloudPrintResponseList as Array<Record<string, unknown>>
      : [];
    const result = items.find((item) => item.objectId === objectId) ?? items[0];
    const trackingNumber = String(result?.waybillCode ?? '').trim();
    if (payload.success !== true || !trackingNumber) {
      throw new CoreError('ExternalBlocked', 'Cainiao rejected the waybill request', 503, {
        provider: 'CAINIAO',
        providerCode: String(payload.errorCode ?? 'UNKNOWN'),
      });
    }
    return { providerReference: trackingNumber, trackingNumber };
  }
}

async function postForm(fetcher: typeof fetch, url: string, body: URLSearchParams, provider: string) {
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', `${provider} returned HTTP ${response.status}`, 503, { provider });
    return response;
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new AmbiguousProviderResultError(`${provider} request ended without a definitive response`);
  }
}

async function jsonObject(response: Response, provider: string) {
  const payload = await response.json().catch(() => undefined);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CoreError('ExternalBlocked', `${provider} returned an invalid response`, 503, { provider });
  }
  return payload as Record<string, unknown>;
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function party(value: PostalParty) {
  return { name: value.name, mobile: value.phone, address: value.address };
}

function configurationRequired(provider: string) {
  return new CoreError('ConfigurationRequired', `${provider} is not configured`, 503, { provider });
}

function sha1(value: string) {
  return createHash('sha1').update(value).digest('hex');
}

function md5(value: string) {
  return createHash('md5').update(value).digest('hex');
}

function providerId(value: string) {
  return value.startsWith('0x') ? value.slice(2) : value;
}
