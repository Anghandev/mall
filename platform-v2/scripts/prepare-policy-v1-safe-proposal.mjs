import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  Contract,
  JsonRpcProvider,
  TypedDataEncoder,
  Wallet,
  getAddress,
  keccak256,
} from 'ethers';
import { CORE_ARTIFACT_VERSION } from '../server/api/enums.ts';
import {
  parsePaymentPolicySnapshot,
  paymentAllocationSetHash,
  paymentBeneficiarySetHash,
} from '../server/api/payment-policy.ts';
import {
  buildPolicyPublication,
  encodePolicyPublicationCalldata,
  policyPublicationTypes,
} from '../server/api/policy-publication-signing.ts';
import {
  SAFE_L2_SINGLETON_ADDRESS,
  SAFE_L2_SINGLETON_CODE_HASH,
  SAFE_VERSION,
  ZERO_ADDRESS,
} from '../server/chain/safe-multisend.ts';

const REPOSITORY = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_OUTPUT = '/Users/ronnie/Desktop/24K-V2-BSC-POLICY-V1-SAFE-PROPOSAL.json';
const LATEST_RULES = '/Users/ronnie/Desktop/24K商城V2已确认规则与待补资料清单.txt';
const SYSTEM_CONTRACT = `${REPOSITORY}/docs/V2_SYSTEM_CONTRACT.md`;
const DECISIONS = `${REPOSITORY}/docs/V2_DECISIONS.md`;
const DEPLOYMENT_EVIDENCE = `${REPOSITORY}/platform-v2/deployments/bsc-payment-v2.json`;
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
};

const env = readEnv(`${REPOSITORY}/.env`);
const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_EVIDENCE, 'utf8'));
const outputPath = process.argv[2] ?? DEFAULT_OUTPUT;
const primary = new JsonRpcProvider(required(env, 'BSC_RPC_URL'), 56, { staticNetwork: true });
const fallback = new JsonRpcProvider(required(env, 'BSC_FALLBACK_RPC_URL'), 56, { staticNetwork: true });
const policyRegistry = getAddress(deployment.contracts.PolicyRegistryV2.address);
const governanceSafe = getAddress(required(env, 'PLATFORM_SAFE_ADDRESS'));
const signer = new Wallet(required(env, 'PLATFORM_TECH_PRIVATE_KEY'));
if (getAddress(signer.address) !== getAddress(required(env, 'SECONDARY_SIGNER_ADDRESS'))) {
  throw new Error('SecondarySignerMismatch');
}

const policyAbi = [
  'function latestVersion() view returns(uint64)',
  'function usedPublicationNonce(uint256) view returns(bool)',
];
const safeAbi = [
  'function nonce() view returns(uint256)',
  'function VERSION() view returns(string)',
  'function masterCopy() view returns(address)',
  'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)',
];
const policyContracts = [primary, fallback].map((provider) => new Contract(policyRegistry, policyAbi, provider));
const safeContracts = [primary, fallback].map((provider) => new Contract(governanceSafe, safeAbi, provider));

const [heads, latestVersions, publicationNonceUsed, safeNonces, safeVersions, singletons, gasData] = await Promise.all([
  Promise.all([primary.getBlockNumber(), fallback.getBlockNumber()]),
  Promise.all(policyContracts.map((contract) => contract.latestVersion())),
  Promise.all(policyContracts.map((contract) => contract.usedPublicationNonce(0n))),
  Promise.all(safeContracts.map((contract) => contract.nonce())),
  Promise.all(safeContracts.map((contract) => contract.VERSION())),
  Promise.all(safeContracts.map((contract) => contract.masterCopy())),
  Promise.all([primary.getFeeData(), fallback.getFeeData()]),
]);
if (
  latestVersions.some((value) => value !== 0n)
  || publicationNonceUsed.some(Boolean)
  || safeNonces[0] !== safeNonces[1]
) throw new Error('NonceOrVersionNotReady');
if (
  safeVersions.some((value) => value !== SAFE_VERSION)
  || singletons.some((value) => getAddress(value) !== getAddress(SAFE_L2_SINGLETON_ADDRESS))
) throw new Error('SafeProfileMismatch');
const singletonCodes = await Promise.all([
  primary.getCode(SAFE_L2_SINGLETON_ADDRESS),
  fallback.getCode(SAFE_L2_SINGLETON_ADDRESS),
]);
if (singletonCodes.some((code) => keccak256(code).toLowerCase() !== SAFE_L2_SINGLETON_CODE_HASH)) {
  throw new Error('SafeSingletonHashMismatch');
}

const genesisNodeDestinations = [{
  account: getAddress(required(env, 'NODE_REWARD_WALLET_1_ADDRESS')).toLowerCase(),
  weightBps: Number(required(env, 'NODE_REWARD_WALLET_1_WEIGHT_BPS')),
}];
const operationsDestinations = [1, 2, 3, 4]
  .map((index) => ({
    account: getAddress(required(env, `OPERATIONS_REWARD_WALLET_${index}_ADDRESS`)).toLowerCase(),
    weightBps: Number(required(env, `OPERATIONS_REWARD_WALLET_${index}_WEIGHT_BPS`)),
  }))
  .sort((left, right) => left.account.localeCompare(right.account));
const decisionEvidenceHash = keccak256(fs.readFileSync(LATEST_RULES));
const rulesContentHash = keccak256(fs.readFileSync(SYSTEM_CONTRACT));
const policy = parsePaymentPolicySnapshot(1, {
  usdtPaymentBps: 7_000,
  nplPaymentBps: 3_000,
  nplBurnListPriceBps: 2_000,
  nplRewardListPriceBps: 1_000,
  genesisBps: 200,
  directReferralBps: 100,
  districtBps: 120,
  cityBps: 80,
  provinceBps: 60,
  regionBps: 40,
  operationsBps: 400,
  platformFeeBps: 100,
  seckillPrizeBps: 0,
  seckillMainDuration: 3_600,
  relayInitial: 60,
  relayIncrement: 30,
  relayCap: 60,
  requiredConfirmations: 15,
  merchantGuaranteeMinimumUsdt: (1_000n * 10n ** 18n).toString(),
  platformServiceFeeSafe: getAddress(required(env, 'PLATFORM_SERVICE_FEE_SAFE_ADDRESS')).toLowerCase(),
  usdtCustodySafe: getAddress(required(env, 'USDT_CUSTODY_SAFE_ADDRESS')).toLowerCase(),
  nplRewardSafe: getAddress(required(env, 'NPL_REWARD_SAFE_ADDRESS')).toLowerCase(),
  operationsTreasurySafe: getAddress(required(env, 'OPERATIONS_TREASURY_SAFE_ADDRESS')).toLowerCase(),
  circulationPool: getAddress(required(env, 'NPL_REWARD_SAFE_ADDRESS')).toLowerCase(),
  concessionDestinationSetHash: paymentAllocationSetHash(),
  decisionEvidenceHash,
  genesisNodeDestinations,
  operationsDestinations,
});
const beneficiarySetHash = paymentBeneficiarySetHash(genesisNodeDestinations, operationsDestinations);
const createdAt = new Date();
const deadline = BigInt(Math.floor(createdAt.getTime() / 1_000) + 3_300);
const publication = buildPolicyPublication(
  { policy, rulesContentHash, beneficiarySetHash },
  0n,
  deadline,
  policyRegistry,
);
const secondarySignature = await signer.signTypedData(
  publication.domain,
  policyPublicationTypes,
  publication.intent,
);
const calldata = encodePolicyPublicationCalldata(publication, secondarySignature);
const innerGasEstimates = await Promise.all([
  primary.estimateGas({ from: governanceSafe, to: policyRegistry, data: calldata, value: 0n }),
  fallback.estimateGas({ from: governanceSafe, to: policyRegistry, data: calldata, value: 0n }),
]);
const safeTransaction = {
  to: policyRegistry,
  value: '0',
  data: calldata,
  operation: 0,
  safeTxGas: '0',
  baseGas: '0',
  gasPrice: '0',
  gasToken: ZERO_ADDRESS,
  refundReceiver: ZERO_ADDRESS,
  nonce: safeNonces[0].toString(),
};
const safeTransactionArgs = [
  safeTransaction.to,
  safeTransaction.value,
  safeTransaction.data,
  safeTransaction.operation,
  safeTransaction.safeTxGas,
  safeTransaction.baseGas,
  safeTransaction.gasPrice,
  safeTransaction.gasToken,
  safeTransaction.refundReceiver,
  safeTransaction.nonce,
];
const safeTxHash = TypedDataEncoder.hash(
  { chainId: 56, verifyingContract: governanceSafe },
  SAFE_TX_TYPES,
  safeTransaction,
).toLowerCase();
const chainSafeTxHashes = await Promise.all(
  safeContracts.map((contract) => contract.getTransactionHash(...safeTransactionArgs)),
);
if (chainSafeTxHashes.some((value) => value.toLowerCase() !== safeTxHash)) {
  throw new Error('SafeTxHashMismatch');
}

const observedGasPriceWei = gasData
  .map((value) => value.gasPrice ?? 0n)
  .reduce((left, right) => left > right ? left : right);
const maxGasPriceWei = observedGasPriceWei * 2n;
const maxOuterGasLimit = 1_200_000n;
const maxBnbCostWei = maxOuterGasLimit * maxGasPriceWei;
const packet = {
  schemaVersion: '1.0',
  packetType: 'SAFE_POLICY_PROPOSAL',
  status: 'AWAITING_EXACT_PACKET_CONFIRMATION',
  broadcastAuthorized: false,
  chainId: 56,
  artifactVersion: CORE_ARTIFACT_VERSION,
  gitCommit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPOSITORY, encoding: 'utf8' }).trim(),
  generatedAt: createdAt.toISOString(),
  expiresAt: new Date(Number(deadline) * 1_000).toISOString(),
  evidence: {
    deploymentEvidenceSha256: sha256(DEPLOYMENT_EVIDENCE),
    latestBusinessRulesSha256: sha256(LATEST_RULES),
    systemContractSha256: sha256(SYSTEM_CONTRACT),
    decisionsSha256: sha256(DECISIONS),
    decisionEvidenceHash,
    rulesContentHash,
    commonRpcBlock: Math.min(...heads),
    dualRpcPolicyStateAgreed: true,
    safeProfile: {
      version: SAFE_VERSION,
      singletonAddress: SAFE_L2_SINGLETON_ADDRESS,
      singletonCodeHash: SAFE_L2_SINGLETON_CODE_HASH,
    },
  },
  approvalScope: {
    exactSafeTxHash: safeTxHash,
    maximumTransactions: 1,
    nativeValueWei: '0',
    usdtAmountAtomic: '0',
    nplAmountAtomic: '0',
    maxOuterGasLimit: maxOuterGasLimit.toString(),
    maxGasPriceWei: maxGasPriceWei.toString(),
    maxBnbCostWei: maxBnbCostWei.toString(),
    maxBnbPriceAssumptionUsdt: '2000',
    maxEquivalentUsdt: (Number(maxBnbCostWei) / 1e18 * 2_000).toFixed(6),
  },
  transaction: {
    sequence: 1,
    transactionType: 'SAFE_TRANSACTION_PROPOSAL',
    requiresSafeOwnerSignatures: true,
    broadcastableWithoutOwnerSignatures: false,
    safeAddress: governanceSafe,
    safeNonce: safeNonces[0].toString(),
    safeTxHash,
    safeTransaction,
    target: policyRegistry,
    functionSignature: 'publishPolicy((uint64,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint32,uint32,uint32,uint32,uint128,address,address,address,address,bytes32,bytes32,bytes32,bytes32),address[],uint16[],uint256,uint64,bytes)',
    selector: calldata.slice(0, 10),
    calldata,
    calldataKeccak256: keccak256(calldata),
    nativeValueWei: '0',
    publication: {
      policyVersion: 1,
      publicationNonce: '0',
      deadline: deadline.toString(),
      policyHash: publication.policyHash,
      operationsHash: publication.operationsHash,
      beneficiarySetHash,
      secondarySignature,
      policy,
    },
    innerGasEstimate: innerGasEstimates.map(String),
    maxOuterGasLimit: maxOuterGasLimit.toString(),
    maxGasPriceWei: maxGasPriceWei.toString(),
    maxBnbCostWei: maxBnbCostWei.toString(),
    expectedEvents: [
      'PolicyPublished(version=1, exact policyHash, exact operationsHash, exact decisionEvidenceHash, safeExecutor=governanceSafe)',
    ],
    expectedBalanceDeltas: {
      platformServiceFeeSafeUsdt: '0',
      usdtCustodySafeUsdt: '0',
      nplRewardSafeNpl: '0',
      operationsTreasurySafeUsdt: '0',
      routerUsdt: '0',
      routerNpl: '0',
    },
    postAssertions: [
      'receipt status=1',
      'PolicyRegistry.latestVersion=1',
      'getPolicy(1) hashes to exact policyHash',
      'getOperations(1) equals sorted four 25% wallets',
      'usedPublicationNonce(0)=true',
      'exactly one matching PolicyPublished event',
      '15 confirmations and canonical block agreement on both RPC providers',
      'all USDT/NPL balances unchanged',
    ],
  },
  stopConditions: [
    'user has not confirmed this exact file SHA-256',
    'current time is at or after expiresAt',
    'governance Safe nonce is no longer 0',
    'PolicyRegistry.latestVersion is no longer 0',
    'publication nonce 0 becomes used',
    'Safe version/singleton/runtime hash changes',
    'either RPC provider disagrees on chain state or receipt',
    'SafeTxHash/calldata/policy hashes differ',
    'Safe owner signatures are unavailable or invalid',
    'outer gas limit or gas price exceeds the packet cap',
    'any token balance changes',
    'receipt fails or any post-assertion fails',
  ],
  excluded: [
    'region publication',
    'token approvals',
    'ordinary payment',
    'seckill session/payment',
    'fulfillment',
    'guarantee',
    'Safe settlement',
  ],
};

fs.writeFileSync(outputPath, `${JSON.stringify(packet, bigintJson, 2)}\n`, { mode: 0o600 });
fs.chmodSync(outputPath, 0o600);
console.log(JSON.stringify({
  output: outputPath,
  sha256: sha256(outputPath),
  safeTxHashMatchesDualRpc: true,
  innerGasEstimateMax: innerGasEstimates.reduce((left, right) => left > right ? left : right).toString(),
  maxBnbCostWei: maxBnbCostWei.toString(),
  expiresAt: packet.expiresAt,
}, null, 2));

function readEnv(path) {
  const result = {};
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

function required(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`ConfigurationRequired:${name}`);
  return value;
}

function sha256(path) {
  return crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
}

function bigintJson(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}
