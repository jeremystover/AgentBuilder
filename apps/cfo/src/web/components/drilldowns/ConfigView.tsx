import { useEffect, useState } from "react";
import { Plus, Pencil, Check, X } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Badge, Input, PageHeader, EmptyState } from "../ui";
import { listBudgetCategories, createBudgetCategory, updateBudgetCategory } from "../../api";
import type { BudgetCategory } from "../../types";

export function ConfigView() {
  const [categories, setCategories] = useState<BudgetCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listBudgetCategories();
      setCategories(res.categories);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <PageHeader title="Configuration" subtitle="Manage budget categories" />

      {error && (
        <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">
          {error}
        </Card>
      )}

      <h2 className="text-sm font-semibold text-text-primary mb-2">Budget categories</h2>
      <Card className="overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border bg-bg-elevated">
              <th className="pl-4 py-2">Name</th>
              <th className="py-2">Slug</th>
              <th className="py-2">Status</th>
              <th className="pr-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4}><EmptyState>Loading…</EmptyState></td></tr>
            ) : categories.length === 0 ? (
              <tr><td colSpan={4}><EmptyState>No categories yet.</EmptyState></td></tr>
            ) : (
              categories.map((cat) => (
                <CategoryRow key={cat.slug} category={cat} onChanged={load} />
              ))
            )}
          </tbody>
        </table>
      </Card>

      <AddCategoryForm existingSlugs={categories.map((c) => c.slug)} onAdded={load} />
    </div>
  );
}

// ── Category row with inline rename ─────────────────────────────────────────

function CategoryRow({ category, onChanged }: { category: BudgetCategory; onChanged(): void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [busy, setBusy] = useState(false);

  const handleRename = async () => {
    if (!name.trim() || name.trim() === category.name) { setEditing(false); return; }
    setBusy(true);
    try {
      await updateBudgetCategory(category.slug, { name: name.trim() });
      toast.success("Renamed");
      onChanged();
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleActive = async () => {
    const next = !category.is_active;
    if (!confirm(`${next ? "Reactivate" : "Deactivate"} "${category.name}"?`)) return;
    setBusy(true);
    try {
      await updateBudgetCategory(category.slug, { is_active: next });
      toast.success(next ? "Category reactivated" : "Category deactivated");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancelEdit = () => { setName(category.name); setEditing(false); };

  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-bg-elevated/50">
      <td className="pl-4 py-2.5">
        {editing ? (
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleRename(); if (e.key === "Escape") cancelEdit(); }}
            autoFocus
            className="w-full"
          />
        ) : (
          <span className={category.is_active ? "text-text-primary" : "text-text-subtle line-through"}>
            {category.name}
          </span>
        )}
      </td>
      <td className="py-2.5 text-text-muted font-mono text-xs">{category.slug}</td>
      <td className="py-2.5">
        <Badge tone={category.is_active ? "ok" : "neutral"}>
          {category.is_active ? "Active" : "Inactive"}
        </Badge>
      </td>
      <td className="pr-4 py-2.5 text-right">
        <div className="flex items-center justify-end gap-1">
          {editing ? (
            <>
              <Button size="sm" variant="primary" onClick={() => void handleRename()} disabled={busy}>
                <Check className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={busy}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={busy} title="Rename">
                <Pencil className="w-3.5 h-3.5" />
              </Button>
              <Button
                size="sm"
                variant={category.is_active ? "danger" : "ghost"}
                onClick={() => void handleToggleActive()}
                disabled={busy}
              >
                {category.is_active ? "Deactivate" : "Reactivate"}
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── Add category form ────────────────────────────────────────────────────────

function AddCategoryForm({ existingSlugs, onAdded }: { existingSlugs: string[]; onAdded(): void }) {
  const [name, setName] = useState("");
  const [slugOverride, setSlugOverride] = useState("");
  const [busy, setBusy] = useState(false);

  const computedSlug = slugOverride || name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const slugExists = existingSlugs.includes(computedSlug);

  const handleAdd = async () => {
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (!computedSlug) { toast.error("Slug is required"); return; }
    if (slugExists) { toast.error(`Slug "${computedSlug}" already exists`); return; }
    if (!/^[a-z0-9_]+$/.test(computedSlug)) { toast.error("Slug must be lowercase letters, digits, and underscores"); return; }
    setBusy(true);
    try {
      await createBudgetCategory({ slug: computedSlug, name: name.trim() });
      toast.success("Category created");
      setName("");
      setSlugOverride("");
      onAdded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2 className="text-sm font-semibold text-text-primary mb-2">Add category</h2>
      <Card className="p-4">
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs text-text-muted mb-1">Name</label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleAdd(); }}
              placeholder="e.g. Pet care"
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Slug (auto-computed)</label>
            <Input
              type="text"
              value={slugOverride}
              onChange={(e) => setSlugOverride(e.target.value)}
              placeholder={computedSlug || "lowercase_with_underscores"}
              className="w-full"
            />
            {computedSlug && (
              <div className="text-xs text-text-subtle mt-1">
                Will use <span className="font-mono">{computedSlug}</span>
                {slugExists && <span className="text-accent-danger"> — already exists</span>}
              </div>
            )}
          </div>
        </div>
        <Button variant="primary" onClick={() => void handleAdd()} disabled={busy}>
          <Plus className="w-4 h-4" /> Add category
        </Button>
      </Card>
    </div>
  );
}
