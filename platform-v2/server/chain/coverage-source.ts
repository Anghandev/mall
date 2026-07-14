import { Interface, JsonRpcProvider, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { CoreError } from '../api/errors.ts';
import type { CoverageObservation, CoverageSource } from './coverage-worker.ts';

const TOKEN = new Interface(['function balanceOf(address account) view returns (uint256)']);

export class ResilientBscCoverageSource implements CoverageSource {
  readonly #providers: readonly JsonRpcProvider[];
  readonly #assets: readonly {
    safeAddress: string;
    asset: 'USDT' | 'NPL';
    tokenAddress: string;
  }[];
  readonly #clock: () => Date;

  constructor(input: {
    primaryRpcUrl?: string;
    fallbackRpcUrl?: string;
    assets: readonly { safeAddress: string; asset: 'USDT' | 'NPL'; tokenAddress: string }[];
    clock?: () => Date;
  }) {
    if (!input.primaryRpcUrl || !input.fallbackRpcUrl) {
      throw new CoreError('ExternalBlocked', 'Two BSC RPC endpoints are required for coverage', 503);
    }
    if (input.assets.length === 0) throw new CoreError('ExternalBlocked', 'Coverage assets are unavailable', 503);
    this.#providers = [input.primaryRpcUrl, input.fallbackRpcUrl].map(
      (url) => new JsonRpcProvider(url, 56, { staticNetwork: true }),
    );
    const seen = new Set<string>();
    this.#assets = input.assets.map((item) => {
      const value = {
        safeAddress: address(item.safeAddress, 'coverage Safe'),
        asset: item.asset,
        tokenAddress: address(item.tokenAddress, 'coverage token'),
      };
      const key = `${value.safeAddress}:${value.asset}`;
      if (seen.has(key)) throw new CoreError('ExternalBlocked', 'Duplicate coverage asset', 503);
      seen.add(key);
      return value;
    }).sort((left, right) =>
      left.safeAddress.localeCompare(right.safeAddress) || left.asset.localeCompare(right.asset));
    this.#clock = input.clock ?? (() => new Date());
  }

  async observe(): Promise<CoverageObservation> {
    const networks = await Promise.all(this.#providers.map((provider) => provider.getNetwork()));
    if (networks.some((network) => network.chainId !== 56n)) {
      throw new CoreError('ExternalBlocked', 'Coverage RPC is not BSC chain 56', 503);
    }
    const heads = await Promise.all(this.#providers.map((provider) => provider.getBlockNumber()));
    const blockNumber = Math.min(...heads);
    const observations = await Promise.all(this.#providers.map((provider) => observeAt(
      provider,
      blockNumber,
      this.#assets,
    )));
    const [primary, fallback] = observations;
    if (!primary || !fallback || stableJson(primary) !== stableJson(fallback)) {
      throw new CoreError('InvalidFinality', 'BSC RPC sources disagree on coverage evidence', 409);
    }
    return {
      chainId: 56,
      blockNumber,
      blockHash: primary.blockHash,
      canonical: true,
      evidenceHash: hashJson({ blockNumber, primary, fallback }),
      observedAt: this.#clock(),
      assets: primary.assets,
    };
  }
}

async function observeAt(
  provider: JsonRpcProvider,
  blockNumber: number,
  assets: readonly { safeAddress: string; asset: 'USDT' | 'NPL'; tokenAddress: string }[],
) {
  const block = await provider.getBlock(blockNumber);
  if (!block?.hash) throw new CoreError('ExternalBlocked', 'Canonical coverage block is unavailable', 503);
  const values = await Promise.all(assets.map(async (asset) => {
    const result = await provider.call({
      to: asset.tokenAddress,
      data: TOKEN.encodeFunctionData('balanceOf', [asset.safeAddress]),
      blockTag: blockNumber,
    });
    const balance = String(TOKEN.decodeFunctionResult('balanceOf', result)[0]);
    return { ...asset, balance };
  }));
  return { blockHash: block.hash.toLowerCase(), assets: values };
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
