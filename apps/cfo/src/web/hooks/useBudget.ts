import { useCallback, useEffect, useState } from "react";
import { getBudgetStatus, listBudgetCategories, listBudgetTargets, type BudgetStatusParams } from "../api";
import type { BudgetCategory, BudgetStatusResponse, BudgetTarget } from "../types";

export interface UseBudgetOptions {
  status: BudgetStatusParams;
}

export interface UseBudgetResult {
  status: BudgetStatusResponse | null;
  categories: BudgetCategory[];
  targets: BudgetTarget[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useBudget(opts: UseBudgetOptions): UseBudgetResult {
  const [status, setStatus] = useState<BudgetStatusResponse | null>(null);
  const [categories, setCategories] = useState<BudgetCategory[]>([]);
  const [targets, setTargets] = useState<BudgetTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const statusKey = JSON.stringify(opts.status);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, c, t] = await Promise.all([
        getBudgetStatus(opts.status),
        listBudgetCategories(),
        listBudgetTargets(),
      ]);
      setStatus(s);
      setCategories(c.categories);
      setTargets(t.targets);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusKey]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { status, categories, targets, loading, error, refresh };
}
