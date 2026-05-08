import { useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, Trash2, Upload, Pencil, Check } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Badge, Select, Input, Drawer, PageHeader, EmptyState, humanizeSlug,
} from "../ui";
import { useRules } from "../../hooks/useRules";
import {
  createRule, updateRule, deleteRule, importAutoCat,
  type RuleInput,
} from "../../api";
import type {
  Rule, RuleMatchField, RuleMatchOperator, EntitySlug, AutoCatImportResult,
} from "../../types";
import { CATEGORY_OPTIONS, ENTITY_OPTIONS, TRANSFER_OPTION } from "../../catalog";

const FIELD_OPTIONS: { value: RuleMatchField; label: string }[] = [
  { value: "merchant_name", label: "Merchant" },
  { value: "description",   label: "Description" },
  { value: "account_id",    label: "Account ID" },
  { value: "amount",        label: "Amount" },
];

const OPERATOR_OPTIONS: { value: RuleMatchOperator; label: string }[] = [
  { value: "contains",    label: "contains" },
  { value: "equals",      label: "equals" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with",   label: "ends with" },
  { value: "regex",       label: "regex" },
];

const EMPTY_DRAFT: RuleInput = {
  name: "",
  match_field: "description",
  match_operator: "contains",
  match_value: "",
  entity: "family_personal",
  category_tax: "",
  category_budget: "",
  priority: 50,
  is_active: true,
};

export function RulesView() {
  const { rules, loading, error, refresh } = useRules();
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState<Rule | null>(null);
  const [creating, setCreating] = useState(false);

  const [filterEntity, setFilterEntity] = useState<string>("");
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [search, setSearch] = useState("");

  const [autoCatResult, setAutoCatResult] = useState<AutoCatImportResult | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rules.filter((r) => {
      if (filterEntity && r.entity !== filterEntity) return false;
      if (filterCategory && r.category_tax !== filterCategory) return false;
      if (q) {
        const hay = `${r.name} ${r.match_value}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rules, filterEntity, filterCategory, search]);

  const handleToggle = async (rule: Rule) => {
    setBusy(true);
    try {
      await updateRule(rule.id, { is_active: !rule.is_active });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (rule: Rule) => {
    if (!confirm(`Delete rule "${rule.name}"?\n\nFuture transactions matching this rule will no longer be auto-classified.`)) return;
    setBusy(true);
    try {
      await deleteRule(rule.id);
      toast.success("Rule deleted");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Rules"
        subtitle={
          loading ? "Loading…" :
          rules.length === 0 ? "No rules yet" :
          `${rules.length} rule${rules.length !== 1 ? "s" : ""}${visible.length !== rules.length ? ` (${visible.length} match filter)` : ""}`
        }
        actions={
          <>
            <Button variant="primary" onClick={() => setCreating(true)} disabled={busy}>
              <Plus className="w-4 h-4" /> New rule
            </Button>
            <Button onClick={() => void refresh()} title="Refresh">
              <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
            </Button>
          </>
        }
      />

      <AutoCatUploader busy={busy} setBusy={setBusy} onResult={async (r) => {
        setAutoCatResult(r);
        await refresh();
      }} />

      {autoCatResult && <AutoCatResultPanel result={autoCatResult} onDismiss={() => setAutoCatResult(null)} />}

      <Card className="p-4 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-text-muted mb-1">Entity</label>
            <Select value={filterEntity} onChange={(e) => setFilterEntity(e.target.value)} className="w-full">
              <option value="">All entities</option>
              {ENTITY_OPTIONS.map(({ slug, label }) => (
                <option key={slug} value={slug}>{label}</option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Category</label>
            <Select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="w-full">
              <option value="">All categories</option>
              {CATEGORY_OPTIONS.map(({ slug, label }) => (
                <option key={slug} value={slug}>{label}</option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Search</label>
            <Input
              type="text"
              placeholder="name or match value"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full"
            />
          </div>
        </div>
      </Card>

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
                <th className="pl-4 py-2 w-12 text-right">Pri.</th>
                <th>Name</th>
                <th>Match</th>
                <th>Entity</th>
                <th>Category</th>
                <th className="text-center">Active</th>
                <th className="pr-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td colSpan={7}><EmptyState>{loading ? "Loading…" : rules.length === 0 ? "No rules yet — create one or import AutoCat." : "No rules match these filters."}</EmptyState></td></tr>
              ) : visible.map((r) => (
                <RuleRow
                  key={r.id}
                  rule={r}
                  busy={busy}
                  onEdit={() => setEditing(r)}
                  onToggle={() => void handleToggle(r)}
                  onDelete={() => void handleDelete(r)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <RuleEditor
        open={creating || !!editing}
        rule={editing}
        onClose={() => { setEditing(null); setCreating(false); }}
        onSaved={async () => { await refresh(); setEditing(null); setCreating(false); }}
      />
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────

function RuleRow({
  rule, busy, onEdit, onToggle, onDelete,
}: {
  rule: Rule;
  busy: boolean;
  onEdit(): void;
  onToggle(): void;
  onDelete(): void;
}) {
  const opLabel = OPERATOR_OPTIONS.find((o) => o.value === rule.match_operator)?.label ?? rule.match_operator;
  const fieldLabel = FIELD_OPTIONS.find((f) => f.value === rule.match_field)?.label ?? rule.match_field;
  const active = !!rule.is_active;

  return (
    <tr className={`border-b border-border last:border-b-0 hover:bg-bg-elevated/50 ${!active ? "opacity-60" : ""}`}>
      <td className="pl-4 py-2.5 text-right tabular-nums text-text-muted">{rule.priority}</td>
      <td className="text-text-primary truncate max-w-[18rem]">{rule.name}</td>
      <td className="text-xs">
        <span className="text-text-muted">{fieldLabel} {opLabel}</span>{" "}
        <span className="text-text-primary font-mono">{rule.match_value}</span>
      </td>
      <td>
        {rule.category_tax === 'transfer'
          ? <span className="text-text-muted italic text-xs">—</span>
          : <Badge tone="info">{humanizeSlug(rule.entity)}</Badge>
        }
      </td>
      <td className="text-text-primary">
        {rule.category_tax ? humanizeSlug(rule.category_tax) : <span className="text-text-subtle italic">—</span>}
        {rule.category_budget && (
          <div className="text-xs text-text-muted">budget: {humanizeSlug(rule.category_budget)}</div>
        )}
      </td>
      <td className="text-center">
        <button
          onClick={onToggle}
          disabled={busy}
          className={`inline-flex items-center justify-center w-9 h-5 rounded-full transition-colors ${
            active ? "bg-accent-success" : "bg-bg-elevated border border-border"
          }`}
          title={active ? "Active — click to disable" : "Disabled — click to enable"}
        >
          <span className={`w-3.5 h-3.5 rounded-full bg-white transition-transform ${active ? "translate-x-2" : "-translate-x-2"}`} />
        </button>
      </td>
      <td className="pr-4">
        <div className="flex items-center gap-1.5">
          <Button size="sm" onClick={onEdit} disabled={busy}>
            <Pencil className="w-3 h-3" />
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete} disabled={busy}>
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

// ── Editor drawer ───────────────────────────────────────────────────────────

function RuleEditor({
  open, rule, onClose, onSaved,
}: {
  open: boolean;
  rule: Rule | null;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const initial = useMemo<RuleInput>(() => rule ? {
    name: rule.name,
    match_field: rule.match_field,
    match_operator: rule.match_operator,
    match_value: rule.match_value,
    entity: rule.entity,
    category_tax: rule.category_tax ?? "",
    category_budget: rule.category_budget ?? "",
    priority: rule.priority,
    is_active: !!rule.is_active,
  } : EMPTY_DRAFT, [rule]);

  // Reset form whenever drawer opens for a different rule.
  const [draft, setDraft] = useState<RuleInput>(initial);
  const [draftKey, setDraftKey] = useState<string | null>(rule?.id ?? null);
  if (open && (rule?.id ?? null) !== draftKey) {
    setDraft(initial);
    setDraftKey(rule?.id ?? null);
  }

  const [busy, setBusy] = useState(false);

  const handleSave = async () => {
    if (!draft.name.trim() || !draft.match_value.trim()) {
      toast.error("Name and match value are required");
      return;
    }
    setBusy(true);
    try {
      const isTransfer = draft.category_tax === "transfer";
      const payload: RuleInput = {
        ...draft,
        entity: isTransfer ? undefined : draft.entity,
        category_tax: draft.category_tax || undefined,
        category_budget: isTransfer ? undefined : (draft.category_budget || undefined),
      };
      if (rule) {
        await updateRule(rule.id, payload);
        toast.success("Rule updated");
      } else {
        await createRule(payload);
        toast.success("Rule created");
      }
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const update = <K extends keyof RuleInput>(key: K, value: RuleInput[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  if (!open) return null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={rule ? "Edit rule" : "New rule"}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={busy}>
            <Check className="w-4 h-4" /> {rule ? "Save" : "Create"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-text-muted mb-1">Name</label>
          <Input
            type="text"
            placeholder="e.g. Whole Foods → Groceries"
            value={draft.name}
            onChange={(e) => update("name", e.target.value)}
            className="w-full"
          />
        </div>

        <div>
          <div className="text-xs text-text-muted mb-1">When</div>
          <div className="grid grid-cols-3 gap-2">
            <Select value={draft.match_field} onChange={(e) => update("match_field", e.target.value as RuleMatchField)} className="w-full">
              {FIELD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            <Select value={draft.match_operator} onChange={(e) => update("match_operator", e.target.value as RuleMatchOperator)} className="w-full">
              {OPERATOR_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            <Input
              type="text"
              placeholder="match value"
              value={draft.match_value}
              onChange={(e) => update("match_value", e.target.value)}
              className="w-full"
            />
          </div>
          <div className="text-xs text-text-subtle mt-1">
            {draft.match_field === "amount" && "Amount comparisons use a numeric string. Negative values are expenses."}
            {draft.match_operator === "regex" && " · Regex is matched case-insensitively against the chosen field."}
          </div>
        </div>

        <div>
          <div className="text-xs text-text-muted mb-1">Then classify as</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <label className="block text-xs text-text-muted mb-1">Tax category</label>
              <Select
                value={draft.category_tax ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  update("category_tax", val);
                  if (val === "transfer") {
                    update("category_budget", "");
                  }
                }}
                className="w-full"
              >
                <option value="">— none —</option>
                <option value={TRANSFER_OPTION.slug}>{TRANSFER_OPTION.label}</option>
                <optgroup label="Schedule C">
                  {CATEGORY_OPTIONS.filter((c) => c.kind === "tax" && c.group === "schedule_c").map(({ slug, label }) => (
                    <option key={slug} value={slug}>{label}</option>
                  ))}
                </optgroup>
                <optgroup label="Schedule E">
                  {CATEGORY_OPTIONS.filter((c) => c.kind === "tax" && c.group === "schedule_e").map(({ slug, label }) => (
                    <option key={slug} value={slug}>{label}</option>
                  ))}
                </optgroup>
              </Select>
            </div>
            {draft.category_tax === "transfer" ? (
              <div className="col-span-2 text-xs text-text-muted bg-bg-elevated rounded px-3 py-2">
                Transfers are excluded from all tax reports and budgets — no entity or budget category needed.
              </div>
            ) : (
              <>
                <div className="col-span-2">
                  <label className="block text-xs text-text-muted mb-1">Entity</label>
                  <Select value={draft.entity ?? "family_personal"} onChange={(e) => update("entity", e.target.value as EntitySlug)} className="w-full">
                    {ENTITY_OPTIONS.map(({ slug, label }) => (
                      <option key={slug} value={slug}>{label}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="block text-xs text-text-muted mb-1">Budget category</label>
                  <Select value={draft.category_budget ?? ""} onChange={(e) => update("category_budget", e.target.value)} className="w-full">
                    <option value="">— none —</option>
                    {CATEGORY_OPTIONS.filter((c) => c.kind === "budget").map(({ slug, label }) => (
                      <option key={slug} value={slug}>{label}</option>
                    ))}
                  </Select>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-text-muted mb-1">Priority</label>
            <Input
              type="number"
              value={draft.priority ?? 0}
              onChange={(e) => update("priority", parseInt(e.target.value, 10) || 0)}
              className="w-full"
            />
            <div className="text-xs text-text-subtle mt-1">Higher runs first. AutoCat imports use 50.</div>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Active</label>
            <label className="flex items-center gap-2 mt-1.5 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={!!draft.is_active}
                onChange={(e) => update("is_active", e.target.checked)}
              />
              Apply to new transactions
            </label>
          </div>
        </div>
      </div>
    </Drawer>
  );
}

// ── AutoCat uploader ────────────────────────────────────────────────────────

function AutoCatUploader({
  busy, setBusy, onResult,
}: {
  busy: boolean;
  setBusy(b: boolean): void;
  onResult(r: AutoCatImportResult): Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  const onPick = async (file: File) => {
    setBusy(true);
    try {
      const r = await importAutoCat(file);
      toast.success(
        `Created ${r.rules_created} rule${r.rules_created !== 1 ? "s" : ""}` +
        (r.skipped ? `, skipped ${r.skipped}` : ""),
      );
      await onResult(r);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Card className="p-4 mb-4 flex items-center justify-between gap-3">
      <div>
        <div className="text-sm font-semibold text-text-primary">Import from Tiller AutoCat</div>
        <div className="text-xs text-text-muted">
          Bulk-create rules from a Tiller AutoCat CSV (columns: Category, Description Contains).
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onPick(f);
        }}
      />
      <Button onClick={() => fileRef.current?.click()} disabled={busy}>
        <Upload className="w-4 h-4" /> Choose AutoCat CSV
      </Button>
    </Card>
  );
}

function AutoCatResultPanel({ result, onDismiss }: { result: AutoCatImportResult; onDismiss(): void }) {
  return (
    <Card className="p-4 mb-4 border-accent-primary/40 bg-accent-primary/5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="text-sm font-semibold text-text-primary mb-2">AutoCat import</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-xs text-text-muted">Rows</div>
              <div className="text-lg tabular-nums text-text-primary">{result.total_rows}</div>
            </div>
            <div>
              <div className="text-xs text-text-muted">Rules created</div>
              <div className="text-lg tabular-nums text-text-primary">{result.rules_created}</div>
            </div>
            <div>
              <div className="text-xs text-text-muted">Skipped</div>
              <div className="text-lg tabular-nums text-text-primary">{result.skipped}</div>
            </div>
            <div>
              <div className="text-xs text-text-muted">Transfers skipped</div>
              <div className="text-lg tabular-nums text-text-primary">{result.skipped_transfers}</div>
            </div>
          </div>
          {result.warnings.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold text-text-muted mb-1">Warnings</div>
              <ul className="text-xs text-accent-warn space-y-0.5">
                {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
          <div className="mt-3 text-xs text-text-muted">{result.message}</div>
        </div>
        <button className="text-text-muted hover:text-text-primary text-xs" onClick={onDismiss} aria-label="Dismiss">✕</button>
      </div>
    </Card>
  );
}
