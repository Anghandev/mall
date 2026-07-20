import { getAddress } from 'ethers';
import { CoreError } from '../api/errors.ts';

const MAX_MICROTEST_USDT = 3n * 10n ** 18n;
const MAX_MICROTEST_DURATION_MS = 24 * 60 * 60 * 1_000;
const CONFIG_NAMES = [
  'MAINNET_MICROTEST_MERCHANT_ID',
  'MAINNET_MICROTEST_MERCHANT_WALLET',
  'MAINNET_MICROTEST_PRODUCT_ID',
  'MAINNET_MICROTEST_BUYER_WALLETS',
  'MAINNET_MICROTEST_EXPIRES_AT',
  'MAINNET_MICROTEST_MAX_LIST_PRICE_USDT',
  'MAINNET_MICROTEST_MAX_FREIGHT_USDT',
  'MAINNET_MICROTEST_MAX_STOCK',
  'MAINNET_MICROTEST_SECKILL_INVENTORY',
  'MAINNET_MICROTEST_EVIDENCE_HASH',
] as const;

export interface MainnetMicrotestEntitlement {
  merchantId: string;
  merchantWallet: string;
  productId: string;
  buyerWallets: ReadonlySet<string>;
  expiresAt: Date;
  maxListPriceUsdt: bigint;
  maxFreightUsdt: bigint;
  maxStock: number;
  seckillInventory: number;
  evidenceHash: string;
}

export interface MicrotestProductSubject {
  merchantId: string;
  merchantWallet: string;
  productId: string;
  listPriceUsdt: string;
  freightUsdt: string;
  stockAvailable: number;
  guaranteeBalanceUsdt: string;
  guaranteeEvidenceHash: string | null;
}

export function loadMainnetMicrotestEntitlement(
  env: Readonly<Record<string, string | undefined>>,
  now = new Date(),
): MainnetMicrotestEntitlement | undefined {
  const configured = CONFIG_NAMES.filter((name) => env[name]?.trim());
  if (configured.length === 0) return undefined;
  if (configured.length !== CONFIG_NAMES.length) {
    throw new CoreError('InvalidRequest', 'Mainnet micro-test entitlement configuration is incomplete', 500);
  }
  const merchantId = boundedId(env.MAINNET_MICROTEST_MERCHANT_ID!, 'merchant ID');
  const merchantWallet = address(env.MAINNET_MICROTEST_MERCHANT_WALLET!, 'merchant wallet');
  const productId = boundedId(env.MAINNET_MICROTEST_PRODUCT_ID!, 'product ID');
  const buyerWallets = new Set(
    env.MAINNET_MICROTEST_BUYER_WALLETS!.split(',')
      .map((value) => address(value.trim(), 'buyer wallet')),
  );
  if (buyerWallets.size !== 3 || buyerWallets.has(merchantWallet)) {
    throw new CoreError('InvalidRequest', 'Mainnet micro-test requires three unique non-merchant buyers', 500);
  }
  const expiresAt = new Date(env.MAINNET_MICROTEST_EXPIRES_AT!);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now
      || expiresAt.getTime() - now.getTime() > MAX_MICROTEST_DURATION_MS) {
    throw new CoreError('InvalidRequest', 'Mainnet micro-test expiry must be within the next 24 hours', 500);
  }
  const maxListPriceUsdt = boundedAmount(
    env.MAINNET_MICROTEST_MAX_LIST_PRICE_USDT!,
    'maximum list price',
    false,
  );
  const maxFreightUsdt = boundedAmount(
    env.MAINNET_MICROTEST_MAX_FREIGHT_USDT!,
    'maximum freight',
    true,
  );
  if (maxListPriceUsdt + maxFreightUsdt > MAX_MICROTEST_USDT) {
    throw new CoreError('InvalidRequest', 'Mainnet micro-test product and freight exceed the bounded amount', 500);
  }
  const maxStock = boundedInteger(env.MAINNET_MICROTEST_MAX_STOCK!, 'maximum stock', 1, 4);
  const seckillInventory = boundedInteger(
    env.MAINNET_MICROTEST_SECKILL_INVENTORY!,
    'seckill inventory',
    1,
    maxStock,
  );
  const evidenceHash = env.MAINNET_MICROTEST_EVIDENCE_HASH!.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(evidenceHash)) {
    throw new CoreError('InvalidRequest', 'Mainnet micro-test evidence hash must be bytes32', 500);
  }
  return Object.freeze({
    merchantId,
    merchantWallet,
    productId,
    buyerWallets,
    expiresAt,
    maxListPriceUsdt,
    maxFreightUsdt,
    maxStock,
    seckillInventory,
    evidenceHash,
  });
}

export function isMicrotestProductEligible(
  entitlement: MainnetMicrotestEntitlement | undefined,
  subject: MicrotestProductSubject,
  now: Date,
) {
  if (!entitlement || now >= entitlement.expiresAt) return false;
  if (
    subject.merchantId !== entitlement.merchantId
    || subject.merchantWallet.toLowerCase() !== entitlement.merchantWallet
    || subject.productId !== entitlement.productId
    || !subject.guaranteeEvidenceHash
    || !/^0x[0-9a-fA-F]{64}$/.test(subject.guaranteeEvidenceHash)
    || subject.guaranteeEvidenceHash.toLowerCase() !== entitlement.evidenceHash
  ) return false;
  try {
    return BigInt(subject.guaranteeBalanceUsdt) > 0n
      && BigInt(subject.listPriceUsdt) > 0n
      && BigInt(subject.listPriceUsdt) <= entitlement.maxListPriceUsdt
      && BigInt(subject.freightUsdt) >= 0n
      && BigInt(subject.freightUsdt) <= entitlement.maxFreightUsdt
      && Number.isSafeInteger(subject.stockAvailable)
      && subject.stockAvailable > 0
      && subject.stockAvailable <= entitlement.maxStock;
  } catch {
    return false;
  }
}

export function isMicrotestBuyerEligible(
  entitlement: MainnetMicrotestEntitlement | undefined,
  subject: MicrotestProductSubject,
  buyerWallet: string,
  quantity: number,
  now: Date,
) {
  return quantity === 1
    && isMicrotestProductEligible(entitlement, subject, now)
    && entitlement!.buyerWallets.has(buyerWallet.toLowerCase());
}

export function isMicrotestMerchantProduct(
  entitlement: MainnetMicrotestEntitlement | undefined,
  merchantId: string,
  productId: string,
  now: Date,
) {
  return entitlement !== undefined
    && now < entitlement.expiresAt
    && merchantId === entitlement.merchantId
    && productId === entitlement.productId;
}

function boundedId(value: string, label: string) {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 128 || !/^[a-z0-9:-]+$/i.test(normalized)) {
    throw new CoreError('InvalidRequest', `Mainnet micro-test ${label} is invalid`, 500);
  }
  return normalized;
}

function address(value: string, label: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', `Mainnet micro-test ${label} is invalid`, 500);
  }
}

function boundedAmount(value: string, label: string, allowZero: boolean) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CoreError('InvalidRequest', `Mainnet micro-test ${label} is invalid`, 500);
  }
  const amount = BigInt(value);
  if ((!allowZero && amount === 0n) || amount > MAX_MICROTEST_USDT) {
    throw new CoreError('InvalidRequest', `Mainnet micro-test ${label} exceeds the bounded amount`, 500);
  }
  return amount;
}

function boundedInteger(value: string, label: string, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CoreError('InvalidRequest', `Mainnet micro-test ${label} is invalid`, 500);
  }
  return parsed;
}
