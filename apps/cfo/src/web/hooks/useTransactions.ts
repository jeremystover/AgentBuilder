import { useCallback, useEffect, useState } from "react";
import { listTransactions, type ListTransactionsParams } from "../api";
import type { TransactionListResponse } from "../types";

export interface UseTransactionsOptions {
  filters: Omit<ListTransactionsParams, "limit" | "offset">;
  pageSize: number;
}

export function useTransactions(opts: UseTransactionsOptions) {
  const [data, setData] = useState<TransactionListResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtersKey = JSON.stringify(opts.filters);
  useEffect(() => { setOffset(0); }, [filtersKey]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listTransactions({
        ...opts.filters,
        limit: opts.pageSize,
        offset,
      });
      setData(res);
      if (res.total > 0 && offset >= res.total) {
        const lastPage = Math.max(0, Math.floor((res.total - 1) / opts.pageSize) * opts.pageSize);
        if (lastPage !== offset) setOffset(lastPage);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filtersKey, opts.pageSize, offset]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { data, offset, setOffset, loading, error, refresh };
}
