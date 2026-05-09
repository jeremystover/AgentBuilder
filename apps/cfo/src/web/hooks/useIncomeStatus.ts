import { useEffect, useState, useCallback } from "react";
import { getIncomeStatus, listIncomeTargets } from "../api";
import type { IncomeStatusResponse, IncomeTarget } from "../types";
import type { IncomeStatusParams } from "../api";

interface UseIncomeStatusResult {
  status: IncomeStatusResponse | null;
  targets: IncomeTarget[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useIncomeStatus(params: IncomeStatusParams): UseIncomeStatusResult {
  const [status, setStatus] = useState<IncomeStatusResponse | null>(null);
  const [targets, setTargets] = useState<IncomeTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const key = JSON.stringify(params);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, t] = await Promise.all([getIncomeStatus(params), listIncomeTargets()]);
      setStatus(s);
      setTargets(t.targets);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { status, targets, loading, error, refresh };
}
