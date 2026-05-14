import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceDot,
} from "recharts";
import {
  Plus, Copy, GitBranch, Star, Archive, RefreshCw, Trash2, Save, ChevronDown, ChevronRight,
  Lightbulb,
} from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Badge, Select, Input, Modal, PageHeader, EmptyState, fmtUsd,
} from "../ui";
import { api, type Category } from "../../api";

type Tab = "categories" | "one_time" | "forecast";

// ── Types ────────────────────────────────────────────────────────────────────

interface Plan {
  id: string;
  name: string;
  type: "foundation" | "modification";
  parent_plan_id: string | null;
  status: "draft" | "active" | "archived";
  is_active: boolean;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
}

interface PlanCategoryChange {
  id: string;
  effective_date: string;
  delta_amount: number;
  notes: string | null;
}

interface PlanCategoryAmount {
  id: string;
  plan_id: string;
  category_id: string;
  category_name: string;
  category_slug: string;
  amount: number | null;
  period_type: "monthly" | "annual";
  override_type: "inherited" | "delta" | "fixed";
  base_rate_pct: number | null;
  base_rate_start: string | null;
  changes: PlanCategoryChange[];
}

interface ResolvedAmount {
  category_id: string;
  amount: number;
  period_type: "monthly" | "annual";
  monthly_amount: number;
  override_type: string;
  source_plan_id: string;
}

interface OneTimeItem {
  id: string;
  name: string;
  type: "expense" | "income";
  item_date: string;
  amount: number;
  category_id: string | null;
  notes: string | null;
}

interface ForecastPeriod {
  period_start: string;
  period_end: string;
  label: string;
  period_type: "month" | "year";
  total_income: number;
  total_expenses: number;
  net: number;
  one_time_items: Array<{ id: string; name: string; type: "expense" | "income"; amount: number; date: string }>;
}

// ── Top-level view ───────────────────────────────────────────────────────────

export function PlansView() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ plans: Plan[] }>("/api/web/plans");
      setPlans(res.plans);
      if (!selectedId && res.plans.length > 0) setSelectedId(res.plans[0]!.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const selected = useMemo(() => plans.find(p => p.id === selectedId) ?? null, [plans, selectedId]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Planning"
        subtitle={loading ? "Loading…" : `${plans.length} plan${plans.length !== 1 ? "s" : ""}`}
        actions={
          <>
            <Button onClick={() => setCreating(true)}><Plus className="w-4 h-4" /> New plan</Button>
            <Button onClick={() => void refresh()}><RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} /></Button>
          </>
        }
      />

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-4">
          <PlanList plans={plans} selectedId={selectedId} onSelect={setSelectedId} onChanged={refresh} />
        </div>
        <div className="col-span-8">
          {selected
            ? <PlanEditor plan={selected} plans={plans} onChanged={refresh} />
            : <Card className="p-6"><EmptyState>Select or create a plan.</EmptyState></Card>}
        </div>
      </div>

      <NewPlanModal
        open={creating}
        plans={plans}
        onClose={() => setCreating(false)}
        onSaved={async (id) => {
          await refresh();
          setSelectedId(id);
          setCreating(false);
        }}
      />
    </div>
  );
}

// ── Plan list panel ──────────────────────────────────────────────────────────

function PlanList({
  plans, selectedId, onSelect, onChanged,
}: {
  plans: Plan[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const setActive = async (id: string) => {
    setBusy(true);
    try {
      await api.put(`/api/web/plans/${id}/set-active`);
      toast.success("Set as active plan");
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const duplicate = async (id: string) => {
    setBusy(true);
    try {
      const res = await api.post<{ id: string }>(`/api/web/plans/${id}/duplicate`);
      await onChanged();
      onSelect(res.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const extend = async (id: string) => {
    setBusy(true);
    try {
      const res = await api.post<{ id: string }>(`/api/web/plans/${id}/extend`);
      await onChanged();
      onSelect(res.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const archive = async (id: string) => {
    if (!confirm("Archive this plan?")) return;
    setBusy(true);
    try {
      await api.del(`/api/web/plans/${id}`);
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  // Tree (foundation → modification) view. Order foundations first, then
  // their descendants by parent_id.
  const byId = new Map(plans.map(p => [p.id, p] as const));
  const childrenByParent = new Map<string | null, Plan[]>();
  for (const p of plans) {
    const arr = childrenByParent.get(p.parent_plan_id) ?? [];
    arr.push(p);
    childrenByParent.set(p.parent_plan_id, arr);
  }
  const roots = childrenByParent.get(null) ?? [];

  const renderTree = (plan: Plan, depth: number): React.ReactNode => (
    <div key={plan.id}>
      <PlanRow
        plan={plan}
        depth={depth}
        parentName={plan.parent_plan_id ? byId.get(plan.parent_plan_id)?.name ?? null : null}
        selected={selectedId === plan.id}
        busy={busy}
        onSelect={() => onSelect(plan.id)}
        onSetActive={() => void setActive(plan.id)}
        onDuplicate={() => void duplicate(plan.id)}
        onExtend={() => void extend(plan.id)}
        onArchive={() => void archive(plan.id)}
      />
      {(childrenByParent.get(plan.id) ?? []).map(child => renderTree(child, depth + 1))}
    </div>
  );

  return (
    <Card>
      {plans.length === 0
        ? <EmptyState>No plans yet.</EmptyState>
        : <div className="divide-y divide-border">{roots.map(p => renderTree(p, 0))}</div>}
    </Card>
  );
}

function PlanRow({
  plan, depth, parentName, selected, busy,
  onSelect, onSetActive, onDuplicate, onExtend, onArchive,
}: {
  plan: Plan;
  depth: number;
  parentName: string | null;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onSetActive: () => void;
  onDuplicate: () => void;
  onExtend: () => void;
  onArchive: () => void;
}) {
  return (
    <div
      className={"p-3 cursor-pointer transition-colors " + (selected ? "bg-accent-primary/5" : "hover:bg-bg-elevated/40")}
      style={{ paddingLeft: 12 + depth * 16 }}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {plan.is_active && <Star className="w-3.5 h-3.5 text-accent-warn fill-current" />}
          <span className="font-medium text-sm truncate">{plan.name}</span>
          <Badge tone={plan.type === "foundation" ? "info" : "neutral"}>
            {plan.type === "foundation" ? "Foundation" : "Modification"}
          </Badge>
          <Badge tone={plan.status === "active" ? "ok" : plan.status === "archived" ? "neutral" : "warn"}>
            {plan.status}
          </Badge>
        </div>
      </div>
      {parentName && <div className="text-xs text-text-muted mt-0.5">↳ {parentName}</div>}
      <div className="flex items-center gap-1 mt-1.5" onClick={e => e.stopPropagation()}>
        {!plan.is_active && (
          <Button size="sm" variant="ghost" onClick={onSetActive} disabled={busy}>
            <Star className="w-3.5 h-3.5" /> Active
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDuplicate} disabled={busy}>
          <Copy className="w-3.5 h-3.5" /> Duplicate
        </Button>
        <Button size="sm" variant="ghost" onClick={onExtend} disabled={busy}>
          <GitBranch className="w-3.5 h-3.5" /> Extend
        </Button>
        <Button size="sm" variant="ghost" onClick={onArchive} disabled={busy}>
          <Archive className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── Plan editor ──────────────────────────────────────────────────────────────

function PlanEditor({ plan, plans, onChanged }: { plan: Plan; plans: Plan[]; onChanged: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>("categories");
  const [name, setName] = useState(plan.name);
  const [savingName, setSavingName] = useState(false);

  useEffect(() => { setName(plan.name); }, [plan.id, plan.name]);

  const saveName = async () => {
    if (name === plan.name) return;
    setSavingName(true);
    try {
      await api.put(`/api/web/plans/${plan.id}`, { name });
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setSavingName(false); }
  };

  const parentName = plan.parent_plan_id ? plans.find(p => p.id === plan.parent_plan_id)?.name ?? "?" : null;

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Input
          className="flex-1 font-semibold"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={() => void saveName()}
          disabled={savingName}
        />
        <Badge tone={plan.type === "foundation" ? "info" : "neutral"}>{plan.type}</Badge>
        {plan.is_active && <Badge tone="warn">Active</Badge>}
      </div>
      {parentName && (
        <div className="text-xs text-text-muted mb-3">Extends: <span className="text-text-primary">{parentName}</span></div>
      )}

      <div className="border-b border-border mb-4 flex gap-1">
        <TabButton active={tab === "categories"} onClick={() => setTab("categories")}>Categories</TabButton>
        <TabButton active={tab === "one_time"} onClick={() => setTab("one_time")}>One-time items</TabButton>
        <TabButton active={tab === "forecast"} onClick={() => setTab("forecast")}>Forecast</TabButton>
      </div>

      {tab === "categories" && <CategoryGrid plan={plan} />}
      {tab === "one_time" && <OneTimeItemsPanel plan={plan} />}
      {tab === "forecast" && <ForecastPanel plan={plan} />}
    </Card>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        "px-3 py-1.5 text-sm font-medium border-b-2 transition-colors -mb-px " +
        (active
          ? "border-accent-primary text-accent-primary"
          : "border-transparent text-text-muted hover:text-text-primary")
      }
    >
      {children}
    </button>
  );
}

// ── Category grid ────────────────────────────────────────────────────────────

function CategoryGrid({ plan }: { plan: Plan }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [amounts, setAmounts] = useState<PlanCategoryAmount[]>([]);
  const [resolved, setResolved] = useState<Map<string, ResolvedAmount>>(new Map());
  const [parentResolved, setParentResolved] = useState<Map<string, ResolvedAmount>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [cs, as, res, parentRes] = await Promise.all([
        api.get<{ categories: Category[] }>("/api/web/categories").then(r => r.categories),
        api.get<{ amounts: PlanCategoryAmount[] }>(`/api/web/plans/${plan.id}/categories`).then(r => r.amounts),
        api.get<{ categories: ResolvedAmount[] }>(`/api/web/plans/${plan.id}/resolve`).then(r => r.categories),
        plan.parent_plan_id
          ? api.get<{ categories: ResolvedAmount[] }>(`/api/web/plans/${plan.parent_plan_id}/resolve`).then(r => r.categories)
          : Promise.resolve<ResolvedAmount[]>([]),
      ]);
      setCategories(cs);
      setAmounts(as);
      setResolved(new Map(res.map(r => [r.category_id, r])));
      setParentResolved(new Map(parentRes.map(r => [r.category_id, r])));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [plan.id, plan.parent_plan_id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const amountByCategory = useMemo(() => new Map(amounts.map(a => [a.category_id, a])), [amounts]);

  const toggleExpand = (catId: string) => {
    const next = new Set(expanded);
    if (next.has(catId)) next.delete(catId); else next.add(catId);
    setExpanded(next);
  };

  const upsert = async (catId: string, body: unknown) => {
    try {
      await api.put(`/api/web/plans/${plan.id}/categories/${catId}`, body);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-text-muted">{categories.length} categories</div>
        <Button size="sm" onClick={() => void refresh()}><RefreshCw className={"w-3.5 h-3.5 " + (loading ? "animate-spin" : "")} /></Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-text-muted uppercase tracking-wide bg-bg-elevated">
            <tr>
              <th className="text-left px-3 py-2 w-6"></th>
              <th className="text-left px-3 py-2">Category</th>
              <th className="text-left px-3 py-2">Period</th>
              {plan.type === "modification" && <th className="text-right px-3 py-2">Parent</th>}
              {plan.type === "modification" && <th className="text-left px-3 py-2">Override</th>}
              <th className="text-right px-3 py-2">Amount</th>
              <th className="text-right px-3 py-2">Effective</th>
              <th className="text-right px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {categories.map(cat => {
              const row = amountByCategory.get(cat.id);
              const res = resolved.get(cat.id);
              const par = parentResolved.get(cat.id);
              const isExpanded = expanded.has(cat.id);
              return (
                <CategoryRow
                  key={cat.id}
                  plan={plan}
                  category={cat}
                  row={row}
                  resolved={res}
                  parent={par}
                  expanded={isExpanded}
                  onToggle={() => toggleExpand(cat.id)}
                  onSave={(body) => upsert(cat.id, body)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CategoryRow({
  plan, category, row, resolved, parent, expanded, onToggle, onSave,
}: {
  plan: Plan;
  category: Category;
  row: PlanCategoryAmount | undefined;
  resolved: ResolvedAmount | undefined;
  parent: ResolvedAmount | undefined;
  expanded: boolean;
  onToggle: () => void;
  onSave: (body: unknown) => Promise<void>;
}) {
  const [amount, setAmount] = useState<string>(row?.amount != null ? String(row.amount) : "");
  const [period, setPeriod] = useState<"monthly" | "annual">(row?.period_type ?? "monthly");
  const [override, setOverride] = useState<"inherited" | "delta" | "fixed">(row?.override_type ?? "inherited");
  const [showSuggest, setShowSuggest] = useState(false);

  useEffect(() => {
    setAmount(row?.amount != null ? String(row.amount) : "");
    setPeriod(row?.period_type ?? "monthly");
    setOverride(row?.override_type ?? "inherited");
  }, [row?.amount, row?.period_type, row?.override_type]);

  const save = () => {
    void onSave({
      amount: amount === "" ? null : Number(amount),
      period_type: period,
      override_type: plan.type === "modification" ? override : "fixed",
      base_rate_pct: row?.base_rate_pct ?? null,
      base_rate_start: row?.base_rate_start ?? null,
      changes: row?.changes ?? [],
    });
  };

  return (
    <>
      <tr className="border-t border-border">
        <td className="px-3 py-2">
          <button onClick={onToggle} className="text-text-muted">
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </td>
        <td className="px-3 py-2 font-medium">{category.name}</td>
        <td className="px-3 py-2">
          <Select value={period} onChange={e => setPeriod(e.target.value as "monthly" | "annual")} onBlur={save}>
            <option value="monthly">Monthly</option>
            <option value="annual">Annual</option>
          </Select>
        </td>
        {plan.type === "modification" && (
          <td className="px-3 py-2 text-right text-text-muted tabular-nums">
            {parent ? fmtUsd(parent.amount) : "—"}
          </td>
        )}
        {plan.type === "modification" && (
          <td className="px-3 py-2">
            <Select value={override} onChange={e => setOverride(e.target.value as "inherited" | "delta" | "fixed")} onBlur={save}>
              <option value="inherited">Inherited</option>
              <option value="delta">Delta</option>
              <option value="fixed">Fixed</option>
            </Select>
          </td>
        )}
        <td className="px-3 py-2 text-right">
          <Input
            type="number"
            step="0.01"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            onBlur={save}
            className="w-32 text-right tabular-nums"
            disabled={plan.type === "modification" && override === "inherited"}
          />
        </td>
        <td className="px-3 py-2 text-right tabular-nums font-medium">
          {resolved ? fmtUsd(resolved.amount) : "—"}
        </td>
        <td className="px-3 py-2 text-right">
          <Button size="sm" variant="ghost" onClick={() => setShowSuggest(true)}>
            <Lightbulb className="w-3.5 h-3.5" /> Suggest
          </Button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-bg-elevated/40">
          <td colSpan={plan.type === "modification" ? 8 : 6} className="px-6 py-3">
            <AdjustmentEditor planId={plan.id} catId={category.id} row={row} onSaved={() => onSave({
              amount: amount === "" ? null : Number(amount),
              period_type: period,
              override_type: plan.type === "modification" ? override : "fixed",
            })} />
          </td>
        </tr>
      )}
      <SuggestModal
        open={showSuggest}
        onClose={() => setShowSuggest(false)}
        planId={plan.id}
        catId={category.id}
        onApply={(value) => {
          setAmount(String(value));
          setShowSuggest(false);
          setTimeout(() => save(), 0);
        }}
      />
    </>
  );
}

// ── Adjustment editor (inline expand) ────────────────────────────────────────

function AdjustmentEditor({
  planId, catId, row, onSaved,
}: {
  planId: string;
  catId: string;
  row: PlanCategoryAmount | undefined;
  onSaved: () => Promise<void>;
}) {
  const [rate, setRate] = useState(row?.base_rate_pct != null ? String(row.base_rate_pct) : "");
  const [rateStart, setRateStart] = useState(row?.base_rate_start ?? "");
  const [changes, setChanges] = useState<PlanCategoryChange[]>(row?.changes ?? []);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRate(row?.base_rate_pct != null ? String(row.base_rate_pct) : "");
    setRateStart(row?.base_rate_start ?? "");
    setChanges(row?.changes ?? []);
  }, [row?.base_rate_pct, row?.base_rate_start, row?.changes]);

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/web/plans/${planId}/categories/${catId}`, {
        amount: row?.amount ?? null,
        period_type: row?.period_type ?? "monthly",
        override_type: row?.override_type ?? "inherited",
        base_rate_pct: rate === "" ? null : Number(rate),
        base_rate_start: rateStart === "" ? null : rateStart,
        changes: changes.map(c => ({ effective_date: c.effective_date, delta_amount: c.delta_amount, notes: c.notes })),
      });
      await onSaved();
      toast.success("Adjustments saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">Fixed rate (% / yr)</label>
          <Input type="number" step="0.001" value={rate} onChange={e => setRate(e.target.value)} className="w-24" placeholder="0.03 = 3%" />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Rate start</label>
          <Input type="date" value={rateStart} onChange={e => setRateStart(e.target.value)} />
        </div>
      </div>
      <div>
        <div className="text-xs text-text-muted mb-1">Scheduled changes</div>
        {changes.map((ch, i) => (
          <div key={i} className="flex items-center gap-2 mb-1">
            <Input
              type="date"
              value={ch.effective_date}
              onChange={e => setChanges(arr => arr.map((c, j) => j === i ? { ...c, effective_date: e.target.value } : c))}
            />
            <Input
              type="number"
              step="0.01"
              value={ch.delta_amount}
              onChange={e => setChanges(arr => arr.map((c, j) => j === i ? { ...c, delta_amount: Number(e.target.value) } : c))}
              className="w-32 text-right tabular-nums"
            />
            <Button size="sm" variant="danger" onClick={() => setChanges(arr => arr.filter((_, j) => j !== i))}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        ))}
        <Button size="sm" onClick={() => setChanges(arr => [...arr, { id: "", effective_date: new Date().toISOString().slice(0, 10), delta_amount: 0, notes: null }])}>
          <Plus className="w-3.5 h-3.5" /> Add change
        </Button>
      </div>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => void save()} disabled={busy}>
          <Save className="w-4 h-4" /> Save adjustments
        </Button>
      </div>
    </div>
  );
}

// ── Suggested-amount modal ───────────────────────────────────────────────────

function SuggestModal({
  open, onClose, planId, catId, onApply,
}: {
  open: boolean;
  onClose: () => void;
  planId: string;
  catId: string;
  onApply: (value: number) => void;
}) {
  const [months, setMonths] = useState(12);
  const [data, setData] = useState<{ average_monthly: number; average_annual: number; transaction_count: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ average_monthly: number; average_annual: number; transaction_count: number }>(
        `/api/web/plans/${planId}/categories/${catId}/suggest?months=${months}`,
      );
      setData(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [planId, catId, months]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  return (
    <Modal open={open} onClose={onClose} title="Suggested amount" width="max-w-md">
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">Lookback (months)</label>
          <Select value={String(months)} onChange={e => setMonths(Number(e.target.value))}>
            <option value="1">1 month</option>
            <option value="3">3 months</option>
            <option value="6">6 months</option>
            <option value="12">12 months</option>
            <option value="24">24 months</option>
          </Select>
        </div>
        {loading
          ? <div className="text-sm text-text-muted">Calculating…</div>
          : data && (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-muted">Transactions found</span>
                <span className="font-medium">{data.transaction_count}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Avg monthly</span>
                <span className="font-medium">{fmtUsd(data.average_monthly)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Avg annual</span>
                <span className="font-medium">{fmtUsd(data.average_annual)}</span>
              </div>
              <div className="flex gap-2 pt-2">
                <Button variant="primary" onClick={() => onApply(data.average_monthly)}>Use monthly avg</Button>
                <Button onClick={() => onApply(data.average_annual)}>Use annual avg</Button>
              </div>
            </div>
          )}
      </div>
    </Modal>
  );
}

// ── One-time items panel ─────────────────────────────────────────────────────

function OneTimeItemsPanel({ plan }: { plan: Plan }) {
  const [items, setItems] = useState<OneTimeItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ items: OneTimeItem[] }>(`/api/web/plans/${plan.id}/one-time-items`);
      setItems(res.items);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [plan.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const remove = async (id: string) => {
    if (!confirm("Delete this item?")) return;
    try {
      await api.del(`/api/web/plans/${plan.id}/one-time-items/${id}`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="flex justify-between mb-3">
        <div className="text-xs text-text-muted">{items.length} item{items.length !== 1 ? "s" : ""}</div>
        <Button onClick={() => setCreating(true)}><Plus className="w-4 h-4" /> Add item</Button>
      </div>
      <Card className="overflow-hidden">
        {items.length === 0
          ? <EmptyState>{loading ? "Loading…" : "No one-time items"}</EmptyState>
          : (
            <table className="w-full text-sm">
              <thead className="text-xs text-text-muted uppercase tracking-wide bg-bg-elevated">
                <tr>
                  <th className="text-left px-3 py-2">Date</th>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Type</th>
                  <th className="text-right px-3 py-2">Amount</th>
                  <th className="text-right px-3 py-2 w-12"></th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id} className="border-t border-border">
                    <td className="px-3 py-2 tabular-nums">{item.item_date}</td>
                    <td className="px-3 py-2 font-medium">{item.name}</td>
                    <td className="px-3 py-2">
                      <Badge tone={item.type === "income" ? "ok" : "neutral"}>{item.type}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(item.amount)}</td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="danger" onClick={() => void remove(item.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>
      <OneTimeItemModal
        open={creating}
        onClose={() => setCreating(false)}
        planId={plan.id}
        onSaved={async () => { await refresh(); setCreating(false); }}
      />
    </div>
  );
}

function OneTimeItemModal({
  open, onClose, planId, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  planId: string;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"expense" | "income">("expense");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("0");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/web/plans/${planId}/one-time-items`, {
        name, type, item_date: date, amount: Number(amount),
      });
      setName(""); setAmount("0");
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add one-time item"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
            <Plus className="w-4 h-4" /> Add
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input className="w-full" placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
        <div className="flex gap-2">
          <Select value={type} onChange={e => setType(e.target.value as "expense" | "income")}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </Select>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
          <Input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="w-32 text-right" />
        </div>
      </div>
    </Modal>
  );
}

// ── Forecast tab ─────────────────────────────────────────────────────────────

function ForecastPanel({ plan }: { plan: Plan }) {
  const [horizon, setHorizon] = useState(12);
  const [periodType, setPeriodType] = useState<"monthly" | "annual">("monthly");
  const [periods, setPeriods] = useState<ForecastPeriod[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ periods: ForecastPeriod[] }>(
        `/api/web/plans/${plan.id}/forecast?horizon_months=${horizon}&period_type=${periodType}`,
      );
      setPeriods(res.periods);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [plan.id, horizon, periodType]);

  useEffect(() => { void refresh(); }, [refresh]);

  const chartData = periods.map(p => ({
    label: p.label,
    income: p.total_income,
    expenses: p.total_expenses,
    net: p.net,
  }));

  // Build flat list of one-time items for tooltip dots.
  const dots = periods.flatMap(p =>
    p.one_time_items.map(it => ({
      label: p.label,
      name: it.name,
      value: it.type === "income" ? it.amount : -it.amount,
      type: it.type,
    })),
  );

  return (
    <div>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-1">
          {[12, 60, 120, 240].map(m => (
            <Button key={m} size="sm" variant={horizon === m ? "primary" : "ghost"} onClick={() => setHorizon(m)}>
              {m === 12 ? "1yr" : m === 60 ? "5yr" : m === 120 ? "10yr" : "20yr"}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant={periodType === "monthly" ? "primary" : "ghost"} onClick={() => setPeriodType("monthly")}>Monthly</Button>
          <Button size="sm" variant={periodType === "annual" ? "primary" : "ghost"} onClick={() => setPeriodType("annual")}>Annual</Button>
        </div>
        <Button size="sm" onClick={() => void refresh()}>
          <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
        </Button>
      </div>

      <Card className="p-3 mb-4">
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#64748B" />
              <YAxis tick={{ fontSize: 11 }} stroke="#64748B" tickFormatter={v => fmtUsd(v as number)} width={70} />
              <Tooltip formatter={(v: number) => fmtUsd(v)} contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="income" stroke="#059669" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="expenses" stroke="#DC2626" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="net" stroke="#4F46E5" strokeWidth={2} dot={false} isAnimationActive={false} />
              {dots.map((d, i) => (
                <ReferenceDot
                  key={i}
                  x={d.label}
                  y={d.value}
                  r={4}
                  fill={d.type === "income" ? "#059669" : "#D97706"}
                  stroke="#fff"
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {periods.length === 0
          ? <EmptyState>{loading ? "Loading…" : "No forecast data"}</EmptyState>
          : (
            <table className="w-full text-sm">
              <thead className="text-xs text-text-muted uppercase tracking-wide bg-bg-elevated">
                <tr>
                  <th className="text-left px-3 py-2">Period</th>
                  <th className="text-right px-3 py-2">Income</th>
                  <th className="text-right px-3 py-2">Expenses</th>
                  <th className="text-right px-3 py-2">Net</th>
                  <th className="text-left px-3 py-2">One-time</th>
                </tr>
              </thead>
              <tbody>
                {periods.map(p => (
                  <tr key={p.period_start} className="border-t border-border">
                    <td className="px-3 py-2">{p.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-accent-success">{fmtUsd(p.total_income)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-accent-danger">{fmtUsd(p.total_expenses)}</td>
                    <td className={"px-3 py-2 text-right tabular-nums font-medium " + (p.net >= 0 ? "text-accent-success" : "text-accent-danger")}>
                      {fmtUsd(p.net, { sign: true })}
                    </td>
                    <td className="px-3 py-2 text-text-muted text-xs">
                      {p.one_time_items.map(it => `${it.name} (${fmtUsd(it.amount)})`).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>
    </div>
  );
}

// ── New plan modal ───────────────────────────────────────────────────────────

function NewPlanModal({
  open, onClose, plans, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  plans: Plan[];
  onSaved: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"foundation" | "modification">("foundation");
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await api.post<{ id: string }>("/api/web/plans", {
        name, type,
        parent_plan_id: type === "modification" ? parentId : null,
      });
      setName(""); setParentId("");
      await onSaved(res.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New plan"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim() || (type === "modification" && !parentId)}>
            <Plus className="w-4 h-4" /> Create
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">Name</label>
          <Input className="w-full" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Type</label>
          <Select value={type} onChange={e => setType(e.target.value as "foundation" | "modification")}>
            <option value="foundation">Foundation</option>
            <option value="modification">Modification</option>
          </Select>
        </div>
        {type === "modification" && (
          <div>
            <label className="block text-xs text-text-muted mb-1">Parent plan</label>
            <Select value={parentId} onChange={e => setParentId(e.target.value)}>
              <option value="">— Select parent —</option>
              {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
        )}
      </div>
    </Modal>
  );
}
