import { useCallback, useEffect, useState } from 'react';

export interface Issue {
  path: (string | number)[];
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: Issue[] = [],
    /** The whole error response, for endpoints that send more than issues. */
    readonly detail: unknown = undefined,
  ) {
    super(message);
  }
}

/** Calls the admin API; JSON in, JSON out. A `Blob` body is sent as is (media uploads). */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const blob = init.body instanceof Blob;
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers:
      init.body === undefined
        ? {}
        : {
            'content-type': blob
              ? (init.body as Blob).type || 'application/octet-stream'
              : 'application/json',
          },
    body:
      init.body === undefined ? undefined : blob ? (init.body as Blob) : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data as { error?: string; message?: string; issues?: Issue[] };
    throw new ApiError(res.status, e.error ?? 'error', e.message ?? res.statusText, e.issues, data);
  }
  return data as T;
}

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
  set: (data: T) => void;
}

/** Loads `path` (null waits) and reloads on demand. */
export function useApi<T>(path: string | null): Resource<T> {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({
    loading: path !== null,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    api<T>(path).then(
      (data) => live && setState({ data, loading: false }),
      (error: unknown) =>
        live &&
        setState({
          loading: false,
          error: error instanceof ApiError ? error : new ApiError(0, 'network', String(error)),
        }),
    );
    return () => {
      live = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const set = useCallback((data: T) => setState({ data, loading: false }), []);
  return { data: state.data, error: state.error, loading: state.loading, reload, set };
}
