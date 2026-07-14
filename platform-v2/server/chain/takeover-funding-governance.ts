import { getAddress, keccak256 } from 'ethers';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';

export interface TakeoverFundingSafeApprovalInput {
  caseId: string;
  policyVersion: number;
  governanceSafeAddress: string;
  operationsSafeAddress: string;
  actionDigest: string;
  oldValueHash: string;
  newValueHash: string;
}

export interface TakeoverFundingSafeApprovalResult {
  safeTxHash: string;
  proposalReferenceHash: string;
  approvalEvidenceHash: string;
  ownerSetHash: string;
  threshold: number;
  approvals: readonly { ownerAddress: string; signatureHash: string }[];
}

export interface TakeoverFundingSafeApprover {
  verify(input: TakeoverFundingSafeApprovalInput): Promise<TakeoverFundingSafeApprovalResult>;
}

export class HttpTakeoverFundingSafeApprover implements TakeoverFundingSafeApprover {
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

  async verify(input: TakeoverFundingSafeApprovalInput) {
    if (!this.#url || !this.#token) {
      throw new CoreError('ConfigurationRequired', 'Takeover-funding Safe approval service is not configured', 503);
    }
    const url = new URL(this.#url);
    if (url.protocol !== 'https:' || url.username || url.password || !this.#mutualTls) {
      throw new CoreError('ExternalBlocked', 'Takeover-funding Safe approval transport requires HTTPS and mTLS', 503);
    }
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({ artifactVersion: CORE_ARTIFACT_VERSION, chainId: 56, ...input }),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Takeover-funding Safe approval was rejected', 503);
    const body = await response.json() as Record<string, unknown>;
    if (
      body.caseId !== input.caseId
      || body.actionDigest !== input.actionDigest
      || body.oldValueHash !== input.oldValueHash
      || body.newValueHash !== input.newValueHash
      || !isHash(body.safeTxHash)
      || !isHash(body.proposalReferenceHash)
      || !isHash(body.approvalEvidenceHash)
      || !isHash(body.ownerSetHash)
      || !Number.isSafeInteger(body.threshold)
      || Number(body.threshold) <= 0
      || !Array.isArray(body.approvals)
    ) throw new CoreError('InvalidFinality', 'Takeover-funding Safe approval is not plan-bound', 502);
    let approvals: { ownerAddress: string; signatureHash: string }[];
    try {
      approvals = body.approvals.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new CoreError('InvalidFinality', 'Takeover-funding Safe owner approval is malformed', 502);
        }
        const approval = value as Record<string, unknown>;
        if (typeof approval.ownerAddress !== 'string' || typeof approval.signature !== 'string') {
          throw new CoreError('InvalidFinality', 'Takeover-funding Safe owner approval is malformed', 502);
        }
        return {
          ownerAddress: getAddress(approval.ownerAddress).toLowerCase(),
          signatureHash: keccak256(approval.signature).toLowerCase(),
        };
      }).sort((left, right) => left.ownerAddress.localeCompare(right.ownerAddress));
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError('InvalidFinality', 'Takeover-funding Safe owner approval is malformed', 502);
    }
    if (
      approvals.length < Number(body.threshold)
      || approvals.some((approval, index) => approval.ownerAddress === approvals[index - 1]?.ownerAddress)
    ) throw new CoreError('InvalidFinality', 'Takeover-funding Safe owner threshold is not satisfied', 502);
    return {
      safeTxHash: body.safeTxHash.toLowerCase(),
      proposalReferenceHash: body.proposalReferenceHash.toLowerCase(),
      approvalEvidenceHash: body.approvalEvidenceHash.toLowerCase(),
      ownerSetHash: body.ownerSetHash.toLowerCase(),
      threshold: Number(body.threshold),
      approvals,
    };
  }
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}
