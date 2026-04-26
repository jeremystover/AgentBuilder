import { useCallback, useEffect, useState } from "react";
import { Download, Lock, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Select, PageHeader, EmptyState, fmtUsd } from "../ui";
import {
  getScheduleC, getScheduleE, getSummary, exportCsvUrl, takeSnapshot,
  getTaxYearWorkflow,
} from "../../api";
import type { ScheduleReport, SummaryReport } from "../../api";
import type { TaxYearWorkflow } from "../../types";

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_CANDIDATES = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2, CURRENT_YEAR - 3];

export function ReportsView() {
  const [year, setYear] = useState<number>(CURRENT_YEAR - 1);
  const [coachingEntity, setCoachingEntity] = useState<"elyse_coaching" | "jeremy_coaching">("elyse_coaching");
  const [workflow, setWorkflow] = useState<TaxYearWorkflow | null>(null);
  const [summary, setSummary] = useState<SummaryReport | null>(null);
  const [schedC, setSchedC] = useState<ScheduleReport | null>(null);
  const [schedE, setSchedE] = useState<ScheduleReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Default to active workflow's year if present.
  useEffect(() => {
    void getTaxYearWorkflow().then((w) => {
      setWorkflow(w);
      if (w.workflow?.tax_year) setYear(w.workflow.tax_year);
    }).catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, c, e] = await Promise.all([
        getSummary(year),
        getScheduleC(year, coachingEntity),
        getScheduleE(year),
      ]);
      setSummary(s);
      setSchedC(c);
      setSchedE(e);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [year, coachingEntity]);

  useEffect(() => { void refresh(); }, [refresh]);

  const onSnapshot = useCallback(async () => {
    if (!confirm(`Take a filing snapshot of ${year}? This locks the totals at this moment.`)) return;
    setBusy(true);
    try {
      const r = await takeSnapshot(year);
      toast.success(`Snapshot saved (${r.snapshot_id})`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [year]);

  const yearOptions = workflow?.workflow?.tax_year && !YEAR_CANDIDATES.includes(workflow.workflow.tax_year)
    ? [workflow.workflow.tax_year, ...YEAR_CANDIDATES]
    : YEAR_CANDIDATES;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Reports"
        subtitle="Schedule C, Schedule E, and a year summary."
        actions={
          <>
            <div>
              <label className="block text-xs text-text-muted mb-1">Tax year</label>
              <Select value={year} onChange={(e) => setYear(parseInt(e.target.value, 10))}>
                {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
              </Select>
            </div>
            <Button onClick={() => void refresh()}><RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} /></Button>
          </>
        }
      />

      {error && <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">{error}</Card>}

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-5">
        <Card className="p-4">
          <div className="text-xs text-text-muted">Coaching net profit</div>
          <div className={"text-2xl font-semibold mt-0.5 " + ((schedC?.net_profit ?? 0) >= 0 ? "text-accent-success" : "text-accent-danger")}>
            {fmtUsd(schedC?.net_profit)}
          </div>
          <div className="text-xs text-text-muted mt-2">{coachingEntity.replace("_", " ")}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-text-muted">Whitford House net</div>
          <div className={"text-2xl font-semibold mt-0.5 " + ((schedE?.net_income ?? 0) >= 0 ? "text-accent-success" : "text-accent-danger")}>
            {fmtUsd(schedE?.net_income)}
          </div>
          <div className="text-xs text-text-muted mt-2">Schedule E</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-text-muted">Pending review</div>
          <div className="text-2xl font-semibold mt-0.5">
            {summary?.review_queue.find((r) => r.status === "pending")?.count ?? 0}
          </div>
          <div className="text-xs text-text-muted mt-2">items still flagged</div>
        </Card>
      </div>

      {/* Schedule C */}
      <Card className="mb-4 p-5">
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <div>
            <h3 className="font-semibold text-text-primary">Schedule C — Coaching</h3>
            <Select value={coachingEntity} onChange={(e) => setCoachingEntity(e.target.value as "elyse_coaching" | "jeremy_coaching")} className="mt-1.5 text-xs">
              <option value="elyse_coaching">Elyse coaching</option>
              <option value="jeremy_coaching">Jeremy coaching</option>
            </Select>
          </div>
          <a href={exportCsvUrl(year, coachingEntity)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-primary hover:bg-bg-elevated">
            <Download className="w-4 h-4" /> Export CSV
          </a>
        </div>
        <ScheduleTable report={schedC} />
      </Card>

      {/* Schedule E */}
      <Card className="mb-4 p-5">
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <h3 className="font-semibold text-text-primary">Schedule E — Whitford House</h3>
          <a href={exportCsvUrl(year, "airbnb_activity")} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-primary hover:bg-bg-elevated">
            <Download className="w-4 h-4" /> Export CSV
          </a>
        </div>
        <ScheduleTable report={schedE} />
      </Card>

      {/* Footer actions */}
      <div className="flex gap-2">
        <a href={exportCsvUrl(year)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-primary hover:bg-bg-elevated">
          <Download className="w-4 h-4" /> Export all transactions
        </a>
        <Button variant="success" onClick={onSnapshot} disabled={busy}>
          <Lock className="w-4 h-4" /> Create filing snapshot
        </Button>
      </div>
    </div>
  );
}

function ScheduleTable({ report }: { report: ScheduleReport | null }) {
  if (!report) return <EmptyState>Loading…</EmptyState>;
  const rows = [
    ...report.income.categories.map((c) => ({ ...c, kind: "income" as const })),
    ...report.expenses.categories.map((c) => ({ ...c, kind: "expense" as const })),
  ];
  if (rows.length === 0) return <EmptyState>No classified transactions for this entity in {report.tax_year}.</EmptyState>;
  const totalIncome = report.income.total;
  const totalExpense = report.expenses.total;
  const net = report.net_profit ?? report.net_income ?? (totalIncome - totalExpense);

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border">
          <th className="py-2">Category</th>
          <th>Form line</th>
          <th className="text-right">Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.kind}-${r.category_tax}`} className="border-b border-border last:border-b-0">
            <td className="py-2">
              <span className={r.kind === "income" ? "text-accent-success font-medium" : "text-text-primary"}>
                {r.category_name ?? r.category_tax.replace(/_/g, " ")}
              </span>
              <span className="text-xs text-text-subtle ml-2">({r.transaction_count} tx)</span>
            </td>
            <td className="text-text-muted">{r.form_line ?? "—"}</td>
            <td className={"text-right tabular-nums " + (r.kind === "income" ? "text-accent-success" : "text-text-primary")}>
              {fmtUsd(r.total_amount)}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-border">
          <td colSpan={2} className="py-2 font-semibold">Income</td>
          <td className="text-right tabular-nums font-semibold text-accent-success">{fmtUsd(totalIncome)}</td>
        </tr>
        <tr>
          <td colSpan={2} className="py-2 font-semibold">Expenses</td>
          <td className="text-right tabular-nums font-semibold text-accent-danger">{fmtUsd(totalExpense)}</td>
        </tr>
        <tr className="border-t border-border">
          <td colSpan={2} className="py-2 font-bold">Net</td>
          <td className={"text-right tabular-nums font-bold " + (net >= 0 ? "text-accent-success" : "text-accent-danger")}>{fmtUsd(net)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
