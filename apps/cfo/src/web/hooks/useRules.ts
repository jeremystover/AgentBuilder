import { useCallback, useEffect, useState } from "react";
import { listRules } from "../api";
import type { Rule } from "../types";

export interface UseRulesResult {
  rules: Rule[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useRules(): UseRulesResult {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listRules();
      setRules(res.rules);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { rules, loading, error, refresh };
}
