export interface Eip1193Provider {
  request(input: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

export type WalletKind = 'metamask' | 'okx';

declare global {
  interface Window {
    ethereum?: Eip1193Provider & { isMetaMask?: boolean };
    okxwallet?: Eip1193Provider;
  }
}

export function walletProvider(kind: WalletKind) {
  if (kind === 'okx') return window.okxwallet;
  return window.ethereum;
}

export async function connectWallet(provider: Eip1193Provider) {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0])) {
    throw new Error('钱包未返回有效地址。');
  }
  const chainId = await provider.request({ method: 'eth_chainId' });
  if (chainId !== '0x38' && chainId !== '0X38') {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
    } catch {
      throw new Error('请在钱包中切换到 BSC 主网（Chain ID 56）后重试。');
    }
  }
  return accounts[0];
}

export async function signSiweMessage(provider: Eip1193Provider, walletAddress: string, message: string) {
  const signature = await provider.request({
    method: 'personal_sign',
    params: [message, walletAddress],
  });
  if (typeof signature !== 'string' || signature.length === 0) throw new Error('钱包未返回有效签名。');
  return signature;
}
