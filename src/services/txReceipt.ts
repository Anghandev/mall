import type { WalletProvider } from './payment';

export type TransactionReceipt = {
  transactionHash: string;
  status?: string;
  blockNumber?: string;
};

export async function waitForTransactionReceipt(provider: WalletProvider, txHash: string, timeoutMs = 90_000, pollMs = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const receipt = await provider.request<TransactionReceipt | null>({
      method: 'eth_getTransactionReceipt',
      params: [txHash]
    });
    if (receipt?.blockNumber) {
      if (receipt.status && receipt.status !== '0x1') {
        throw new Error(`交易失败：${txHash.slice(0, 10)}...`);
      }
      return receipt;
    }
    await sleep(pollMs);
  }
  throw new Error(`等待交易确认超时：${txHash.slice(0, 10)}...`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
