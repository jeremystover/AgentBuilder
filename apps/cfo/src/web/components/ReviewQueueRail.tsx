import { useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import { listReview } from "../api";
import type { ReviewItem } from "../types";
import { fmtUsd, humanizeSlug } from "./ui";

// Left-rail "next 3 pending" widget. Click any item or the header to
// jump to #/review for the full list. Refreshes when the route changes
// (handled by App.tsx via the `tick` prop).

export function ReviewQueueRail({ tick = 0 }: { tick?: number }) {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    listReview({ status: "pending", limit: 3, offset: 0 })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [tick]);

  return (
    <div className="h-full flex flex-col">
      <a
        href="#/review"
        className="border-b border-border px-4 py-3 hover:bg-bg-elevated transition-colors"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
            Review queue
          </h2>
          <Inbox className="w-4 h-4 text-text-muted" />
        </div>
        {total > 0 && (
          <div className="mt-1 text-xs text-text-muted">{total} pending</div>
        )}
      </a>
      <div className="flex-1 overflow-y-auto px-2 py-2 scrollbar-thin">
        {error && <div className="text-xs text-accent-danger px-2">{error}</div>}
        {!error && items === null && <div className="text-xs text-text-subtle px-2">Loading…</div>}
        {!error && items?.length === 0 && (
          <div className="text-xs text-text-subtle px-2 py-2">All caught up. 🎉</div>
        )}
        {items?.map((it) => (
          <a
            key={it.id}
            href="#/review"
            className="block rounded-md px-2 py-2 hover:bg-bg-elevated transition-colors"
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-sm text-text-primary truncate">
                {it.merchant_name ?? it.description ?? "—"}
              </div>
              <div className="text-xs tabular-nums text-text-muted">
                {fmtUsd(it.amount, { sign: true })}
              </div>
            </div>
            {it.suggested_category_tax && (
              <div className="text-xs text-text-subtle truncate">
                → {humanizeSlug(it.suggested_category_tax)}
              </div>
            )}
          </a>
        ))}
        {total > (items?.length ?? 0) && (
          <a href="#/review" className="block px-2 py-2 text-xs text-accent-primary hover:underline">
            View all {total} →
          </a>
        )}
      </div>
    </div>
  );
}
