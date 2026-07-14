import { AbiCoder, Contract, JsonRpcProvider, getAddress, hashMessage, keccak256, type InterfaceAbi } from 'ethers';
import type { WalletMessageSignatureVerifier } from '../api/auth.ts';
import { CORE_ARTIFACT_VERSION, NPL_ADDRESS, NPL_USDT_PAIR_ADDRESS, USDT_ADDRESS } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { paymentAllocationSetHash, type PaymentPolicySnapshot } from '../api/payment-policy.ts';
import type {
  BeneficiarySnapshotSource,
  PaymentOracleQuoteSource,
  PaymentPolicyAttestationSource,
} from '../data/catalog-payment-service.ts';

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const SOURCE_ABI = [
  'function pair() view returns (address)',
  'function consult(address pair,address baseToken,address quoteToken,uint256 baseAmount,uint32 window) view returns (uint256 quoteAmount,uint128 usdtLiquidity,uint64 updatedAt)',
];
const BENEFICIARY_ABI = [
  'function referrerOf(address member) view returns (address)',
  'function regionBeneficiaries(bytes32 regionCodeHash) view returns (address district,address city,address province,address region)',
  'function isGenesisEligible(uint64 policyVersion,address account) view returns (bool)',
];
export const PAYMENT_POLICY_TUPLE_ABI = 'tuple(uint64 version,uint16 usdtPaymentBps,uint16 nplPaymentBps,uint16 nplBurnListPriceBps,uint16 nplRewardListPriceBps,uint16 genesisBps,uint16 directReferralBps,uint16 districtBps,uint16 cityBps,uint16 provinceBps,uint16 regionBps,uint16 operationsBps,uint16 platformFeeBps,uint16 seckillPrizeBps,uint32 seckillMainDuration,uint32 relayInitial,uint32 relayIncrement,uint32 relayCap,bytes32 oracleVersion,uint64 oracleMaxAge,uint128 oracleMinLiquidity,uint128 merchantGuaranteeMinimum,address usdtCustodySafe,address nplRewardSafe,address operationsTreasurySafe,address circulationPool,address genesisCredential,uint256 genesisTokenId,uint8 genesisCredentialStandard,bytes32 beneficiarySetHash,bytes32 concessionDestinationSetHash,bytes32 decisionEvidenceHash,bytes32 rulesContentHash)';
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

export class ResilientBscContractReader implements ContractReader {
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

  async #withProvider<Result>(operation: (provider: JsonRpcProvider) => Promise<Result>) {
    let lastError: unknown;
    for (const provider of this.#providers) {
      try {
        const network = await provider.getNetwork();
        if (network.chainId !== 56n) throw new CoreError('ExternalBlocked', 'RPC is not BSC chain 56', 503);
        return await operation(provider);
      } catch (error) {
        lastError = error;
      }
    }
    throw new CoreError('ExternalBlocked', 'Both BSC RPC providers failed', 503, {
      reason: lastError instanceof Error ? lastError.name : 'UnknownRpcFailure',
    });
  }
}

export class RpcPaymentOracleQuoteSource implements PaymentOracleQuoteSource {
  readonly #reader: ContractReader;
  readonly #sourceAddress: string;
  readonly #clock: () => Date;

  constructor(input: { reader: ContractReader; sourceAddress?: string; clock?: () => Date }) {
    this.#reader = input.reader;
    this.#sourceAddress = address(input.sourceAddress, 'TWAP source');
    this.#clock = input.clock ?? (() => new Date());
  }

  async quote(input: { listPriceUsdt: bigint; policyVersion: number; oracleVersion: string }) {
    if (input.listPriceUsdt <= 0n || input.policyVersion <= 0 || !isHash(input.oracleVersion)) {
      throw new CoreError('InvalidRequest', 'Invalid Oracle quote request');
    }
    const pair = String(await this.#reader.call(this.#sourceAddress, SOURCE_ABI, 'pair', []));
    if (pair.toLowerCase() !== NPL_USDT_PAIR_ADDRESS) {
      throw new CoreError('InvalidFinality', 'TWAP source uses the wrong NPL/USDT pair', 409);
    }
    const raw = await this.#reader.call(this.#sourceAddress, SOURCE_ABI, 'consult', [
      NPL_USDT_PAIR_ADDRESS,
      USDT_ADDRESS,
      NPL_ADDRESS,
      input.listPriceUsdt,
      1_800,
    ]);
    const result = raw as readonly [bigint, bigint, bigint];
    const nplQuoteAmount = BigInt(result[0]);
    const usdtLiquidity = BigInt(result[1]);
    const updatedAt = Number(result[2]);
    const now = Math.floor(this.#clock().getTime() / 1000);
    if (nplQuoteAmount <= 0n || !Number.isSafeInteger(updatedAt) || updatedAt > now) {
      throw new CoreError('InvalidFinality', 'TWAP source returned an invalid observation', 409);
    }
    if (now - updatedAt > 10 * 60) throw new CoreError('QuoteExpired', 'TWAP observation is stale', 409);
    if (usdtLiquidity < 50_000n * 10n ** 18n) {
      throw new CoreError('InventoryUnavailable', 'TWAP USDT liquidity is below the frozen minimum', 409);
    }
    return { nplQuoteAmount, oracleVersion: input.oracleVersion };
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
    const [referrerValue, regionValue, genesisValue] = await Promise.all([
      this.#reader.call(this.#registryAddress, BENEFICIARY_ABI, 'referrerOf', [buyer]),
      this.#reader.call(this.#registryAddress, BENEFICIARY_ABI, 'regionBeneficiaries', [input.regionCodeHash]),
      this.#reader.call(this.#registryAddress, BENEFICIARY_ABI, 'isGenesisEligible', [input.policyVersion, buyer]),
    ]);
    const referrer = address(String(referrerValue), 'direct referrer');
    if (referrer.toLowerCase() === buyer.toLowerCase()) {
      throw new CoreError('InvalidFinality', 'Self-referral is forbidden', 409);
    }
    const region = regionValue as readonly [string, string, string, string];
    return Object.freeze({
      genesis: Boolean(genesisValue) ? buyer.toLowerCase() : ZERO_ADDRESS,
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
    const operationsHash = keccak256(AbiCoder.defaultAbiCoder().encode(
      ['address[]', 'uint16[]'],
      [operationAccounts, operationWeights],
    ));
    const destinationHash = paymentAllocationSetHash(
      input.policy.concessionDestinations,
      input.policy.otherUsdtDestinations,
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
      ['oracleVersion', String(chain[18]).toLowerCase(), input.policy.oracleVersion.toLowerCase()],
      ['oracleMaxAge', Number(chain[19]), input.policy.oracleMaxAgeSeconds],
      ['oracleMinLiquidity', BigInt(String(chain[20])), input.policy.oracleMinimumUsdtLiquidity],
      ['merchantGuaranteeMinimum', BigInt(String(chain[21])), input.policy.merchantGuaranteeMinimumUsdt],
      ['usdtCustodySafe', String(chain[22]).toLowerCase(), input.policy.usdtCustodySafe.toLowerCase()],
      ['nplRewardSafe', String(chain[23]).toLowerCase(), input.policy.nplRewardSafe.toLowerCase()],
      ['operationsTreasurySafe', String(chain[24]).toLowerCase(), input.policy.operationsTreasurySafe.toLowerCase()],
      ['circulationPool', String(chain[25]).toLowerCase(), input.policy.circulationPool.toLowerCase()],
      ['genesisCredential', String(chain[26]).toLowerCase(), input.policy.genesisCredential.toLowerCase()],
      ['genesisTokenId', BigInt(String(chain[27])), input.policy.genesisTokenId],
      ['genesisCredentialStandard', Number(chain[28]), input.policy.genesisCredentialStandard],
      ['beneficiarySetHash', String(chain[29]).toLowerCase(), input.beneficiarySetHash.toLowerCase()],
      ['operationsHash', operationsHash.toLowerCase(), input.beneficiarySetHash.toLowerCase()],
      ['concessionDestinationSetHash', String(chain[30]).toLowerCase(), input.policy.concessionDestinationSetHash.toLowerCase()],
      ['destinationHash', destinationHash.toLowerCase(), input.policy.concessionDestinationSetHash.toLowerCase()],
      ['decisionEvidenceHash', String(chain[31]).toLowerCase(), input.policy.decisionEvidenceHash.toLowerCase()],
      ['rulesContentHash', String(chain[32]).toLowerCase(), input.rulesContentHash.toLowerCase()],
      ['operationAccounts', JSON.stringify(operationAccounts), JSON.stringify(input.policy.operationsDestinations.map((item) => item.account))],
      ['operationWeights', JSON.stringify(operationWeights), JSON.stringify(input.policy.operationsDestinations.map((item) => item.weightBps))],
    ];
    const mismatch = comparisons.find(([, actual, expected]) => actual !== expected);
    if (mismatch) {
      throw new CoreError('InvalidFinality', `Payment policy attestation mismatch: ${mismatch[0]}`, 409);
    }
  }
}

export class RpcWalletMessageSignatureVerifier implements WalletMessageSignatureVerifier {
  readonly #reader: ContractReader;

  constructor(reader: ContractReader) {
    this.#reader = reader;
  }

  async isValid(walletAddress: string, message: string, signature: string) {
    try {
      const result = await this.#reader.call(
        address(walletAddress, 'contract wallet'),
        ERC1271_ABI,
        'isValidSignature',
        [hashMessage(message), signature],
      );
      return String(result).toLowerCase() === ERC1271_MAGIC_VALUE;
    } catch {
      return false;
    }
  }
}

function policyValues(value: unknown) {
  if (!Array.isArray(value) || value.length !== 33) {
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
