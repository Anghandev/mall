import { describe, expect, it, vi } from 'vitest';
import {
  connectWallet,
  signSettlementTypedData,
  signSiweMessage,
  walletProvider,
  type Eip1193Provider,
} from '../src/wallet';
import { settlementIntent } from './settlement-fixtures';

const walletAddress = '0x1111111111111111111111111111111111111111';

describe('EIP-1193 merchant wallet boundary', () => {
  it('picks the requested wallet provider in multi-wallet browsers', () => {
    const metaMask = { request: vi.fn(), isMetaMask: true };
    const okx = { request: vi.fn(), isOkxWallet: true };
    Object.defineProperty(window, 'ethereum', { configurable: true, value: { request: vi.fn(), providers: [okx, metaMask] } });
    Object.defineProperty(window, 'okxwallet', { configurable: true, value: okx });

    expect(walletProvider('metamask')).toBe(metaMask);
    expect(walletProvider('okx')).toBe(okx);
  });

  it('does not treat an OKX-only injection as MetaMask', () => {
    const okx = { request: vi.fn(), isOkxWallet: true };
    Object.defineProperty(window, 'ethereum', { configurable: true, value: okx });
    Object.defineProperty(window, 'okxwallet', { configurable: true, value: okx });

    expect(walletProvider('metamask')).toBeUndefined();
    expect(walletProvider('okx')).toBe(okx);
  });

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
      if (method === 'eth_accounts') return [walletAddress];
      if (method === 'eth_signTypedData_v4') return signature;
      throw new Error(`Unexpected method: ${method}`);
    });

    await expect(signSettlementTypedData({ request }, walletAddress, settlementIntent.typedData)).resolves.toBe(signature);
    expect(request).toHaveBeenNthCalledWith(3, {
      method: 'eth_signTypedData_v4',
      params: [walletAddress, JSON.stringify(withEip712DomainType(settlementIntent.typedData))],
    });
  });

  it('does not ask for a settlement signature when the wallet plugin account changed', async () => {
    const otherWallet = '0x2222222222222222222222222222222222222222';
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_accounts') return [otherWallet];
      if (method === 'eth_signTypedData_v4') return `0x${'12'.repeat(65)}`;
      throw new Error(`Unexpected method: ${method}`);
    });

    await expect(signSettlementTypedData({ request }, walletAddress, settlementIntent.typedData))
      .rejects.toThrow('钱包插件当前账户不是商家结算钱包');
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      method: 'eth_signTypedData_v4',
    }));
  });

  it('rejects an invalid settlement signature response', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => (
      method === 'eth_chainId' ? '0x38' : method === 'eth_accounts' ? [walletAddress] : 'not-a-signature'
    ));

    await expect(signSettlementTypedData({ request }, walletAddress, settlementIntent.typedData))
      .rejects.toThrow('EIP-712');
  });
});


function withEip712DomainType(typedData: typeof settlementIntent.typedData) {
  return {
    ...typedData,
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...typedData.types,
    },
  };
}
