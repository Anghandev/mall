import type { Eip712TypedData } from '@abu24k/core-artifacts';

export interface Eip1193Provider {
  request(input: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  isMetaMask?: boolean;
  isOkxWallet?: boolean;
  providers?: readonly Eip1193Provider[];
}

export type WalletKind = 'metamask' | 'okx';

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
    okxwallet?: Eip1193Provider;
  }
}

export function walletProvider(kind: WalletKind) {
  const providers = injectedProviders();
  if (kind === 'okx') return window.okxwallet ?? providers.find((provider) => provider.isOkxWallet);
  return providers.find((provider) => provider.isMetaMask && !provider.isOkxWallet)
    ?? (providers.length === 1 && !window.okxwallet && !providers[0]!.isOkxWallet ? providers[0] : undefined);
}

function injectedProviders() {
  const ethereum = window.ethereum;
  if (!ethereum) return [] as readonly Eip1193Provider[];
  return ethereum.providers?.length ? ethereum.providers : [ethereum];
}

export async function connectWallet(provider: Eip1193Provider) {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0])) {
    throw new Error('钱包未返回有效地址。');
  }
  await ensureBsc(provider);
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

export async function signSettlementTypedData(
  provider: Eip1193Provider,
  walletAddress: string,
  typedData: Eip712TypedData,
) {
  await ensureBsc(provider);
  const activeAccount = await activeWalletAccount(provider);
  if (!activeAccount) throw new Error('钱包没有连接账户，请重新连接商家钱包。');
  if (activeAccount.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error(`钱包插件当前账户不是商家结算钱包，请切换到 ${shortWalletAddress(walletAddress)} 后重试。`);
  }
  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [walletAddress, JSON.stringify(withEip712DomainType(typedData))],
  });
  if (typeof signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) {
    throw new Error('钱包未返回有效的 EIP-712 签名。');
  }
  return signature;
}


function withEip712DomainType(typedData: Eip712TypedData): Eip712TypedData {
  if (Object.prototype.hasOwnProperty.call(typedData.types, 'EIP712Domain')) return typedData;
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

async function activeWalletAccount(provider: Eip1193Provider) {
  const accounts = await provider.request({ method: 'eth_accounts' })
    .catch(() => provider.request({ method: 'eth_requestAccounts' }));
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0])) {
    return '';
  }
  return accounts[0];
}

async function ensureBsc(provider: Eip1193Provider) {
  const chainId = await provider.request({ method: 'eth_chainId' });
  if (chainId === '0x38' || chainId === '0X38') return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
    const switchedChainId = await provider.request({ method: 'eth_chainId' });
    if (switchedChainId !== '0x38' && switchedChainId !== '0X38') throw new Error('wrong chain');
  } catch {
    throw new Error('请在钱包中切换到 BSC 主网（Chain ID 56）后重试。');
  }
}

function shortWalletAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
