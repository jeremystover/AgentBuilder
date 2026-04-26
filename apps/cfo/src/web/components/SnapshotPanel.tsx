import { RefreshCw, AlertTriangle } from "lucide-react";
import type { Snapshot, SnapshotBudgetLine } from "../types";

interface Props {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  onRefresh(): void;
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function SnapshotPanel({ snapshot, loading, error, onRefresh }: Props) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
          Snapshot
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          className="text-text-muted hover:text-text-primary"
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 scrollbar-thin">
        {error && (
          <div className="rounded-lg border border-accent-danger/40 bg-accent-danger/5 p-3 text-xs text-accent-danger flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>{error}</div>
          </div>
        )}

        {!error && !snapshot && loading && (
          <div className="text-xs text-text-subtle">Loading…</div>
        )}

        {snapshot && (
          <div className="flex flex-col gap-5">
            {snapshot.review_queue_count > 0 && (
              <Section title="Review queue">
                <div className="text-2xl font-semibold text-text-primary">
                  {snapshot.review_queue_count}
                </div>
                <div className="text-xs text-text-muted">items need attention</div>
              </Section>
            )}

            {snapshot.pnl && (
              <Section title={`P&L · ${snapshot.pnl.period_label}`}>
                <Row label="Income" value={fmtUsd(snapshot.pnl.consolidated.income)} positive />
                <Row label="Expense" value={fmtUsd(snapshot.pnl.consolidated.expense)} />
                <div className="mt-2 pt-2 border-t border-border">
                  <Row
                    label="Net"
                    value={fmtUsd(snapshot.pnl.consolidated.net)}
                    bold
                    positive={snapshot.pnl.consolidated.net >= 0}
                  />
                </div>
              </Section>
            )}

            {snapshot.budget && snapshot.budget.lines.length > 0 && (
              <Section title={`Budget · ${snapshot.budget.period_label}`}>
                <div className="flex flex-col gap-2">
                  {snapshot.budget.lines.slice(0, 6).map((line) => (
                    <BudgetRow key={line.category_slug} line={line} />
                  ))}
                </div>
              </Section>
            )}

            {!snapshot.pnl && !snapshot.budget && snapshot.review_queue_count === 0 && (
              <div className="text-xs text-text-subtle">No data yet for this tax year.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle mb-2">
        {title}
      </div>
      <div className="rounded-lg border border-border bg-bg-surface p-3">
        {children}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  bold = false,
  positive,
}: { label: string; value: string; bold?: boolean; positive?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={"text-text-muted " + (bold ? "font-medium text-text-primary" : "")}>{label}</span>
      <span
        className={
          (bold ? "font-semibold " : "") +
          (positive === true ? "text-accent-success " : positive === false ? "text-accent-danger " : "text-text-primary")
        }
      >
        {value}
      </span>
    </div>
  );
}

function BudgetRow({ line }: { line: SnapshotBudgetLine }) {
  const pct = Math.min(line.pct, 1.5);
  const over = line.pct > 1;
  const barColor = over ? "bg-accent-danger" : line.pct > 0.85 ? "bg-accent-warn" : "bg-accent-primary";
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="truncate text-text-primary">{line.category_name}</span>
        <span className={"tabular-nums " + (over ? "text-accent-danger font-medium" : "text-text-muted")}>
          {Math.round(line.pct * 100)}%
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-bg-elevated overflow-hidden">
        <div
          className={"h-full " + barColor}
          style={{ width: `${Math.min(pct * 100, 100)}%` }}
        />
      </div>
    </div>
  );
}
