import { useCallback, useEffect, useRef, useState } from 'react';
import { CoreApiError } from './coreApi';

export type CoreResource<Value> = {
  data: Value | null;
  error: CoreApiError | null;
  loading: boolean;
  reload(): void;
};

export function useCoreResource<Value>(load: (signal: AbortSignal) => Promise<Value>): CoreResource<Value> {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [request, setRequest] = useState(0);
  const [state, setState] = useState<Omit<CoreResource<Value>, 'reload'>>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, error: null, loading: true }));
    loadRef.current(controller.signal).then(
      (data) => setState({ data, error: null, loading: false }),
      (cause) => {
        if (controller.signal.aborted) return;
        const error = cause instanceof CoreApiError
          ? cause
          : new CoreApiError({ code: 'ExternalBlocked', message: '系统服务暂时无法连接', status: 503 });
        setState({ data: null, error, loading: false });
      },
    );
    return () => controller.abort();
  }, [request]);

  const reload = useCallback(() => setRequest((value) => value + 1), []);
  return { ...state, reload };
}
