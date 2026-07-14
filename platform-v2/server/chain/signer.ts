import { recoverAddress } from 'ethers';
import { CoreError } from '../api/errors.ts';

export interface SignerRequest {
  purpose: 'ORDER_QUOTE' | 'FINALITY' | 'SENSITIVE_ACTION';
  digest: string;
  resourceId: string;
  policyVersion: number;
  deadline: number;
  idempotencyKey: string;
}

export class RemoteSignerClient {
  readonly #url: string;
  readonly #token: string;
  readonly #expectedSigner: string;
  readonly #fetch: typeof fetch;

  constructor(input: { url?: string; token?: string; expectedSigner?: string; fetch?: typeof fetch }) {
    if (!input.url || !input.token || !input.expectedSigner) {
      throw new CoreError('ExternalBlocked', 'Remote signer configuration is unavailable', 503);
    }
    this.#url = input.url;
    this.#token = input.token;
    this.#expectedSigner = input.expectedSigner.toLowerCase();
    this.#fetch = input.fetch ?? fetch;
  }

  async sign(request: SignerRequest) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(request.digest) || request.deadline <= Math.floor(Date.now() / 1000)) {
      throw new CoreError('InvalidRequest', 'Signer request digest or deadline is invalid');
    }
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Remote signer rejected the request', 503);
    const body = (await response.json()) as { signature?: string };
    if (!body.signature) throw new CoreError('InvalidSignature', 'Remote signer returned no signature', 502);
    let recovered: string;
    try {
      recovered = recoverAddress(request.digest, body.signature).toLowerCase();
    } catch {
      throw new CoreError('InvalidSignature', 'Remote signer returned an invalid signature', 502);
    }
    if (recovered !== this.#expectedSigner) throw new CoreError('InvalidSignature', 'Unexpected remote signer', 502);
    return { signature: body.signature, signer: recovered };
  }
}
