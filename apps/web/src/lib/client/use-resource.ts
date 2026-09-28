'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** Load a GET resource through the BFF; `reload()` after mutations. */
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(path !== null);

  const reload = useCallback(async () => {
    if (path === null) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(undefined);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}
