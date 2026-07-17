import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  AbiCoder,
  Contract,
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  NonceManager,
  keccak256,
  toUtf8Bytes,
  type InterfaceAbi,
  type ContractTransactionResponse,
  type TransactionReceipt,
} from 'ethers';
import type { CanonicalPaymentIntent } from '../../server/api/checkout.ts';
import { NPL_ADDRESS, USDT_ADDRESS } from '../../server/api/enums.ts';
import { paymentIntentHash } from '../../server/api/payment-signing.ts';
import type { ChainSegmentBlock } from '../../server/chain/indexer.ts';

const PLATFORM_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MNEMONIC = 'test test test test test test test test test test test junk';
const BURN_ADDRESS = '0x000000000000000000000000000000000000dead';
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const HASH = `0x${'1'.repeat(64)}`;
const PRODUCT_ID = `0x${'b'.repeat(64)}`;
const SKU_ID = `0x${'c'.repeat(64)}`;
const RESERVATION_ID = `0x${'d'.repeat(64)}`;
const RESERVATION_HASH = `0x${'e'.repeat(64)}`;
const ONE_TOKEN = 10n ** 18n;

interface FoundryArtifact {
  abi: InterfaceAbi;
  bytecode: { object: string };
  deployedBytecode: { object: string };
}

export interface LocalPaymentChainResult {
  intent: CanonicalPaymentIntent;
  routerAddress: string;
  transactionHash: string;
  segment: ChainSegmentBlock[];
  safes: {
    usdtCustody: string;
    nplReward: string;
    operationsTreasury: string;
  };
  contracts: {
    genesisCredential: string;
  };
  balances: {
    custodyUsdt: string;
    burnedNpl: string;
    rewardNpl: string;
    routerUsdt: string;
    routerNpl: string;
  };
}

export async function executeLocalPaymentChain(): Promise<LocalPaymentChainResult> {
  execFileSync('forge', ['build', '--quiet'], { cwd: PLATFORM_ROOT, stdio: 'pipe' });
  const chain = await startAnvil();
  try {
    return await deployAndPay(chain.provider);
  } finally {
    await chain.stop();
  }
}

async function deployAndPay(provider: JsonRpcProvider): Promise<LocalPaymentChainResult> {
  const rawWallets = Array.from({ length: 5 }, (_, index) => (
    HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).connect(provider)
  ));
  const [safeWallet, secondaryWallet, quoteWallet, buyerWallet, merchantWallet] = rawWallets;
  if (!safeWallet || !secondaryWallet || !quoteWallet || !buyerWallet || !merchantWallet) {
    throw new Error('Local Anvil wallets are unavailable');
  }
  const safe = new NonceManager(safeWallet);
  const buyer = new NonceManager(buyerWallet);
  const safeAddress = safeWallet.address.toLowerCase();
  const buyerAddress = buyerWallet.address.toLowerCase();
  const merchantAddress = merchantWallet.address.toLowerCase();
  const usdtCustody = '0x0000000000000000000000000000000000007001';
  const nplReward = '0x0000000000000000000000000000000000007002';
  const operationsTreasury = '0x0000000000000000000000000000000000007003';
  const circulationPool = '0x0000000000000000000000000000000000007004';
  const beneficiaryAddresses = {
    genesis: buyerAddress,
    directReferral: '0x0000000000000000000000000000000000005003',
    district: '0x0000000000000000000000000000000000005004',
    city: '0x0000000000000000000000000000000000005005',
    province: '0x0000000000000000000000000000000000005006',
    region: '0x0000000000000000000000000000000000005007',
    operations: '0x0000000000000000000000000000000000006001',
  } as const;
  const regionCodeHash = keccak256(toUtf8Bytes('210211'));
  const concessionAllocationHash = keccak256(toUtf8Bytes('test-concession-allocation'));
  const oracleVersion = keccak256(toUtf8Bytes('pancake-v2-npl-usdt-30m-v1'));

  const tokenArtifact = artifact('Mocks.sol/CallbackERC20.json');
  const tokenImplementation = await deploy(tokenArtifact, safe, ['Mock Token', 'MOCK']);
  const tokenRuntime = tokenArtifact.deployedBytecode.object;
  await provider.send('anvil_setCode', [USDT_ADDRESS, tokenRuntime]);
  await provider.send('anvil_setCode', [NPL_ADDRESS, tokenRuntime]);
  const usdt = new Contract(USDT_ADDRESS, tokenArtifact.abi, safe);
  const npl = new Contract(NPL_ADDRESS, tokenArtifact.abi, safe);

  const credential = await deploy(artifact('Mocks.sol/MockCredential.json'), safe);
  const twapSource = await deploy(artifact('Mocks.sol/MockTwapSource.json'), safe);
  const policyRegistry = await deploy(
    artifact('PolicyRegistryV2.sol/PolicyRegistryV2.json'),
    safe,
    [safeAddress, secondaryWallet.address],
  );
  const beneficiaryRegistry = await deploy(
    artifact('BeneficiaryRegistryV2.sol/BeneficiaryRegistryV2.json'),
    safe,
    [await policyRegistry.getAddress()],
  );

  await transact(credential, 'mint', [buyerAddress]);
  const latest = await provider.getBlock('latest');
  if (!latest) throw new Error('Local Anvil head is unavailable');
  const publicationDeadline = BigInt(latest.timestamp + 3_600);
  const regionBeneficiaries = {
    district: beneficiaryAddresses.district,
    city: beneficiaryAddresses.city,
    province: beneficiaryAddresses.province,
    region: beneficiaryAddresses.region,
  };
  const regionDigest = await readContract<string>(beneficiaryRegistry, 'hashRegionPublication', [
    1, regionCodeHash, regionBeneficiaries, 1, publicationDeadline,
  ]);
  await transact(beneficiaryRegistry, 'publishRegionBeneficiaries', [
    1, regionCodeHash, regionBeneficiaries, 1, publicationDeadline,
    rawSignature(secondaryWallet, regionDigest),
  ]);

  const operationsAccounts = [beneficiaryAddresses.operations];
  const operationsWeights = [10_000];
  const beneficiarySetHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(['address[]', 'uint16[]'], [operationsAccounts, operationsWeights]),
  );
  const policy = {
    version: 1,
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
    platformFeeBps: 500,
    seckillPrizeBps: 1_000,
    seckillMainDuration: 3_600,
    relayInitial: 60,
    relayIncrement: 30,
    relayCap: 60,
    oracleVersion,
    oracleMaxAge: 600,
    oracleMinLiquidity: 50_000n * ONE_TOKEN,
    merchantGuaranteeMinimum: 1_000n * ONE_TOKEN,
    usdtCustodySafe: usdtCustody,
    nplRewardSafe: nplReward,
    operationsTreasurySafe: operationsTreasury,
    circulationPool,
    genesisCredential: await credential.getAddress(),
    genesisTokenId: 1,
    genesisCredentialStandard: 1,
    beneficiarySetHash,
    concessionDestinationSetHash: concessionAllocationHash,
    decisionEvidenceHash: keccak256(toUtf8Bytes('local-payment-policy-evidence')),
    rulesContentHash: keccak256(toUtf8Bytes('local-payment-seckill-rules')),
  };
  const policyDigest = await readContract<string>(policyRegistry, 'hashPublication', [
    policy, operationsAccounts, operationsWeights, 1, publicationDeadline,
  ]);
  await transact(policyRegistry, 'publishPolicy', [
    policy, operationsAccounts, operationsWeights, 1, publicationDeadline,
    rawSignature(secondaryWallet, policyDigest),
  ]);

  await transact(twapSource, 'setResult', [1_000n * ONE_TOKEN, 50_000n * ONE_TOKEN, latest.timestamp]);
  const oracle = await deploy(
    artifact('TwapOracleAdapterV2.sol/TwapOracleAdapterV2.json'),
    safe,
    [await twapSource.getAddress(), oracleVersion],
  );
  const router = await deploy(
    artifact('PaymentRouterV2.sol/PaymentRouterV2.json'),
    safe,
    [
      USDT_ADDRESS,
      NPL_ADDRESS,
      await policyRegistry.getAddress(),
      await beneficiaryRegistry.getAddress(),
      await oracle.getAddress(),
      usdtCustody,
      nplReward,
      operationsTreasury,
      quoteWallet.address,
    ],
  );
  const routerAddress = (await router.getAddress()).toLowerCase();
  await transact(beneficiaryRegistry, 'setReferrer', [buyerAddress, beneficiaryAddresses.directReferral]);
  await transact(usdt, 'mint', [buyerAddress, 1_000n * ONE_TOKEN]);
  await transact(npl, 'mint', [buyerAddress, 10_000n * ONE_TOKEN]);
  const buyerUsdt = new Contract(USDT_ADDRESS, tokenArtifact.abi, buyer);
  const buyerNpl = new Contract(NPL_ADDRESS, tokenArtifact.abi, buyer);
  await transact(buyerUsdt, 'approve', [routerAddress, (1n << 256n) - 1n]);
  await transact(buyerNpl, 'approve', [routerAddress, (1n << 256n) - 1n]);

  const head = await provider.getBlock('latest');
  if (!head) throw new Error('Local payment head is unavailable');
  const canonicalIntent = paymentIntent({
    buyer: buyerAddress,
    merchant: merchantAddress,
    issuedAt: head.timestamp,
    oracleVersion,
    regionCodeHash,
    concessionAllocationHash,
    beneficiaries: beneficiaryAddresses,
  });
  const {
    merchantConcessionAllocations: _merchantConcessionAllocations,
    otherUsdtAllocations: _otherUsdtAllocations,
    nplRewardAllocations: _nplRewardAllocations,
    requiredConfirmations: _requiredConfirmations,
    ...paymentFields
  } = canonicalIntent;
  const onchainIntent = {
    ...paymentFields,
    policyVersion: BigInt(canonicalIntent.policyVersion),
    quantity: canonicalIntent.quantity,
    fulfillmentMode: 0,
    reservationDeadline: BigInt(canonicalIntent.reservationDeadline),
    issuedAt: BigInt(canonicalIntent.issuedAt),
    deadline: BigInt(canonicalIntent.deadline),
    nonce: BigInt(canonicalIntent.nonce),
    listPriceUsdt: BigInt(canonicalIntent.listPriceUsdt),
    usdtPaymentAmount: BigInt(canonicalIntent.usdtPaymentAmount),
    nplQuoteAmount: BigInt(canonicalIntent.nplQuoteAmount),
    nplPaymentAmount: BigInt(canonicalIntent.nplPaymentAmount),
    nplBurnAmount: BigInt(canonicalIntent.nplBurnAmount),
    nplRewardAmount: BigInt(canonicalIntent.nplRewardAmount),
    merchantBaseReceivableUsdt: BigInt(canonicalIntent.merchantBaseReceivableUsdt),
    merchantConcessionAmount: BigInt(canonicalIntent.merchantConcessionAmount),
    merchantNetReceivableUsdt: BigInt(canonicalIntent.merchantNetReceivableUsdt),
    bnmAmount: BigInt(canonicalIntent.bnmAmount),
  };
  const digest = await readContract<string>(router, 'hashPayment', [onchainIntent]);
  const buyerRouter = new Contract(routerAddress, artifact('PaymentRouterV2.sol/PaymentRouterV2.json').abi, buyer);
  const receipt = await transact(buyerRouter, 'pay', [
    onchainIntent, rawSignature(quoteWallet, digest), rawSignature(buyerWallet, digest),
  ]);
  await provider.send('anvil_mine', ['0xe']);
  const lastBlockNumber = receipt.blockNumber + 14;
  const segment: ChainSegmentBlock[] = [];
  for (let number = receipt.blockNumber - 1; number <= lastBlockNumber; number += 1) {
    const block = await provider.getBlock(number);
    if (!block || !block.hash || !block.parentHash) throw new Error(`Local block ${number} is unavailable`);
    segment.push({
      block: { number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp },
      logs: number === receipt.blockNumber
        ? receipt.logs.map((log) => ({
            address: log.address,
            topics: [...log.topics],
            data: log.data,
            transactionHash: log.transactionHash,
            blockHash: log.blockHash,
            blockNumber: log.blockNumber,
            logIndex: log.index,
          }))
        : [],
    });
  }
  const paymentLog = receipt.logs.find((log) => {
    if (log.address.toLowerCase() !== routerAddress) return false;
    return router.interface.parseLog({ topics: log.topics, data: log.data })?.name === 'PaymentCompleted';
  });
  if (!paymentLog) throw new Error('Local PaymentCompleted log is unavailable');
  const paymentEvent = router.interface.decodeEventLog('PaymentCompleted', paymentLog.data, paymentLog.topics);
  if (paymentIntentHash(canonicalIntent).toLowerCase() !== String(paymentEvent.snapshotHash).toLowerCase()) {
    throw new Error('Local Router snapshot hash does not match Core signing');
  }

  return {
    intent: canonicalIntent,
    routerAddress,
    transactionHash: receipt.hash.toLowerCase(),
    segment,
    safes: { usdtCustody, nplReward, operationsTreasury },
    contracts: { genesisCredential: (await credential.getAddress()).toLowerCase() },
    balances: {
      custodyUsdt: String(await readContract<bigint>(usdt, 'balanceOf', [usdtCustody])),
      burnedNpl: String(await readContract<bigint>(npl, 'balanceOf', [BURN_ADDRESS])),
      rewardNpl: String(await readContract<bigint>(npl, 'balanceOf', [nplReward])),
      routerUsdt: String(await readContract<bigint>(usdt, 'balanceOf', [routerAddress])),
      routerNpl: String(await readContract<bigint>(npl, 'balanceOf', [routerAddress])),
    },
  };
}

function paymentIntent(input: {
  buyer: string;
  merchant: string;
  issuedAt: number;
  oracleVersion: string;
  regionCodeHash: string;
  concessionAllocationHash: string;
  beneficiaries: Record<'genesis' | 'directReferral' | 'district' | 'city' | 'province' | 'region' | 'operations', string>;
}): CanonicalPaymentIntent {
  const amount = (value: bigint) => (value * ONE_TOKEN).toString();
  return {
    orderId: keccak256(toUtf8Bytes(`local-payment:${input.issuedAt}`)),
    policyVersion: 1,
    oracleVersion: input.oracleVersion,
    buyer: input.buyer,
    merchant: input.merchant,
    productId: PRODUCT_ID,
    skuId: SKU_ID,
    quantity: 1,
    fulfillmentMode: 'DELIVERY',
    fulfillmentTargetHash: HASH,
    regionCodeHash: input.regionCodeHash,
    productPolicyHash: HASH,
    reservationId: RESERVATION_ID,
    reservationHash: RESERVATION_HASH,
    reservationDeadline: input.issuedAt + 600,
    issuedAt: input.issuedAt,
    deadline: input.issuedAt + 300,
    nonce: '1',
    listPriceUsdt: amount(100n),
    productUsdtPaymentAmount: amount(70n),
    freightUsdt: '0',
    usdtPaymentAmount: amount(70n),
    nplQuoteAmount: amount(1_000n),
    nplPaymentAmount: amount(300n),
    nplBurnAmount: amount(200n),
    nplRewardAmount: amount(100n),
    merchantBaseReceivableUsdt: amount(60n),
    merchantConcessionBps: 2_500,
    merchantConcessionAmount: amount(15n),
    merchantNetReceivableUsdt: amount(45n),
    concessionAllocationHash: input.concessionAllocationHash,
    bnmAmount: amount(100n),
    seckill: false,
    sessionId: ZERO_BYTES32,
    beneficiaries: {
      genesis: input.beneficiaries.genesis,
      directReferral: input.beneficiaries.directReferral,
      district: input.beneficiaries.district,
      city: input.beneficiaries.city,
      province: input.beneficiaries.province,
      region: input.beneficiaries.region,
    },
    merchantConcessionAllocations: [
      { account: '0x7000000000000000000000000000000000000001', amount: amount(6n) },
      { account: '0x7000000000000000000000000000000000000002', amount: amount(9n) },
    ],
    otherUsdtAllocations: [
      { account: '0x7000000000000000000000000000000000000003', amount: amount(10n), purpose: 'POLICY_ALLOCATION' },
    ],
    nplRewardAllocations: [
      { role: 'genesis', account: input.beneficiaries.genesis, amount: amount(20n) },
      { role: 'directReferral', account: input.beneficiaries.directReferral, amount: amount(10n) },
      { role: 'district', account: input.beneficiaries.district, amount: amount(12n) },
      { role: 'city', account: input.beneficiaries.city, amount: amount(8n) },
      { role: 'province', account: input.beneficiaries.province, amount: amount(6n) },
      { role: 'region', account: input.beneficiaries.region, amount: amount(4n) },
      { role: 'operations', account: input.beneficiaries.operations, amount: amount(40n) },
    ],
    requiredConfirmations: 15,
  };
}

function artifact(relativePath: string): FoundryArtifact {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../out/${relativePath}`, import.meta.url)), 'utf8')) as FoundryArtifact;
}

async function deploy(source: FoundryArtifact, signer: NonceManager, args: unknown[] = []) {
  const contract = await new ContractFactory(source.abi, source.bytecode.object, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract as Contract;
}

async function readContract<Result>(contract: Contract, functionName: string, args: unknown[]): Promise<Result> {
  return contract.getFunction(functionName).staticCall(...args) as Promise<Result>;
}

async function transact(contract: Contract, functionName: string, args: unknown[]): Promise<TransactionReceipt> {
  const transaction = await contract.getFunction(functionName)(...args) as ContractTransactionResponse;
  const receipt = await transaction.wait();
  if (!receipt) throw new Error(`Local ${functionName} receipt is unavailable`);
  return receipt;
}

function rawSignature(wallet: HDNodeWallet, digest: string) {
  return wallet.signingKey.sign(digest).serialized;
}

async function startAnvil() {
  const port = await freePort();
  const child = spawn('anvil', [
    '--silent',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--chain-id', '56',
    '--disable-code-size-limit',
    '--mnemonic', MNEMONIC,
  ], { cwd: PLATFORM_ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 56, { staticNetwork: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Anvil exited before readiness: ${stderr}`);
    try {
      await provider.getBlockNumber();
      return { provider, stop: () => stopAnvil(child, provider) };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await stopAnvil(child, provider);
  throw new Error(`Anvil did not become ready: ${stderr}`);
}

async function stopAnvil(child: ChildProcess, provider: JsonRpcProvider) {
  await provider.destroy();
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate Anvil port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
