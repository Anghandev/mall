import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  artifactVersion,
  type Eip712TypedData,
} from '@abu24k/core-artifacts';
import {
  createCoreApi,
  CoreApiError,
  type CoreApi,
  type CoreBootstrap,
  type MerchantSession,
  type PublicMerchantApplicationResult,
} from './core-api';
import { humanizeError } from './display';
import {
  connectWallet,
  signSettlementTypedData as signWalletTypedData,
  signSiweMessage,
  type Eip1193Provider,
} from './wallet';

type BootstrapState =
  | { phase: 'checking' }
  | { phase: 'ready'; value: CoreBootstrap }
  | { phase: 'offline'; error: string };

interface CoreRuntimeValue {
  api: CoreApi;
  bootstrap: BootstrapState;
  session: MerchantSession | undefined;
  signingIn: boolean;
  authError: string | undefined;
  signIn(provider: Eip1193Provider): Promise<void>;
  submitMerchantApplication(
    provider: Eip1193Provider,
    input: { shopName: string; legalName: string; legalId: string; contactPhone: string; idempotencyKey: string },
  ): Promise<PublicMerchantApplicationResult>;
  signTypedData(typedData: Eip712TypedData): Promise<string>;
  signSettlementTypedData(typedData: Eip712TypedData): Promise<string>;
  signOut(message?: string): void;
  refreshBootstrap(): Promise<void>;
}

const CoreRuntimeContext = createContext<CoreRuntimeValue | undefined>(undefined);

export function CoreRuntimeProvider({
  children,
  client,
}: {
  children: ReactNode;
  client?: CoreApi;
}) {
  const api = useMemo(() => client ?? createCoreApi(), [client]);
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ phase: 'checking' });
  const [session, setSession] = useState<MerchantSession>();
  const [activeProvider, setActiveProvider] = useState<Eip1193Provider>();
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string>();

  useEffect(() => {
    if (!activeProvider?.on) return;
    const sessionWallet = session?.walletAddress;
    const clearWalletSession = () => {
      if (sessionWallet) clearCachedMerchantSession(sessionWallet);
      setSession(undefined);
      setActiveProvider(undefined);
      setAuthError('钱包账户或网络已变更，请重新连接商家钱包。');
    };
    activeProvider.on('accountsChanged', clearWalletSession);
    activeProvider.on('chainChanged', clearWalletSession);
    activeProvider.on('disconnect', clearWalletSession);
    return () => {
      activeProvider.removeListener?.('accountsChanged', clearWalletSession);
      activeProvider.removeListener?.('chainChanged', clearWalletSession);
      activeProvider.removeListener?.('disconnect', clearWalletSession);
    };
  }, [activeProvider, session?.walletAddress]);

  const refreshBootstrap = useCallback(async () => {
    setBootstrap({ phase: 'checking' });
    try {
      setBootstrap({ phase: 'ready', value: await api.bootstrap() });
    } catch (error) {
      setBootstrap({ phase: 'offline', error: readableError(error) });
    }
  }, [api]);

  useEffect(() => {
    void refreshBootstrap();
  }, [refreshBootstrap]);

  const signIn = useCallback(async (provider: Eip1193Provider) => {
    setSigningIn(true);
    setAuthError(undefined);
    try {
      if (bootstrap.phase !== 'ready') throw new Error('系统服务尚未就绪。');
      const walletAddress = await connectWallet(provider);
      const cachedSession = loadCachedMerchantSession(walletAddress);
      let nextSession = cachedSession ?? await createSignedMerchantSession(api, provider, walletAddress);
      if (cachedSession) {
        try {
          const profile = await api.getMerchantProfile(cachedSession.token);
          if (profile.merchantId !== cachedSession.merchantId) {
            throw new Error('缓存登录与当前商家不一致。');
          }
        } catch (error) {
          if (!isMerchantSessionAuthFailure(error) && !(error instanceof Error && error.message === '缓存登录与当前商家不一致。')) {
            throw error;
          }
          clearCachedMerchantSession(walletAddress);
          nextSession = await createSignedMerchantSession(api, provider, walletAddress);
        }
      }
      if (nextSession.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new Error('登录钱包与实际签名钱包不一致。');
      }
      if (!nextSession.roles.includes('MERCHANT')) {
        throw new Error('该钱包没有商家工作台权限。');
      }
      if (!nextSession.merchantId) {
        throw new Error('当前钱包没有绑定商家身份，已拒绝进入工作台。');
      }
      setSession({ ...nextSession, merchantId: nextSession.merchantId });
      saveCachedMerchantSession({ ...nextSession, merchantId: nextSession.merchantId });
      setActiveProvider(provider);
    } catch (error) {
      setSession(undefined);
      setActiveProvider(undefined);
      setAuthError(readableError(error));
      throw error;
    } finally {
      setSigningIn(false);
    }
  }, [api, bootstrap.phase]);

  const submitMerchantApplication = useCallback(async (
    provider: Eip1193Provider,
    input: { shopName: string; legalName: string; legalId: string; contactPhone: string; idempotencyKey: string },
  ) => {
    if (bootstrap.phase !== 'ready') throw new Error('系统服务尚未就绪。');
    const walletAddress = await connectWallet(provider);
    const challenge = await api.createSiweChallenge(walletAddress);
    const signature = await signSiweMessage(provider, walletAddress, challenge.message);
    return api.submitMerchantApplication({ ...input, message: challenge.message, signature });
  }, [api, bootstrap.phase]);

  const signTypedData = useCallback(async (typedData: Eip712TypedData) => {
    if (!session || !activeProvider) throw new Error('请先连接并验证商家钱包。');
    return signWalletTypedData(activeProvider, session.walletAddress, typedData);
  }, [activeProvider, session]);

  const signOut = useCallback((message?: string) => {
    if (session) clearCachedMerchantSession(session.walletAddress);
    setSession(undefined);
    setActiveProvider(undefined);
    setAuthError(message);
  }, [session]);

  const value = useMemo<CoreRuntimeValue>(() => ({
    api,
    bootstrap,
    session,
    signingIn,
    authError,
    signIn,
    submitMerchantApplication,
    signTypedData,
    signSettlementTypedData: signTypedData,
    signOut,
    refreshBootstrap,
  }), [
    api,
    authError,
    bootstrap,
    refreshBootstrap,
    session,
    signIn,
    signOut,
    signTypedData,
    submitMerchantApplication,
    signingIn,
  ]);

  return <CoreRuntimeContext.Provider value={value}>{children}</CoreRuntimeContext.Provider>;
}

export function useCoreRuntime() {
  const value = useContext(CoreRuntimeContext);
  if (!value) throw new Error('CoreRuntimeProvider is required');
  return value;
}

export function readableError(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 4001) return '已取消钱包操作。';
  if (error instanceof CoreApiError) return humanizeError(error);
  return humanizeError(error);
}

async function createSignedMerchantSession(api: CoreApi, provider: Eip1193Provider, walletAddress: string) {
  const challenge = await api.createSiweChallenge(walletAddress);
  const signature = await signSiweMessage(provider, walletAddress, challenge.message);
  return api.verifySiwe(challenge.message, signature);
}

const MERCHANT_SESSION_CACHE_PREFIX = 'abu24k:merchant:wallet-session';

function merchantSessionCacheKey(walletAddress: string) {
  return [
    MERCHANT_SESSION_CACHE_PREFIX,
    artifactVersion,
    '56',
    walletAddress.toLowerCase(),
  ].join(':');
}

function loadCachedMerchantSession(walletAddress: string): MerchantSession | undefined {
  try {
    const raw = globalThis.sessionStorage?.getItem(merchantSessionCacheKey(walletAddress));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<MerchantSession>;
    if (!isCachedMerchantSession(value, walletAddress)) {
      clearCachedMerchantSession(walletAddress);
      return undefined;
    }
    return value;
  } catch {
    clearCachedMerchantSession(walletAddress);
    return undefined;
  }
}

function saveCachedMerchantSession(session: MerchantSession) {
  try {
    globalThis.sessionStorage?.setItem(merchantSessionCacheKey(session.walletAddress), JSON.stringify(session));
  } catch {
    // Session reuse is a best-effort frontend optimization.
  }
}

export function clearCachedMerchantSession(walletAddress: string) {
  try {
    globalThis.sessionStorage?.removeItem(merchantSessionCacheKey(walletAddress));
  } catch {
    // ignore unavailable storage
  }
}

function isCachedMerchantSession(value: Partial<MerchantSession>, walletAddress: string): value is MerchantSession {
  const payload = typeof value.token === 'string' ? decodeJwtPayload(value.token) : null;
  return typeof value.token === 'string'
    && typeof value.walletAddress === 'string'
    && value.walletAddress.toLowerCase() === walletAddress.toLowerCase()
    && Array.isArray(value.roles)
    && value.roles.includes('MERCHANT')
    && typeof value.merchantId === 'string'
    && typeof payload?.exp === 'number'
    && payload.exp > Math.floor(Date.now() / 1_000) + 60
    && payload?.sub === walletAddress.toLowerCase();
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split('.');
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = globalThis.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isMerchantSessionAuthFailure(error: unknown) {
  return error instanceof CoreApiError
    && (error.status === 401 || ['Forbidden', 'WalletMismatch'].includes(error.code));
}
