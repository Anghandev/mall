import { AbiCoder, Contract, JsonRpcProvider, getAddress, hashMessage, keccak256, type InterfaceAbi } from 'ethers';
import type { WalletMessageSignatureVerifier } from '../api/auth.ts';
import type { WalletDigestSignatureVerifier } from '../api/settlement-signing.ts';
import { CORE_ARTIFACT_VERSION, NPL_ADDRESS, NPL_USDT_PAIR_ADDRESS, USDT_ADDRESS } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import {
  paymentAllocationSetHash,
  paymentBeneficiarySetHash,
  type PaymentPolicySnapshot,
} from '../api/payment-policy.ts';
import type {
  BeneficiarySnapshotSource,
  PaymentNplQuoteSource,
  PaymentPolicyAttestationSource,
} from '../data/catalog-payment-service.ts';

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)',
];
const BENEFICIARY_ABI = [
  'function referrerOf(address member) view returns (address)',
  'function regionBeneficiaries(uint64 policyVersion,bytes32 regionCodeHash) view returns (address district,address city,address province,address region)',
];
export const PAYMENT_POLICY_TUPLE_ABI = 'tuple(uint64 version,uint16 usdtPaymentBps,uint16 nplPaymentBps,uint16 nplBurnListPriceBps,uint16 nplRewardListPriceBps,uint16 genesisBps,uint16 directReferralBps,uint16 districtBps,uint16 cityBps,uint16 provinceBps,uint16 regionBps,uint16 operationsBps,uint16 platformFeeBps,uint16 seckillPrizeBps,uint32 seckillMainDuration,uint32 relayInitial,uint32 relayIncrement,uint32 relayCap,uint128 merchantGuaranteeMinimum,address usdtCustodySafe,address nplRewardSafe,address operationsTreasurySafe,address circulationPool,bytes32 beneficiarySetHash,bytes32 concessionDestinationSetHash,bytes32 decisionEvidenceHash,bytes32 rulesContentHash)';
const POLICY_REGISTRY_ABI = [
  `function getPolicy(uint64 version) view returns (${PAYMENT_POLICY_TUPLE_ABI} policy)`,
  'function getOperations(uint64 version) view returns (address[] accounts,uint16[] weights)',
  'function latestVersion() view returns (uint64)',
];
const ERC1271_ABI = ['function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4)'];
const ERC1271_MAGIC_VALUE = '0x1626ba7e';

export interface ContractReader {
  call(address: string, abi: InterfaceAbi, method: string, args: readonly unknown[]): Promise<unknown>;
}

export interface PairReserveSnapshot {
  blockNumber: number;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
}

export interface PairReserveReader extends ContractReader {
  pairReserves(address: string): Promise<PairReserveSnapshot>;
}

export class ResilientBscContractReader implements PairReserveReader {
  readonly #providers: JsonRpcProvider[];

  constructor(primaryRpcUrl?: string, fallbackRpcUrl?: string) {
    if (!primaryRpcUrl || !fallbackRpcUrl) {
      throw new CoreError('ExternalBlocked', 'Primary and fallback BSC RPC are required', 503);
    }
    this.#providers = [primaryRpcUrl, fallbackRpcUrl].map((url) => new JsonRpcProvider(url, 56, { staticNetwork: true }));
  }

  async call(address: string, abi: InterfaceAbi, method: string, args: readonly unknown[]) {
    return this.#withProvider(async (provider) => {
      const contract = new Contract(address, abi, provider);
      const operation = contract.getFunction(method);
      return operation(...args);
    });
  }

  chainId() {
    return this.#withProvider(async (provider) => Number((await provider.getNetwork()).chainId));
  }

  code(address: string) {
    return this.#withProvider((provider) => provider.getCode(address));
  }

  async codeHash(address: string) {
    const code = await this.code(address);
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) {
      throw new CoreError('ExternalBlocked', 'Runtime code is unavailable', 503);
    }
    return keccak256(code).toLowerCase();
  }

  async pairReserves(pairAddress: string): Promise<PairReserveSnapshot> {
    try {
      const heads = await Promise.all(this.#providers.map(async (provider) => {
        const network = await provider.getNetwork();
        if (network.chainId !== 56n) throw new CoreError('ExternalBlocked', 'RPC is not BSC chain 56', 503);
        return provider.getBlockNumber();
      }));
      const blockNumber = Math.min(...heads);
      if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
        throw new CoreError('ExternalBlocked', 'BSC RPC common block is unavailable', 503);
      }
      const snapshots = await Promise.all(this.#providers.map(async (provider) => {
        const pair = new Contract(pairAddress, PAIR_ABI, provider);
        const [token0, token1, reserves] = await Promise.all([
          pair.getFunction('token0')({ blockTag: blockNumber }),
          pair.getFunction('token1')({ blockTag: blockNumber }),
          pair.getFunction('getReserves')({ blockTag: blockNumber }),
        ]);
        return {
          blockNumber,
          token0: getAddress(String(token0)),
          token1: getAddress(String(token1)),
          reserve0: BigInt(reserves[0]),
          reserve1: BigInt(reserves[1]),
        };
      }));
      if (stableRpcValue(snapshots[0]) !== stableRpcValue(snapshots[1])) {
        throw new CoreError('InvalidFinality', 'BSC RPC providers returned inconsistent pair reserves', 409);
      }
      return snapshots[0]!;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError('ExternalBlocked', 'Both BSC RPC providers must return matching pair reserves', 503, {
        reason: error instanceof Error ? error.name : 'UnknownRpcFailure',
      });
    }
  }

  async #withProvider<Result>(operation: (provider: JsonRpcProvider) => Promise<Result>) {
    try {
      const results = await Promise.all(this.#providers.map(async (provider) => {
        const network = await provider.getNetwork();
        if (network.chainId !== 56n) throw new CoreError('ExternalBlocked', 'RPC is not BSC chain 56', 503);
        return operation(provider);
      }));
      if (stableRpcValue(results[0]) !== stableRpcValue(results[1])) {
        throw new CoreError('InvalidFinality', 'BSC RPC providers returned inconsistent contract state', 409);
      }
      return results[0]!;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError('ExternalBlocked', 'Both BSC RPC providers must return matching state', 503, {
        reason: error instanceof Error ? error.name : 'UnknownRpcFailure',
      });
    }
  }
}

export class RpcPaymentNplQuoteSource implements PaymentNplQuoteSource {
  readonly #reader: PairReserveReader;

  constructor(input: { reader: PairReserveReader }) {
    this.#reader = input.reader;
  }

  async quote(input: { listPriceUsdt: bigint; policyVersion: number }) {
    if (input.listPriceUsdt <= 0n || input.policyVersion <= 0) {
      throw new CoreError('InvalidRequest', 'Invalid NPL quote request');
    }
    const snapshot = await this.#reader.pairReserves(NPL_USDT_PAIR_ADDRESS);
    const token0 = snapshot.token0.toLowerCase();
    const token1 = snapshot.token1.toLowerCase();
    const validOrder = (token0 === USDT_ADDRESS && token1 === NPL_ADDRESS)
      || (token0 === NPL_ADDRESS && token1 === USDT_ADDRESS);
    if (!validOrder) throw new CoreError('InvalidFinality', 'Configured pair does not contain NPL and USDT', 409);
    const usdtLiquidity = token0 === USDT_ADDRESS ? snapshot.reserve0 : snapshot.reserve1;
    const nplLiquidity = token0 === NPL_ADDRESS ? snapshot.reserve0 : snapshot.reserve1;
    if (usdtLiquidity <= 0n || nplLiquidity <= 0n) {
      throw new CoreError('InvalidFinality', 'NPL/USDT pair reserves are empty', 409);
    }
    if (usdtLiquidity < 50_000n * 10n ** 18n) {
      throw new CoreError('InventoryUnavailable', 'NPL quote USDT liquidity is below the frozen minimum', 409);
    }
    const nplQuoteAmount = input.listPriceUsdt * nplLiquidity / usdtLiquidity;
    if (nplQuoteAmount <= 0n) throw new CoreError('InvalidFinality', 'NPL quote rounds to zero', 409);
    return { nplQuoteAmount };
  }
}

export class RpcBeneficiarySnapshotSource implements BeneficiarySnapshotSource {
  readonly #reader: ContractReader;
  readonly #registryAddress: string;

  constructor(input: { reader: ContractReader; beneficiaryRegistryAddress?: string }) {
    this.#reader = input.reader;
    this.#registryAddress = address(input.beneficiaryRegistryAddress, 'BeneficiaryRegistry');
  }

  async resolve(input: { buyer: string; merchant: string; regionCodeHash: string; policyVersion: number }) {
    const buyer = address(input.buyer, 'buyer');
    address(input.merchant, 'merchant');
    if (!isHash(input.regionCodeHash) || !Number.isSafeInteger(input.policyVersion) || input.policyVersion <= 0) {
      throw new CoreError('InvalidRequest', 'Invalid beneficiary snapshot request');
    }
    const [referrerValue, regionValue] = await Promise.all([
      this.#reader.call(this.#registryAddress, BENEFICIARY_ABI, 'referrerOf', [buyer]),
      this.#reader.call(
        this.#registryAddress,
        BENEFICIARY_ABI,
        'regionBeneficiaries',
        [input.policyVersion, input.regionCodeHash],
      ),
    ]);
    const referrer = address(String(referrerValue), 'direct referrer');
    if (referrer.toLowerCase() === buyer.toLowerCase()) {
      throw new CoreError('InvalidFinality', 'Self-referral is forbidden', 409);
    }
    const region = regionValue as readonly [string, string, string, string];
    return Object.freeze({
      genesis: ZERO_ADDRESS,
      directReferral: referrer.toLowerCase(),
      district: address(String(region[0]), 'district beneficiary').toLowerCase(),
      city: address(String(region[1]), 'city beneficiary').toLowerCase(),
      province: address(String(region[2]), 'province beneficiary').toLowerCase(),
      region: address(String(region[3]), 'region beneficiary').toLowerCase(),
    });
  }
}

export class RpcPaymentPolicyAttestationSource implements PaymentPolicyAttestationSource {
  readonly #reader: ContractReader;
  readonly #registryAddress: string;

  constructor(input: { reader: ContractReader; policyRegistryAddress?: string }) {
    this.#reader = input.reader;
    this.#registryAddress = address(input.policyRegistryAddress, 'PolicyRegistry');
  }

  async assertPublished(input: {
    artifactVersion: string;
    policyHash: string;
    rulesContentHash: string;
    beneficiarySetHash: string;
    policy: PaymentPolicySnapshot;
    requireLatest: boolean;
  }) {
    if (input.artifactVersion !== CORE_ARTIFACT_VERSION) {
      throw new CoreError('ArtifactVersionMismatch', 'Payment policy artifact version is not current', 409);
    }
    const [rawPolicy, rawOperations, latestVersion] = await Promise.all([
      this.#reader.call(this.#registryAddress, POLICY_REGISTRY_ABI, 'getPolicy', [input.policy.policyVersion]),
      this.#reader.call(this.#registryAddress, POLICY_REGISTRY_ABI, 'getOperations', [input.policy.policyVersion]),
      input.requireLatest
        ? this.#reader.call(this.#registryAddress, POLICY_REGISTRY_ABI, 'latestVersion', [])
        : Promise.resolve(input.policy.policyVersion),
    ]);
    const chain = policyValues(rawPolicy);
    const policyHash = keccak256(AbiCoder.defaultAbiCoder().encode([PAYMENT_POLICY_TUPLE_ABI], [chain]));
    const operations = rawOperations as readonly [readonly string[], readonly bigint[]];
    const operationAccounts = [...operations[0]].map((value) => address(String(value), 'operations beneficiary').toLowerCase());
    const operationWeights = [...operations[1]].map((value) => Number(value));
    const destinationHash = paymentAllocationSetHash();
    const beneficiarySetHash = paymentBeneficiarySetHash(
      input.policy.genesisNodeDestinations,
      input.policy.operationsDestinations,
    );
    const comparisons: Array<[string, unknown, unknown]> = [
      ['policyHash', policyHash.toLowerCase(), input.policyHash.toLowerCase()],
      ['version', Number(chain[0]), input.policy.policyVersion],
      ['latestVersion', Number(latestVersion), input.policy.policyVersion],
      ['usdtPaymentBps', Number(chain[1]), input.policy.usdtPaymentBps],
      ['nplPaymentBps', Number(chain[2]), input.policy.nplPaymentBps],
      ['nplBurnListPriceBps', Number(chain[3]), input.policy.nplBurnListPriceBps],
      ['nplRewardListPriceBps', Number(chain[4]), input.policy.nplRewardListPriceBps],
      ['genesisBps', Number(chain[5]), input.policy.genesisBps],
      ['directReferralBps', Number(chain[6]), input.policy.directReferralBps],
      ['districtBps', Number(chain[7]), input.policy.districtBps],
      ['cityBps', Number(chain[8]), input.policy.cityBps],
      ['provinceBps', Number(chain[9]), input.policy.provinceBps],
      ['regionBps', Number(chain[10]), input.policy.regionBps],
      ['operationsBps', Number(chain[11]), input.policy.operationsBps],
      ['platformFeeBps', Number(chain[12]), input.policy.platformFeeBps],
      ['seckillPrizeBps', Number(chain[13]), input.policy.seckillPrizeBps],
      ['seckillMainDuration', Number(chain[14]), input.policy.seckillMainDuration],
      ['relayInitial', Number(chain[15]), input.policy.relayInitial],
      ['relayIncrement', Number(chain[16]), input.policy.relayIncrement],
      ['relayCap', Number(chain[17]), input.policy.relayCap],
      ['merchantGuaranteeMinimum', BigInt(String(chain[18])), input.policy.merchantGuaranteeMinimumUsdt],
      ['usdtCustodySafe', String(chain[19]).toLowerCase(), input.policy.usdtCustodySafe.toLowerCase()],
      ['nplRewardSafe', String(chain[20]).toLowerCase(), input.policy.nplRewardSafe.toLowerCase()],
      ['operationsTreasurySafe', String(chain[21]).toLowerCase(), input.policy.operationsTreasurySafe.toLowerCase()],
      ['circulationPool', String(chain[22]).toLowerCase(), input.policy.circulationPool.toLowerCase()],
      ['beneficiarySetHash', String(chain[23]).toLowerCase(), input.beneficiarySetHash.toLowerCase()],
      ['configuredBeneficiarySetHash', beneficiarySetHash.toLowerCase(), input.beneficiarySetHash.toLowerCase()],
      ['concessionDestinationSetHash', String(chain[24]).toLowerCase(), input.policy.concessionDestinationSetHash.toLowerCase()],
      ['destinationHash', destinationHash.toLowerCase(), input.policy.concessionDestinationSetHash.toLowerCase()],
      ['decisionEvidenceHash', String(chain[25]).toLowerCase(), input.policy.decisionEvidenceHash.toLowerCase()],
      ['rulesContentHash', String(chain[26]).toLowerCase(), input.rulesContentHash.toLowerCase()],
      ['operationAccounts', JSON.stringify(operationAccounts), JSON.stringify(input.policy.operationsDestinations.map((item) => item.account))],
      ['operationWeights', JSON.stringify(operationWeights), JSON.stringify(input.policy.operationsDestinations.map((item) => item.weightBps))],
    ];
    const mismatch = comparisons.find(([, actual, expected]) => actual !== expected);
    if (mismatch) {
      throw new CoreError('InvalidFinality', `Payment policy attestation mismatch: ${mismatch[0]}`, 409);
    }
  }
}

export class RpcWalletMessageSignatureVerifier implements WalletMessageSignatureVerifier, WalletDigestSignatureVerifier {
  readonly #reader: ContractReader;

  constructor(reader: ContractReader) {
    this.#reader = reader;
  }

  async isValid(walletAddress: string, message: string, signature: string) {
    return this.isValidDigest(walletAddress, hashMessage(message), signature);
  }

  async isValidDigest(walletAddress: string, digest: string, signature: string) {
    try {
      const result = await this.#reader.call(
        address(walletAddress, 'contract wallet'),
        ERC1271_ABI,
        'isValidSignature',
        [digest, signature],
      );
      return String(result).toLowerCase() === ERC1271_MAGIC_VALUE;
    } catch {
      return false;
    }
  }
}

function policyValues(value: unknown) {
  if (!Array.isArray(value) || value.length !== 27) {
    throw new CoreError('InvalidFinality', 'PolicyRegistry returned an invalid policy tuple', 409);
  }
  return value;
}

function address(value: string | undefined, name: string) {
  if (!value) throw new CoreError('ExternalBlocked', `${name} address is unavailable`, 503);
  try {
    return getAddress(value);
  } catch {
    throw new CoreError('InvalidRequest', `${name} address is invalid`);
  }
}

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function stableRpcValue(value: unknown) {
  return JSON.stringify(value, (_key, child) => typeof child === 'bigint' ? child.toString() : child);
}
