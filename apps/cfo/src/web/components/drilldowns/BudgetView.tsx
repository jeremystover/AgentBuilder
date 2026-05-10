import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Badge, Select, Input, Drawer, PageHeader, EmptyState, fmtUsd,
} from "../ui";
import { useBudget } from "../../hooks/useBudget";
import {
  upsertBudgetTarget, deleteBudgetTarget, createBudgetCategory,
  listTransactions, classifyTransaction, getBudgetForecast, getCutsReport,
} from "../../api";
import { txAmountColor } from "../../utils/txColor";
import { CATEGORY_OPTIONS } from "../../catalog";
import type {
  BudgetCadence, BudgetPreset, BudgetStatusLine, BudgetStatusTone, BudgetTarget,
  BudgetForecastResponse, CutsReportResponse, Transaction, EntitySlug, ExpenseType,
} from "../../types";

const PRESETS: { value: BudgetPreset; label: string }[] = [
  { value: "this_week",     label: "This week" },
  { value: "this_month",    label: "This month" },
  { value: "last_month",    label: "Last month" },
  { value: "trailing_30d",  label: "Last 30d" },
  { value: "trailing_90d",  label: "Last 90d" },
  { value: "ytd",           label: "Year-to-date" },
];

const CADENCE_OPTIONS: { value: BudgetCadence; label: string }[] = [
  { value: "weekly",   label: "Weekly" },
  { value: "monthly",  label: "Monthly" },
  { value: "annual",   label: "Annual" },
  { value: "one_time", label: "One-time" },
];

const CADENCE_LABEL: Record<BudgetCadence, string> = {
  weekly:   "weekly",
  monthly:  "monthly",
  annual:   "annual",
  one_time: "one-time",
};

export function BudgetView() {
  const [preset, setPreset] = useState<BudgetPreset | "custom">("this_month");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [showNoTarget, setShowNoTarget] = useState(true);

  const statusParams = useMemo(() => {
    if (preset === "custom" && customStart && customEnd) {
      return { start: customStart, end: customEnd };
    }
    return { preset: preset === "custom" ? "this_month" : preset };
  }, [preset, customStart, customEnd]);

  const { status, categories, targets, loading, error, refresh } = useBudget({ status: statusParams });

  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [openTxSlug, setOpenTxSlug] = useState<string | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);

  const [forecast, setForecast] = useState<BudgetForecastResponse | null>(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [cuts, setCuts] = useState<CutsReportResponse | null>(null);
  const [cutsLoading, setCutsLoading] = useState(false);

  const refreshForecast = async () => {
    setForecastLoading(true);
    try {
      setForecast(await getBudgetForecast());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setForecastLoading(false);
    }
  };

  const refreshCuts = async () => {
    setCutsLoading(true);
    try {
      setCuts(await getCutsReport());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCutsLoading(false);
    }
  };

  useEffect(() => {
    void refreshForecast();
    void refreshCuts();
  }, []);

  const refreshAll = async () => {
    await Promise.all([refresh(), refreshForecast(), refreshCuts()]);
  };

  const visible = useMemo(() => {
    if (!status) return [];
    if (showNoTarget) return status.categories;
    return status.categories.filter((l) => l.status !== "no_target");
  }, [status, showNoTarget]);

  const totals = useMemo(() => {
    if (!status) return { spent: 0, target: 0, remaining: 0 };
    let spent = 0;
    let target = 0;
    for (const line of status.categories) {
      spent += line.spent;
      if (line.target) target += line.target.prorated_amount;
    }
    return { spent, target, remaining: target - spent };
  }, [status]);

  const targetByCategory = useMemo(() => {
    const map = new Map<string, BudgetTarget>();
    for (const t of targets) map.set(t.category_slug, t);
    return map;
  }, [targets]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Budget"
        subtitle={
          loading ? "Loading…" :
          status ? `${status.period.label} · ${status.period.start} → ${status.period.end} (${status.period.days} days)` :
          "No budget data"
        }
        actions={
          <>
            <Button onClick={() => setCreatingCategory(true)} disabled={loading}>
              <Plus className="w-4 h-4" /> New category
            </Button>
            <Button onClick={() => void refresh()} title="Refresh">
              <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
            </Button>
          </>
        }
      />

      <Card className="p-3 mb-4">
        <div className="flex items-center gap-1.5 flex-wrap">
          {PRESETS.map((p) => (
            <Button
              key={p.value}
              size="sm"
              variant={preset === p.value ? "primary" : "ghost"}
              onClick={() => setPreset(p.value)}
            >
              {p.label}
            </Button>
          ))}
          <div className="h-6 border-l border-border mx-1" />
          <Button
            size="sm"
            variant={preset === "custom" ? "primary" : "ghost"}
            onClick={() => setPreset("custom")}
          >
            Custom
          </Button>
          {preset === "custom" && (
            <>
              <Input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="ml-2"
              />
              <span className="text-text-muted text-xs">→</span>
              <Input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </>
          )}
        </div>
      </Card>

      <BudgetForecastPanel forecast={forecast} loading={forecastLoading} />
      <CutsPanel cuts={cuts} loading={cutsLoading} />

      {/* Totals */}
      {status && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <SummaryStat label="Total target (prorated)" value={fmtUsd(totals.target)} tone="neutral" />
          <SummaryStat label="Spent" value={fmtUsd(totals.spent)} tone="neutral" />
          <SummaryStat
            label="Remaining"
            value={fmtUsd(totals.remaining)}
            tone={totals.remaining < 0 ? "danger" : totals.remaining < totals.target * 0.1 ? "warn" : "ok"}
          />
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-text-primary">Categories</h2>
        <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={showNoTarget}
            onChange={(e) => setShowNoTarget(e.target.checked)}
          />
          Show categories without targets
        </label>
      </div>

      {error && (
        <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">
          {error}
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border bg-bg-elevated">
                <th className="pl-4 py-2">Category</th>
                <th className="text-right">Target</th>
                <th className="text-right">Spent</th>
                <th className="text-right">Remaining</th>
                <th className="w-64">Used</th>
                <th className="pr-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td colSpan={6}><EmptyState>{loading ? "Loading…" : "No categories to show."}</EmptyState></td></tr>
              ) : visible.map((line) => (
                <BudgetRow
                  key={line.category_slug}
                  line={line}
                  onClick={() => setOpenSlug(line.category_slug)}
                  onSpentClick={() => setOpenTxSlug(line.category_slug)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <BudgetTransactionsDrawer
        slug={openTxSlug}
        categoryName={openTxSlug ? (status?.categories.find((c) => c.category_slug === openTxSlug)?.category_name ?? openTxSlug) : null}
        dateFrom={status?.period.start ?? ""}
        dateTo={status?.period.end ?? ""}
        onClose={() => setOpenTxSlug(null)}
        onChanged={refreshAll}
      />

      <TargetEditor
        slug={openSlug}
        categoryName={openSlug ? (status?.categories.find((c) => c.category_slug === openSlug)?.category_name ?? openSlug) : null}
        existingTarget={openSlug ? targetByCategory.get(openSlug) ?? null : null}
        onClose={() => setOpenSlug(null)}
        onSaved={async () => { await refreshAll(); setOpenSlug(null); }}
      />

      <NewCategoryDrawer
        open={creatingCategory}
        existingSlugs={categories.map((c) => c.slug)}
        onClose={() => setCreatingCategory(false)}
        onSaved={async () => { await refreshAll(); setCreatingCategory(false); }}
      />
    </div>
  );
}

// ── Anticipated-expenses forecast panel ─────────────────────────────────────

function BudgetForecastPanel({
  forecast, loading,
}: { forecast: BudgetForecastResponse | null; loading: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (!forecast && !loading) return null;
  if (!forecast) {
    return (
      <Card className="p-3 mb-4 text-sm text-text-muted">Loading forecast…</Card>
    );
  }

  const sourceLabel: Record<"target" | "history" | "none", string> = {
    target:  "From target",
    history: "From history",
    none:    "No data",
  };

  return (
    <Card className="p-4 mb-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-xs text-text-muted uppercase tracking-wide">Anticipated expenses</div>
          <div className="text-xs text-text-subtle">
            Hybrid of active targets + trailing-12mo recurring spend.
            One-time excluded.
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Hide details" : "Show details"}
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
        <SummaryStat label="Per month" value={fmtUsd(forecast.monthly_anticipated)} tone="neutral" />
        <SummaryStat label="Per year"  value={fmtUsd(forecast.annual_anticipated)}  tone="neutral" />
        <SummaryStat
          label="Excluded one-time (last 12mo)"
          value={`${forecast.excluded_one_time_transactions.count} tx · ${fmtUsd(forecast.excluded_one_time_transactions.total)}`}
          tone="neutral"
        />
      </div>

      {forecast.one_time_targets.length > 0 && (
        <div className="rounded-md border border-border p-3 mb-3 text-xs">
          <div className="text-text-muted mb-2">
            One-time targets (envelopes — not included in monthly anticipated)
          </div>
          <ul className="space-y-1">
            {forecast.one_time_targets.map((o) => (
              <li key={o.category_slug} className="flex items-center justify-between">
                <span className="text-text-primary">{o.category_name}</span>
                <span className="tabular-nums text-text-muted">{fmtUsd(o.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border">
                <th className="py-2">Category</th>
                <th className="text-right">Per month</th>
                <th className="text-right">Per year</th>
                <th className="text-right">12mo actual</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {forecast.categories
                .filter((l) => l.monthly_anticipated > 0 || l.history_total_12mo)
                .map((line) => (
                <tr key={line.category_slug} className="border-b border-border last:border-b-0">
                  <td className="py-2">
                    <div className="text-text-primary">{line.category_name}</div>
                    {line.target && (
                      <div className="text-xs text-text-muted">
                        {fmtUsd(line.target.amount)} {CADENCE_LABEL[line.target.cadence]}
                      </div>
                    )}
                  </td>
                  <td className="text-right tabular-nums">{fmtUsd(line.monthly_anticipated)}</td>
                  <td className="text-right tabular-nums">{fmtUsd(line.annual_anticipated)}</td>
                  <td className="text-right tabular-nums text-text-muted">
                    {line.history_total_12mo == null ? "—" : fmtUsd(line.history_total_12mo)}
                  </td>
                  <td>
                    <Badge tone={line.source === "target" ? "ok" : line.source === "history" ? "neutral" : "warn"}>
                      {sourceLabel[line.source]}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ── Cuts panel ──────────────────────────────────────────────────────────────

function CutsPanel({
  cuts, loading,
}: { cuts: CutsReportResponse | null; loading: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (!cuts && !loading) return null;
  if (!cuts) {
    return <Card className="p-3 mb-4 text-sm text-text-muted">Loading cuts…</Card>;
  }

  const empty = cuts.flagged.count === 0 && cuts.complete.count === 0;

  return (
    <Card className="p-4 mb-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-xs text-text-muted uppercase tracking-wide">Expense cuts</div>
          <div className="text-xs text-text-subtle">
            Flag transactions you want to eliminate, then mark them complete once cancelled.
          </div>
        </div>
        {!empty && (
          <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide details" : "Show details"}
          </Button>
        )}
      </div>

      {empty ? (
        <div className="text-sm text-text-muted">
          Nothing flagged yet. Open the Transactions page and use the Cut tracking control on any
          transaction to mark it for elimination.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
            <SummaryStat
              label={`Flagged to cut (${cuts.flagged.count})`}
              value={fmtUsd(cuts.flagged.total)}
              tone="warn"
            />
            <SummaryStat
              label={`Cut complete (${cuts.complete.count})`}
              value={fmtUsd(cuts.complete.total)}
              tone="ok"
            />
            <SummaryStat
              label="Estimated annual savings"
              value={fmtUsd(cuts.estimated_annual_savings)}
              tone="ok"
            />
          </div>

          {expanded && (
            <div className="space-y-4">
              {cuts.complete.by_merchant.length > 0 && (
                <div>
                  <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                    Cut complete — by merchant
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-text-muted border-b border-border">
                        <th className="py-1">Merchant</th>
                        <th className="text-right">Tx total</th>
                        <th className="text-right">Annualized (12mo)</th>
                        <th className="text-right">Latest</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cuts.complete.by_merchant.map((m) => {
                        const ann = cuts.annual_savings_breakdown.find((a) => a.merchant === m.merchant);
                        return (
                          <tr key={m.merchant} className="border-b border-border last:border-b-0">
                            <td className="py-1.5 text-text-primary truncate max-w-[16rem]">{m.merchant}</td>
                            <td className="text-right tabular-nums">{fmtUsd(m.total)}</td>
                            <td className="text-right tabular-nums text-text-muted">
                              {ann?.annualized ? fmtUsd(ann.trailing_12mo) : "—"}
                            </td>
                            <td className="text-right text-xs text-text-muted">{m.latest_posted_date}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {cuts.flagged.by_merchant.length > 0 && (
                <div>
                  <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                    Flagged to cut — by merchant
                  </div>
                  <ul className="text-sm space-y-1">
                    {cuts.flagged.by_merchant.map((m) => (
                      <li key={m.merchant} className="flex items-center justify-between">
                        <span className="text-text-primary truncate max-w-[20rem]">{m.merchant}</span>
                        <span className="tabular-nums text-text-muted">
                          {m.count} tx · {fmtUsd(m.total)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────

function SummaryStat({ label, value, tone }: { label: string; value: string; tone: "neutral" | "ok" | "warn" | "danger" }) {
  const cls = {
    neutral: "text-text-primary",
    ok: "text-accent-success",
    warn: "text-accent-warn",
    danger: "text-accent-danger",
  }[tone];
  return (
    <Card className="p-3">
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`text-2xl tabular-nums font-semibold ${cls}`}>{value}</div>
    </Card>
  );
}

const STATUS_TONE: Record<BudgetStatusTone, "ok" | "warn" | "danger" | "neutral"> = {
  under: "ok",
  near: "warn",
  over: "danger",
  no_target: "neutral",
};

const STATUS_LABEL: Record<BudgetStatusTone, string> = {
  under: "On track",
  near: "Near limit",
  over: "Over budget",
  no_target: "No target",
};

function BudgetRow({ line, onClick, onSpentClick }: { line: BudgetStatusLine; onClick(): void; onSpentClick(): void }) {
  const pct = line.percent_used ?? 0;
  const barCls =
    line.status === "over" ? "bg-accent-danger" :
    line.status === "near" ? "bg-accent-warn" :
    line.status === "under" ? "bg-accent-success" :
    "bg-bg-elevated";
  const remainingCls =
    line.remaining == null ? "text-text-subtle" :
    line.remaining < 0 ? "text-accent-danger" :
    "text-text-muted";

  return (
    <tr
      className="border-b border-border last:border-b-0 hover:bg-bg-elevated/50 cursor-pointer"
      onClick={onClick}
    >
      <td className="pl-4 py-2.5">
        <div className="text-text-primary">{line.category_name}</div>
        <div className="text-xs text-text-muted">{line.tx_count} tx</div>
      </td>
      <td className="text-right tabular-nums">
        {line.target ? (
          <>
            <div className="text-text-primary">{fmtUsd(line.target.prorated_amount)}</div>
            <div className="text-xs text-text-muted">
              {fmtUsd(line.target.native_amount)} {CADENCE_LABEL[line.target.native_cadence]}
            </div>
          </>
        ) : (
          <span className="text-text-subtle">—</span>
        )}
      </td>
      <td className="text-right tabular-nums">
        <button
          className="text-accent-primary hover:underline tabular-nums cursor-pointer"
          onClick={(e) => { e.stopPropagation(); onSpentClick(); }}
          title="View transactions"
        >
          {fmtUsd(line.spent)}
        </button>
      </td>
      <td className={`text-right tabular-nums ${remainingCls}`}>
        {line.remaining == null ? "—" : fmtUsd(line.remaining)}
      </td>
      <td>
        {line.target ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 rounded-full bg-bg-elevated overflow-hidden">
              <div
                className={`h-full ${barCls} transition-all`}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
            <span className="text-xs tabular-nums text-text-muted w-12 text-right">
              {Math.round(pct)}%
            </span>
          </div>
        ) : (
          <span className="text-xs text-text-subtle">—</span>
        )}
      </td>
      <td className="pr-4">
        <Badge tone={STATUS_TONE[line.status]}>{STATUS_LABEL[line.status]}</Badge>
      </td>
    </tr>
  );
}

// ── Budget transactions drawer ───────────────────────────────────────────────

function BudgetTransactionsDrawer({
  slug, categoryName, dateFrom, dateTo, onClose, onChanged,
}: {
  slug: string | null;
  categoryName: string | null;
  dateFrom: string;
  dateTo: string;
  onClose(): void;
  onChanged(): Promise<void>;
}) {
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [reclassifying, setReclassifying] = useState<string | null>(null);

  useEffect(() => {
    if (!slug || !dateFrom || !dateTo) { setTxs([]); return; }
    setLoading(true);
    listTransactions({ category_budget: slug, date_from: dateFrom, date_to: dateTo, limit: 500, sort_by: "posted_date", sort_dir: "desc" })
      .then((r) => setTxs(r.transactions))
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [slug, dateFrom, dateTo]);

  const handleReclassify = async (tx: Transaction, newBudgetCategory: string) => {
    setReclassifying(tx.id);
    try {
      await classifyTransaction(tx.id, {
        ...(tx.entity ? { entity: tx.entity as EntitySlug } : {}),
        category_tax: tx.category_tax ?? "uncategorized",
        category_budget: newBudgetCategory || undefined,
        expense_type: tx.expense_type,
      });
      toast.success("Recategorized");
      setTxs((prev) => prev.map((t) => t.id === tx.id ? { ...t, category_budget: newBudgetCategory } : t));
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setReclassifying(null);
    }
  };

  const handleToggleOneTime = async (tx: Transaction, makeOneTime: boolean) => {
    const next: ExpenseType | null = makeOneTime ? "one_time" : null;
    setReclassifying(tx.id);
    try {
      await classifyTransaction(tx.id, {
        ...(tx.entity ? { entity: tx.entity as EntitySlug } : {}),
        category_tax: tx.category_tax ?? "uncategorized",
        category_budget: tx.category_budget ?? undefined,
        expense_type: next,
      });
      toast.success(makeOneTime ? "Marked one-time" : "Marked recurring");
      setTxs((prev) => prev.map((t) => t.id === tx.id ? { ...t, expense_type: next } : t));
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setReclassifying(null);
    }
  };

  const total = txs.reduce((sum, t) => sum + Math.abs(t.amount), 0);

  return (
    <Drawer
      open={!!slug}
      onClose={onClose}
      title={categoryName ?? "Transactions"}
    >
      {loading ? (
        <div className="text-sm text-text-muted">Loading…</div>
      ) : txs.length === 0 ? (
        <EmptyState>No transactions in this category for the period.</EmptyState>
      ) : (
        <>
          <div className="text-xs text-text-muted mb-3">
            {txs.length} transaction{txs.length !== 1 ? "s" : ""} · {fmtUsd(total)} total
          </div>
          <div className="space-y-2">
            {txs.map((tx) => (
              <div key={tx.id} className="rounded-lg border border-border p-3 bg-bg-elevated">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <div className="text-sm text-text-primary font-medium truncate">
                      {tx.merchant_name ?? tx.description ?? "—"}
                    </div>
                    {tx.merchant_name && tx.description !== tx.merchant_name && (
                      <div className="text-xs text-text-muted truncate">{tx.description}</div>
                    )}
                    <div className="text-xs text-text-muted mt-0.5">{tx.posted_date} · {tx.account_name ?? "—"}</div>
                  </div>
                  <span className={`tabular-nums text-sm font-semibold flex-none ${txAmountColor(tx.amount, tx.account_type ?? null, tx.category_tax ?? null)}`}>
                    {fmtUsd(Math.abs(tx.amount))}
                  </span>
                </div>
                <Select
                  value={tx.category_budget ?? ""}
                  onChange={(e) => void handleReclassify(tx, e.target.value)}
                  disabled={reclassifying === tx.id}
                  className="w-full text-xs"
                >
                  <option value="">— no budget category —</option>
                  {CATEGORY_OPTIONS.map(({ slug: s, label }) => (
                    <option key={s} value={s}>{label}</option>
                  ))}
                </Select>
                <label className="flex items-center gap-1.5 text-xs text-text-muted mt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tx.expense_type === "one_time"}
                    onChange={(e) => void handleToggleOneTime(tx, e.target.checked)}
                    disabled={reclassifying === tx.id}
                  />
                  Treat as one-time (exclude from forecasts)
                </label>
              </div>
            ))}
          </div>
        </>
      )}
    </Drawer>
  );
}

// ── Target editor ───────────────────────────────────────────────────────────

function TargetEditor({
  slug, categoryName, existingTarget, onClose, onSaved,
}: {
  slug: string | null;
  categoryName: string | null;
  existingTarget: BudgetTarget | null;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const [cadence, setCadence] = useState<BudgetCadence>(existingTarget?.cadence ?? "monthly");
  const [amount, setAmount] = useState<string>(existingTarget?.amount?.toString() ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState(existingTarget?.effective_from ?? "");
  const [notes, setNotes] = useState(existingTarget?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(slug);

  // Reset form whenever a different category is opened.
  if (slug !== editKey) {
    setEditKey(slug);
    setCadence(existingTarget?.cadence ?? "monthly");
    setAmount(existingTarget?.amount?.toString() ?? "");
    setEffectiveFrom(existingTarget?.effective_from ?? "");
    setNotes(existingTarget?.notes ?? "");
  }

  if (!slug) return null;

  const handleSave = async () => {
    const numericAmount = parseFloat(amount);
    if (!isFinite(numericAmount) || numericAmount < 0) {
      toast.error("Amount must be a non-negative number");
      return;
    }
    setBusy(true);
    try {
      await upsertBudgetTarget({
        category_slug: slug,
        cadence,
        amount: numericAmount,
        effective_from: effectiveFrom || undefined,
        notes: notes.trim() || undefined,
      });
      toast.success(existingTarget ? "Target updated" : "Target set");
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!existingTarget) return;
    if (!confirm(`Remove the ${CADENCE_LABEL[existingTarget.cadence]} ${fmtUsd(existingTarget.amount)} target for "${categoryName}"?`)) return;
    setBusy(true);
    try {
      await deleteBudgetTarget(existingTarget.id);
      toast.success("Target removed");
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={!!slug}
      onClose={onClose}
      title={existingTarget ? `Edit target — ${categoryName}` : `Set target — ${categoryName}`}
      footer={
        <div className="flex items-center justify-between gap-2">
          {existingTarget ? (
            <Button variant="danger" onClick={() => void handleDelete()} disabled={busy}>
              <Trash2 className="w-4 h-4" /> Remove target
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => void handleSave()} disabled={busy}>
              {existingTarget ? "Save" : "Set target"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-text-muted mb-1">Amount</label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Cadence</label>
            <Select value={cadence} onChange={(e) => setCadence(e.target.value as BudgetCadence)} className="w-full">
              {CADENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            {cadence === "one_time" && (
              <div className="text-xs text-text-subtle mt-1">
                Fixed envelope (e.g. kitchen remodel). Excluded from monthly forecast.
              </div>
            )}
          </div>
        </div>

        <div>
          <label className="block text-xs text-text-muted mb-1">Effective from</label>
          <Input
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="w-full"
          />
          <div className="text-xs text-text-subtle mt-1">
            Leaves prior target untouched for periods before this date. Defaults to today.
          </div>
        </div>

        <div>
          <label className="block text-xs text-text-muted mb-1">Notes (optional)</label>
          <Input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full"
          />
        </div>

        {existingTarget && (
          <div className="rounded-md border border-border p-3 text-xs text-text-muted">
            Current target: <span className="text-text-primary">{fmtUsd(existingTarget.amount)} {CADENCE_LABEL[existingTarget.cadence]}</span>
            {" "}since {existingTarget.effective_from}
            {existingTarget.notes && <div className="mt-1 italic">"{existingTarget.notes}"</div>}
          </div>
        )}
      </div>
    </Drawer>
  );
}

// ── New category drawer ────────────────────────────────────────────────────

function NewCategoryDrawer({
  open, existingSlugs, onClose, onSaved,
}: {
  open: boolean;
  existingSlugs: string[];
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const computedSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const slugExists = existingSlugs.includes(computedSlug);

  const handleSave = async () => {
    if (!name.trim() || !computedSlug) {
      toast.error("Name and slug are required");
      return;
    }
    if (slugExists) {
      toast.error(`Slug "${computedSlug}" already exists`);
      return;
    }
    if (!/^[a-z0-9_]+$/.test(computedSlug)) {
      toast.error("Slug must be lowercase_with_underscores");
      return;
    }
    setBusy(true);
    try {
      await createBudgetCategory({ slug: computedSlug, name: name.trim() });
      toast.success("Category created");
      setName("");
      setSlug("");
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="New budget category"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={busy}>Create</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-text-muted mb-1">Name</label>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Pet care"
            className="w-full"
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Slug</label>
          <Input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={computedSlug || "lowercase_with_underscores"}
            className="w-full"
          />
          <div className="text-xs text-text-subtle mt-1">
            Will use <span className="font-mono">{computedSlug || "—"}</span>.
            {slugExists && <span className="text-accent-danger"> Already exists.</span>}
          </div>
        </div>
      </div>
    </Drawer>
  );
}
