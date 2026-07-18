import {
  Interface,
  TypedDataEncoder,
  concat,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
  type TypedDataField,
} from 'ethers';
import { BSC_CHAIN_ID, NPL_ADDRESS, USDT_ADDRESS } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';

export const SAFE_VERSION = '1.3.0';
export const SAFE_L2_SINGLETON_ADDRESS = '0x3e5c63644e683549055b9be8653de26e0b4cd36e';
export const SAFE_L2_SINGLETON_CODE_HASH = '0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f';
export const MULTISEND_CALL_ONLY_ADDRESS = '0x40a2accbd92bca938b02010e17a5b8929b49130d';
export const MULTISEND_CALL_ONLY_CODE_HASH = '0xa9865ac2d9c7a1591619b188c4d88167b50df6cc0c5327fcbd1c8c75f7c066ad';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const TOKEN_INTERFACE = new Interface(['function transfer(address recipient,uint256 amount) returns (bool)']);
const MULTISEND_INTERFACE = new Interface(['function multiSend(bytes transactions)']);
const SAFE_TX_TYPES: Record<string, TypedDataField[]> = {
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

export interface SettlementTransferItem {
  orderId: string;
  requestId: string;
  requestItemIndex: number;
  accountId: string;
  tokenAddress: string;
  recipientAddress: string;
  amount: string;
}

export interface SafeSettlementBatch {
  batchId: string;
  chainId: 56;
  safeAddress: string;
  safeVersion: typeof SAFE_VERSION;
  safeNonce: string;
  multisendAddress: string;
  multisendCodeHash: string;
  items: ReadonlyArray<SettlementTransferItem & {
    transferCalldata: string;
    itemHash: string;
  }>;
  itemCount: number;
  totalAmount: string;
  itemsHash: string;
  multisendTransactions: string;
  multisendCalldata: string;
  safeTransaction: {
    to: string;
    value: '0';
    data: string;
    operation: 1;
    safeTxGas: '0';
    baseGas: '0';
    gasPrice: '0';
    gasToken: string;
    refundReceiver: string;
    nonce: string;
  };
  safeTxHash: string;
  signingData: string;
  contentHash: string;
}

export function buildSafeSettlementBatch(input: {
  batchId: string;
  safeAddress: string;
  safeNonce: string;
  items: readonly SettlementTransferItem[];
}): SafeSettlementBatch {
  if (!isHash(input.batchId)) throw new CoreError('InvalidRequest', 'Settlement batch ID is invalid');
  const safeAddress = address(input.safeAddress, 'Safe');
  if (!/^(0|[1-9][0-9]*)$/.test(input.safeNonce)) throw new CoreError('InvalidRequest', 'Safe nonce is invalid');
  if (input.items.length === 0 || input.items.length > 256) {
    throw new CoreError('InvalidRequest', 'Settlement batch must contain between 1 and 256 items');
  }
  const canonicalItems = input.items.map((item, index) => canonicalItem(item, index));
  const asset = canonicalItems[0]!.tokenAddress;
  if (canonicalItems.some((item) => item.tokenAddress !== asset)) {
    throw new CoreError('InvalidRequest', 'A settlement batch must use exactly one asset');
  }
  const packedChildren = canonicalItems.map((item) => packCall(item.tokenAddress, item.transferCalldata));
  const multisendTransactions = hexlify(concat(packedChildren));
  const multisendCalldata = MULTISEND_INTERFACE.encodeFunctionData('multiSend', [multisendTransactions]);
  const safeTransaction = {
    to: MULTISEND_CALL_ONLY_ADDRESS,
    value: '0' as const,
    data: multisendCalldata,
    operation: 1 as const,
    safeTxGas: '0' as const,
    baseGas: '0' as const,
    gasPrice: '0' as const,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce: input.safeNonce,
  };
  const safeTxHash = TypedDataEncoder.hash(
    { chainId: BSC_CHAIN_ID, verifyingContract: safeAddress },
    SAFE_TX_TYPES,
    safeTransaction,
  );
  const signingData = TypedDataEncoder.encode(
    { chainId: BSC_CHAIN_ID, verifyingContract: safeAddress },
    SAFE_TX_TYPES,
    safeTransaction,
  );
  const totalAmount = canonicalItems.reduce((total, item) => total + BigInt(item.amount), 0n).toString();
  const itemsHash = hashJson(canonicalItems.map((item) => ({
    orderId: item.orderId,
    requestId: item.requestId,
    requestItemIndex: item.requestItemIndex,
    accountId: item.accountId,
    tokenAddress: item.tokenAddress,
    recipientAddress: item.recipientAddress,
    amount: item.amount,
    itemHash: item.itemHash,
  })));
  const contentHash = hashJson({
    batchId: input.batchId.toLowerCase(),
    chainId: BSC_CHAIN_ID,
    safeAddress,
    safeVersion: SAFE_VERSION,
    safeNonce: input.safeNonce,
    multisendAddress: MULTISEND_CALL_ONLY_ADDRESS,
    multisendCodeHash: MULTISEND_CALL_ONLY_CODE_HASH,
    itemCount: canonicalItems.length,
    totalAmount,
    itemsHash,
    multisendTransactions,
    multisendCalldata,
    safeTransaction,
    safeTxHash,
    signingData,
  });
  return {
    batchId: input.batchId.toLowerCase(),
    chainId: BSC_CHAIN_ID,
    safeAddress,
    safeVersion: SAFE_VERSION,
    safeNonce: input.safeNonce,
    multisendAddress: MULTISEND_CALL_ONLY_ADDRESS,
    multisendCodeHash: MULTISEND_CALL_ONLY_CODE_HASH,
    items: canonicalItems,
    itemCount: canonicalItems.length,
    totalAmount,
    itemsHash,
    multisendTransactions,
    multisendCalldata,
    safeTransaction,
    safeTxHash,
    signingData,
    contentHash,
  };
}

export function assertSafeSettlementBatch(batch: SafeSettlementBatch) {
  const rebuilt = buildSafeSettlementBatch({
    batchId: batch.batchId,
    safeAddress: batch.safeAddress,
    safeNonce: batch.safeNonce,
    items: batch.items,
  });
  for (const key of [
    'multisendAddress',
    'multisendCodeHash',
    'itemsHash',
    'multisendTransactions',
    'multisendCalldata',
    'safeTxHash',
    'signingData',
    'contentHash',
    'totalAmount',
  ] as const) {
    if (rebuilt[key].toLowerCase() !== batch[key].toLowerCase()) {
      throw new CoreError('InvalidFinality', `Safe settlement batch mismatch: ${key}`, 409);
    }
  }
  return rebuilt;
}

function canonicalItem(item: SettlementTransferItem, index: number) {
  if (
    !isHash(item.orderId)
    || !isHash(item.requestId)
    || !Number.isSafeInteger(item.requestItemIndex)
    || item.requestItemIndex < 0
    || item.accountId.length === 0
    || item.accountId.length > 256
    || !/^[1-9][0-9]*$/.test(item.amount)
  ) throw new CoreError('InvalidRequest', `Settlement batch item ${index} is invalid`);
  const tokenAddress = address(item.tokenAddress, 'settlement token');
  const recipientAddress = address(item.recipientAddress, 'settlement recipient');
  if (tokenAddress !== USDT_ADDRESS && tokenAddress !== NPL_ADDRESS) {
    throw new CoreError('InvalidRequest', 'Settlement token is not allowlisted');
  }
  const transferCalldata = TOKEN_INTERFACE.encodeFunctionData('transfer', [recipientAddress, item.amount]);
  const itemHash = hashJson({
    index,
    orderId: item.orderId.toLowerCase(),
    requestId: item.requestId.toLowerCase(),
    requestItemIndex: item.requestItemIndex,
    accountId: item.accountId,
    tokenAddress,
    recipientAddress,
    amount: item.amount,
    operation: 0,
    value: '0',
    transferCalldata,
  });
  return {
    ...item,
    orderId: item.orderId.toLowerCase(),
    requestId: item.requestId.toLowerCase(),
    tokenAddress,
    recipientAddress,
    transferCalldata,
    itemHash,
  };
}

function packCall(to: string, data: string) {
  const bytes = getBytes(data);
  return concat([
    '0x00',
    to,
    zeroPadValue('0x00', 32),
    zeroPadValue(toBeHex(bytes.length), 32),
    data,
  ]);
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(stableJson(value)));
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

function address(value: string, name: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', `${name} address is invalid`);
  }
}

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

export const safeTransactionTypes = SAFE_TX_TYPES;
