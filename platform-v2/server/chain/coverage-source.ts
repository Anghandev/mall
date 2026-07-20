import { Interface, JsonRpcProvider, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { CoreError } from '../api/errors.ts';
import type { CoverageObservation, CoverageSource } from './coverage-worker.ts';

const TOKEN = new Interface(['function balanceOf(address account) view returns (uint256)']);

type CoverageRpcProvider = Pick<JsonRpcProvider, 'getNetwork' | 'getBlock' | 'call'>;

export class ResilientBscCoverageSource implements CoverageSource {
  readonly #providers: readonly CoverageRpcProvider[];
  readonly #assets: readonly {
    walletAddress: string;
    asset: 'USDT' | 'NPL';
    tokenAddress: string;
  }[];
  readonly #clock: () => Date;

  constructor(input: {
    primaryRpcUrl?: string;
    fallbackRpcUrl?: string;
    providers?: readonly CoverageRpcProvider[];
    assets: readonly { walletAddress: string; asset: 'USDT' | 'NPL'; tokenAddress: string }[];
    clock?: () => Date;
  }) {
    if (input.providers && input.providers.length !== 2) {
      throw new CoreError('ExternalBlocked', 'Two BSC RPC endpoints are required for coverage', 503);
    }
    if (!input.providers && (!input.primaryRpcUrl || !input.fallbackRpcUrl)) {
      throw new CoreError('ExternalBlocked', 'Two BSC RPC endpoints are required for coverage', 503);
    }
    if (input.assets.length === 0) throw new CoreError('ExternalBlocked', 'Coverage assets are unavailable', 503);
    this.#providers = input.providers
      ? [...input.providers]
      : [input.primaryRpcUrl!, input.fallbackRpcUrl!].map(
          (url) => new JsonRpcProvider(url, 56, { staticNetwork: true }),
        );
    const seen = new Set<string>();
    this.#assets = input.assets.map((item) => {
      const value = {
        walletAddress: address(item.walletAddress, 'coverage wallet'),
        asset: item.asset,
        tokenAddress: address(item.tokenAddress, 'coverage token'),
      };
      const key = `${value.walletAddress}:${value.asset}`;
      if (seen.has(key)) throw new CoreError('ExternalBlocked', 'Duplicate coverage asset', 503);
      seen.add(key);
      return value;
    }).sort((left, right) =>
      left.walletAddress.localeCompare(right.walletAddress) || left.asset.localeCompare(right.asset));
    this.#clock = input.clock ?? (() => new Date());
  }

  async observe(): Promise<CoverageObservation> {
    const networks = await Promise.all(this.#providers.map((provider) => provider.getNetwork()));
    if (networks.some((network) => network.chainId !== 56n)) {
      throw new CoreError('ExternalBlocked', 'Coverage RPC is not BSC chain 56', 503);
    }
    const heads = await Promise.all(this.#providers.map((provider) => provider.getBlock('latest')));
    if (heads.some((head) => !head?.hash || !Number.isSafeInteger(head.number))) {
      throw new CoreError('ExternalBlocked', 'Latest canonical coverage block is unavailable', 503);
    }
    const commonHeight = Math.min(...heads.map((head) => head!.number));
    const observations = await Promise.all(this.#providers.map((provider) => observeBlock(
      provider,
      this.#assets,
      commonHeight,
    )));
    const [primary, fallback] = observations;
    if (!primary || !fallback || stableJson(primary) !== stableJson(fallback)) {
      throw new CoreError('InvalidFinality', 'BSC RPC sources disagree on coverage evidence', 409);
    }
    return {
      chainId: 56,
      blockNumber: primary.blockNumber,
      blockHash: primary.blockHash,
      canonical: true,
      evidenceHash: hashJson({ primary, fallback }),
      observedAt: this.#clock(),
      assets: primary.assets,
    };
  }
}

async function observeBlock(
  provider: CoverageRpcProvider,
  assets: readonly { walletAddress: string; asset: 'USDT' | 'NPL'; tokenAddress: string }[],
  blockNumber: number,
) {
  const before = await provider.getBlock(blockNumber);
  if (!before?.hash || before.number !== blockNumber) {
    throw new CoreError('ExternalBlocked', 'Common canonical coverage block is unavailable', 503);
  }
  const values = await Promise.all(assets.map(async (asset) => {
    const result = await provider.call({
      to: asset.tokenAddress,
      data: TOKEN.encodeFunctionData('balanceOf', [asset.walletAddress]),
      blockTag: blockNumber,
    });
    const balance = String(TOKEN.decodeFunctionResult('balanceOf', result)[0]);
    return { ...asset, balance };
  }));
  const after = await provider.getBlock(blockNumber);
  if (!after?.hash || after.number !== before.number || after.hash.toLowerCase() !== before.hash.toLowerCase()) {
    throw new CoreError('FinalityPending', 'Coverage block changed while balances were observed', 409);
  }
  return { blockNumber: before.number, blockHash: before.hash.toLowerCase(), assets: values };
}

function address(value: string, name: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('ExternalBlocked', `${name} address is unavailable`, 503);
  }
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(stableJson(value))).toLowerCase();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
