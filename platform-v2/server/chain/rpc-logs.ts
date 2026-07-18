import { toQuantity, type JsonRpcProvider } from 'ethers';
import { CoreError } from '../api/errors.ts';

export interface RpcLogRecord {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockHash: string;
  blockNumber: number;
  logIndex: number;
}

type LogProvider = Pick<JsonRpcProvider, 'getLogs' | 'send'>;

export async function readAddressLogs(
  provider: LogProvider,
  input: {
    addresses: string | readonly string[];
    fromBlock: number;
    toBlock: number;
    topic0?: string;
  },
): Promise<RpcLogRecord[]> {
  const addresses = (Array.isArray(input.addresses) ? input.addresses : [input.addresses])
    .map((address) => address.toLowerCase());
  try {
    const logs = await provider.getLogs({
      address: addresses.length === 1 ? addresses[0] : addresses,
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
      ...(input.topic0 ? { topics: [input.topic0] } : {}),
    });
    return logs.map((log) => ({
      address: log.address.toLowerCase(),
      topics: [...log.topics],
      data: log.data,
      transactionHash: log.transactionHash.toLowerCase(),
      blockHash: log.blockHash.toLowerCase(),
      blockNumber: log.blockNumber,
      logIndex: log.index,
    }));
  } catch (getLogsError) {
    try {
      return await readBlockReceipts(provider, { ...input, addresses });
    } catch (blockReceiptsError) {
      throw new CoreError('ExternalBlocked', 'BSC log query and block-receipt fallback are unavailable', 503, {
        getLogsReason: errorName(getLogsError),
        blockReceiptsReason: errorName(blockReceiptsError),
      });
    }
  }
}

async function readBlockReceipts(
  provider: LogProvider,
  input: { addresses: readonly string[]; fromBlock: number; toBlock: number; topic0?: string },
) {
  const addressSet = new Set(input.addresses);
  const topic0 = input.topic0?.toLowerCase();
  const logs: RpcLogRecord[] = [];
  for (let blockNumber = input.fromBlock; blockNumber <= input.toBlock; blockNumber += 1) {
    const receipts = await provider.send('eth_getBlockReceipts', [toQuantity(blockNumber)]);
    if (!Array.isArray(receipts)) throw new Error('MalformedBlockReceipts');
    for (const receipt of receipts) {
      if (!isRecord(receipt) || !Array.isArray(receipt.logs)) throw new Error('MalformedBlockReceipt');
      for (const candidate of receipt.logs) {
        if (!isRecord(candidate) || typeof candidate.address !== 'string') throw new Error('MalformedReceiptLog');
        if (!addressSet.has(candidate.address.toLowerCase())) continue;
        const log = normalizeReceiptLog(candidate);
        if (log.blockNumber !== blockNumber) throw new Error('ReceiptLogBlockMismatch');
        if (!topic0 || log.topics[0]?.toLowerCase() === topic0) logs.push(log);
      }
    }
  }
  return logs.sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
}

function normalizeReceiptLog(value: Record<string, unknown>): RpcLogRecord {
  if (
    typeof value.address !== 'string'
    || !Array.isArray(value.topics)
    || value.topics.some((topic) => typeof topic !== 'string')
    || typeof value.data !== 'string'
    || typeof value.transactionHash !== 'string'
    || typeof value.blockHash !== 'string'
    || typeof value.blockNumber !== 'string'
    || typeof value.logIndex !== 'string'
  ) throw new Error('MalformedReceiptLog');
  const blockNumber = parseQuantity(value.blockNumber);
  const logIndex = parseQuantity(value.logIndex);
  return {
    address: value.address.toLowerCase(),
    topics: value.topics as string[],
    data: value.data,
    transactionHash: value.transactionHash.toLowerCase(),
    blockHash: value.blockHash.toLowerCase(),
    blockNumber,
    logIndex,
  };
}

function parseQuantity(value: string) {
  if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw new Error('MalformedRpcQuantity');
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('MalformedRpcQuantity');
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : 'UnknownRpcFailure';
}
