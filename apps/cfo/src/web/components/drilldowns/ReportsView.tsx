import { useCallback, useEffect, useState } from "react";
import { RefreshCw, AlertTriangle, ExternalLink, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Badge, Select, PageHeader, EmptyState, SummaryStat, fmtUsd,
} from "../ui";
import { api } from "../../api";

interface ReportConfig {
  id: string;
  name: string;
  entity_ids: string[];
  category_ids: string[];
  category_mode: "tax" | "budget" | "all";
  include_transactions: boolean;
  drive_folder_id: string | null;
  notes: string | null;
  last_run: { generated_at: string; drive_link: string | null; status: string } | null;
}

interface ReportRun {
  id: string;
  date_from: string;
  date_to: string;
  generated_at: string;
  drive_link: string | null;
  file_name: string | null;
  status: string;
  error_message: string | null;
  transaction_count: number | null;
  unreviewed_warning_count: number | null;
}

interface ReportLine {
  line_number: string;
  label: string;
  total: number;
}
interface ReportSection {
  section_name: string;
  lines: ReportLine[];
  section_total: number;
}
interface ReportOutput {
  title: string;
  date_range: { from: string; to: string };
  generated_at: string;
  entity_names: string[];
  unreviewed_warning_count: number;
  sections: ReportSection[];
  net_total: number;
}

interface GenerateResponse {
  run_id: string;
  drive_link: string;
  file_name: string;
  transaction_count: number;
  unreviewed_warning_count: number;
  report: ReportOutput;
}

type Period = "last_month" | "last_quarter" | "last_year" | "ytd" | "custom";

export function ReportsView() {
  const [configs, setConfigs] = useState<ReportConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("last_quarter");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [runs, setRuns] = useState<ReportRun[]>([]);
  const [lastReport, setLastReport] = useState<ReportOutput | null>(null);
  const [lastDriveLink, setLastDriveLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);

  const refreshConfigs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ configs: ReportConfig[] }>("/api/web/reports/configs");
      setConfigs(res.configs);
      if (!selectedId && res.configs.length > 0) setSelectedId(res.configs[0]!.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { void refreshConfigs(); }, [refreshConfigs]);

  useEffect(() => {
    if (!selectedId) { setRuns([]); return; }
    (async () => {
      try {
        const res = await api.get<{ runs: ReportRun[] }>(`/api/web/reports/configs/${selectedId}/runs`);
        setRuns(res.runs);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [selectedId]);

  const selected = configs.find(c => c.id === selectedId) ?? null;

  const generate = async () => {
    if (!selectedId) return;
    setGenerating(true);
    setLastReport(null);
    setLastDriveLink(null);
    try {
      const body: Record<string, unknown> = { period };
      if (period === "custom") {
        body.date_from = customFrom;
        body.date_to = customTo;
      }
      const res = await api.post<GenerateResponse>(`/api/web/reports/configs/${selectedId}/generate`, body);
      setLastReport(res.report);
      setLastDriveLink(res.drive_link);
      toast.success("Report generated");
      // refresh runs
      const r = await api.get<{ runs: ReportRun[] }>(`/api/web/reports/configs/${selectedId}/runs`);
      setRuns(r.runs);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Reporting"
        subtitle="Schedule C / E and family summary reports"
        actions={<Button onClick={() => void refreshConfigs()} disabled={loading}><RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} /> Refresh</Button>}
      />

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-5">
        {/* Config list */}
        <Card className="overflow-hidden h-fit">
          <div className="px-4 py-3 border-b border-border font-semibold text-text-primary">Configurations</div>
          {configs.length === 0
            ? <EmptyState>No configs yet.</EmptyState>
            : (
              <ul>
                {configs.map(c => (
                  <li key={c.id}>
                    <button
                      onClick={() => setSelectedId(c.id)}
                      className={
                        "w-full text-left px-4 py-3 border-b border-border hover:bg-bg-elevated/60 transition-colors " +
                        (c.id === selectedId ? "bg-bg-elevated" : "")
                      }
                    >
                      <div className="font-medium text-sm">{c.name}</div>
                      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                        <Badge tone="info">{c.category_mode}</Badge>
                        {c.entity_ids.length > 0 && <Badge tone="neutral">{c.entity_ids.length} entity</Badge>}
                      </div>
                      {c.last_run && (
                        <div className="text-xs text-text-muted mt-1">
                          Last run {c.last_run.generated_at.slice(0, 10)}
                        </div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )
          }
        </Card>

        {/* Run panel */}
        <div>
          {selected ? (
            <Card className="p-4 mb-4">
              <div className="flex items-end gap-3 flex-wrap mb-3">
                <div>
                  <label className="block text-xs text-text-muted mb-1">Period</label>
                  <Select value={period} onChange={e => setPeriod(e.target.value as Period)}>
                    <option value="last_month">Last month</option>
                    <option value="last_quarter">Last quarter</option>
                    <option value="last_year">Last year</option>
                    <option value="ytd">Year to date</option>
                    <option value="custom">Custom range</option>
                  </Select>
                </div>
                {period === "custom" && (
                  <>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">From</label>
                      <input type="date" className="rounded-lg border border-border bg-bg-surface px-3 py-1.5 text-sm" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">To</label>
                      <input type="date" className="rounded-lg border border-border bg-bg-surface px-3 py-1.5 text-sm" value={customTo} onChange={e => setCustomTo(e.target.value)} />
                    </div>
                  </>
                )}
                <div className="ml-auto">
                  <Button variant="primary" onClick={() => void generate()} disabled={generating}>
                    <Sparkles className="w-4 h-4" /> {generating ? "Generating…" : "Generate"}
                  </Button>
                </div>
              </div>

              {lastReport && lastReport.unreviewed_warning_count > 0 && (
                <div className="flex items-center gap-2 p-3 mb-3 rounded-lg border border-accent-warn/30 bg-accent-warn/5 text-sm text-accent-warn">
                  <AlertTriangle className="w-4 h-4 flex-none" />
                  <span>
                    {lastReport.unreviewed_warning_count} transaction
                    {lastReport.unreviewed_warning_count !== 1 ? "s" : ""} in this period haven't been reviewed and were excluded.
                  </span>
                </div>
              )}

              {lastDriveLink && (
                <div className="flex items-center gap-2 p-3 mb-3 rounded-lg border border-accent-success/30 bg-accent-success/5 text-sm">
                  <ExternalLink className="w-4 h-4 text-accent-success" />
                  <a href={lastDriveLink} target="_blank" rel="noreferrer" className="text-accent-success font-medium hover:underline">
                    Open in Google Sheets
                  </a>
                </div>
              )}

              {lastReport && <ReportPreview report={lastReport} />}
            </Card>
          ) : (
            <Card className="p-6"><EmptyState>Select a configuration on the left.</EmptyState></Card>
          )}

          {/* Run history */}
          <Card>
            <div className="px-4 py-3 border-b border-border font-semibold text-text-primary">Run history</div>
            {runs.length === 0
              ? <EmptyState>No runs yet for this config.</EmptyState>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase text-text-muted bg-bg-elevated">
                      <tr>
                        <th className="px-4 py-2">Generated</th>
                        <th className="px-4 py-2">Period</th>
                        <th className="px-4 py-2">Status</th>
                        <th className="px-4 py-2">Tx count</th>
                        <th className="px-4 py-2">Drive</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map(r => (
                        <tr key={r.id} className="border-t border-border">
                          <td className="px-4 py-2 text-text-muted whitespace-nowrap">{r.generated_at.slice(0, 19).replace("T", " ")}</td>
                          <td className="px-4 py-2 text-text-muted">{r.date_from} → {r.date_to}</td>
                          <td className="px-4 py-2">
                            {r.status === "complete" && <Badge tone="ok">complete</Badge>}
                            {r.status === "running" && <Badge tone="info">running</Badge>}
                            {r.status === "failed" && <Badge tone="danger" >failed</Badge>}
                            {r.status === "pending" && <Badge tone="neutral">pending</Badge>}
                          </td>
                          <td className="px-4 py-2">{r.transaction_count ?? "—"}</td>
                          <td className="px-4 py-2">
                            {r.drive_link
                              ? <a href={r.drive_link} target="_blank" rel="noreferrer" className="text-accent-primary hover:underline inline-flex items-center gap-1"><ExternalLink className="w-3 h-3" /> Open</a>
                              : <span className="text-text-muted">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </Card>
        </div>
      </div>
    </div>
  );
}

function ReportPreview({ report }: { report: ReportOutput }) {
  const income = report.sections.find(s => s.section_name.toLowerCase().includes("income"));
  const expense = report.sections.find(s => s.section_name.toLowerCase().includes("expense"));

  return (
    <div>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <SummaryStat label="Income" value={fmtUsd(income?.section_total ?? 0)} />
        <SummaryStat label="Expenses" value={fmtUsd(expense ? Math.abs(expense.section_total) : 0)} />
        <SummaryStat
          label="Net"
          value={fmtUsd(report.net_total)}
          tone={report.net_total > 0 ? "success" : report.net_total < 0 ? "danger" : "default"}
        />
      </div>

      {report.sections.map(section => (
        <Card key={section.section_name} className="overflow-hidden mb-3">
          <div className="px-4 py-2 border-b border-border bg-bg-elevated text-xs uppercase text-text-muted">{section.section_name}</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border">
                <th className="pl-4 py-2 w-32">Line</th>
                <th>Category</th>
                <th className="text-right pr-4">Amount</th>
              </tr>
            </thead>
            <tbody>
              {section.lines.map(line => (
                <tr key={line.label + line.line_number} className="border-b border-border last:border-b-0">
                  <td className="pl-4 py-2 text-text-muted text-xs">{line.line_number}</td>
                  <td className="py-2">{line.label}</td>
                  <td className="py-2 pr-4 text-right">{fmtUsd(line.total)}</td>
                </tr>
              ))}
              <tr className="bg-bg-elevated">
                <td className="pl-4 py-2"></td>
                <td className="py-2 font-medium">Section total</td>
                <td className="py-2 pr-4 text-right font-medium">{fmtUsd(section.section_total)}</td>
              </tr>
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}
