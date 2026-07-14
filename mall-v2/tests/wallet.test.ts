import abiBundle from '@abu24k/core-artifacts/contracts';
import { Interface, type Eip1193Provider } from 'ethers';
import { vi } from 'vitest';

import {
  createBrowserWalletGateway,
  encodeRouterPaymentCall,
  validatePaymentQuoteForWallet,
} from '../src/wallet';
import { paymentQuote, seckillQuote } from './payment-fixtures';

describe('published PaymentRouter wallet call', () => {
  it('encodes the ABI-shaped routerCall without a copied Router fragment', async () => {
    const quote = paymentQuote();
    const buyerSignature = `0x${'22'.repeat(65)}`;
    const data = await encodeRouterPaymentCall(quote, buyerSignature);
    const parsed = new Interface(abiBundle.contracts.PaymentRouterV2).parseTransaction({ data });

    expect(parsed?.name).toBe('pay');
    expect(parsed?.args[0].orderId).toBe(quote.orderId);
    expect(parsed?.args[1]).toBe(quote.quoteSignature);
    expect(parsed?.args[2]).toBe(buyerSignature);
  });

  it('encodes the published dual seckill routerCall', async () => {
    const quote = seckillQuote();
    const buyerSignature = `0x${'22'.repeat(65)}`;
    const data = await encodeRouterPaymentCall(quote, buyerSignature);
    const parsed = new Interface(abiBundle.contracts.PaymentRouterV2).parseTransaction({ data });

    expect(parsed?.name).toBe('paySeckill');
    expect(parsed?.args[0].sessionId).toBe(quote.dual.sessionId);
    expect(parsed?.args[0].seckillPayment.reservationId).toBe(quote.dual.seckill.reservationId);
    expect(parsed?.args[0].fallbackPayment.reservationId).toBe(quote.dual.fallback.reservationId);
  });

  it('rejects an unpinned Router and canonical/calldata mismatch before approval', async () => {
    const quote = paymentQuote();
    await expect(validatePaymentQuoteForWallet(quote, null)).rejects.toThrow(/manifest/);
    await expect(validatePaymentQuoteForWallet(quote, '0x8888888888888888888888888888888888888888')).rejects.toThrow(/Router/);

    const mismatched = structuredClone(quote);
    (mismatched.intent as { usdtPaymentAmount: string }).usdtPaymentAmount = '1';
    await expect(validatePaymentQuoteForWallet(mismatched, quote.paymentRouterAddress)).rejects.toThrow(/usdtPaymentAmount/);
  });

  it('rejects empty or rewritten EIP-712 authorization types before approval', async () => {
    const emptyTypes = structuredClone(paymentQuote());
    (emptyTypes.buyerAuthorization.types as { PaymentAuthorization: unknown[] }).PaymentAuthorization = [];
    await expect(validatePaymentQuoteForWallet(emptyTypes, emptyTypes.paymentRouterAddress)).rejects.toThrow(/EIP-712/);

    const rewrittenTypes = structuredClone(paymentQuote());
    (rewrittenTypes.buyerAuthorization.types.PaymentAuthorization[0] as { name: string }).name = 'otherHash';
    await expect(validatePaymentQuoteForWallet(rewrittenTypes, rewrittenTypes.paymentRouterAddress)).rejects.toThrow(/EIP-712/);

    const digestMismatch = structuredClone(paymentQuote());
    (digestMismatch.buyerAuthorization.message as { nplPaymentAmount: string }).nplPaymentAmount = '1';
    await expect(validatePaymentQuoteForWallet(digestMismatch, digestMismatch.paymentRouterAddress)).rejects.toThrow(/摘要/);
  });

  it('rejects an expired quote before any wallet write', async () => {
    const quote = paymentQuote();
    vi.useFakeTimers();
    vi.setSystemTime(new Date((quote.intent.deadline + 1) * 1000));
    try {
      await expect(validatePaymentQuoteForWallet(quote, quote.paymentRouterAddress)).rejects.toThrow(/已过期/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the wallet refuses the BSC chain switch', async () => {
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111'];
        if (method === 'eth_chainId') return '0x1';
        if (method === 'wallet_switchEthereumChain') throw new Error('rejected');
        throw new Error(`Unexpected wallet method: ${method}`);
      }),
    } as Eip1193Provider;

    await expect(createBrowserWalletGateway(provider).connect()).rejects.toMatchObject({
      code: 'WrongChain',
    });
  });

  it('skips repeat approvals and broadcasts the pinned Router call through EIP-1193', async () => {
    const quote = paymentQuote();
    const txHash = `0x${'f'.repeat(64)}`;
    let sentTransaction: Record<string, string> | undefined;
    const provider = {
      request: vi.fn(async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [quote.intent.buyer];
        if (method === 'eth_chainId') return '0x38';
        if (method === 'eth_call') return `0x${'f'.repeat(64)}`;
        if (method === 'eth_signTypedData_v4') return `0x${'22'.repeat(65)}`;
        if (method === 'eth_blockNumber') return '0x10';
        if (method === 'eth_estimateGas') return '0x5208';
        if (method === 'eth_sendTransaction') {
          sentTransaction = (params?.[0] ?? {}) as Record<string, string>;
          return txHash;
        }
        if (method === 'eth_getTransactionByHash') {
          return sentTransaction ? rpcTransaction(txHash, sentTransaction, quote.intent.buyer) : null;
        }
        throw new Error(`Unexpected wallet method: ${method}`);
      }),
    } as Eip1193Provider;
    const gateway = createBrowserWalletGateway(provider, quote.paymentRouterAddress);

    await expect(gateway.connect()).resolves.toBe(quote.intent.buyer);
    await expect(gateway.broadcastPayment(quote, false)).resolves.toBe(txHash);
    expect(sentTransaction?.to).toBe(quote.paymentRouterAddress);
    expect(sentTransaction?.data).toMatch(/^0x/);
    expect(provider.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'wallet_switchEthereumChain' }));
  });

  it('rejects a connected wallet that differs from the signed buyer', async () => {
    const quote = paymentQuote();
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x3333333333333333333333333333333333333333'];
        if (method === 'eth_chainId') return '0x38';
        throw new Error(`Unexpected wallet method: ${method}`);
      }),
    } as Eip1193Provider;
    const gateway = createBrowserWalletGateway(provider, quote.paymentRouterAddress);
    await gateway.connect();
    await expect(gateway.broadcastPayment(quote, false)).rejects.toMatchObject({ code: 'WalletMismatch' });
  });

  it('uses MaxUint for insufficient legs, waits for receipts and revokes to zero', async () => {
    const quote = paymentQuote();
    const mock = statefulWalletProvider(quote, 0n);
    const gateway = createBrowserWalletGateway(mock.provider, quote.paymentRouterAddress);
    await gateway.connect();

    await expect(gateway.broadcastPayment(quote, true)).resolves.toMatch(/^0x/);
    const approvalTransactions = mock.transactions.filter((transaction) =>
      transaction.to?.toLowerCase() !== quote.paymentRouterAddress.toLowerCase());
    expect(approvalTransactions).toHaveLength(2);
    for (const transaction of approvalTransactions) {
      const decoded = erc20.parseTransaction({ data: transaction.data ?? '0x' });
      expect(decoded?.name).toBe('approve');
      expect(decoded?.args[1]).toBe(2n ** 256n - 1n);
    }

    const requirement = quote.approvalRequirements[0]!;
    await expect(gateway.revokeApproval({
      ...requirement,
      revocation: { ...requirement.revocation, spender: '0x8888888888888888888888888888888888888888' },
    })).rejects.toMatchObject({ code: 'InvalidQuote' });
    await expect(gateway.revokeApproval(requirement)).resolves.toMatch(/^0x/);
    expect(mock.allowance(quote.approvalRequirements[0]!.token)).toBe(0n);
    expect(mock.receiptRequests).toBeGreaterThanOrEqual(3);
  });
});

const erc20 = new Interface([
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
]);

function statefulWalletProvider(quote: ReturnType<typeof paymentQuote>, initialAllowance: bigint) {
  const allowances = new Map(quote.approvalRequirements.map((requirement) => [requirement.token.toLowerCase(), initialAllowance]));
  const transactions: Array<Record<string, string>> = [];
  const transactionByHash = new Map<string, Record<string, string>>();
  let receiptRequests = 0;
  const provider = {
    request: vi.fn(async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [quote.intent.buyer];
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_call') {
        const call = (params?.[0] ?? {}) as Record<string, string>;
        const value = allowances.get((call.to ?? '').toLowerCase()) ?? 0n;
        return `0x${value.toString(16).padStart(64, '0')}`;
      }
      if (method === 'eth_signTypedData_v4') return `0x${'22'.repeat(65)}`;
      if (method === 'eth_blockNumber') return '0x20';
      if (method === 'eth_estimateGas') return '0x5208';
      if (method === 'eth_sendTransaction') {
        const transaction = (params?.[0] ?? {}) as Record<string, string>;
        const hash = `0x${(transactions.length + 1).toString(16).repeat(64).slice(0, 64)}`;
        transactions.push(transaction);
        transactionByHash.set(hash, transaction);
        const to = transaction.to ?? '';
        if (to.toLowerCase() !== quote.paymentRouterAddress.toLowerCase()) {
          const decoded = erc20.parseTransaction({ data: transaction.data ?? '0x' });
          allowances.set(to.toLowerCase(), decoded?.args[1] as bigint);
        }
        return hash;
      }
      if (method === 'eth_getTransactionByHash') {
        const hash = String(params?.[0]);
        const transaction = transactionByHash.get(hash);
        return transaction ? rpcTransaction(hash, transaction, quote.intent.buyer) : null;
      }
      if (method === 'eth_getTransactionReceipt') {
        receiptRequests += 1;
        const hash = String(params?.[0]);
        const transaction = transactionByHash.get(hash);
        return transaction ? rpcReceipt(hash, transaction, quote.intent.buyer) : null;
      }
      throw new Error(`Unexpected wallet method: ${method}`);
    }),
  } as Eip1193Provider;
  return {
    provider,
    transactions,
    get receiptRequests() { return receiptRequests; },
    allowance(token: string) { return allowances.get(token.toLowerCase()) ?? 0n; },
  };
}

function rpcTransaction(hash: string, transaction: Record<string, string>, from: string) {
  return {
    blockHash: null,
    blockNumber: null,
    from,
    gas: transaction.gas ?? '0x5208',
    gasPrice: '0x1',
    hash,
    input: transaction.data ?? '0x',
    nonce: '0x0',
    to: transaction.to,
    transactionIndex: null,
    value: transaction.value ?? '0x0',
    type: '0x0',
    chainId: '0x38',
    v: '0x1b',
    r: `0x${'1'.repeat(64)}`,
    s: `0x${'2'.repeat(64)}`,
  };
}

function rpcReceipt(hash: string, transaction: Record<string, string>, from: string) {
  return {
    blockHash: `0x${'a'.repeat(64)}`,
    blockNumber: '0x1f',
    contractAddress: null,
    cumulativeGasUsed: '0x5208',
    effectiveGasPrice: '0x1',
    from,
    gasUsed: '0x5208',
    logs: [],
    logsBloom: `0x${'0'.repeat(512)}`,
    status: '0x1',
    to: transaction.to,
    transactionHash: hash,
    transactionIndex: '0x0',
    type: '0x0',
  };
}
