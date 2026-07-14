import type {
  ExactUsdtAllocation,
  FrozenPaymentPolicy,
  WeightedDestination,
} from './checkout.ts';
import { AbiCoder, keccak256 } from 'ethers';
import { assertPolicyReady } from './checkout.ts';
import { CoreError } from './errors.ts';

const BPS = 10_000n;

export interface PaymentPolicySnapshot extends FrozenPaymentPolicy {
  platformFeeBps: number;
  seckillPrizeBps: number;
  seckillMainDuration: number;
  relayInitial: number;
  relayIncrement: number;
  relayCap: number;
  usdtCustodySafe: string;
  nplRewardSafe: string;
  operationsTreasurySafe: string;
  circulationPool: string;
  genesisCredential: string;
  genesisTokenId: bigint;
  genesisCredentialStandard: number;
  concessionDestinationSetHash: string;
  decisionEvidenceHash: string;
  concessionDestinations: readonly WeightedDestination[];
  operationsDestinations: readonly WeightedDestination[];
  otherUsdtDestinations: readonly WeightedDestination[];
}

export function parsePaymentPolicySnapshot(
  policyVersion: number,
  oracleVersion: string,
  payload: unknown,
): PaymentPolicySnapshot {
  const value = record(payload, 'payment policy');
  const policy: PaymentPolicySnapshot = {
    policyVersion,
    oracleVersion,
    usdtPaymentBps: integer(value.usdtPaymentBps, 'usdtPaymentBps'),
    nplPaymentBps: integer(value.nplPaymentBps, 'nplPaymentBps'),
    nplBurnListPriceBps: integer(value.nplBurnListPriceBps, 'nplBurnListPriceBps'),
    nplRewardListPriceBps: integer(value.nplRewardListPriceBps, 'nplRewardListPriceBps'),
    genesisBps: integer(value.genesisBps, 'genesisBps'),
    directReferralBps: integer(value.directReferralBps, 'directReferralBps'),
    districtBps: integer(value.districtBps, 'districtBps'),
    cityBps: integer(value.cityBps, 'cityBps'),
    provinceBps: integer(value.provinceBps, 'provinceBps'),
    regionBps: integer(value.regionBps, 'regionBps'),
    operationsBps: integer(value.operationsBps, 'operationsBps'),
    platformFeeBps: integer(value.platformFeeBps, 'platformFeeBps'),
    seckillPrizeBps: integer(value.seckillPrizeBps, 'seckillPrizeBps'),
    seckillMainDuration: integer(value.seckillMainDuration, 'seckillMainDuration'),
    relayInitial: integer(value.relayInitial, 'relayInitial'),
    relayIncrement: integer(value.relayIncrement, 'relayIncrement'),
    relayCap: integer(value.relayCap, 'relayCap'),
    oracleWindowSeconds: integer(value.oracleWindowSeconds, 'oracleWindowSeconds'),
    oracleMaxDeviationBps: integer(value.oracleMaxDeviationBps, 'oracleMaxDeviationBps'),
    oracleMaxAgeSeconds: integer(value.oracleMaxAgeSeconds, 'oracleMaxAgeSeconds'),
    oracleMinimumUsdtLiquidity: unsigned(value.oracleMinimumUsdtLiquidity, 'oracleMinimumUsdtLiquidity'),
    requiredConfirmations: integer(value.requiredConfirmations, 'requiredConfirmations'),
    merchantGuaranteeMinimumUsdt: unsigned(value.merchantGuaranteeMinimumUsdt, 'merchantGuaranteeMinimumUsdt'),
    usdtCustodySafe: text(value.usdtCustodySafe, 'usdtCustodySafe'),
    nplRewardSafe: text(value.nplRewardSafe, 'nplRewardSafe'),
    operationsTreasurySafe: text(value.operationsTreasurySafe, 'operationsTreasurySafe'),
    circulationPool: text(value.circulationPool, 'circulationPool'),
    genesisCredential: text(value.genesisCredential, 'genesisCredential'),
    genesisTokenId: unsigned(value.genesisTokenId, 'genesisTokenId'),
    genesisCredentialStandard: integer(value.genesisCredentialStandard, 'genesisCredentialStandard'),
    concessionDestinationSetHash: text(value.concessionDestinationSetHash, 'concessionDestinationSetHash'),
    decisionEvidenceHash: text(value.decisionEvidenceHash, 'decisionEvidenceHash'),
    concessionDestinations: destinations(value.concessionDestinations, 'concessionDestinations'),
    operationsDestinations: destinations(value.operationsDestinations, 'operationsDestinations'),
    otherUsdtDestinations: destinations(value.otherUsdtDestinations, 'otherUsdtDestinations'),
  };
  assertPolicyReady(policy);
  if (
    policy.platformFeeBps > 10_000
      || policy.seckillPrizeBps > 10_000
      || policy.platformFeeBps + policy.seckillPrizeBps > 10_000
      || policy.seckillMainDuration <= 0
      || policy.relayInitial <= 0
      || policy.relayIncrement <= 0
      || policy.relayCap <= 0
      || policy.relayInitial > policy.relayCap
      || policy.relayCap > policy.seckillMainDuration
      || !/^0x[0-9a-fA-F]{40}$/.test(policy.genesisCredential)
      || ![1, 2].includes(policy.genesisCredentialStandard)
      || !/^0x[0-9a-fA-F]{64}$/.test(policy.decisionEvidenceHash)
  ) throw new CoreError('InvalidRequest', 'Published payment policy contains invalid governed fields');
  validateDestinations(policy.otherUsdtDestinations, 'otherUsdtDestinations');
  return Object.freeze(policy);
}

export function buildOtherUsdtAllocations(
  listPriceUsdt: bigint,
  merchantBaseReceivableUsdt: bigint,
  policy: PaymentPolicySnapshot,
): readonly ExactUsdtAllocation[] {
  const buyerUsdt = (listPriceUsdt * BigInt(policy.usdtPaymentBps)) / BPS;
  if (merchantBaseReceivableUsdt > buyerUsdt) {
    throw new CoreError('InvalidRequest', 'Merchant base receivable exceeds buyer USDT payment');
  }
  const amount = buyerUsdt - merchantBaseReceivableUsdt;
  let allocated = 0n;
  return Object.freeze(policy.otherUsdtDestinations.map((destination, index) => {
    const share = index + 1 === policy.otherUsdtDestinations.length
      ? amount - allocated
      : (amount * BigInt(destination.weightBps)) / BPS;
    allocated += share;
    return Object.freeze({
      account: destination.account.toLowerCase(),
      amount: share,
      purpose: 'POLICY_ALLOCATION',
    });
  }));
}

export function paymentAllocationSetHash(
  concessionDestinations: readonly WeightedDestination[],
  otherUsdtDestinations: readonly WeightedDestination[],
) {
  validateDestinations(concessionDestinations, 'concessionDestinations');
  validateDestinations(otherUsdtDestinations, 'otherUsdtDestinations');
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]', 'uint16[]', 'address[]', 'uint16[]'],
    [
      concessionDestinations.map((item) => item.account),
      concessionDestinations.map((item) => item.weightBps),
      otherUsdtDestinations.map((item) => item.account),
      otherUsdtDestinations.map((item) => item.weightBps),
    ],
  ));
}

function destinations(value: unknown, name: string) {
  if (!Array.isArray(value)) throw blocked(name);
  const parsed = value.map((item, index) => {
    const entry = record(item, `${name}[${index}]`);
    return {
      account: text(entry.account, `${name}[${index}].account`).toLowerCase(),
      weightBps: integer(entry.weightBps, `${name}[${index}].weightBps`),
    };
  });
  validateDestinations(parsed, name);
  return Object.freeze(parsed);
}

function validateDestinations(value: readonly WeightedDestination[], name: string) {
  if (value.length === 0) throw blocked(name);
  let total = 0;
  let previous = '';
  for (const destination of value) {
    if (
      !/^0x[0-9a-f]{40}$/.test(destination.account)
      || destination.account <= previous
      || destination.weightBps <= 0
    ) throw new CoreError('InvalidRequest', `${name} must contain sorted unique positive destinations`);
    total += destination.weightBps;
    previous = destination.account;
  }
  if (total !== 10_000) throw new CoreError('InvalidRequest', `${name} weights must sum to 100%`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw blocked(name);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0) throw blocked(name);
  return value;
}

function integer(value: unknown, name: string) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw blocked(name);
  return parsed;
}

function unsigned(value: unknown, name: string) {
  try {
    const parsed = BigInt(typeof value === 'string' || typeof value === 'number' ? value : '');
    if (parsed < 0n) throw new Error('negative');
    return parsed;
  } catch {
    throw blocked(name);
  }
}

function blocked(name: string) {
  return new CoreError('DecisionBlocked', `Published payment policy is missing ${name}`, 409);
}
