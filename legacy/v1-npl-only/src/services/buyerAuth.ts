import AsyncStorage from '@react-native-async-storage/async-storage';
import { BSC_CHAIN_ID } from '../config/web3';
import { createBuyerActionIntent, createBuyerSiweNonce, verifyBuyerSiwe } from './api';
import type { AddressMutationAuth, BuyerActionIntent, BuyerAuthSession } from './api';
import { personalSign } from './payment';
import type { WalletProvider } from './payment';

const SESSION_PREFIX = '@24k/buyer-session/';

export async function ensureBuyerSession(provider: WalletProvider, address: string): Promise<BuyerAuthSession> {
  const normalized = address.toLowerCase();
  const stored = await readStoredSession(normalized);
  if (stored && stored.expiresAt > Date.now() + 30_000) return stored;

  const nonce = await createBuyerSiweNonce(address);
  if (nonce.role !== 'buyer' || nonce.address.toLowerCase() !== normalized) throw new Error('BUYER_SIWE_MESSAGE_MISMATCH');
  const signature = await personalSign(provider, address, nonce.message);
  const session = await verifyBuyerSiwe(address, nonce.message, signature);
  if (!session.token || session.role !== 'buyer' || session.address.toLowerCase() !== normalized || session.expiresAt <= Date.now()) {
    throw new Error('BUYER_SIWE_SESSION_INVALID');
  }
  await AsyncStorage.setItem(`${SESSION_PREFIX}${normalized}`, JSON.stringify(session));
  return session;
}

export async function authorizeBuyerAction(
  provider: WalletProvider,
  address: string,
  action: BuyerActionIntent['action'],
  payload: Record<string, unknown>
): Promise<AddressMutationAuth & { session: BuyerAuthSession }> {
  const session = await ensureBuyerSession(provider, address);
  const intent = await createBuyerActionIntent(session.token, action, payload);
  if (intent.action !== action || intent.chainId !== BSC_CHAIN_ID || intent.signatureKind !== 'personal_sign' || intent.walletAddress.toLowerCase() !== session.address.toLowerCase()) {
    throw new Error('BUYER_ACTION_INTENT_MISMATCH');
  }
  const secondarySignature = await personalSign(provider, session.address, intent.secondaryMessage);
  return { session, token: session.token, secondaryMessage: intent.secondaryMessage, secondarySignature };
}

export async function clearBuyerSession(address: string) {
  await AsyncStorage.removeItem(`${SESSION_PREFIX}${address.toLowerCase()}`);
}

async function readStoredSession(address: string): Promise<BuyerAuthSession | null> {
  const raw = await AsyncStorage.getItem(`${SESSION_PREFIX}${address}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BuyerAuthSession;
    if (parsed.role !== 'buyer' || parsed.address.toLowerCase() !== address || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}
