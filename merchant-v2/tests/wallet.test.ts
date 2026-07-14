import { describe, expect, it, vi } from 'vitest';
import { connectWallet, signSiweMessage, type Eip1193Provider } from '../src/wallet';

const walletAddress = '0x1111111111111111111111111111111111111111';

describe('EIP-1193 merchant wallet boundary', () => {
  it('switches a wrong-chain wallet to BSC before authentication', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return [walletAddress];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_switchEthereumChain') return null;
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
});
