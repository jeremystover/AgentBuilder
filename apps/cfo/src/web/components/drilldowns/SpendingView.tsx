import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea,
  Legend, ResponsiveContainer,
} from "recharts";
import { AlertTriangle, Layers, Plus, Save, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Badge, Select, Input, Modal, PageHeader, EmptyState, SummaryStat, fmtUsd,
} from "../ui";
import { api, type Entity, type Category } from "../../api";

// ── Types mirroring the spending engine payload ─────────────────────────────

interface ReportPeriod { start: string; end: string; label: string; is_future: boolean }
interface ReportCell {
  actual: number | null;
  planned: number;
  plans: number[];
  delta: number | null;
  projected: number | null;
}
interface ReportRow {
  category_id: string;
  category_name: string;
  is_group: boolean;
  member_ids: string[];
  periods: ReportCell[];
  total_actual: number;
  total_planned: number;
  total_delta: number | null;
}
interface ReportSummary {
  total_spent: number;
  total_planned_to_date: number | null;
  delta_to_date: number | null;
  delta_to_date_pct: number | null;
  projected_end_total: number | null;
  plan_end_total: number | null;
  projected_delta: number | null;
}
interface PlanMeta { id: string; name: string; status: string; is_active: boolean }
interface SpendingReport {
  date_range: { from: string; to: string };
  period_type: "monthly" | "annual";
  periods: ReportPeriod[];
  categories: ReportRow[];
  summary: ReportSummary;
  unreviewed_count: number;
  plans: PlanMeta[];
}

interface Plan { id: string; name: string; status: string; is_active: boolean }
interface Group { id: string; name: string; member_ids: string[] }
interface SavedView {
  id: string; name: string;
  plan_ids: string[];
  date_preset: string | null;
  date_from: string | null; date_to: string | null;
  entity_ids: string[];
  category_ids: string[];
  group_ids: string[];
  period_type: "monthly" | "annual";
}

type Preset = "this_month" | "this_quarter" | "this_year" | "last_12_months" | "custom";
type Tab = "expenses" | "income";

const LINE_COLORS = [
  "#4F46E5", "#059669", "#D97706", "#DC2626", "#0891B2", "#9333EA", "#DB2777", "#65A30D",
];

// ── Main component ───────────────────────────────────────────────────────────

export function SpendingView() {
  const [tab, setTab] = useState<Tab>("expenses");

  // Reference data
  const [entities, setEntities] = useState<Entity[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);

  // Configuration
  const [activeView, setActiveView] = useState<SavedView | null>(null);
  const [preset, setPreset] = useState<Preset>("this_month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo]   = useState("");
  const [periodType, setPeriodType] = useState<"monthly" | "annual">("monthly");
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([]);
  const [selectedEntityIds, setSelectedEntityIds] = useState<string[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);

  // Data
  const [report, setReport] = useState<SpendingReport | null>(null);
  const [loading, setLoading] = useState(false);

  // Modals
  const [showGroupManager, setShowGroupManager] = useState(false);
  const [showSaveView, setShowSaveView] = useState(false);

  // Hidden lines in the chart legend (separate from analysis inclusion).
  const [hiddenLines, setHiddenLines] = useState<Set<string>>(new Set());

  // Derived: which categories are "income" vs "expense" for the tab split.
  const isIncomeCategory = useCallback((c: Category): boolean => {
    const slug = (c.slug ?? "").toLowerCase();
    const name = (c.name ?? "").toLowerCase();
    if (c.category_set === "schedule_e") return slug.includes("rent") || slug.includes("royalt");
    return /income|salary|wage|rent|dividend|interest|revenue|royalty/.test(`${slug} ${name}`);
  }, []);

  // ── Load reference data once ───────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [es, cs, ps, gs, vs] = await Promise.all([
          api.get<{ entities: Entity[] }>("/api/web/entities").then(r => r.entities),
          api.get<{ categories: Category[] }>("/api/web/categories").then(r => r.categories),
          api.get<{ plans: Plan[] }>("/api/web/spending/plans").then(r => r.plans),
          api.get<{ groups: Group[] }>("/api/web/spending/groups").then(r => r.groups),
          api.get<{ views: SavedView[] }>("/api/web/spending/views").then(r => r.views),
        ]);
        setEntities(es); setCategories(cs); setPlans(ps); setGroups(gs); setSavedViews(vs);
        if (ps.length > 0) {
          const active = ps.find(p => p.is_active) ?? ps[0]!;
          setSelectedPlanIds([active.id]);
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // Computed date range for the current preset.
  const dateRange = useMemo<{ from: string; to: string }>(() => {
    return computeDateRange(preset, customFrom, customTo);
  }, [preset, customFrom, customTo]);

  // Smart default for period type: annual if range > 24 months.
  useEffect(() => {
    if (!dateRange.from || !dateRange.to) return;
    const months = monthDiff(dateRange.from, dateRange.to);
    setPeriodType(prev => (months > 24 ? "annual" : prev === "annual" ? "monthly" : prev));
    // (Only switch to annual; leave it alone otherwise so user override sticks.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRange.from, dateRange.to]);

  // Filter category options by tab.
  const tabCategoryOptions = useMemo(() => {
    return categories.filter(c => {
      const income = isIncomeCategory(c);
      return tab === "income" ? income : !income;
    });
  }, [categories, tab, isIncomeCategory]);

  // ── Run report whenever config changes ─────────────────────────────────────
  const runReport = useCallback(async () => {
    if (!dateRange.from || !dateRange.to) return;
    setLoading(true);
    try {
      // If user hasn't picked anything, default to all categories for the tab.
      const catIds = selectedCategoryIds.length === 0 && selectedGroupIds.length === 0
        ? tabCategoryOptions.map(c => c.id)
        : selectedCategoryIds;

      const params = new URLSearchParams();
      params.set("date_from", dateRange.from);
      params.set("date_to", dateRange.to);
      params.set("period_type", periodType);
      for (const id of selectedPlanIds)   params.append("plan_ids", id);
      for (const id of selectedEntityIds) params.append("entity_ids", id);
      for (const id of catIds)            params.append("category_ids", id);
      for (const id of selectedGroupIds)  params.append("group_ids", id);

      const data = await api.get<SpendingReport>(`/api/web/spending/report?${params.toString()}`);
      setReport(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [dateRange, periodType, selectedPlanIds, selectedEntityIds, selectedCategoryIds, selectedGroupIds, tabCategoryOptions]);

  useEffect(() => { void runReport(); }, [runReport]);

  // ── Saved view loading / "modified" detection ──────────────────────────────
  const loadView = (v: SavedView) => {
    setActiveView(v);
    setSelectedPlanIds(v.plan_ids);
    setSelectedEntityIds(v.entity_ids);
    setSelectedCategoryIds(v.category_ids);
    setSelectedGroupIds(v.group_ids);
    setPeriodType(v.period_type);
    if (v.date_preset) {
      setPreset(v.date_preset as Preset);
    } else if (v.date_from && v.date_to) {
      setPreset("custom"); setCustomFrom(v.date_from); setCustomTo(v.date_to);
    }
  };
  const isModified = useMemo(() => {
    if (!activeView) return false;
    return (
      !sameArr(activeView.plan_ids, selectedPlanIds) ||
      !sameArr(activeView.entity_ids, selectedEntityIds) ||
      !sameArr(activeView.category_ids, selectedCategoryIds) ||
      !sameArr(activeView.group_ids, selectedGroupIds) ||
      activeView.period_type !== periodType ||
      (activeView.date_preset ?? "") !== (preset === "custom" ? "" : preset)
    );
  }, [activeView, selectedPlanIds, selectedEntityIds, selectedCategoryIds, selectedGroupIds, periodType, preset]);

  // ── Render ─────────────────────────────────────────────────────────────────
  const planCount = selectedPlanIds.length;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Spending"
        subtitle={
          loading ? "Loading…"
          : report
            ? `${report.date_range.from} → ${report.date_range.to} · ${report.periods.length} ${periodType === "monthly" ? "month" : "year"}${report.periods.length !== 1 ? "s" : ""}`
            : "Configure a view to see spending"
        }
        actions={
          <>
            <Button onClick={() => void runReport()} disabled={loading}>
              <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} /> Refresh
            </Button>
            {isModified && (
              <Button variant="primary" onClick={() => setShowSaveView(true)}>
                <Save className="w-4 h-4" /> Save view
              </Button>
            )}
          </>
        }
      />

      {/* Tab strip */}
      <div className="border-b border-border mb-4 flex gap-1">
        <TabButton active={tab === "expenses"} onClick={() => setTab("expenses")}>Expenses</TabButton>
        <TabButton active={tab === "income"}   onClick={() => setTab("income")}  >Income</TabButton>
      </div>

      {/* Configuration bar */}
      <Card className="p-3 mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <label className="block text-xs text-text-muted mb-1">View</label>
            <Select
              value={activeView?.id ?? ""}
              onChange={e => {
                const v = savedViews.find(sv => sv.id === e.target.value);
                if (v) loadView(v);
                else setActiveView(null);
              }}
            >
              <option value="">{isModified ? "Unsaved" : "—"}</option>
              {savedViews.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
          </div>

          <div className="flex-1 min-w-[240px]">
            <label className="block text-xs text-text-muted mb-1">Plans</label>
            <MultiSelect
              items={plans.map(p => ({ id: p.id, label: p.name + (p.is_active ? " ★" : "") }))}
              selectedIds={selectedPlanIds}
              onChange={setSelectedPlanIds}
              empty="No plans yet"
            />
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1">Range</label>
            <div className="flex items-center gap-1">
              {(["this_month", "this_quarter", "this_year", "last_12_months", "custom"] as Preset[]).map(p => (
                <Button
                  key={p}
                  size="sm"
                  variant={preset === p ? "primary" : "ghost"}
                  onClick={() => setPreset(p)}
                >
                  {presetLabel(p)}
                </Button>
              ))}
            </div>
            {preset === "custom" && (
              <div className="flex items-center gap-1 mt-1">
                <Input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
                <span className="text-text-muted text-xs">→</span>
                <Input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} />
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1">Period</label>
            <div className="flex items-center gap-1">
              <Button size="sm" variant={periodType === "monthly" ? "primary" : "ghost"} onClick={() => setPeriodType("monthly")}>Monthly</Button>
              <Button size="sm" variant={periodType === "annual"  ? "primary" : "ghost"} onClick={() => setPeriodType("annual")}>Annual</Button>
            </div>
          </div>

          <div className="min-w-[160px]">
            <label className="block text-xs text-text-muted mb-1">Entities</label>
            <MultiSelect
              items={entities.map(e => ({ id: e.id, label: e.name }))}
              selectedIds={selectedEntityIds}
              onChange={setSelectedEntityIds}
              empty="All entities"
            />
          </div>

          <div className="min-w-[200px] flex-1">
            <div className="flex items-center justify-between">
              <label className="block text-xs text-text-muted mb-1">Categories & groups</label>
              <button
                className="text-xs text-accent-primary hover:underline"
                onClick={() => setShowGroupManager(true)}
              >
                Manage groups
              </button>
            </div>
            <MultiSelect
              items={[
                ...tabCategoryOptions.map(c => ({ id: c.id, label: c.name })),
                ...groups.map(g => ({ id: `group:${g.id}`, label: g.name, icon: <Layers className="w-3 h-3" /> })),
              ]}
              selectedIds={[
                ...selectedCategoryIds,
                ...selectedGroupIds.map(id => `group:${id}`),
              ]}
              onChange={(ids) => {
                const cats: string[] = [];
                const grps: string[] = [];
                for (const id of ids) {
                  if (id.startsWith("group:")) grps.push(id.slice("group:".length));
                  else cats.push(id);
                }
                setSelectedCategoryIds(cats);
                setSelectedGroupIds(grps);
              }}
              empty={`All ${tab === "income" ? "income" : "expense"} categories`}
            />
          </div>
        </div>
      </Card>

      {/* Unreviewed alert */}
      {report && report.unreviewed_count > 0 && (
        <Card className="p-3 mb-4 border-accent-warn/40 bg-accent-warn/5 flex items-center gap-3 text-sm">
          <AlertTriangle className="w-4 h-4 text-accent-warn" />
          <span className="flex-1">
            You have {report.unreviewed_count} unreviewed transaction{report.unreviewed_count !== 1 ? "s" : ""} in this period.
          </span>
          <a href="#/review" className="text-accent-primary hover:underline font-medium">Review now →</a>
        </Card>
      )}

      {/* Summary cards */}
      {report && (
        <SummaryCards summary={report.summary} planCount={planCount} tab={tab} />
      )}

      {/* Chart */}
      {report && report.categories.length > 0 && report.periods.length > 0 && (
        <SpendingChart
          report={report}
          hiddenLines={hiddenLines}
          onToggleLine={(key) => {
            const next = new Set(hiddenLines);
            if (next.has(key)) next.delete(key); else next.add(key);
            setHiddenLines(next);
          }}
        />
      )}

      {/* Period table */}
      {report && (
        <PeriodTable report={report} tab={tab} />
      )}

      {/* Group manager */}
      <GroupManager
        open={showGroupManager}
        onClose={() => setShowGroupManager(false)}
        groups={groups}
        categories={categories}
        onChanged={async () => {
          const gs = await api.get<{ groups: Group[] }>("/api/web/spending/groups").then(r => r.groups);
          setGroups(gs);
        }}
      />

      {/* Save view */}
      <SaveViewModal
        open={showSaveView}
        onClose={() => setShowSaveView(false)}
        existing={activeView}
        snapshot={{
          plan_ids: selectedPlanIds,
          date_preset: preset === "custom" ? null : preset,
          date_from: preset === "custom" ? customFrom : null,
          date_to:   preset === "custom" ? customTo   : null,
          entity_ids: selectedEntityIds,
          category_ids: selectedCategoryIds,
          group_ids: selectedGroupIds,
          period_type: periodType,
        }}
        onSaved={async (saved) => {
          const vs = await api.get<{ views: SavedView[] }>("/api/web/spending/views").then(r => r.views);
          setSavedViews(vs);
          const fresh = vs.find(v => v.id === saved.id) ?? null;
          if (fresh) setActiveView(fresh);
          setShowSaveView(false);
        }}
      />
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        "px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px " +
        (active
          ? "border-accent-primary text-accent-primary"
          : "border-transparent text-text-muted hover:text-text-primary")
      }
    >
      {children}
    </button>
  );
}

function SummaryCards({ summary, planCount, tab }: { summary: ReportSummary; planCount: number; tab: Tab }) {
  // For income, "delta > 0" (over plan) is good (green); for expenses it's bad (red).
  const overIsBad = tab === "expenses";
  const deltaTone = (d: number | null): "default" | "success" | "warn" | "danger" => {
    if (d == null) return "default";
    const over = d > 0;
    if (over) return overIsBad ? "danger" : "success";
    return overIsBad ? "success" : "danger";
  };
  const multi = planCount > 1;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
      <SummaryStat label="Total spent" value={fmtUsd(summary.total_spent)} />
      {multi
        ? <SummaryStat label="Planned (to date)" value="—" sub="Multiple plans selected" />
        : <SummaryStat label="Planned (to date)" value={fmtUsd(summary.total_planned_to_date ?? 0)} />}
      {multi
        ? <SummaryStat label="Δ vs. plan" value="Multiple plans" tone="default" />
        : <SummaryStat
            label="Δ vs. plan"
            value={fmtUsd(summary.delta_to_date, { sign: true })}
            sub={summary.delta_to_date_pct != null ? `${(summary.delta_to_date_pct * 100).toFixed(1)}%` : undefined}
            tone={deltaTone(summary.delta_to_date)}
          />}
      <SummaryStat label="Projected end total" value={fmtUsd(summary.projected_end_total ?? 0)} />
      {multi
        ? <SummaryStat label="Plan end total" value="—" sub="Multiple plans selected" />
        : <SummaryStat label="Plan end total" value={fmtUsd(summary.plan_end_total ?? 0)} />}
      {multi
        ? <SummaryStat label="Projected Δ" value="—" sub="Multiple plans selected" />
        : <SummaryStat
            label="Projected Δ"
            value={fmtUsd(summary.projected_delta, { sign: true })}
            tone={deltaTone(summary.projected_delta)}
          />}
    </div>
  );
}

function SpendingChart({
  report, hiddenLines, onToggleLine,
}: {
  report: SpendingReport;
  hiddenLines: Set<string>;
  onToggleLine: (key: string) => void;
}) {
  // Build chart data: one row per period, with one key per (row, plan).
  const today = new Date().toISOString().slice(0, 10);
  const data = report.periods.map((p, idx) => {
    const row: Record<string, number | string | null> = { period: p.label, _start: p.start };
    for (const cat of report.categories) {
      const cell = cat.periods[idx]!;
      row[`${cat.category_id}__actual`] = p.is_future ? cell.projected : cell.actual;
      for (let pi = 0; pi < report.plans.length; pi++) {
        row[`${cat.category_id}__plan_${pi}`] = cell.plans[pi] ?? 0;
      }
    }
    return row;
  });

  const futureFrom = report.periods.find(p => p.is_future)?.label;
  const futureTo   = report.periods[report.periods.length - 1]?.label;
  const todayIdx   = report.periods.findIndex(p => p.start <= today && p.end >= today);
  const todayLabel = todayIdx >= 0 ? report.periods[todayIdx]!.label : undefined;

  const lines: Array<{ key: string; name: string; color: string; dashed: boolean }> = [];
  report.categories.forEach((cat, ci) => {
    const color = LINE_COLORS[ci % LINE_COLORS.length]!;
    lines.push({ key: `${cat.category_id}__actual`, name: `${cat.category_name} (actual)`, color, dashed: false });
    report.plans.forEach((plan, pi) => {
      lines.push({
        key: `${cat.category_id}__plan_${pi}`,
        name: `${cat.category_name} (${plan.name})`,
        color,
        dashed: true,
      });
    });
  });

  return (
    <Card className="p-4 mb-4">
      <div className="text-xs text-text-muted uppercase tracking-wide mb-3">Trend</div>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
            <XAxis dataKey="period" tick={{ fontSize: 11 }} stroke="#64748B" />
            <YAxis tick={{ fontSize: 11 }} stroke="#64748B" tickFormatter={(v) => fmtUsd(v as number)} width={70} />
            <Tooltip
              formatter={(value: number) => fmtUsd(value)}
              contentStyle={{ fontSize: 12 }}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, cursor: "pointer" }}
              onClick={(payload) => {
                const key = (payload as { dataKey?: string }).dataKey;
                if (key) onToggleLine(key);
              }}
            />
            {futureFrom && futureTo && (
              <ReferenceArea
                x1={futureFrom}
                x2={futureTo}
                strokeOpacity={0}
                fill="#F1F5F9"
                fillOpacity={0.6}
              />
            )}
            {todayLabel && (
              <ReferenceLine x={todayLabel} stroke="#0F172A" strokeDasharray="2 2" />
            )}
            {lines.map(l => (
              <Line
                key={l.key}
                type="monotone"
                dataKey={l.key}
                name={l.name}
                stroke={l.color}
                strokeWidth={l.dashed ? 1.5 : 2}
                strokeDasharray={l.dashed ? "4 4" : undefined}
                dot={false}
                hide={hiddenLines.has(l.key)}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function PeriodTable({ report, tab }: { report: SpendingReport; tab: Tab }) {
  const multi = report.plans.length > 1;
  const overIsBad = tab === "expenses";
  const deltaCls = (d: number | null) => {
    if (d == null || d === 0) return "text-text-muted";
    const over = d > 0;
    if (over) return overIsBad ? "text-accent-danger" : "text-accent-success";
    return overIsBad ? "text-accent-success" : "text-accent-danger";
  };

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-bg-elevated text-text-muted uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2 sticky left-0 bg-bg-elevated z-10">Category</th>
              {report.periods.map(p => (
                <th key={p.start} className={"text-right px-3 py-2 " + (p.is_future ? "italic text-text-muted" : "")}>{p.label}</th>
              ))}
              <th className="text-right px-3 py-2">Total</th>
            </tr>
          </thead>
          <tbody>
            {report.categories.length === 0 && (
              <tr><td colSpan={report.periods.length + 2}><EmptyState>No categories selected</EmptyState></td></tr>
            )}
            {report.categories.map(row => (
              <tr key={row.category_id} className="border-t border-border align-top">
                <td className="px-3 py-2 sticky left-0 bg-bg-surface z-10 whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    {row.is_group && <Layers className="w-3 h-3 text-text-muted" />}
                    <span className="font-medium">{row.category_name}</span>
                  </div>
                </td>
                {row.periods.map((cell, i) => {
                  const p = report.periods[i]!;
                  return (
                    <td key={i} className="px-3 py-2 text-right whitespace-nowrap">
                      <div className={p.is_future ? "italic text-text-muted" : ""}>
                        {p.is_future
                          ? (cell.projected != null ? fmtUsd(cell.projected) : "—")
                          : (cell.actual != null ? fmtUsd(cell.actual) : "—")}
                      </div>
                      {multi ? (
                        report.plans.map((plan, pi) => (
                          <div key={plan.id} className="text-text-muted">{plan.name}: {fmtUsd(cell.plans[pi] ?? 0)}</div>
                        ))
                      ) : (
                        <div className="text-text-muted">Plan: {fmtUsd(cell.planned)}</div>
                      )}
                      {!multi && !p.is_future && cell.delta != null && cell.delta !== 0 && (
                        <div className={"font-medium " + deltaCls(cell.delta)}>{fmtUsd(cell.delta, { sign: true })}</div>
                      )}
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right whitespace-nowrap font-medium">
                  <div>{fmtUsd(row.total_actual)}</div>
                  <div className="text-text-muted">Plan: {fmtUsd(row.total_planned)}</div>
                  {row.total_delta != null && (
                    <div className={deltaCls(row.total_delta)}>{fmtUsd(row.total_delta, { sign: true })}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Group manager modal ──────────────────────────────────────────────────────

function GroupManager({
  open, onClose, groups, categories, onChanged,
}: {
  open: boolean;
  onClose: () => void;
  groups: Group[];
  categories: Category[];
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => { setName(""); setMemberIds([]); setEditingId(null); };

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (editingId) {
        await api.put(`/api/web/spending/groups/${editingId}`, { name, category_ids: memberIds });
      } else {
        await api.post(`/api/web/spending/groups`, { name, category_ids: memberIds });
      }
      reset();
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const removeGroup = async (id: string) => {
    if (!confirm("Delete this group?")) return;
    setBusy(true);
    try {
      await api.del(`/api/web/spending/groups/${id}`);
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const editGroup = (g: Group) => {
    setEditingId(g.id); setName(g.name); setMemberIds(g.member_ids);
  };

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title="Category groups" width="max-w-2xl">
      <div className="space-y-4">
        {groups.length > 0 && (
          <div className="space-y-2">
            {groups.map(g => (
              <div key={g.id} className="flex items-start justify-between border border-border rounded-lg p-3">
                <div className="flex-1">
                  <div className="font-medium">{g.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {g.member_ids.map(mid => {
                      const c = categories.find(cc => cc.id === mid);
                      return <Badge key={mid} tone="neutral">{c?.name ?? mid}</Badge>;
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" onClick={() => editGroup(g)}>Edit</Button>
                  <Button size="sm" variant="danger" onClick={() => void removeGroup(g.id)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-border pt-4 space-y-2">
          <div className="text-xs uppercase text-text-muted">{editingId ? "Edit group" : "New group"}</div>
          <Input className="w-full" placeholder="Group name" value={name} onChange={e => setName(e.target.value)} />
          <div className="text-xs text-text-muted">Members</div>
          <div className="max-h-48 overflow-y-auto border border-border rounded-lg p-2 space-y-1">
            {categories.map(c => (
              <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={memberIds.includes(c.id)}
                  onChange={() => setMemberIds(prev => prev.includes(c.id) ? prev.filter(x => x !== c.id) : [...prev, c.id])}
                />
                {c.name}
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            {editingId && <Button onClick={reset}>Cancel</Button>}
            <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
              <Plus className="w-4 h-4" /> {editingId ? "Save changes" : "Create group"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Save view modal ──────────────────────────────────────────────────────────

interface ViewSnapshot {
  plan_ids: string[];
  date_preset: string | null;
  date_from: string | null;
  date_to: string | null;
  entity_ids: string[];
  category_ids: string[];
  group_ids: string[];
  period_type: "monthly" | "annual";
}

function SaveViewModal({
  open, onClose, existing, snapshot, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  existing: SavedView | null;
  snapshot: ViewSnapshot;
  onSaved: (view: { id: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"new" | "update">(existing ? "update" : "new");
  const [busy, setBusy] = useState(false);

  useEffect(() => { setName(existing?.name ?? ""); setMode(existing ? "update" : "new"); }, [existing, open]);

  const save = async () => {
    setBusy(true);
    try {
      if (mode === "update" && existing) {
        await api.put(`/api/web/spending/views/${existing.id}`, { name, ...snapshot });
        await onSaved({ id: existing.id });
      } else {
        const res = await api.post<{ id: string }>("/api/web/spending/views", { name, ...snapshot });
        await onSaved(res);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save view"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
            <Save className="w-4 h-4" /> Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {existing && (
          <div className="flex gap-2">
            <Button size="sm" variant={mode === "update" ? "primary" : "ghost"} onClick={() => setMode("update")}>Update "{existing.name}"</Button>
            <Button size="sm" variant={mode === "new" ? "primary" : "ghost"} onClick={() => setMode("new")}>Save as new</Button>
          </div>
        )}
        <div>
          <label className="block text-xs text-text-muted mb-1">View name</label>
          <Input className="w-full" value={name} onChange={e => setName(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

// ── Tiny multi-select ────────────────────────────────────────────────────────

interface MsItem { id: string; label: string; icon?: React.ReactNode }

function MultiSelect({
  items, selectedIds, onChange, empty,
}: {
  items: MsItem[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  empty: string;
}) {
  const [open, setOpen] = useState(false);

  const summary = selectedIds.length === 0
    ? empty
    : selectedIds.length <= 2
      ? items.filter(i => selectedIds.includes(i.id)).map(i => i.label).join(", ") || `${selectedIds.length} selected`
      : `${selectedIds.length} selected`;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full rounded-lg border border-border bg-bg-surface px-3 py-1.5 text-sm text-left truncate hover:bg-bg-elevated/40"
      >
        {summary}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute z-40 mt-1 max-h-64 w-full min-w-[200px] overflow-y-auto rounded-lg border border-border bg-bg-surface shadow-lg p-1">
            {items.length === 0 && <div className="px-2 py-1 text-xs text-text-muted">No options</div>}
            {items.map(item => {
              const checked = selectedIds.includes(item.id);
              return (
                <label key={item.id} className="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer rounded hover:bg-bg-elevated">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onChange(checked ? selectedIds.filter(x => x !== item.id) : [...selectedIds, item.id])}
                  />
                  {item.icon}
                  {item.label}
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeDateRange(preset: Preset, customFrom: string, customTo: string): { from: string; to: string } {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  switch (preset) {
    case "this_month":
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) };
    case "this_quarter": {
      const q = Math.floor(m / 3) * 3;
      return { from: iso(new Date(Date.UTC(y, q, 1))), to: iso(new Date(Date.UTC(y, q + 3, 0))) };
    }
    case "this_year":
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    case "last_12_months":
      return { from: iso(new Date(Date.UTC(y - 1, m, 1))), to: iso(today) };
    case "custom":
      return { from: customFrom, to: customTo };
  }
}

function presetLabel(p: Preset): string {
  return ({
    this_month:     "This month",
    this_quarter:   "This quarter",
    this_year:      "This year",
    last_12_months: "Last 12mo",
    custom:         "Custom",
  } as const)[p];
}

function monthDiff(fromIso: string, toIso: string): number {
  const a = new Date(fromIso); const b = new Date(toIso);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

function sameArr(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(); const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
