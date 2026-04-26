import { useCallback, useEffect, useState } from "react";
import { Plus, Upload, Trash2, RefreshCw, Pencil } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Select, Input, Badge, Drawer, PageHeader, EmptyState, humanizeSlug,
} from "../ui";
import {
  listRules, createRule, updateRule, deleteRule, importAutoCat,
} from "../../api";
import type { Rule, RuleInput, RuleMatchField, RuleMatchOperator } from "../../api";
import { CATEGORY_OPTIONS, ENTITY_OPTIONS } from "../../catalog";

const FIELDS: Array<{ value: RuleMatchField; label: string }> = [
  { value: "merchant_name", label: "Merchant" },
  { value: "description",   label: "Description" },
  { value: "account_id",    label: "Account ID" },
  { value: "amount",        label: "Amount" },
];

const OPERATORS: Array<{ value: RuleMatchOperator; label: string }> = [
  { value: "contains",    label: "contains" },
  { value: "equals",      label: "equals" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with",   label: "ends with" },
  { value: "regex",       label: "regex" },
];

const EMPTY_INPUT: RuleInput = {
  name: "",
  match_field: "merchant_name",
  match_operator: "contains",
  match_value: "",
  entity: "elyse_coaching",
  category_tax: undefined,
  category_budget: undefined,
  priority: 0,
  is_active: true,
};

export function RulesView() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listRules();
      setRules(r.rules);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="Rules"
        subtitle={loading ? "Loading…" : `${rules.length} rule${rules.length !== 1 ? "s" : ""}`}
        actions={
          <>
            <Button variant="primary" onClick={() => setCreating(true)}><Plus className="w-4 h-4" /> New rule</Button>
            <AutoCatImportButton onDone={refresh} />
            <Button onClick={() => void refresh()}><RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} /></Button>
          </>
        }
      />

      {error && <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">{error}</Card>}

      <Card className="overflow-hidden">
        {rules.length === 0 ? (
          <EmptyState>No rules yet — create one or import from Tiller AutoCat.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border bg-bg-elevated">
                <th className="pl-5 py-2">Name</th>
                <th>Match</th>
                <th>Entity / category</th>
                <th>Priority</th>
                <th>Active</th>
                <th className="pr-5"></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-b-0 hover:bg-bg-elevated/50">
                  <td className="pl-5 py-2.5 font-medium text-text-primary">{r.name}</td>
                  <td className="text-text-muted">
                    <span className="font-mono text-xs">{r.match_field} {r.match_operator} "{r.match_value}"</span>
                  </td>
                  <td>
                    <div className="text-text-primary">{humanizeSlug(r.entity)}</div>
                    {r.category_tax && <Badge tone="info">{humanizeSlug(r.category_tax)}</Badge>}
                  </td>
                  <td className="text-text-muted tabular-nums">{r.priority}</td>
                  <td>{r.is_active ? <Badge tone="ok">on</Badge> : <Badge tone="neutral">off</Badge>}</td>
                  <td className="pr-5">
                    <Button size="sm" onClick={() => setEditing(r)}><Pencil className="w-3.5 h-3.5" /> Edit</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Create modal — reuses the edit drawer with empty initial state */}
      {creating && (
        <RuleDrawer
          rule={null}
          onClose={() => setCreating(false)}
          onSave={async (input) => {
            await createRule(input);
            toast.success("Rule created");
            setCreating(false);
            await refresh();
          }}
          onDelete={undefined}
        />
      )}

      {editing && (
        <RuleDrawer
          rule={editing}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            await updateRule(editing.id, input);
            toast.success("Rule saved");
            setEditing(null);
            await refresh();
          }}
          onDelete={async () => {
            if (!confirm(`Delete rule "${editing.name}"?`)) return;
            await deleteRule(editing.id);
            toast.success("Rule deleted");
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function AutoCatImportButton({ onDone }: { onDone(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium cursor-pointer hover:bg-bg-elevated">
      <Upload className="w-4 h-4" /> {busy ? "Importing…" : "Import AutoCat"}
      <input
        type="file" accept=".csv,text/csv" className="hidden"
        disabled={busy}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setBusy(true);
          try {
            const r = await importAutoCat(f);
            toast.success(`Imported ${r.imported} rules, skipped ${r.skipped}`);
            await onDone();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </label>
  );
}

function RuleDrawer({
  rule, onClose, onSave, onDelete,
}: {
  rule: Rule | null;
  onClose(): void;
  onSave(input: RuleInput): Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const initial: RuleInput = rule ? {
    name: rule.name,
    match_field: rule.match_field,
    match_operator: rule.match_operator,
    match_value: rule.match_value,
    entity: rule.entity,
    category_tax: rule.category_tax ?? undefined,
    category_budget: rule.category_budget ?? undefined,
    priority: rule.priority,
    is_active: rule.is_active === 1,
  } : EMPTY_INPUT;

  const [draft, setDraft] = useState<RuleInput>(initial);
  const [busy, setBusy] = useState(false);

  return (
    <Drawer
      open
      onClose={onClose}
      title={rule ? `Edit "${rule.name}"` : "New rule"}
      footer={
        <div className="flex items-center justify-between">
          {onDelete ? (
            <Button variant="danger" disabled={busy} onClick={async () => { setBusy(true); try { await onDelete(); } finally { setBusy(false); } }}>
              <Trash2 className="w-4 h-4" /> Delete
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy || !draft.name || !draft.match_value}
              onClick={async () => {
                setBusy(true);
                try { await onSave(draft); }
                catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
                finally { setBusy(false); }
              }}
            >
              {rule ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-text-muted mb-1">Name</label>
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-full" />
        </div>

        <div>
          <label className="block text-xs text-text-muted mb-1">Field</label>
          <Select value={draft.match_field} onChange={(e) => setDraft({ ...draft, match_field: e.target.value as RuleMatchField })} className="w-full">
            {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </Select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Operator</label>
          <Select value={draft.match_operator} onChange={(e) => setDraft({ ...draft, match_operator: e.target.value as RuleMatchOperator })} className="w-full">
            {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-text-muted mb-1">Value</label>
          <Input value={draft.match_value} onChange={(e) => setDraft({ ...draft, match_value: e.target.value })} className="w-full font-mono text-sm" />
        </div>

        <div className="col-span-2">
          <label className="block text-xs text-text-muted mb-1">Entity</label>
          <Select value={draft.entity} onChange={(e) => setDraft({ ...draft, entity: e.target.value as RuleInput["entity"] })} className="w-full">
            {ENTITY_OPTIONS.map(({ slug, label }) => <option key={slug} value={slug}>{label}</option>)}
          </Select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Tax category</label>
          <Select value={draft.category_tax ?? ""} onChange={(e) => setDraft({ ...draft, category_tax: e.target.value || undefined })} className="w-full">
            <option value="">— none —</option>
            {CATEGORY_OPTIONS.filter((c) => c.kind === "tax").map(({ slug, label }) => <option key={slug} value={slug}>{label}</option>)}
          </Select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Budget category</label>
          <Select value={draft.category_budget ?? ""} onChange={(e) => setDraft({ ...draft, category_budget: e.target.value || undefined })} className="w-full">
            <option value="">— none —</option>
            {CATEGORY_OPTIONS.filter((c) => c.kind === "budget").map(({ slug, label }) => <option key={slug} value={slug}>{label}</option>)}
          </Select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Priority</label>
          <Input type="number" value={draft.priority ?? 0} onChange={(e) => setDraft({ ...draft, priority: parseInt(e.target.value || "0", 10) })} className="w-full" />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Active</label>
          <Select value={draft.is_active ? "1" : "0"} onChange={(e) => setDraft({ ...draft, is_active: e.target.value === "1" })} className="w-full">
            <option value="1">on</option>
            <option value="0">off</option>
          </Select>
        </div>
      </div>
    </Drawer>
  );
}
