import { useCallback, useEffect, useState } from "react";
import { listReview } from "../api";
import type { ReviewListResponse, ReviewStatus } from "../types";

export interface UseReviewQueueOptions {
  status: ReviewStatus;
  category_tax: string | null;
  pageSize: number;
}

export function useReviewQueue(opts: UseReviewQueueOptions) {
  const [data, setData] = useState<ReviewListResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to first page when filters change.
  useEffect(() => { setOffset(0); }, [opts.status, opts.category_tax]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = {
        status: opts.status,
        limit: opts.pageSize,
        offset,
        ...(opts.category_tax ? { category_tax: opts.category_tax } : {}),
      };
      const res = await listReview(params);
      setData(res);
      // If filters narrowed results past the current offset, snap back.
      if (res.total > 0 && offset >= res.total) {
        const lastPage = Math.max(0, Math.floor((res.total - 1) / opts.pageSize) * opts.pageSize);
        if (lastPage !== offset) setOffset(lastPage);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [opts.status, opts.category_tax, opts.pageSize, offset]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { data, offset, setOffset, loading, error, refresh };
}
