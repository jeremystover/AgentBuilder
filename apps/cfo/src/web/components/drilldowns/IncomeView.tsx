import { useMemo, useState } from "react";
import { RefreshCw, Target, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Badge, Select, Input, Drawer, PageHeader, fmtUsd,
} from "../ui";
import { useIncomeStatus } from "../../hooks/useIncomeStatus";
import { upsertIncomeTarget, deleteIncomeTarget } from "../../api";
import type { BudgetCadence, EntitySlug, IncomeStatusLine, IncomeTarget } from "../../types";

type ViewCadence = "monthly" | "quarterly" | "annual";

const CADENCE_OPTIONS: { value: BudgetCadence; label: string }[] = [
  { value: "annual",  label: "Annual" },
  { value: "monthly", label: "Monthly" },
  { value: "weekly",  label: "Weekly" },
];

const ENTITY_LABELS: Record<EntitySlug, string> = {
  elyse_coaching:  "Elyse's Coaching",
  jeremy_coaching: "Jeremy's Coaching",
  airbnb_activity: "Whitford House",
  family_personal: "Family / Personal",
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getPeriodBounds(cadence: ViewCadence, offset: number): { start: string; end: string; label: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  if (cadence === "annual") {
    const y = year + offset;
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
  }

  if (cadence === "quarterly") {
    const currentQ = Math.floor(month / 3);
    const totalQ = year * 4 + currentQ + offset;
    const y = Math.floor(totalQ / 4);
    const q = ((totalQ % 4) + 4) % 4;
    const qStart = q * 3;
    const start = new Date(y, qStart, 1);
    const end = new Date(y, qStart + 3, 0);
    return { start: isoDate(start), end: isoDate(end), label: `Q${q + 1} ${y}` };
  }

  // monthly
  const totalMonths = year * 12 + month + offset;
  const y = Math.floor(totalMonths / 12);
  const m = ((totalMonths % 12) + 12) % 12;
  const start = new Date(y, m, 1);
  const end = new Date(y, m + 1, 0);
  return {
    start: isoDate(start),
    end: isoDate(end),
    label: start.toLocaleString("default", { month: "long", year: "numeric" }),
  };
}

function statusTone(s: string): "ok" | "warn" | "danger" | "neutral" {
  if (s === "on_track") return "ok";
  if (s === "near")     return "warn";
  if (s === "under")    return "danger";
  return "neutral";
}

function statusLabel(s: string): string {
  if (s === "on_track") return "On track";
  if (s === "near")     return "Near";
  if (s === "under")    return "Under";
  return "No target";
}

export function IncomeView() {
  const [viewCadence, setViewCadence] = useState<ViewCadence>("annual");
  const [periodOffset, setPeriodOffset] = useState(0);
  const [openEntity, setOpenEntity] = useState<EntitySlug | null>(null);

  const handleCadenceChange = (c: ViewCadence) => {
    setViewCadence(c);
    setPeriodOffset(0);
  };

  const { start, end, label: periodLabel } = getPeriodBounds(viewCadence, periodOffset);
  const statusParams = useMemo(() => ({ start, end }), [start, end]);

  const { status, targets, loading, error, refresh } = useIncomeStatus(statusParams);

  const entities = status?.entities ?? [];

  const totalIncome  = entities.reduce((s, e) => s + e.actual_income,  0);
  const totalExpense = entities.reduce((s, e) => s + e.actual_expense, 0);
  const totalNet     = totalIncome - totalExpense;
  const totalTarget  = entities.reduce((s, e) => s + (e.target?.prorated_amount ?? 0), 0);

  const openLine   = openEntity ? entities.find(e => e.entity === openEntity) ?? null : null;
  const openTarget = openEntity ? targets.find(t => t.entity === openEntity) ?? null : null;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="Income"
        subtitle={loading ? "Loading…" : `${periodLabel} · ${start} → ${end}`}
        actions={
          <Button onClick={() => void refresh()} title="Refresh" disabled={loading}>
            <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
          </Button>
        }
      />

      {error && (
        <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">
          {error}
        </Card>
      )}

      {/* Period controls */}
      <Card className="p-4 mb-4">
        <div className="flex items-center gap-4 flex-wrap">
          {/* View cadence toggle */}
          <div className="flex rounded-md border border-border overflow-hidden">
            {(["monthly", "quarterly", "annual"] as ViewCadence[]).map((c) => (
              <button
                key={c}
                onClick={() => handleCadenceChange(c)}
                className={
                  "px-3 py-1.5 text-sm font-medium transition-colors border-r border-border last:border-r-0 " +
                  (viewCadence === c
                    ? "bg-accent-primary text-white"
                    : "bg-bg-surface text-text-muted hover:text-text-primary hover:bg-bg-elevated")
                }
              >
                {c.charAt(0).toUpperCase() + c.slice(1)}
              </button>
            ))}
          </div>

          {/* Period navigation */}
          <div className="flex items-center gap-1">
            <Button size="sm" onClick={() => setPeriodOffset(o => o - 1)}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-sm font-medium text-text-primary w-32 text-center select-none">
              {periodLabel}
            </span>
            <Button size="sm" onClick={() => setPeriodOffset(o => o + 1)} disabled={periodOffset >= 0}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </Card>

      {/* Summary totals */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {[
          { label: "Income target",  value: totalTarget,  muted: totalTarget === 0 },
          { label: "Actual income",  value: totalIncome,  muted: false },
          { label: "Total expenses", value: totalExpense, muted: false },
          { label: "Net cash flow",  value: totalNet,     signed: true },
        ].map(({ label, value, muted, signed }) => (
          <Card key={label} className="p-4">
            <div className="text-xs text-text-muted mb-1">{label}</div>
            <div className={`text-xl font-semibold tabular-nums ${
              signed
                ? value >= 0 ? "text-accent-ok" : "text-accent-danger"
                : muted ? "text-text-muted" : "text-text-primary"
            }`}>
              {signed && value > 0 ? "+" : ""}{fmtUsd(value)}
            </div>
          </Card>
        ))}
      </div>

      {/* Entity table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border bg-bg-elevated">
                <th className="pl-4 py-2">Entity</th>
                <th className="py-2">Annual target</th>
                <th className="py-2">Period target</th>
                <th className="py-2">Actual income</th>
                <th className="py-2">Expenses</th>
                <th className="py-2">Net</th>
                <th className="py-2">% of target</th>
                <th className="py-2 pr-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {entities.map((line) => (
                <EntityRow
                  key={line.entity}
                  line={line}
                  viewCadence={viewCadence}
                  onOpen={() => setOpenEntity(line.entity)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <TargetDrawer
        entity={openEntity}
        line={openLine}
        target={openTarget}
        onClose={() => setOpenEntity(null)}
        onSaved={() => { setOpenEntity(null); void refresh(); }}
      />
    </div>
  );
}

// ── Entity row ───────────────────────────────────────────────────────────────

function EntityRow({ line, viewCadence, onOpen }: {
  line: IncomeStatusLine;
  viewCadence: ViewCadence;
  onOpen(): void;
}) {
  const netColor = line.net >= 0 ? "text-accent-ok" : "text-accent-danger";
  const pct = line.pct_of_target;

  // Annualise the native target regardless of its stored cadence
  const annualTarget = line.target
    ? line.target.native_cadence === "annual"  ? line.target.native_amount
    : line.target.native_cadence === "monthly" ? line.target.native_amount * 12
    : line.target.native_amount * 52  // weekly
    : null;

  const periodTargetLabel = viewCadence === "annual" ? null
    : line.target ? fmtUsd(line.target.prorated_amount)
    : null;

  return (
    <tr
      className="border-b border-border last:border-b-0 hover:bg-bg-elevated/50 cursor-pointer"
      onClick={onOpen}
    >
      <td className="pl-4 py-3 font-medium text-text-primary">
        {ENTITY_LABELS[line.entity]}
      </td>
      <td className="py-3 tabular-nums text-text-primary">
        {annualTarget != null
          ? fmtUsd(annualTarget)
          : <span className="italic text-text-subtle">no target</span>}
      </td>
      <td className="py-3 tabular-nums text-text-muted">
        {periodTargetLabel ?? <span className="text-text-subtle">—</span>}
      </td>
      <td className="py-3 tabular-nums text-text-primary">
        {fmtUsd(line.actual_income)}
        {line.tx_count_income > 0 && (
          <span className="text-xs text-text-muted ml-1">({line.tx_count_income})</span>
        )}
      </td>
      <td className="py-3 tabular-nums text-text-muted">
        {line.actual_expense > 0 ? fmtUsd(line.actual_expense) : "—"}
        {line.tx_count_expense > 0 && (
          <span className="text-xs text-text-muted ml-1">({line.tx_count_expense})</span>
        )}
      </td>
      <td className={`py-3 tabular-nums font-medium ${netColor}`}>
        {line.net >= 0 ? "+" : ""}{fmtUsd(line.net)}
      </td>
      <td className="py-3 tabular-nums text-text-muted">
        {pct != null ? `${Math.round(pct)}%` : "—"}
      </td>
      <td className="py-3 pr-4">
        <Badge tone={statusTone(line.status)}>{statusLabel(line.status)}</Badge>
      </td>
    </tr>
  );
}

// ── Target drawer ────────────────────────────────────────────────────────────

function TargetDrawer({
  entity, line, target, onClose, onSaved,
}: {
  entity: EntitySlug | null;
  line: IncomeStatusLine | null;
  target: IncomeTarget | null;
  onClose(): void;
  onSaved(): void;
}) {
  const [amount, setAmount] = useState(target?.amount?.toString() ?? "");
  const [cadence, setCadence] = useState<BudgetCadence>(target?.cadence ?? "annual");
  const [busy, setBusy] = useState(false);

  // Sync form when a different entity is opened
  useMemo(() => {
    setAmount(target?.amount?.toString() ?? "");
    setCadence(target?.cadence ?? "annual");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity]);

  if (!entity || !line) return null;

  const handleSave = async () => {
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed < 0) { toast.error("Enter a valid amount"); return; }
    setBusy(true);
    try {
      await upsertIncomeTarget({ entity, cadence, amount: parsed });
      toast.success("Income target saved");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!target) return;
    if (!confirm("Remove this income target?")) return;
    setBusy(true);
    try {
      await deleteIncomeTarget(target.id);
      toast.success("Target removed");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={!!entity}
      onClose={onClose}
      title={`Income target — ${ENTITY_LABELS[entity]}`}
      footer={
        <div className="flex items-center justify-between gap-2">
          <div>
            {target && (
              <Button variant="danger" onClick={() => void handleDelete()} disabled={busy}>
                Remove target
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => void handleSave()} disabled={busy || !amount}>
              <Target className="w-4 h-4" /> Save target
            </Button>
          </div>
        </div>
      }
    >
      <dl className="grid grid-cols-2 gap-3 text-sm mb-5">
        <div><dt className="text-xs text-text-muted">Actual income</dt><dd className="text-text-primary tabular-nums">{fmtUsd(line.actual_income)}</dd></div>
        <div><dt className="text-xs text-text-muted">Actual expenses</dt><dd className="text-text-muted tabular-nums">{fmtUsd(line.actual_expense)}</dd></div>
        <div>
          <dt className="text-xs text-text-muted">Net</dt>
          <dd className={`tabular-nums font-medium ${line.net >= 0 ? "text-accent-ok" : "text-accent-danger"}`}>
            {line.net >= 0 ? "+" : ""}{fmtUsd(line.net)}
          </dd>
        </div>
        {line.target && (
          <div>
            <dt className="text-xs text-text-muted">vs. period target</dt>
            <dd className="text-text-primary tabular-nums">
              {Math.round(line.pct_of_target ?? 0)}% of {fmtUsd(line.target.prorated_amount)}
            </dd>
          </div>
        )}
      </dl>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">Annual income target</label>
          <Input
            type="number"
            min="0"
            step="1000"
            placeholder="e.g. 120000"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full"
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Cadence</label>
          <Select value={cadence} onChange={(e) => setCadence(e.target.value as BudgetCadence)} className="w-full">
            {CADENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </div>
      </div>

      {target && (
        <div className="mt-4 text-xs text-text-muted">
          Current: {fmtUsd(target.amount)} / {target.cadence} · effective {target.effective_from}
        </div>
      )}
    </Drawer>
  );
}
