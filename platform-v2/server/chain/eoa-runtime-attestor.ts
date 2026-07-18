import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { CoreError } from '../api/errors.ts';
import type { EoaRuntimeEvidence } from '../data/settlement-service.ts';

export interface EoaRuntimeReader {
  chainId(): Promise<number>;
  code(address: string): Promise<string>;
  codeHash(address: string): Promise<string>;
  transactionCount(address: string): Promise<number>;
}

export interface EoaRuntimeExpectations {
  walletAddress: string;
  tokenAddress: string;
  tokenCodeHash: string;
  tokenTransferConformanceEvidenceHash: string;
}

export class RpcEoaRuntimeAttestor {
  readonly #reader: EoaRuntimeReader;
  readonly #expected: EoaRuntimeExpectations;
  readonly #clock: () => Date;

  constructor(input: {
    reader: EoaRuntimeReader;
    expected: EoaRuntimeExpectations;
    clock?: () => Date;
  }) {
    this.#reader = input.reader;
    this.#expected = validateExpectations(input.expected);
    this.#clock = input.clock ?? (() => new Date());
  }

  async attest(): Promise<EoaRuntimeEvidence> {
    const [chainId, walletCode, tokenCodeHash, nextNonce] = await Promise.all([
      this.#reader.chainId(),
      this.#reader.code(this.#expected.walletAddress),
      this.#reader.codeHash(this.#expected.tokenAddress),
      this.#reader.transactionCount(this.#expected.walletAddress),
    ]);
    if (
      chainId !== 56
      || walletCode !== '0x'
      || tokenCodeHash.toLowerCase() !== this.#expected.tokenCodeHash
      || !Number.isSafeInteger(nextNonce)
      || nextNonce < 0
    ) {
      throw new CoreError('ExternalBlocked', 'EOA settlement runtime does not match configured expectations', 503);
    }
    const checkedAt = this.#clock();
    const evidenceHash = keccak256(toUtf8Bytes(JSON.stringify({
      chainId,
      executorWallet: this.#expected.walletAddress,
      tokenAddress: this.#expected.tokenAddress,
      tokenCodeHash: this.#expected.tokenCodeHash,
      nextNonce,
      tokenTransferConformanceEvidenceHash: this.#expected.tokenTransferConformanceEvidenceHash,
      checkedAt: checkedAt.toISOString(),
    })));
    return {
      executorWallet: this.#expected.walletAddress,
      nextNonce: String(nextNonce),
      tokenAddress: this.#expected.tokenAddress,
      tokenCodeHash: this.#expected.tokenCodeHash,
      tokenTransferConformanceEvidenceHash: this.#expected.tokenTransferConformanceEvidenceHash,
      evidenceHash: evidenceHash.toLowerCase(),
      checkedAt,
    };
  }
}

function validateExpectations(value: EoaRuntimeExpectations): EoaRuntimeExpectations {
  return {
    walletAddress: address(value.walletAddress, 'EOA executor wallet'),
    tokenAddress: address(value.tokenAddress, 'settlement token'),
    tokenCodeHash: hash(value.tokenCodeHash, 'token code hash'),
    tokenTransferConformanceEvidenceHash: hash(
      value.tokenTransferConformanceEvidenceHash,
      'token transfer conformance evidence hash',
    ),
  };
}

function address(value: string, name: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('ExternalBlocked', `${name} is unavailable`, 503);
  }
}

function hash(value: string, name: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new CoreError('ExternalBlocked', `${name} is unavailable`, 503);
  }
  return value.toLowerCase();
}
