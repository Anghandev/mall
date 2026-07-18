import {
  AbiCoder,
  Interface,
  TypedDataEncoder,
  getAddress,
  keccak256,
  verifyTypedData,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers';
import {
  paymentAllocationSetHash,
  paymentBeneficiarySetHash,
  type PaymentPolicySnapshot,
} from './payment-policy.ts';
import { BSC_CHAIN_ID } from './enums.ts';
import { CoreError } from './errors.ts';
import { PAYMENT_POLICY_TUPLE_ABI } from '../chain/payment-sources.ts';

export interface PolicyPublicationIntent {
  policyHash: string;
  operationsHash: string;
  nonce: bigint;
  deadline: bigint;
}

export interface PolicyPublicationMaterial {
  policy: PaymentPolicySnapshot;
  rulesContentHash: string;
  beneficiarySetHash: string;
}

export const policyPublicationTypes: Record<string, TypedDataField[]> = {
  PolicyPublication: [
    { name: 'policyHash', type: 'bytes32' },
    { name: 'operationsHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
};

const registryInterface = new Interface([
  `function publishPolicy(${PAYMENT_POLICY_TUPLE_ABI} policy,address[] operationsAccounts,uint16[] operationsWeights,uint256 nonce,uint64 deadline,bytes secondarySignature)`,
]);

export function policyPublicationDomain(policyRegistryAddress: string): TypedDataDomain {
  return {
    name: 'Abu24KPolicyRegistry',
    version: '2',
    chainId: BSC_CHAIN_ID,
    verifyingContract: normalizeAddress(policyRegistryAddress),
  };
}

export function buildPolicyPublication(
  material: PolicyPublicationMaterial,
  nonce: bigint,
  deadline: bigint,
  policyRegistryAddress: string,
) {
  if (nonce < 0n || deadline <= 0n || deadline > (1n << 64n) - 1n) {
    throw new CoreError('InvalidRequest', 'Policy publication nonce or deadline is invalid');
  }
  const tuple = policyTuple(material);
  const operationsAccounts = material.policy.operationsDestinations.map((item) => normalizeAddress(item.account));
  const operationsWeights = material.policy.operationsDestinations.map((item) => item.weightBps);
  const operationsHash = policyOperationsHash(material.policy);
  const beneficiarySetHash = paymentBeneficiarySetHash(
    material.policy.genesisNodeDestinations,
    material.policy.operationsDestinations,
  );
  if (beneficiarySetHash !== normalizedHash(material.beneficiarySetHash, 'beneficiary set hash')) {
    throw new CoreError('InvalidRequest', 'Policy beneficiary set hash does not match node/Operations routing');
  }
  const allocationHash = paymentAllocationSetHash().toLowerCase();
  if (allocationHash !== material.policy.concessionDestinationSetHash.toLowerCase()) {
    throw new CoreError('InvalidRequest', 'Policy concession destination hash does not match configured routing');
  }
  const policyHash = keccak256(AbiCoder.defaultAbiCoder().encode([PAYMENT_POLICY_TUPLE_ABI], [tuple])).toLowerCase();
  const intent: PolicyPublicationIntent = { policyHash, operationsHash, nonce, deadline };
  const domain = policyPublicationDomain(policyRegistryAddress);
  const digest = TypedDataEncoder.hash(domain, policyPublicationTypes, intent).toLowerCase();
  return Object.freeze({
    tuple: Object.freeze(tuple),
    operationsAccounts: Object.freeze(operationsAccounts),
    operationsWeights: Object.freeze(operationsWeights),
    policyHash,
    operationsHash,
    intent: Object.freeze(intent),
    domain: Object.freeze(domain),
    digest,
  });
}

export function policyOperationsHash(policy: PaymentPolicySnapshot) {
  const accounts = policy.operationsDestinations.map((item) => normalizeAddress(item.account));
  const weights = policy.operationsDestinations.map((item) => item.weightBps);
  return keccak256(AbiCoder.defaultAbiCoder().encode(['address[]', 'uint16[]'], [accounts, weights])).toLowerCase();
}

export function verifyPolicyPublicationSignature(
  publication: ReturnType<typeof buildPolicyPublication>,
  signature: string,
  expectedSecondarySigner: string,
) {
  let signer: string;
  try {
    signer = normalizeAddress(verifyTypedData(
      publication.domain,
      policyPublicationTypes,
      publication.intent,
      signature,
    ));
  } catch {
    throw new CoreError('InvalidSignature', 'Invalid policy publication secondary signature', 401);
  }
  if (signer !== normalizeAddress(expectedSecondarySigner)) {
    throw new CoreError('InvalidSignature', 'Policy publication secondary signer mismatch', 401);
  }
  return signer;
}

export function encodePolicyPublicationCalldata(
  publication: ReturnType<typeof buildPolicyPublication>,
  secondarySignature: string,
) {
  try {
    return registryInterface.encodeFunctionData('publishPolicy', [
      publication.tuple,
      publication.operationsAccounts,
      publication.operationsWeights,
      publication.intent.nonce,
      publication.intent.deadline,
      secondarySignature,
    ]);
  } catch {
    throw new CoreError('InvalidRequest', 'Policy publication calldata cannot be encoded');
  }
}

function policyTuple(material: PolicyPublicationMaterial) {
  const policy = material.policy;
  return [
    policy.policyVersion,
    policy.usdtPaymentBps,
    policy.nplPaymentBps,
    policy.nplBurnListPriceBps,
    policy.nplRewardListPriceBps,
    policy.genesisBps,
    policy.directReferralBps,
    policy.districtBps,
    policy.cityBps,
    policy.provinceBps,
    policy.regionBps,
    policy.operationsBps,
    policy.platformFeeBps,
    policy.seckillPrizeBps,
    policy.seckillMainDuration,
    policy.relayInitial,
    policy.relayIncrement,
    policy.relayCap,
    policy.merchantGuaranteeMinimumUsdt,
    normalizeAddress(policy.usdtCustodySafe),
    normalizeAddress(policy.nplRewardSafe),
    normalizeAddress(policy.operationsTreasurySafe),
    normalizeAddress(policy.circulationPool),
    normalizedHash(material.beneficiarySetHash, 'beneficiary set hash'),
    normalizedHash(policy.concessionDestinationSetHash, 'concession destination set hash'),
    normalizedHash(policy.decisionEvidenceHash, 'decision evidence hash'),
    normalizedHash(material.rulesContentHash, 'rules content hash'),
  ] as const;
}

function normalizeAddress(value: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', 'Policy publication contains an invalid address');
  }
}

function normalizedHash(value: string, name: string) {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new CoreError('InvalidRequest', `Invalid ${name}`);
  return normalized;
}
