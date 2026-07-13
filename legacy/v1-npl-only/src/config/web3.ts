import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Storage } from '@reown/appkit-react-native';
import { EthersAdapter } from '@reown/appkit-ethers-react-native';
import { createAppKit } from '@reown/appkit-react-native';
import { NativeModules, Platform } from 'react-native';

export const BSC_CHAIN_ID = Number(process.env.EXPO_PUBLIC_BSC_CHAIN_ID || 56);
export const NPL_BSC_ADDRESS = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2' as const;
export const ESCROW_ADDRESS = (process.env.EXPO_PUBLIC_ESCROW_ADDRESS || '') as `0x${string}` | '';
export const API_BASE_URL = resolveApiBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8787');

export const bscNetwork = {
  id: BSC_CHAIN_ID,
  name: 'BNB Smart Chain',
  nativeCurrency: {
    decimals: 18,
    name: 'BNB',
    symbol: 'BNB'
  },
  rpcUrls: {
    default: {
      http: [process.env.EXPO_PUBLIC_BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org']
    }
  },
  blockExplorers: {
    default: {
      name: 'BscScan',
      url: process.env.EXPO_PUBLIC_BSC_EXPLORER_URL || 'https://bscscan.com'
    }
  },
  chainNamespace: 'eip155',
  caipNetworkId: `eip155:${BSC_CHAIN_ID}`
} as const;

const storage: Storage = {
  async getKeys() {
    return AsyncStorage.getAllKeys();
  },
  async getEntries<T = unknown>() {
    const keys = await AsyncStorage.getAllKeys();
    const entries = await Promise.all(keys.map(async (key): Promise<[string, T | undefined]> => {
      const value = await AsyncStorage.getItem(key);
      return [key, value ? (JSON.parse(value) as T) : undefined];
    }));
    return entries as [string, T][];
  },
  async getItem<T = unknown>(key: string) {
    const value = await AsyncStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : undefined;
  },
  async setItem<T = unknown>(key: string, value: T) {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  },
  async removeItem(key: string) {
    await AsyncStorage.removeItem(key);
  }
};

export const appKitProjectId = process.env.EXPO_PUBLIC_REOWN_PROJECT_ID || '00000000000000000000000000000000';
export const isWalletProjectConfigured = Boolean(process.env.EXPO_PUBLIC_REOWN_PROJECT_ID);

export const appKit = createAppKit({
  projectId: appKitProjectId,
  metadata: {
    name: '24K Mall',
    description: '24K Web3 mall on BSC with NPL settlement',
    url: 'https://24k.local',
    icons: ['https://24k.local/icon.png'],
    redirect: {
      native: 'twentyfourk://'
    }
  },
  adapters: [new EthersAdapter()],
  networks: [bscNetwork],
  defaultNetwork: bscNetwork,
  storage,
  themeMode: 'light',
  themeVariables: {
    accent: '#D8A23A'
  },
  features: {
    swaps: false,
    onramp: false,
    socials: false
  }
});

function resolveApiBaseUrl(configuredUrl: string) {
  const trimmed = configuredUrl.replace(/\/$/, '');
  if (!isLocalhostUrl(trimmed)) return trimmed;

  const host = getDevServerHost();
  if (!host || isLoopbackHost(host) || host.endsWith('.exp.direct') || host.endsWith('.expo.dev')) {
    return trimmed;
  }

  return `http://${host}:8787`;
}

function isLocalhostUrl(value: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value);
}

function isLoopbackHost(value: string) {
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

function getDevServerHost() {
  if (Platform.OS === 'web') return '';
  const scriptURL = String(NativeModules.SourceCode?.scriptURL || '');
  const match = scriptURL.match(/^(?:https?|exp):\/\/(\[[^\]]+\]|[^/:?#]+)(?::\d+)?/i);
  return match?.[1]?.replace(/^\[|\]$/g, '') || '';
}
