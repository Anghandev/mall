import type {
  ApprovalRequirement,
  Eip712TypedData,
  PaymentQuoteResponse,
  PaymentRouterIntent,
  SeckillQuoteResponse,
  SettlementIntentProjection,
} from '@abu24k/core-artifacts';
import { chainIdentity } from '@abu24k/core-artifacts';
import type {
  BrowserProvider,
  Eip1193Provider,
  Signer,
  TypedDataDomain,
  TypedDataField,
} from 'ethers';

import { productBaseline } from './bootstrap';
import { assertPaymentQuoteIntegrity, authorizationTypesForQuote } from './payment-integrity';

type SignedQuote = PaymentQuoteResponse | SeckillQuoteResponse;

const settlementRequestFields = [
  { name: 'intentId', type: 'bytes32' },
  { name: 'artifactVersion', type: 'string' },
  { name: 'wallet', type: 'address' },
  { name: 'recipient', type: 'address' },
  { name: 'rail', type: 'string' },
  { name: 'asset', type: 'address' },
  { name: 'safeAddress', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'itemsHash', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint64' },
] as const;

export interface WalletGateway {
  connect(): Promise<string>;
  signMessage(message: string): Promise<string>;
  signSettlementIntent(projection: SettlementIntentProjection): Promise<string>;
  inspectApprovals(requirements: readonly ApprovalRequirement[]): Promise<readonly ApprovalStatus[]>;
  broadcastPayment(quote: SignedQuote, acknowledgeUnlimitedApproval: boolean): Promise<string>;
  revokeApproval(requirement: ApprovalRequirement): Promise<string>;
}

export interface ApprovalStatus {
  currentAllowance: string;
  sufficient: boolean;
}

export function createBrowserWalletGateway(
  provider = injectedProvider(),
  publishedRouterAddress = productBaseline.paymentRouterAddress,
): WalletGateway {
  let browserProvider: BrowserProvider | undefined;
  let signer: Signer | undefined;

  return {
    async connect() {
      if (!provider) throw new WalletGatewayError('WalletUnavailable', '未检测到可用的浏览器钱包');
      await provider.request({ method: 'eth_requestAccounts' });
      await ensureBsc(provider);
      const { BrowserProvider } = await import('ethers');
      browserProvider = new BrowserProvider(provider);
      signer = await browserProvider.getSigner();
      return (await signer.getAddress()).toLowerCase();
    },

    async signMessage(message) {
      return (await requireSigner()).signMessage(message);
    },

    async signSettlementIntent(projection) {
      if (!provider) throw new WalletGatewayError('WalletUnavailable', '未检测到可用的浏览器钱包');
      await ensureBsc(provider);
      const activeSigner = await requireSigner();
      const walletAddress = (await activeSigner.getAddress()).toLowerCase();
      const { domain, types, message } = await validateSettlementIntentForWallet(projection, walletAddress);
      return activeSigner.signTypedData(domain, types, message);
    },

    async inspectApprovals(requirements) {
      if (!provider) throw new WalletGatewayError('WalletUnavailable', '未检测到可用的浏览器钱包');
      await ensureBsc(provider);
      assertApprovalTokens(requirements);
      const activeSigner = await requireSigner();
      const walletAddress = (await activeSigner.getAddress()).toLowerCase();
      return Promise.all(requirements.map(async (requirement) => {
        const token = await tokenContract(requirement.token, activeSigner);
        const allowance = await token.getFunction('allowance')(walletAddress, requirement.spender) as bigint;
        return {
          currentAllowance: allowance.toString(),
          sufficient: allowance >= BigInt(requirement.requiredAmount),
        };
      }));
    },

    async broadcastPayment(quote, acknowledgeUnlimitedApproval) {
      if (!provider) throw new WalletGatewayError('WalletUnavailable', '未检测到可用的浏览器钱包');
      await ensureBsc(provider);
      await validatePaymentQuoteForWallet(quote, publishedRouterAddress);
      const activeSigner = await requireSigner();
      const walletAddress = (await activeSigner.getAddress()).toLowerCase();
      if (quote.buyerAuthorization.message.buyer.toLowerCase() !== walletAddress) {
        throw new WalletGatewayError('WalletMismatch', '当前钱包与签名报价不一致');
      }

      const missingApprovals: ApprovalRequirement[] = [];
      for (const requirement of quote.approvalRequirements) {
        const token = await tokenContract(requirement.token, activeSigner);
        const allowance = await token.getFunction('allowance')(walletAddress, requirement.spender) as bigint;
        if (allowance < BigInt(requirement.requiredAmount)) missingApprovals.push(requirement);
      }
      if (missingApprovals.length > 0 && !acknowledgeUnlimitedApproval) {
        throw new WalletGatewayError('ApprovalDisclosureRequired', '请先确认无限额度授权风险和撤销方式');
      }
      for (const requirement of missingApprovals) {
        assertQuoteNotExpired(quote);
        const transaction = await (await tokenContract(requirement.token, activeSigner))
          .getFunction('approve')(requirement.spender, requirement.requestedAllowance);
        const receipt = await transaction.wait();
        if (!receipt || receipt.status !== 1) {
          throw new WalletGatewayError('ApprovalFailed', '代币授权未成功');
        }
        const current = await (await tokenContract(requirement.token, activeSigner))
          .getFunction('allowance')(walletAddress, requirement.spender) as bigint;
        if (current < BigInt(requirement.requiredAmount)) {
          throw new WalletGatewayError('ApprovalFailed', '代币授权额度未生效');
        }
      }

      assertQuoteNotExpired(quote);
      const authorization = quote.buyerAuthorization;
      const buyerSignature = await activeSigner.signTypedData(
        authorization.domain as TypedDataDomain,
        mutableTypedDataTypes(authorizationTypesForQuote(quote)),
        authorization.message,
      );
      const data = await encodeRouterPaymentCall(quote, buyerSignature);
      assertQuoteNotExpired(quote);
      const transaction = await activeSigner.sendTransaction({
        to: quote.paymentRouterAddress,
        data,
      });
      return transaction.hash;
    },

    async revokeApproval(requirement) {
      if (!provider) throw new WalletGatewayError('WalletUnavailable', '未检测到可用的浏览器钱包');
      await ensureBsc(provider);
      assertApprovalTokens([requirement]);
      if (
        requirement.revocation.token.toLowerCase() !== requirement.token.toLowerCase()
          || requirement.revocation.spender.toLowerCase() !== requirement.spender.toLowerCase()
      ) throw new WalletGatewayError('InvalidQuote', '撤销授权目标与原授权要求不一致');
      const transaction = await (await tokenContract(requirement.revocation.token, await requireSigner()))
        .getFunction('approve')(requirement.revocation.spender, 0n);
      const receipt = await transaction.wait();
      if (!receipt || receipt.status !== 1) throw new WalletGatewayError('ApprovalFailed', '撤销授权未成功');
      const walletAddress = await (await requireSigner()).getAddress();
      const current = await (await tokenContract(requirement.token, await requireSigner()))
        .getFunction('allowance')(walletAddress, requirement.spender) as bigint;
      if (current !== 0n) throw new WalletGatewayError('ApprovalFailed', '撤销授权额度未生效');
      return transaction.hash;
    },
  };

  async function requireSigner() {
    if (!signer) await gatewayConnect();
    if (!signer) throw new WalletGatewayError('WalletUnavailable', '钱包连接失败');
    return signer;
  }

  async function gatewayConnect() {
    if (!provider) throw new WalletGatewayError('WalletUnavailable', '未检测到可用的浏览器钱包');
    await provider.request({ method: 'eth_requestAccounts' });
    await ensureBsc(provider);
    const { BrowserProvider } = await import('ethers');
    browserProvider = new BrowserProvider(provider);
    signer = await browserProvider.getSigner();
  }
}

export class WalletGatewayError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WalletGatewayError';
  }
}

export async function encodeRouterPaymentCall(quote: SignedQuote, buyerSignature: string) {
  const [{ Interface }, abiModule] = await Promise.all([
    import('ethers'),
    import('@abu24k/core-artifacts/contracts', { with: { type: 'json' } }),
  ]);
  const router = new Interface(abiModule.default.contracts.PaymentRouterV2);
  return router.encodeFunctionData(quote.routerCall.functionName, [
    quote.routerCall.intent,
    quote.routerCall.quoteSignature,
    buyerSignature,
  ]);
}

async function tokenContract(address: string, signer: Signer) {
  const { Contract } = await import('ethers');
  return new Contract(address, [
    'function allowance(address owner,address spender) view returns (uint256)',
    'function approve(address spender,uint256 amount) returns (bool)',
  ], signer);
}

async function ensureBsc(provider: Eip1193Provider) {
  const chainId = await provider.request({ method: 'eth_chainId' });
  if (chainId === '0x38') return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
  } catch {
    throw new WalletGatewayError('WrongChain', '请将钱包切换到 BSC Mainnet (56)');
  }
}

function injectedProvider() {
  return (globalThis as typeof globalThis & { ethereum?: Eip1193Provider }).ethereum;
}

function mutableTypedDataTypes(types: Readonly<Record<string, readonly Readonly<{ name: string; type: string }>[]>>) {
  return Object.fromEntries(
    Object.entries(types).map(([name, fields]) => [name, fields.map((field) => ({ ...field }))]),
  ) as Record<string, TypedDataField[]>;
}

export async function validateSettlementIntentForWallet(projection: SettlementIntentProjection, walletAddress: string) {
  const { intent, typedData } = projection;
  const now = Math.floor(Date.now() / 1000);
  const expectedAsset = intent.rail === 'REWARD_NPL'
    ? chainIdentity.nplAddress
    : intent.rail === 'PRIZE_USDT'
      ? chainIdentity.usdtAddress
      : null;
  if (
    intent.artifactVersion !== productBaseline.coreArtifacts
    || intent.wallet.toLowerCase() !== walletAddress
    || intent.recipient.toLowerCase() !== walletAddress
    || expectedAsset === null
    || intent.asset.toLowerCase() !== expectedAsset.toLowerCase()
    || intent.deadline <= now
  ) throw new WalletGatewayError('InvalidIntent', '结算申请与当前钱包、资产或有效期不一致');

  if (typedData.primaryType !== 'SettlementRequest') {
    throw new WalletGatewayError('InvalidIntent', '结算签名类型无效');
  }
  const domain = typedData.domain as TypedDataDomain;
  if (
    domain.name !== 'Abu24KV2Settlement'
    || domain.version !== '2'
    || Number(domain.chainId) !== chainIdentity.chainId
    || String(domain.verifyingContract).toLowerCase() !== intent.safeAddress.toLowerCase()
  ) throw new WalletGatewayError('InvalidIntent', '结算签名的链或 Safe 不一致');

  const message = typedData.message as Record<string, unknown>;
  for (const [field, value] of Object.entries(intent)) {
    if (String(message[field]).toLowerCase() !== String(value).toLowerCase()) {
      throw new WalletGatewayError('InvalidIntent', '结算签名内容与权威意图不一致');
    }
  }
  const types = settlementTypedDataTypes(typedData);
  const { TypedDataEncoder } = await import('ethers');
  if (TypedDataEncoder.hash(domain, types, message).toLowerCase() !== projection.digest.toLowerCase()) {
    throw new WalletGatewayError('InvalidIntent', '结算签名摘要与权威意图不一致');
  }
  return { domain, types, message };
}

function settlementTypedDataTypes(typedData: Eip712TypedData) {
  const parsed: Record<string, TypedDataField[]> = {};
  for (const [typeName, fields] of Object.entries(typedData.types)) {
    if (typeName === 'EIP712Domain') continue;
    if (!Array.isArray(fields)) throw new WalletGatewayError('InvalidIntent', '结算签名字段无效');
    parsed[typeName] = fields.map((field) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw new WalletGatewayError('InvalidIntent', '结算签名字段无效');
      }
      const entry = field as Record<string, unknown>;
      if (typeof entry.name !== 'string' || typeof entry.type !== 'string') {
        throw new WalletGatewayError('InvalidIntent', '结算签名字段无效');
      }
      return { name: entry.name, type: entry.type };
    });
  }
  if (
    Object.keys(parsed).length !== 1
    || !parsed.SettlementRequest
    || JSON.stringify(parsed.SettlementRequest) !== JSON.stringify(settlementRequestFields)
  ) throw new WalletGatewayError('InvalidIntent', '结算签名字段与发布协议不一致');
  return parsed;
}

export async function validatePaymentQuoteForWallet(quote: SignedQuote, publishedRouterAddress: string | null) {
  await assertPaymentQuoteIntegrity(quote);
  const router = quote.paymentRouterAddress.toLowerCase();
  assertQuoteNotExpired(quote);
  if (!publishedRouterAddress) {
    throw new WalletGatewayError('ExternalBlocked', '协调 manifest 未发布 PaymentRouter 地址');
  }
  if (router !== publishedRouterAddress.toLowerCase()) {
    throw new WalletGatewayError('InvalidQuote', '签名报价 Router 与协调部署 manifest 不一致');
  }
  if (
    quote.buyerAuthorization.domain.chainId !== chainIdentity.chainId
      || quote.buyerAuthorization.domain.verifyingContract.toLowerCase() !== router
  ) {
    throw new WalletGatewayError('InvalidQuote', '签名报价的链或 Router 与钱包调用不一致');
  }
  assertApprovalTokens(quote.approvalRequirements);
  const approvalTokens = new Set(quote.approvalRequirements.map((requirement) => requirement.token.toLowerCase()));
  if (
    approvalTokens.size !== 2
      || !approvalTokens.has(chainIdentity.usdtAddress.toLowerCase())
      || !approvalTokens.has(chainIdentity.nplAddress.toLowerCase())
  ) {
    throw new WalletGatewayError('InvalidQuote', '签名报价没有完整的 USDT/NPL 授权要求');
  }
  if (quote.approvalRequirements.some((requirement) => requirement.spender.toLowerCase() !== router)) {
    throw new WalletGatewayError('InvalidQuote', '授权对象与签名报价 Router 不一致');
  }
  assertAuthorizationMatchesRouterCall(quote);
}

function assertQuoteNotExpired(quote: SignedQuote) {
  if (quote.buyerAuthorization.message.deadline <= Math.floor(Date.now() / 1000)) {
    throw new WalletGatewayError('QuoteExpired', '签名报价已过期，请重新预留库存');
  }
}

function assertApprovalTokens(requirements: readonly ApprovalRequirement[]) {
  const publishedTokens = new Set([
    chainIdentity.usdtAddress.toLowerCase(),
    chainIdentity.nplAddress.toLowerCase(),
  ]);
  if (requirements.some((requirement) => !publishedTokens.has(requirement.token.toLowerCase()))) {
    throw new WalletGatewayError('InvalidQuote', '授权代币不在协调支付资产列表中');
  }
}

function assertAuthorizationMatchesRouterCall(quote: SignedQuote) {
  if ('intent' in quote) {
    const message = quote.buyerAuthorization.message;
    const payment = quote.routerCall.intent;
    assertSharedAuthorization(message, payment);
    if (
      message.listPriceUsdt !== payment.listPriceUsdt
        || message.usdtPaymentAmount !== payment.usdtPaymentAmount
        || message.nplPaymentAmount !== payment.nplPaymentAmount
    ) throw new WalletGatewayError('InvalidQuote', '钱包签名金额与 Router 支付意图不一致');
    return;
  }
  const message = quote.buyerAuthorization.message;
  const payment = quote.routerCall.intent.seckillPayment;
  assertSharedAuthorization(message, payment);
  const fallback = quote.routerCall.intent.fallbackPayment;
  if (
    message.seckillListPriceUsdt !== payment.listPriceUsdt
      || message.seckillUsdtPaymentAmount !== payment.usdtPaymentAmount
      || message.seckillNplPaymentAmount !== payment.nplPaymentAmount
      || message.fallbackListPriceUsdt !== fallback.listPriceUsdt
      || message.fallbackUsdtPaymentAmount !== fallback.usdtPaymentAmount
      || message.fallbackNplPaymentAmount !== fallback.nplPaymentAmount
  ) throw new WalletGatewayError('InvalidQuote', '秒杀与日常备用金额与 Router 意图不一致');
}

function assertSharedAuthorization(
  message: Readonly<{
    orderId: string;
    buyer: string;
    merchant: string;
    productId: string;
    skuId: string;
    quantity: number;
    fulfillmentMode: 0 | 1;
    deadline: number;
  }>,
  payment: PaymentRouterIntent,
) {
  if (
    message.orderId.toLowerCase() !== payment.orderId.toLowerCase()
      || message.buyer.toLowerCase() !== payment.buyer.toLowerCase()
      || message.merchant.toLowerCase() !== payment.merchant.toLowerCase()
      || message.productId.toLowerCase() !== payment.productId.toLowerCase()
      || message.skuId.toLowerCase() !== payment.skuId.toLowerCase()
      || message.quantity !== payment.quantity
      || message.fulfillmentMode !== payment.fulfillmentMode
      || message.deadline !== payment.deadline
  ) throw new WalletGatewayError('InvalidQuote', '钱包签名消息与 Router 支付意图不一致');
}
