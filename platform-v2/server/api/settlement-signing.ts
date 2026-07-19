import { getAddress, TypedDataEncoder, verifyTypedData, type TypedDataDomain, type TypedDataField } from 'ethers';
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

function canonicalIntent(intent: SettlementRequestIntent) {
  return {
    ...intent,
    wallet: normalizeAddress(intent.wallet, 'settlement wallet'),
    recipient: normalizeAddress(intent.recipient, 'settlement recipient'),
    asset: normalizeAddress(intent.asset, 'settlement asset'),
    executorWallet: normalizeAddress(intent.executorWallet, 'settlement executor wallet'),
  };
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
