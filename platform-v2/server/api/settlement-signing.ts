import {
  getAddress,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyTypedData,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers';
import {
  BSC_CHAIN_ID,
  CORE_ARTIFACT_VERSION,
  settlementRails,
  type SettlementRail,
} from './enums.ts';
import { CoreError } from './errors.ts';

export interface SettlementRequestIntent {
  intentId: string;
  artifactVersion: string;
  wallet: string;
  recipient: string;
  rail: SettlementRail;
  asset: string;
  executorWallet: string;
  amount: string;
  itemsHash: string;
  nonce: string;
  deadline: number;
}

export interface SettlementAuthorizationItem {
  itemIndex: number;
  orderId: string;
  accountId: string;
  backingWalletAddress: string;
  amount: string;
  itemHash: string;
}

export interface SettlementExecutionAuthorization {
  requestId: string;
  selectedItemIndex: number;
  intent: SettlementRequestIntent;
  signature: string;
  items: readonly SettlementAuthorizationItem[];
}

export interface SettlementExecutionBinding {
  requestId: string;
  requestItemIndex: number;
  orderId: string;
  accountId: string;
  backingWalletAddress: string;
  executorWallet: string;
  tokenAddress: string;
  recipientAddress: string;
  amount: string;
}

export const settlementRequestTypes: Record<string, TypedDataField[]> = {
  SettlementRequest: [
    { name: 'intentId', type: 'bytes32' },
    { name: 'artifactVersion', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'rail', type: 'string' },
    { name: 'asset', type: 'address' },
    { name: 'executorWallet', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'itemsHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
};

export function settlementRequestDomain(executorWallet: string): TypedDataDomain {
  return {
    name: 'Abu24KV2Settlement',
    version: '2',
    chainId: BSC_CHAIN_ID,
    verifyingContract: normalizeAddress(executorWallet, 'settlement executor wallet'),
  };
}

export function settlementIntentDigest(intent: SettlementRequestIntent) {
  validateIntent(intent);
  return TypedDataEncoder.hash(
    settlementRequestDomain(intent.executorWallet),
    settlementRequestTypes,
    canonicalIntent(intent),
  );
}

export async function verifySettlementRequestSignature(
  intent: SettlementRequestIntent,
  signature: string,
  now = new Date(),
) {
  validateIntent(intent);
  if (intent.deadline < Math.floor(now.getTime() / 1000)) {
    throw new CoreError('NonceExpired', 'Settlement request intent expired', 401);
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) {
    throw new CoreError('InvalidSignature', 'Settlement request signature is invalid', 401);
  }
  return verifySignature(intent, signature);
}

export function verifySettlementExecutionAuthorization(
  authorization: SettlementExecutionAuthorization,
  binding: SettlementExecutionBinding,
) {
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    throw new CoreError('InvalidSignature', 'Settlement execution authorization is invalid', 401);
  }
  const verified = verifySignature(authorization.intent, authorization.signature);
  if (
    !isHash(authorization.requestId)
    || authorization.requestId.toLowerCase() !== settlementRequestId(authorization.intent)
    || authorization.requestId.toLowerCase() !== binding.requestId.toLowerCase()
    || !Number.isSafeInteger(authorization.selectedItemIndex)
    || authorization.selectedItemIndex !== binding.requestItemIndex
    || !Array.isArray(authorization.items)
    || authorization.items.length === 0
    || authorization.items.length > 256
  ) throw new CoreError('InvalidSignature', 'Settlement execution request identity is invalid', 401);

  const items = authorization.items.map((item, index) => canonicalAuthorizationItem(item, authorization.intent.intentId, index));
  if (
    settlementItemsHash(items) !== authorization.intent.itemsHash.toLowerCase()
    || items.reduce((sum, item) => sum + BigInt(item.amount), 0n) !== BigInt(authorization.intent.amount)
  ) throw new CoreError('InvalidSignature', 'Settlement execution items do not match the signed request', 401);

  const selected = items[authorization.selectedItemIndex];
  if (
    !selected
    || selected.orderId !== binding.orderId
    || selected.accountId !== binding.accountId
    || selected.backingWalletAddress !== normalizeAddress(binding.backingWalletAddress, 'settlement backing wallet')
    || selected.amount !== binding.amount
    || normalizeAddress(authorization.intent.executorWallet, 'settlement executor wallet')
      !== normalizeAddress(binding.executorWallet, 'settlement executor wallet')
    || normalizeAddress(authorization.intent.asset, 'settlement asset')
      !== normalizeAddress(binding.tokenAddress, 'settlement token')
    || normalizeAddress(authorization.intent.recipient, 'settlement recipient')
      !== normalizeAddress(binding.recipientAddress, 'settlement recipient')
  ) throw new CoreError('InvalidSignature', 'Settlement execution is not bound to the signed request item', 401);

  return {
    ...verified,
    requestId: authorization.requestId.toLowerCase(),
    selectedItem: selected,
    items,
    signatureHash: keccak256(authorization.signature).toLowerCase(),
  };
}

export function settlementRequestId(intent: SettlementRequestIntent) {
  return hashJson({ intentId: intent.intentId, digest: settlementIntentDigest(intent).toLowerCase() });
}

export function settlementItemHash(intentId: string, item: Omit<SettlementAuthorizationItem, 'itemHash'>) {
  return hashJson({ intentId, ...item });
}

export function settlementItemsHash(items: readonly SettlementAuthorizationItem[]) {
  return hashJson(items);
}

function canonicalIntent(intent: SettlementRequestIntent) {
  return {
    ...intent,
    wallet: normalizeAddress(intent.wallet, 'settlement wallet'),
    recipient: normalizeAddress(intent.recipient, 'settlement recipient'),
    asset: normalizeAddress(intent.asset, 'settlement asset'),
    executorWallet: normalizeAddress(intent.executorWallet, 'settlement executor wallet'),
  };
}

function verifySignature(intent: SettlementRequestIntent, signature: string) {
  validateIntent(intent);
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) {
    throw new CoreError('InvalidSignature', 'Settlement request signature is invalid', 401);
  }
  const domain = settlementRequestDomain(intent.executorWallet);
  const value = canonicalIntent(intent);
  const digest = TypedDataEncoder.hash(domain, settlementRequestTypes, value);
  let signer: string | undefined;
  try {
    signer = normalizeAddress(
      verifyTypedData(domain, settlementRequestTypes, value, signature),
      'settlement signer',
    );
  } catch {
    signer = undefined;
  }
  const wallet = normalizeAddress(intent.wallet, 'settlement wallet');
  if (signer !== wallet) {
    throw new CoreError('InvalidSignature', 'Settlement request signer does not match the bound wallet', 401);
  }
  return { wallet, digest, domain, intent: value, scheme: 'EIP712' as const };
}

function canonicalAuthorizationItem(
  item: SettlementAuthorizationItem,
  intentId: string,
  expectedIndex: number,
): SettlementAuthorizationItem {
  if (
    !item
    || typeof item !== 'object'
    || Array.isArray(item)
    || item.itemIndex !== expectedIndex
    || !isHash(item.orderId)
    || typeof item.accountId !== 'string'
    || item.accountId.length === 0
    || item.accountId.length > 512
    || !/^[1-9][0-9]*$/.test(item.amount)
    || !isHash(item.itemHash)
  ) throw new CoreError('InvalidSignature', 'Settlement execution item is invalid', 401);
  const result = {
    itemIndex: item.itemIndex,
    orderId: item.orderId.toLowerCase(),
    accountId: item.accountId,
    backingWalletAddress: normalizeAddress(item.backingWalletAddress, 'settlement backing wallet'),
    amount: item.amount,
    itemHash: item.itemHash.toLowerCase(),
  };
  if (settlementItemHash(intentId, {
    itemIndex: result.itemIndex,
    orderId: result.orderId,
    accountId: result.accountId,
    backingWalletAddress: result.backingWalletAddress,
    amount: result.amount,
  }) !== result.itemHash) {
    throw new CoreError('InvalidSignature', 'Settlement execution item hash is invalid', 401);
  }
  return result;
}

function validateIntent(intent: SettlementRequestIntent) {
  if (
    !isHash(intent.intentId)
    || intent.artifactVersion !== CORE_ARTIFACT_VERSION
    || !settlementRails.includes(intent.rail)
    || !isHash(intent.itemsHash)
    || !/^[1-9][0-9]*$/.test(intent.amount)
    || !/^(0|[1-9][0-9]*)$/.test(intent.nonce)
    || !Number.isSafeInteger(intent.deadline)
    || intent.deadline <= 0
  ) {
    throw new CoreError('InvalidRequest', 'Settlement request intent is invalid');
  }
  normalizeAddress(intent.wallet, 'settlement wallet');
  normalizeAddress(intent.recipient, 'settlement recipient');
  normalizeAddress(intent.asset, 'settlement asset');
  normalizeAddress(intent.executorWallet, 'settlement executor wallet');
}

function normalizeAddress(value: string, name: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', `${name} is invalid`);
  }
}

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
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
