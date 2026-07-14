import { BSC_CHAIN_ID, type FinalityState } from './enums.ts';
import type { CoreConfig } from './config.ts';
import { CoreError } from './errors.ts';

export interface FinalityRecord {
  resourceType: string;
  resourceId: string;
  chainId: 56;
  contractAddress: string;
  expectedEventHash: string;
  txHash: string;
  replacementForTxHash?: string;
  blockNumber?: number;
  blockHash?: string;
  confirmations: number;
  requiredConfirmations: number;
  receiptStatus?: 0 | 1;
  eventResourceId?: string;
  observedEventHash?: string;
  canonicalBlock: boolean;
  state: FinalityState;
}

export function submittedFinality(
  config: Pick<CoreConfig, 'requiredConfirmations'>,
  input: {
    resourceType: string;
    resourceId: string;
    contractAddress: string;
    expectedEventHash: string;
    txHash: string;
  },
): FinalityRecord {
  if (!config.requiredConfirmations) {
    throw new CoreError('DecisionBlocked', 'Required finality confirmations are not frozen', 409);
  }
  return {
    ...input,
    chainId: BSC_CHAIN_ID,
    confirmations: 0,
    requiredConfirmations: config.requiredConfirmations,
    canonicalBlock: false,
    state: 'SUBMITTED',
  };
}

export function applyReceipt(
  record: FinalityRecord,
  receipt: {
    txHash: string;
    chainId: number;
    contractAddress: string;
    eventHash: string;
    eventResourceId: string;
    blockNumber: number;
    blockHash: string;
    confirmations: number;
    status: 0 | 1;
    canonicalBlock: boolean;
  },
): FinalityRecord {
  if (
    receipt.txHash.toLowerCase() !== record.txHash.toLowerCase() ||
    receipt.chainId !== record.chainId ||
    receipt.contractAddress.toLowerCase() !== record.contractAddress.toLowerCase() ||
    receipt.eventHash.toLowerCase() !== record.expectedEventHash.toLowerCase() ||
    receipt.eventResourceId !== record.resourceId ||
    !receipt.blockHash
  ) {
    throw new CoreError('InvalidFinality', 'Receipt does not bind the expected resource/event domain');
  }
  if (receipt.status !== 1) return { ...record, receiptStatus: 0, state: 'FAILED' };
  if (!receipt.canonicalBlock) {
    return {
      ...record,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      confirmations: receipt.confirmations,
      receiptStatus: 1,
      canonicalBlock: false,
      state: 'REORGED',
    };
  }
  return {
    ...record,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    confirmations: receipt.confirmations,
    receiptStatus: 1,
    eventResourceId: receipt.eventResourceId,
    observedEventHash: receipt.eventHash,
    canonicalBlock: true,
    state: receipt.confirmations >= record.requiredConfirmations ? 'FINAL' : 'MINED',
  };
}

export function replaceTransaction(record: FinalityRecord, replacementTxHash: string): FinalityRecord {
  if (record.state === 'FINAL') throw new CoreError('InvalidFinality', 'Final transaction cannot be replaced');
  if (!/^0x[0-9a-fA-F]{64}$/.test(replacementTxHash)) throw new CoreError('InvalidRequest', 'Invalid replacement hash');
  return {
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    chainId: record.chainId,
    contractAddress: record.contractAddress,
    expectedEventHash: record.expectedEventHash,
    replacementForTxHash: record.txHash,
    txHash: replacementTxHash,
    confirmations: 0,
    requiredConfirmations: record.requiredConfirmations,
    canonicalBlock: false,
    state: 'REPLACED',
  };
}

export function requireFinal(record: FinalityRecord) {
  if (record.state === 'REORGED') throw new CoreError('ReorgPending', 'Transaction was removed from the canonical chain', 409);
  if (record.state !== 'FINAL') throw new CoreError('FinalityPending', 'Transaction has not reached finality', 409);
  return record;
}
