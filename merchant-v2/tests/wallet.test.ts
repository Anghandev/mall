import { describe, expect, it, vi } from 'vitest';
import {
  connectWallet,
  signSettlementTypedData,
  signSiweMessage,
  type Eip1193Provider,
} from '../src/wallet';
import { settlementIntent } from './settlement-fixtures';

const walletAddress = '0x1111111111111111111111111111111111111111';

describe('EIP-1193 merchant wallet boundary', () => {
  it('switches a wrong-chain wallet to BSC before authentication', async () => {
    let chainId = '0x1';
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return [walletAddress];
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') {
        chainId = '0x38';
        return null;
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    await expect(connectWallet({ request })).resolves.toBe(walletAddress);
    expect(request).toHaveBeenNthCalledWith(3, {
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x38' }],
    });
  });

  it('fails closed when BSC switching is rejected', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_requestAccounts') return [walletAddress];
        if (method === 'eth_chainId') return '0x1';
        throw new Error('switch rejected');
      }),
    };

    await expect(connectWallet(provider)).rejects.toThrow('Chain ID 56');
  });

  it('signs the exact Core SIWE message with the connected address', async () => {
    const request = vi.fn(async () => '0xsigned');
    await expect(signSiweMessage({ request }, walletAddress, 'exact challenge')).resolves.toBe('0xsigned');
    expect(request).toHaveBeenCalledWith({
      method: 'personal_sign',
      params: ['exact challenge', walletAddress],
    });
  });

  it('signs the exact published settlement typed data on BSC', async () => {
    const signature = `0x${'12'.repeat(65)}`;
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_signTypedData_v4') return signature;
      throw new Error(`Unexpected method: ${method}`);
    });

    await expect(signSettlementTypedData({ request }, walletAddress, settlementIntent.typedData)).resolves.toBe(signature);
    expect(request).toHaveBeenNthCalledWith(2, {
      method: 'eth_signTypedData_v4',
      params: [walletAddress, JSON.stringify(settlementIntent.typedData)],
    });
  });

  it('rejects an invalid settlement signature response', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => (
      method === 'eth_chainId' ? '0x38' : 'not-a-signature'
    ));

    await expect(signSettlementTypedData({ request }, walletAddress, settlementIntent.typedData))
      .rejects.toThrow('EIP-712');
  });
});
