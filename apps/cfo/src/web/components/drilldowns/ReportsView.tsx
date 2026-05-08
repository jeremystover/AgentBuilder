import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Badge, Select, Drawer, PageHeader, EmptyState, fmtUsd, humanizeSlug,
} from "../ui";
import {
  getScheduleC, getScheduleE, getSummaryReport, reportExportUrl, listTransactions,
} from "../../api";
import type {
  ScheduleReport, ScheduleCEntity, SummaryReport, ScheduleLine,
  EntitySlug, Transaction,
} from "../../types";

type Tab =
  | { kind: "schedule_c"; entity: ScheduleCEntity }
  | { kind: "schedule_e" }
  | { kind: "summary" };

const TABS: { id: string; label: string; tab: Tab }[] = [
  { id: "c-elyse",   label: "Schedule C — Elyse",   tab: { kind: "schedule_c", entity: "elyse_coaching" } },
  { id: "c-jeremy",  label: "Schedule C — Jeremy",  tab: { kind: "schedule_c", entity: "jeremy_coaching" } },
  { id: "e",         label: "Schedule E — Whitford", tab: { kind: "schedule_e" } },
  { id: "summary",   label: "Summary",              tab: { kind: "summary" } },
];

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2, CURRENT_YEAR - 3, CURRENT_YEAR - 4];

export function ReportsView() {
  const [year, setYear] = useState<string>(String(CURRENT_YEAR));
  const [tabId, setTabId] = useState<string>("c-elyse");
  const tab = TABS.find((t) => t.id === tabId)!.tab;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Reports"
        subtitle={`Tax year ${year}`}
        actions={
          <>
            <div>
              <label className="block text-xs text-text-muted mb-1">Year</label>
              <Select value={year} onChange={(e) => setYear(e.target.value)}>
                {YEAR_OPTIONS.map((y) => <option key={y} value={String(y)}>{y}</option>)}
              </Select>
            </div>
          </>
        }
      />

      <div className="flex items-center gap-1.5 mb-4 flex-wrap">
        {TABS.map((t) => (
          <Button
            key={t.id}
            size="sm"
            variant={tabId === t.id ? "primary" : "ghost"}
            onClick={() => setTabId(t.id)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      {tab.kind === "schedule_c" && <ScheduleView key={`c-${tab.entity}-${year}`} year={year} kind="C" entity={tab.entity} />}
      {tab.kind === "schedule_e" && <ScheduleView key={`e-${year}`} year={year} kind="E" entity="airbnb_activity" />}
      {tab.kind === "summary"    && <SummaryView  key={`summary-${year}`} year={year} />}
    </div>
  );
}

// ── Schedule C / E view ─────────────────────────────────────────────────────

function ScheduleView({
  year, kind, entity,
}: {
  year: string;
  kind: "C" | "E";
  entity: EntitySlug;
}) {
  const [report, setReport] = useState<ScheduleReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [drillLine, setDrillLine] = useState<ScheduleLine | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = kind === "C"
        ? await getScheduleC(year, entity as ScheduleCEntity)
        : await getScheduleE(year);
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [year, kind, entity]);

  if (error) {
    return (
      <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">
        {error}
      </Card>
    );
  }

  if (!report) return <Card className="p-6"><EmptyState>{loading ? "Loading…" : "No data"}</EmptyState></Card>;

  const netCls =
    report.net_profit > 0 ? "text-accent-success" :
    report.net_profit < 0 ? "text-accent-danger" :
    "text-text-primary";

  return (
    <>
      {/* Summary header */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <SummaryStat label="Total income" value={fmtUsd(report.income.total)} />
        <SummaryStat label="Total expenses" value={fmtUsd(report.expenses.total)} />
        <SummaryStat label="Net profit" value={fmtUsd(report.net_profit)} valueCls={netCls} />
      </div>

      {report.pending_review > 0 && (
        <Card className="p-3 mb-4 border-accent-warn/40 bg-accent-warn/5 text-sm text-accent-warn flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {report.pending_review} transaction{report.pending_review !== 1 ? "s" : ""} for this entity still need review and are excluded from the totals above.
        </Card>
      )}

      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-text-primary">Schedule {kind} — {humanizeSlug(entity)} — {year}</h2>
        <div className="flex items-center gap-2">
          <a
            href={reportExportUrl(year, entity)}
            download
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-primary hover:bg-bg-elevated"
          >
            <Download className="w-4 h-4" /> Download CSV
          </a>
          <Button onClick={() => void refresh()} title="Refresh">
            <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
          </Button>
        </div>
      </div>

      {/* Income */}
      <Card className="overflow-hidden mb-4">
        <div className="px-4 py-2 border-b border-border bg-bg-elevated text-xs uppercase text-text-muted">Income</div>
        <ScheduleLineTable lines={report.income.categories} total={report.income.total} onLineClick={setDrillLine} />
      </Card>

      {/* Expenses */}
      <Card className="overflow-hidden">
        <div className="px-4 py-2 border-b border-border bg-bg-elevated text-xs uppercase text-text-muted">Expenses</div>
        <ScheduleLineTable lines={report.expenses.categories} total={report.expenses.total} onLineClick={setDrillLine} />
      </Card>

      <DrillDrawer
        line={drillLine}
        year={year}
        entity={entity}
        onClose={() => setDrillLine(null)}
      />
    </>
  );
}

function ScheduleLineTable({
  lines, total, onLineClick,
}: {
  lines: ScheduleLine[];
  total: number;
  onLineClick(line: ScheduleLine): void;
}) {
  if (lines.length === 0) {
    return <div className="px-4"><EmptyState>No entries</EmptyState></div>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border">
          <th className="pl-4 py-2 w-16">Line</th>
          <th>Category</th>
          <th className="text-right">Count</th>
          <th className="text-right pr-4">Amount</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr
            key={l.category_tax}
            className="border-b border-border last:border-b-0 hover:bg-bg-elevated/50 cursor-pointer"
            onClick={() => onLineClick(l)}
          >
            <td className="pl-4 py-2.5 text-text-muted text-xs">{l.form_line ?? "—"}</td>
            <td className="text-text-primary">
              {l.category_name ?? humanizeSlug(l.category_tax)}
              {!l.category_name && l.category_tax && (
                <span className="text-xs text-text-subtle ml-2">({l.category_tax})</span>
              )}
            </td>
            <td className="text-right tabular-nums text-text-muted">{l.transaction_count}</td>
            <td className="text-right pr-4 tabular-nums text-text-primary">{fmtUsd(l.total_amount)}</td>
          </tr>
        ))}
        <tr className="bg-bg-elevated font-semibold">
          <td className="pl-4 py-2.5"></td>
          <td className="text-text-primary">Total</td>
          <td></td>
          <td className="text-right pr-4 tabular-nums text-text-primary">{fmtUsd(total)}</td>
        </tr>
      </tbody>
    </table>
  );
}

// ── Drill drawer ────────────────────────────────────────────────────────────

function DrillDrawer({
  line, year, entity, onClose,
}: {
  line: ScheduleLine | null;
  year: string;
  entity: EntitySlug;
  onClose(): void;
}) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!line) {
      setTransactions([]);
      setTotal(0);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await listTransactions({
          entity,
          category_tax: line.category_tax,
          date_from: `${year}-01-01`,
          date_to: `${year}-12-31`,
          limit: 200,
        });
        if (cancelled) return;
        setTransactions(res.transactions);
        setTotal(res.total);
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [line, year, entity]);

  if (!line) return null;

  return (
    <Drawer
      open={!!line}
      onClose={onClose}
      title={`${line.category_name ?? humanizeSlug(line.category_tax)} — ${year}`}
      footer={
        <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
          <span>
            {line.transaction_count} transaction{line.transaction_count !== 1 ? "s" : ""} · {fmtUsd(line.total_amount)}
          </span>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      }
    >
      {loading ? (
        <div className="text-sm text-text-muted">Loading…</div>
      ) : transactions.length === 0 ? (
        <EmptyState>No transactions found.</EmptyState>
      ) : (
        <>
          {total > transactions.length && (
            <div className="text-xs text-text-subtle mb-2">
              Showing first {transactions.length} of {total}. Use the Transactions page to see them all.
            </div>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border">
                <th className="py-1.5">Date</th>
                <th>Merchant</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-b-0">
                  <td className="py-1.5 text-text-muted whitespace-nowrap text-xs">{t.posted_date}</td>
                  <td className="text-text-primary">
                    <div className="truncate max-w-[18rem]">{t.merchant_name ?? t.description ?? "—"}</div>
                    {t.account_name && <div className="text-xs text-text-subtle truncate">{t.account_name}</div>}
                  </td>
                  <td className="text-right tabular-nums text-text-primary">{fmtUsd(t.amount, { sign: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Drawer>
  );
}

// ── Summary view ────────────────────────────────────────────────────────────

const ENTITY_ORDER: EntitySlug[] = ["elyse_coaching", "jeremy_coaching", "airbnb_activity", "family_personal"];

function SummaryView({ year }: { year: string }) {
  const [report, setReport] = useState<SummaryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await getSummaryReport(year));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [year]);

  const monthGrid = useMemo(() => {
    if (!report) return null;
    const months = Array.from(new Set(report.by_month.map((r) => r.month))).sort();
    const totalsByMonthEntity = new Map<string, number>();
    for (const r of report.by_month) {
      if (!r.entity) continue;
      totalsByMonthEntity.set(`${r.month}|${r.entity}`, r.total);
    }
    return { months, totalsByMonthEntity };
  }, [report]);

  if (error) {
    return (
      <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">
        {error}
      </Card>
    );
  }

  if (!report) return <Card className="p-6"><EmptyState>{loading ? "Loading…" : "No data"}</EmptyState></Card>;

  const byEntity = new Map<string, { total: number; count: number }>();
  for (const r of report.by_entity) {
    if (!r.entity) continue;
    byEntity.set(r.entity, { total: r.total, count: r.count });
  }

  return (
    <>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-text-primary">Year {year} — by entity</h2>
        <div className="flex items-center gap-2">
          <a
            href={reportExportUrl(year)}
            download
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-primary hover:bg-bg-elevated"
          >
            <Download className="w-4 h-4" /> Download CSV
          </a>
          <Button onClick={() => void refresh()} title="Refresh">
            <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {ENTITY_ORDER.map((entity) => {
          const row = byEntity.get(entity);
          const total = row?.total ?? 0;
          const count = row?.count ?? 0;
          const tone =
            total > 0 ? "text-accent-success" :
            total < 0 ? "text-accent-danger" :
            "text-text-primary";
          return (
            <Card key={entity} className="p-3">
              <div className="text-xs text-text-muted">{humanizeSlug(entity)}</div>
              <div className={`text-2xl tabular-nums font-semibold ${tone}`}>{fmtUsd(total, { sign: true })}</div>
              <div className="text-xs text-text-subtle">{count} tx</div>
            </Card>
          );
        })}
      </div>

      {/* Month grid */}
      <h2 className="text-sm font-semibold text-text-primary mb-2">By month</h2>
      <Card className="overflow-x-auto mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border bg-bg-elevated">
              <th className="pl-4 py-2">Month</th>
              {ENTITY_ORDER.map((e) => (
                <th key={e} className="text-right pr-4">{humanizeSlug(e)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {monthGrid && monthGrid.months.length === 0 ? (
              <tr><td colSpan={ENTITY_ORDER.length + 1}><EmptyState>No data</EmptyState></td></tr>
            ) : monthGrid!.months.map((m) => (
              <tr key={m} className="border-b border-border last:border-b-0">
                <td className="pl-4 py-2 text-text-muted whitespace-nowrap text-xs">{m}</td>
                {ENTITY_ORDER.map((e) => {
                  const v = monthGrid!.totalsByMonthEntity.get(`${m}|${e}`);
                  const cls =
                    v == null ? "text-text-subtle" :
                    v > 0 ? "text-accent-success" :
                    v < 0 ? "text-text-primary" :
                    "text-text-muted";
                  return (
                    <td key={e} className={`text-right pr-4 tabular-nums ${cls}`}>
                      {v == null ? "—" : fmtUsd(v, { sign: true })}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Review queue stats */}
      {report.review_queue.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-text-primary mb-2">Review queue (within {year})</h2>
          <Card className="p-3 flex items-center gap-2 flex-wrap">
            {report.review_queue.map((r) => (
              <Badge
                key={r.status}
                tone={r.status === "pending" ? "warn" : r.status === "resolved" ? "ok" : "neutral"}
              >
                {r.status}: {r.count}
              </Badge>
            ))}
          </Card>
        </>
      )}
    </>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────────

function SummaryStat({ label, value, valueCls = "text-text-primary" }: { label: string; value: string; valueCls?: string }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`text-2xl tabular-nums font-semibold ${valueCls}`}>{value}</div>
    </Card>
  );
}
