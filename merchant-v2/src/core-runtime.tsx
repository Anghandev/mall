import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Eip712TypedData } from '@abu24k/core-artifacts';
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
  signOut(): void;
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
      const challenge = await api.createSiweChallenge(walletAddress);
      const signature = await signSiweMessage(provider, walletAddress, challenge.message);
      const nextSession = await api.verifySiwe(challenge.message, signature);
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

  const signOut = useCallback(() => {
    setSession(undefined);
    setActiveProvider(undefined);
    setAuthError(undefined);
  }, []);

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
