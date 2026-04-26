import { useCallback, useEffect, useState } from "react";
import { getSnapshot } from "../api";
import type { Snapshot } from "../types";

export interface UseSnapshotResult {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
}

export function useSnapshot(): UseSnapshotResult {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await getSnapshot());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { snapshot, loading, error, refresh };
}
