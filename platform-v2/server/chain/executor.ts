import { CoreError } from '../api/errors.ts';

export interface ExecutionRequest {
  chainId: 56;
  to: string;
  data: string;
  value: '0';
  resourceId: string;
  policyVersion: number;
  idempotencyKey: string;
  gasLimit: string;
  replacementForTxHash?: string;
}

export class RemoteExecutorClient {
  readonly #url: string;
  readonly #token: string;
  readonly #maxGasLimit: bigint;
  readonly #fetch: typeof fetch;

  constructor(input: { url?: string; token?: string; maxGasLimit: bigint; fetch?: typeof fetch }) {
    if (!input.url || !input.token) throw new CoreError('ExternalBlocked', 'Remote executor is unavailable', 503);
    this.#url = input.url;
    this.#token = input.token;
    this.#maxGasLimit = input.maxGasLimit;
    this.#fetch = input.fetch ?? fetch;
  }

  async execute(request: ExecutionRequest) {
    if (
      request.chainId !== 56 ||
      request.value !== '0' ||
      !/^0x[0-9a-fA-F]{40}$/.test(request.to) ||
      !/^0x[0-9a-fA-F]*$/.test(request.data) ||
      BigInt(request.gasLimit) <= 0n ||
      BigInt(request.gasLimit) > this.#maxGasLimit
    ) {
      throw new CoreError('InvalidRequest', 'Executor request violates the bounded transaction plan');
    }
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Remote executor rejected the request', 503);
    const body = (await response.json()) as { txHash?: string; replacementForTxHash?: string };
    if (!body.txHash || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
      throw new CoreError('InvalidFinality', 'Remote executor returned an invalid transaction hash', 502);
    }
    if (request.replacementForTxHash && body.replacementForTxHash !== request.replacementForTxHash) {
      throw new CoreError('InvalidFinality', 'Replacement transaction evidence mismatch', 502);
    }
    return body;
  }
}
