import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Select, Input, Badge, PageHeader, EmptyState, fmtUsd,
} from "../ui";
import {
  listBudgetCategories, createBudgetCategory, updateBudgetCategory,
  listBudgetTargets, upsertBudgetTarget, deleteBudgetTarget,
  getBudgetStatus,
} from "../../api";
import type { BudgetCategory, BudgetTarget, BudgetStatus, Cadence } from "../../api";

const CADENCES: Cadence[] = ["weekly", "monthly", "annual"];

export function BudgetView() {
  const [categories, setCategories] = useState<BudgetCategory[]>([]);
  const [targets, setTargets] = useState<BudgetTarget[]>([]);
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, t, s] = await Promise.all([listBudgetCategories(), listBudgetTargets(), getBudgetStatus()]);
      setCategories(c.categories);
      setTargets(t.targets);
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Budget"
        subtitle="Categories, targets, and current-period status."
        actions={<Button onClick={() => void refresh()}><RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} /></Button>}
      />

      {error && <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">{error}</Card>}

      {/* Status (current month) */}
      {status && status.categories.length > 0 && (
        <Card className="p-5 mb-5">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="font-semibold text-text-primary">{status.period.label}</h3>
            <span className="text-xs text-text-muted">{status.period.start} → {status.period.end}</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border">
                <th className="py-2">Category</th>
                <th className="text-right">Spent</th>
                <th className="text-right">Target</th>
                <th>%</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {status.categories.map((c) => (
                <tr key={c.category_slug} className="border-b border-border last:border-b-0">
                  <td className="py-2 text-text-primary">{c.category_name}</td>
                  <td className="text-right tabular-nums">{fmtUsd(c.spent)}</td>
                  <td className="text-right tabular-nums text-text-muted">{c.target ? fmtUsd(c.target.prorated_amount) : "—"}</td>
                  <td className="tabular-nums">{c.percent_used != null ? `${c.percent_used.toFixed(0)}%` : "—"}</td>
                  <td>
                    <Badge tone={
                      c.status === "over" ? "danger" :
                      c.status === "near" ? "warn" :
                      c.status === "under" ? "ok" : "neutral"
                    }>
                      {c.status === "no_target" ? "no target" : c.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <CategoriesCard categories={categories} onChange={refresh} />
        <TargetsCard categories={categories} targets={targets} onChange={refresh} />
      </div>
    </div>
  );
}

// ── Categories ──────────────────────────────────────────────────────────

function CategoriesCard({ categories, onChange }: { categories: BudgetCategory[]; onChange(): Promise<void> }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");

  const onAdd = async () => {
    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (!cleanSlug || !name.trim()) {
      toast.error("Slug + name required");
      return;
    }
    try {
      await createBudgetCategory({ slug: cleanSlug, name: name.trim() });
      toast.success(`Created ${cleanSlug}`);
      setSlug(""); setName("");
      await onChange();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  const onToggle = async (cat: BudgetCategory) => {
    try {
      await updateBudgetCategory(cat.slug, { is_active: cat.is_active === 0 });
      await onChange();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Card className="p-5">
      <h3 className="font-semibold text-text-primary mb-3">Categories</h3>
      <div className="flex items-end gap-2 mb-4">
        <div className="flex-1">
          <label className="block text-xs text-text-muted mb-1">Slug</label>
          <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="lowercase_with_underscores" className="w-full font-mono text-sm" />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-text-muted mb-1">Display name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Groceries" className="w-full" />
        </div>
        <Button variant="primary" onClick={onAdd}><Plus className="w-4 h-4" /> Add</Button>
      </div>
      {categories.length === 0 ? (
        <EmptyState>No categories yet.</EmptyState>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border">
              <th className="py-2">Slug</th>
              <th>Name</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id} className="border-b border-border last:border-b-0">
                <td className="py-2 font-mono text-xs text-text-muted">{c.slug}</td>
                <td className="text-text-primary">{c.name}</td>
                <td>{c.is_active ? <Badge tone="ok">on</Badge> : <Badge tone="neutral">off</Badge>}</td>
                <td>
                  <Button size="sm" onClick={() => void onToggle(c)}>
                    {c.is_active ? "Deactivate" : "Activate"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ── Targets ─────────────────────────────────────────────────────────────

function TargetsCard({ categories, targets, onChange }: { categories: BudgetCategory[]; targets: BudgetTarget[]; onChange(): Promise<void> }) {
  const [categorySlug, setCategorySlug] = useState("");
  const [cadence, setCadence] = useState<Cadence>("monthly");
  const [amount, setAmount] = useState("");

  const onUpsert = async () => {
    const amt = parseFloat(amount);
    if (!categorySlug || !amt || amt < 0) {
      toast.error("Pick a category and a positive amount");
      return;
    }
    try {
      await upsertBudgetTarget({ category_slug: categorySlug, cadence, amount: amt });
      toast.success("Target saved");
      setAmount("");
      await onChange();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  const onDelete = async (t: BudgetTarget) => {
    if (!confirm(`Delete target for ${t.category_slug}?`)) return;
    try {
      await deleteBudgetTarget(t.id);
      toast.success("Target deleted");
      await onChange();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Card className="p-5">
      <h3 className="font-semibold text-text-primary mb-3">Targets</h3>
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div>
          <label className="block text-xs text-text-muted mb-1">Category</label>
          <Select value={categorySlug} onChange={(e) => setCategorySlug(e.target.value)} className="w-full">
            <option value="">—</option>
            {categories.filter((c) => c.is_active).map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </Select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Cadence</label>
          <Select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)} className="w-full">
            {CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Amount</label>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full" />
        </div>
      </div>
      <Button variant="primary" onClick={onUpsert} className="mb-4">
        <Plus className="w-4 h-4" /> Add / update target
      </Button>

      {targets.length === 0 ? (
        <EmptyState>No targets set.</EmptyState>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border">
              <th className="py-2">Category</th>
              <th>Cadence</th>
              <th className="text-right">Amount</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => (
              <tr key={t.id} className="border-b border-border last:border-b-0">
                <td className="py-2 text-text-primary">{t.category_name ?? t.category_slug}</td>
                <td className="text-text-muted">{t.cadence}</td>
                <td className="text-right tabular-nums">{fmtUsd(t.amount)}</td>
                <td>
                  <Button size="sm" variant="ghost" onClick={() => void onDelete(t)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
