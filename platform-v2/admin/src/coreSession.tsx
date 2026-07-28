import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CoreApiError, createWalletSession, type CoreSession } from './coreApi';
import { humanizeError } from './display';

type SessionState = {
  connect(): Promise<void>;
  disconnect(): void;
  error: string | null;
  session: CoreSession | null;
  status: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';
};

const SessionContext = createContext<SessionState | null>(null);

export function CoreSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<CoreSession | null>(null);
  const [status, setStatus] = useState<SessionState['status']>('DISCONNECTED');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.on) return;
    const clearWalletSession = () => {
      setSession(null);
      setStatus('DISCONNECTED');
      setError('钱包账户或链已变更，请重新认证');
    };
    provider.on('accountsChanged', clearWalletSession);
    provider.on('chainChanged', clearWalletSession);
    return () => {
      provider.removeListener?.('accountsChanged', clearWalletSession);
      provider.removeListener?.('chainChanged', clearWalletSession);
    };
  }, []);

  const value = useMemo<SessionState>(() => ({
    connect: async () => {
      const provider = window.ethereum;
      if (!provider) {
        setError('未检测到支持 EIP-1193 的钱包');
        return;
      }
      setStatus('CONNECTING');
      setError(null);
      try {
        const nextSession = await createWalletSession(provider);
        setSession(nextSession);
        setStatus('CONNECTED');
      } catch (cause) {
        setSession(null);
        setStatus('DISCONNECTED');
        setError(cause instanceof CoreApiError ? humanizeError(cause) : '钱包认证失败，请确认当前钱包有后台权限。');
      }
    },
    disconnect: () => {
      setSession(null);
      setStatus('DISCONNECTED');
      setError(null);
    },
    error,
    session,
    status,
  }), [error, session, status]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useCoreSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useCoreSession must be used inside CoreSessionProvider');
  return context;
}

declare global {
  interface Window {
    ethereum?: import('./coreApi').WalletProvider;
  }
}
