import { useCallback, useEffect, useState } from "react";
import { listImports } from "../api";
import type { ImportRecord } from "../types";

export interface UseImportsResult {
  imports: ImportRecord[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useImports(): UseImportsResult {
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listImports();
      setImports(res.imports);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { imports, loading, error, refresh };
}
