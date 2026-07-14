import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';

export interface SystemConfigSafeApprovalInput {
  configVersionId: string;
  configKey: string;
  version: number;
  safeAddress: string;
  actionDigest: string;
  oldValueHash: string;
  newValueHash: string;
}

export interface SystemConfigSafeApprovalResult {
  safeTxHash: string;
  approvalEvidenceHash: string;
}

export interface SystemConfigSafeApprover {
  verify(input: SystemConfigSafeApprovalInput): Promise<SystemConfigSafeApprovalResult>;
}

export class HttpSystemConfigSafeApprover implements SystemConfigSafeApprover {
  readonly #url: string | undefined;
  readonly #token: string | undefined;
  readonly #mutualTls: boolean;
  readonly #fetch: typeof fetch;

  constructor(input: { url?: string; token?: string; mutualTls?: boolean; fetchImpl?: typeof fetch }) {
    this.#url = input.url;
    this.#token = input.token;
    this.#mutualTls = input.mutualTls === true;
    this.#fetch = input.fetchImpl ?? fetch;
  }

  async verify(input: SystemConfigSafeApprovalInput) {
    if (!this.#url || !this.#token) {
      throw new CoreError('ConfigurationRequired', 'System-config Safe approval service is not configured', 503);
    }
    const url = new URL(this.#url);
    if (url.protocol !== 'https:' || !this.#mutualTls) {
      throw new CoreError('ExternalBlocked', 'System-config Safe approval transport requires HTTPS and mTLS', 503);
    }
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({ artifactVersion: CORE_ARTIFACT_VERSION, chainId: 56, ...input }),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', 'System-config Safe approval was rejected', 503);
    const body = await response.json() as Record<string, unknown>;
    if (
      body.configVersionId !== input.configVersionId
      || body.actionDigest !== input.actionDigest
      || !isHash(body.safeTxHash)
      || !isHash(body.approvalEvidenceHash)
    ) throw new CoreError('InvalidFinality', 'System-config Safe approval is not digest-bound', 502);
    return {
      safeTxHash: body.safeTxHash.toLowerCase(),
      approvalEvidenceHash: body.approvalEvidenceHash.toLowerCase(),
    };
  }
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}
