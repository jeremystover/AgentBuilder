import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from "recharts";
import {
  Plus, RefreshCw, Trash2, Save, Edit2, Archive, Star,
} from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Badge, Select, Input, Drawer, PageHeader, EmptyState, fmtUsd,
} from "../ui";
import { api, type Entity } from "../../api";

type Tab = "accounts" | "networth" | "scenarios";

const ACCOUNT_TYPES = [
  { value: "checking",               label: "Checking / Savings",  group: "asset" },
  { value: "brokerage",              label: "Taxable Brokerage",   group: "asset" },
  { value: "trad_401k",              label: "Traditional 401(k)",  group: "asset" },
  { value: "roth_ira",               label: "Roth IRA",            group: "asset" },
  { value: "real_estate_primary",    label: "Real Estate — Primary",    group: "asset" },
  { value: "real_estate_investment", label: "Real Estate — Investment", group: "asset" },
  { value: "private_equity",         label: "Private Equity",      group: "asset" },
  { value: "529",                    label: "529",                 group: "asset" },
  { value: "social_security",        label: "Social Security",     group: "asset" },
  { value: "other_asset",            label: "Other Asset",         group: "asset" },
  { value: "mortgage",               label: "Mortgage",            group: "liability" },
  { value: "heloc",                  label: "HELOC",               group: "liability" },
  { value: "loan",                   label: "Loan",                group: "liability" },
  { value: "other_liability",        label: "Other Liability",     group: "liability" },
] as const;
type AccountType = typeof ACCOUNT_TYPES[number]["value"];

interface ScenarioAccount {
  id: string;
  name: string;
  type: AccountType;
  asset_or_liability: "asset" | "liability";
  entity_id: string | null;
  entity_name: string | null;
  is_active: boolean;
  notes: string | null;
  current_balance: number | null;
  latest_balance: number | null;
  latest_balance_date: string | null;
  current_rate: number | null;
  config: Record<string, unknown> | null;
}

interface RateEntry { id: string; base_rate: number; effective_date: string; notes: string | null }
interface BalanceEntry { id: string; balance: number; recorded_date: string; source: string; notes: string | null }

// ── Top-level ────────────────────────────────────────────────────────────────

export function ScenariosView() {
  const [tab, setTab] = useState<Tab>("accounts");
  const [accounts, setAccounts] = useState<ScenarioAccount[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [as, es] = await Promise.all([
        api.get<{ accounts: ScenarioAccount[] }>("/api/web/scenario-accounts").then(r => r.accounts),
        api.get<{ entities: Entity[] }>("/api/web/entities").then(r => r.entities),
      ]);
      setAccounts(as);
      setEntities(es);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Scenarios"
        subtitle="Net worth tracking and forward projection"
        actions={<Button onClick={() => void refresh()}><RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} /></Button>}
      />

      <div className="border-b border-border mb-4 flex gap-1">
        <TabButton active={tab === "accounts"}  onClick={() => setTab("accounts")}>Accounts</TabButton>
        <TabButton active={tab === "networth"}  onClick={() => setTab("networth")}>Net Worth</TabButton>
        <TabButton active={tab === "scenarios"} onClick={() => setTab("scenarios")}>Scenarios</TabButton>
      </div>

      {tab === "accounts" && (
        <AccountsTab
          accounts={accounts}
          loading={loading}
          onEdit={setEditingId}
          onAdd={() => setCreating(true)}
        />
      )}
      {tab === "networth" && <NetWorthTab accounts={accounts} />}
      {tab === "scenarios" && (
        <Card className="p-6"><EmptyState>Projection engine arrives in Phase 6.</EmptyState></Card>
      )}

      <AccountEditor
        accountId={editingId}
        entities={entities}
        open={editingId !== null || creating}
        creating={creating}
        onClose={() => { setEditingId(null); setCreating(false); }}
        onSaved={async () => { await refresh(); setEditingId(null); setCreating(false); }}
      />
    </div>
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

// ── Accounts tab ─────────────────────────────────────────────────────────────

function AccountsTab({
  accounts, loading, onEdit, onAdd,
}: {
  accounts: ScenarioAccount[];
  loading: boolean;
  onEdit: (id: string) => void;
  onAdd: () => void;
}) {
  const assets       = accounts.filter(a => a.asset_or_liability === "asset");
  const liabilities  = accounts.filter(a => a.asset_or_liability === "liability");
  const totalAssets      = sumLatest(assets);
  const totalLiabilities = sumLatest(liabilities);
  const netWorth = totalAssets - totalLiabilities;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="Total assets"      value={totalAssets}      tone="positive" />
        <SummaryCard label="Total liabilities" value={totalLiabilities} tone="negative" />
        <SummaryCard label="Net worth"         value={netWorth}         tone="primary"  signed />
      </div>

      <div className="flex justify-between items-center">
        <div className="text-xs text-text-muted">
          {accounts.length} active accounts
        </div>
        <Button variant="primary" onClick={onAdd}>
          <Plus className="w-4 h-4" /> Add account
        </Button>
      </div>

      <AccountTable label="Assets"      accounts={assets}      onEdit={onEdit} loading={loading} />
      <AccountTable label="Liabilities" accounts={liabilities} onEdit={onEdit} loading={loading} />
    </div>
  );
}

function SummaryCard({
  label, value, tone, signed,
}: {
  label: string; value: number;
  tone: "positive" | "negative" | "primary"; signed?: boolean;
}) {
  const color = tone === "positive" ? "text-accent-success"
              : tone === "negative" ? "text-accent-danger"
              : (signed && value < 0) ? "text-accent-danger"
              : "text-text-primary";
  return (
    <Card className="p-4">
      <div className="text-xs text-text-muted uppercase tracking-wide">{label}</div>
      <div className={"text-2xl font-semibold tabular-nums mt-1 " + color}>
        {fmtUsd(value, signed ? { sign: true } : undefined)}
      </div>
    </Card>
  );
}

function AccountTable({
  label, accounts, onEdit, loading,
}: {
  label: string;
  accounts: ScenarioAccount[];
  onEdit: (id: string) => void;
  loading: boolean;
}) {
  return (
    <Card>
      <div className="px-4 py-2 bg-bg-elevated border-b border-border text-xs font-semibold uppercase tracking-wide text-text-muted">
        {label}
      </div>
      {accounts.length === 0
        ? <EmptyState>{loading ? "Loading…" : `No ${label.toLowerCase()}`}</EmptyState>
        : (
          <table className="w-full text-sm">
            <thead className="text-xs text-text-muted uppercase tracking-wide bg-bg-elevated/40">
              <tr>
                <th className="text-left px-3 py-2">Name</th>
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-left px-3 py-2">Entity</th>
                <th className="text-right px-3 py-2">Balance</th>
                <th className="text-right px-3 py-2">As of</th>
                <th className="text-right px-3 py-2">Rate</th>
                <th className="text-right px-3 py-2 w-12"></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => (
                <tr key={a.id} className="border-t border-border hover:bg-bg-elevated/40 cursor-pointer" onClick={() => onEdit(a.id)}>
                  <td className="px-3 py-2 font-medium">{a.name}</td>
                  <td className="px-3 py-2"><Badge tone="neutral">{accountTypeLabel(a.type)}</Badge></td>
                  <td className="px-3 py-2 text-text-muted">{a.entity_name ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{a.latest_balance != null ? fmtUsd(a.latest_balance) : "—"}</td>
                  <td className="px-3 py-2 text-right text-xs text-text-muted">{a.latest_balance_date ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{a.current_rate != null ? `${(a.current_rate * 100).toFixed(2)}%` : "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onEdit(a.id); }}>
                      <Edit2 className="w-3.5 h-3.5" />
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

function accountTypeLabel(type: AccountType): string {
  return ACCOUNT_TYPES.find(t => t.value === type)?.label ?? type;
}

function sumLatest(accounts: ScenarioAccount[]): number {
  return accounts.reduce((acc, a) => acc + (a.latest_balance ?? 0), 0);
}

// ── Account editor drawer ───────────────────────────────────────────────────

function AccountEditor({
  accountId, entities, open, creating, onClose, onSaved,
}: {
  accountId: string | null;
  entities: Entity[];
  open: boolean;
  creating: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [account, setAccount] = useState<ScenarioAccount | null>(null);
  const [rateSchedule, setRateSchedule] = useState<RateEntry[]>([]);
  const [balanceHistory, setBalanceHistory] = useState<BalanceEntry[]>([]);
  const [busy, setBusy] = useState(false);

  // Form state — synced from `account` when loaded.
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [entityId, setEntityId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [config, setConfig] = useState<Record<string, unknown>>({});

  const load = useCallback(async () => {
    if (creating) {
      setAccount(null);
      setName("");
      setType("checking");
      setEntityId(entities[0]?.id ?? "");
      setNotes("");
      setConfig({});
      setRateSchedule([]);
      setBalanceHistory([]);
      return;
    }
    if (!accountId) return;
    setBusy(true);
    try {
      const [acc, rs, bh] = await Promise.all([
        api.get<ScenarioAccount & { config: Record<string, unknown> | null }>(`/api/web/scenario-accounts/${accountId}`),
        api.get<{ entries: RateEntry[] }>(`/api/web/scenario-accounts/${accountId}/rate-schedule`).then(r => r.entries),
        api.get<{ entries: BalanceEntry[] }>(`/api/web/scenario-accounts/${accountId}/balance-history`).then(r => r.entries),
      ]);
      setAccount(acc);
      setName(acc.name);
      setType(acc.type);
      setEntityId(acc.entity_id ?? "");
      setNotes(acc.notes ?? "");
      setConfig(acc.config ?? {});
      setRateSchedule(rs);
      setBalanceHistory(bh);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [accountId, creating, entities]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const payload = {
        name, type,
        entity_id: entityId || null,
        notes: notes || null,
        config,
      };
      if (creating) {
        const res = await api.post<{ id: string }>("/api/web/scenario-accounts", payload);
        toast.success("Account created");
        await persistSubResources(res.id);
      } else if (accountId) {
        await api.put(`/api/web/scenario-accounts/${accountId}`, payload);
        await persistSubResources(accountId);
        toast.success("Account saved");
      }
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const persistSubResources = async (id: string) => {
    await api.put(`/api/web/scenario-accounts/${id}/rate-schedule`, {
      entries: rateSchedule.map(r => ({
        base_rate: r.base_rate, effective_date: r.effective_date, notes: r.notes,
      })),
    });
  };

  const archive = async () => {
    if (!accountId || !confirm("Archive this account?")) return;
    setBusy(true);
    try {
      await api.del(`/api/web/scenario-accounts/${accountId}`);
      toast.success("Archived");
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const addBalance = async () => {
    if (!accountId) {
      toast.error("Save the account first, then add balance entries.");
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    try {
      await api.post(`/api/web/scenario-accounts/${accountId}/balance-history`, {
        balance: 0, recorded_date: today, source: "manual",
      });
      const refreshed = await api.get<{ entries: BalanceEntry[] }>(`/api/web/scenario-accounts/${accountId}/balance-history`);
      setBalanceHistory(refreshed.entries);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const updateBalanceEntry = async (entry: BalanceEntry, patch: Partial<BalanceEntry>) => {
    if (!accountId) return;
    try {
      await api.put(`/api/web/scenario-accounts/${accountId}/balance-history/${entry.id}`, patch);
      setBalanceHistory(arr => arr.map(b => b.id === entry.id ? { ...b, ...patch } : b));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteBalanceEntry = async (entryId: string) => {
    if (!accountId) return;
    try {
      await api.del(`/api/web/scenario-accounts/${accountId}/balance-history/${entryId}`);
      setBalanceHistory(arr => arr.filter(b => b.id !== entryId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={creating ? "New account" : (account?.name ?? "Account")}
      footer={
        <div className="flex gap-2 w-full justify-end">
          {!creating && (
            <Button variant="danger" onClick={() => void archive()} disabled={busy}>
              <Archive className="w-4 h-4" /> Archive
            </Button>
          )}
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
            <Save className="w-4 h-4" /> Save
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Core fields */}
        <Section title="Core">
          <Field label="Name">
            <Input className="w-full" value={name} onChange={e => setName(e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={e => setType(e.target.value as AccountType)} disabled={!creating}>
              <optgroup label="Assets">
                {ACCOUNT_TYPES.filter(t => t.group === "asset").map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </optgroup>
              <optgroup label="Liabilities">
                {ACCOUNT_TYPES.filter(t => t.group === "liability").map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </optgroup>
            </Select>
          </Field>
          <Field label="Entity">
            <Select value={entityId} onChange={e => setEntityId(e.target.value)}>
              <option value="">— Select —</option>
              {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
          </Field>
          <Field label="Notes">
            <Input className="w-full" value={notes} onChange={e => setNotes(e.target.value)} />
          </Field>
        </Section>

        {/* Type-specific config */}
        <Section title="Configuration">
          <TypeConfigForm type={type} config={config} onChange={setConfig} />
        </Section>

        {/* Rate schedule */}
        <Section title="Rate schedule">
          <RateScheduleEditor entries={rateSchedule} onChange={setRateSchedule} />
        </Section>

        {/* Balance history */}
        <Section title="Balance history">
          <BalanceHistoryEditor
            entries={balanceHistory}
            onAdd={() => void addBalance()}
            onUpdate={updateBalanceEntry}
            onDelete={deleteBalanceEntry}
            disabled={!accountId}
          />
        </Section>
      </div>
    </Drawer>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-text-muted mb-1">{label}</label>
      {children}
    </div>
  );
}

// ── Type-specific config form ───────────────────────────────────────────────

function TypeConfigForm({
  type, config, onChange,
}: {
  type: AccountType;
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const set = (key: string, value: unknown) => onChange({ ...config, [key]: value });
  const num = (key: string) => (config[key] as number | undefined) ?? "";
  const str = (key: string) => (config[key] as string | undefined) ?? "";

  if (type === "trad_401k" || type === "roth_ira") {
    return (
      <>
        <Field label="Owner">
          <Select value={str("owner")} onChange={e => set("owner", e.target.value)}>
            <option value="">—</option>
            <option value="jeremy">Jeremy</option>
            <option value="elyse">Elyse</option>
          </Select>
        </Field>
        <Field label="Annual contribution">
          <Input type="number" step="100" value={num("annual_contribution")}
            onChange={e => set("annual_contribution", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
        {type === "roth_ira" && (
          <Field label="Roth contribution basis (post-tax)">
            <Input type="number" step="100" value={num("roth_contribution_basis")}
              onChange={e => set("roth_contribution_basis", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
        )}
      </>
    );
  }

  if (type === "real_estate_primary" || type === "real_estate_investment") {
    return (
      <>
        <Field label="Purchase price">
          <Input type="number" step="1000" value={num("purchase_price")}
            onChange={e => set("purchase_price", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
        <Field label="Purchase date">
          <Input type="date" value={str("purchase_date")} onChange={e => set("purchase_date", e.target.value)} />
        </Field>
        <Field label="Accumulated depreciation">
          <Input type="number" step="1000" value={num("accumulated_depreciation")}
            onChange={e => set("accumulated_depreciation", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
      </>
    );
  }

  if (type === "mortgage" || type === "heloc" || type === "loan") {
    return (
      <>
        {type === "mortgage" && (
          <>
            <Field label="Original principal">
              <Input type="number" step="1000" value={num("original_principal")}
                onChange={e => set("original_principal", e.target.value === "" ? null : Number(e.target.value))} />
            </Field>
            <Field label="Origination date">
              <Input type="date" value={str("origination_date")} onChange={e => set("origination_date", e.target.value)} />
            </Field>
            <Field label="Term (months)">
              <Input type="number" step="12" value={num("term_months")}
                onChange={e => set("term_months", e.target.value === "" ? null : Number(e.target.value))} />
            </Field>
          </>
        )}
        <Field label="Current principal">
          <Input type="number" step="100" value={num("current_principal")}
            onChange={e => set("current_principal", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
        <Field label="Monthly payment">
          <Input type="number" step="10" value={num("monthly_payment")}
            onChange={e => set("monthly_payment", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
      </>
    );
  }

  if (type === "529") {
    return (
      <>
        <Field label="Owner">
          <Select value={str("owner")} onChange={e => set("owner", e.target.value)}>
            <option value="">—</option>
            <option value="jeremy">Jeremy</option>
            <option value="elyse">Elyse</option>
          </Select>
        </Field>
        <Field label="Beneficiary">
          <Input value={str("beneficiary")} onChange={e => set("beneficiary", e.target.value)} />
        </Field>
        <Field label="Annual contribution">
          <Input type="number" step="100" value={num("annual_contribution")}
            onChange={e => set("annual_contribution", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
      </>
    );
  }

  if (type === "social_security") {
    return (
      <>
        <Field label="Person">
          <Select value={str("person")} onChange={e => set("person", e.target.value)}>
            <option value="">—</option>
            <option value="jeremy">Jeremy</option>
            <option value="elyse">Elyse</option>
          </Select>
        </Field>
        <Field label="FRA monthly benefit">
          <Input type="number" step="50" value={num("fra_monthly_benefit")}
            onChange={e => set("fra_monthly_benefit", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
        <Field label="Full retirement age">
          <Input type="number" step="1" value={num("full_retirement_age")}
            onChange={e => set("full_retirement_age", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
        <Field label="Elected start age">
          <Input type="number" step="1" value={num("elected_start_age")}
            onChange={e => set("elected_start_age", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
      </>
    );
  }

  if (type === "private_equity") {
    return (
      <>
        <Field label="Company">
          <Input value={str("company")} onChange={e => set("company", e.target.value)} />
        </Field>
        <Field label="Grant type">
          <Select value={str("grant_type")} onChange={e => set("grant_type", e.target.value)}>
            <option value="">—</option>
            <option value="ISO">ISO</option>
            <option value="NSO">NSO</option>
            <option value="RSU">RSU</option>
            <option value="common">Common</option>
          </Select>
        </Field>
        <Field label="Shares / units">
          <Input type="number" step="1" value={num("shares_or_units")}
            onChange={e => set("shares_or_units", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
        <Field label="Cost basis per share">
          <Input type="number" step="0.01" value={num("cost_basis_per_share")}
            onChange={e => set("cost_basis_per_share", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
      </>
    );
  }

  return <div className="text-xs text-text-muted">No extra configuration for this type.</div>;
}

// ── Rate schedule editor ────────────────────────────────────────────────────

function RateScheduleEditor({
  entries, onChange,
}: { entries: RateEntry[]; onChange: (next: RateEntry[]) => void }) {
  const today = new Date();
  const sorted = [...entries].sort((a, b) => a.effective_date.localeCompare(b.effective_date));
  const todayRate = sorted.filter(e => e.effective_date <= today.toISOString().slice(0, 10)).pop();

  return (
    <>
      {sorted.length === 0
        ? <div className="text-xs text-text-muted">No rate schedule. Add a row to set the base rate.</div>
        : (
          <div className="text-xs text-text-muted">
            Rate in effect today: {todayRate ? `${(todayRate.base_rate * 100).toFixed(2)}%` : "—"}
          </div>
        )}
      {sorted.map((e, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <Input
            type="date"
            value={e.effective_date}
            onChange={ev => onChange(entries.map(x => x === e ? { ...x, effective_date: ev.target.value } : x))}
          />
          <Input
            type="number" step="0.001"
            value={e.base_rate}
            onChange={ev => onChange(entries.map(x => x === e ? { ...x, base_rate: Number(ev.target.value) } : x))}
            className="w-24"
            placeholder="0.07"
          />
          <span className="text-xs text-text-muted w-12">{(e.base_rate * 100).toFixed(2)}%</span>
          <Button size="sm" variant="danger" onClick={() => onChange(entries.filter(x => x !== e))}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      ))}
      <Button size="sm" onClick={() => onChange([...entries, {
        id: "", base_rate: 0.05, effective_date: new Date().toISOString().slice(0, 10), notes: null,
      }])}>
        <Plus className="w-3.5 h-3.5" /> Add rate change
      </Button>
    </>
  );
}

// ── Balance history editor ──────────────────────────────────────────────────

function BalanceHistoryEditor({
  entries, onAdd, onUpdate, onDelete, disabled,
}: {
  entries: BalanceEntry[];
  onAdd: () => void;
  onUpdate: (e: BalanceEntry, patch: Partial<BalanceEntry>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  disabled: boolean;
}) {
  const sparkData = [...entries]
    .sort((a, b) => a.recorded_date.localeCompare(b.recorded_date))
    .map(e => ({ date: e.recorded_date, balance: e.balance }));

  return (
    <>
      {entries.length === 0
        ? <div className="text-xs text-text-muted">{disabled ? "Save the account, then record balance history." : "No balance history."}</div>
        : (
          <div className="h-24 bg-bg-elevated/40 rounded">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparkData} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                <XAxis dataKey="date" tick={false} axisLine={false} />
                <YAxis hide />
                <Tooltip formatter={(v: number) => fmtUsd(v)} contentStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="balance" stroke="#4F46E5" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      {entries.map(e => (
        <div key={e.id} className="flex items-center gap-2">
          <Input
            type="date"
            value={e.recorded_date}
            onChange={ev => void onUpdate(e, { recorded_date: ev.target.value })}
          />
          <Input
            type="number" step="0.01"
            value={e.balance}
            onChange={ev => void onUpdate(e, { balance: Number(ev.target.value) })}
            className="w-32 text-right tabular-nums"
          />
          <Badge tone={e.source === "manual" ? "neutral" : "info"}>{e.source}</Badge>
          <Button size="sm" variant="danger" onClick={() => void onDelete(e.id)}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      ))}
      <Button size="sm" onClick={onAdd} disabled={disabled}>
        <Plus className="w-3.5 h-3.5" /> Add balance
      </Button>
    </>
  );
}

// ── Net Worth tab ───────────────────────────────────────────────────────────

interface NetWorthSeries {
  date: string;
  net_worth: number;
  [accountKey: string]: string | number;
}

function NetWorthTab({ accounts }: { accounts: ScenarioAccount[] }) {
  const today = new Date();
  const oneYearAgo = new Date(today); oneYearAgo.setUTCFullYear(today.getUTCFullYear() - 1);
  const [from, setFrom] = useState(oneYearAgo.toISOString().slice(0, 10));
  const [to, setTo]     = useState(today.toISOString().slice(0, 10));
  const [allHistories, setAllHistories] = useState<Map<string, BalanceEntry[]>>(new Map());
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const histories = new Map<string, BalanceEntry[]>();
      for (const a of accounts) {
        const res = await api.get<{ entries: BalanceEntry[] }>(`/api/web/scenario-accounts/${a.id}/balance-history`);
        histories.set(a.id, res.entries);
      }
      setAllHistories(histories);
      setVisible(new Set(accounts.map(a => a.id)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [accounts]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Build series: union of all dates with any balance entry, then carry-forward
  // each account's most recent balance ≤ that date.
  const series: NetWorthSeries[] = useMemo(() => {
    const dateSet = new Set<string>();
    for (const entries of allHistories.values()) {
      for (const e of entries) {
        if (e.recorded_date >= from && e.recorded_date <= to) dateSet.add(e.recorded_date);
      }
    }
    const dates = [...dateSet].sort();
    return dates.map(date => {
      const row: NetWorthSeries = { date, net_worth: 0 };
      let net = 0;
      for (const a of accounts) {
        const entries = allHistories.get(a.id) ?? [];
        const matching = entries
          .filter(e => e.recorded_date <= date)
          .sort((x, y) => y.recorded_date.localeCompare(x.recorded_date))[0];
        const signed = matching
          ? (a.asset_or_liability === "liability" ? -matching.balance : matching.balance)
          : 0;
        row[a.id] = signed;
        net += signed;
      }
      row.net_worth = net;
      return row;
    });
  }, [accounts, allHistories, from, to]);

  const totalAssets      = sumLatest(accounts.filter(a => a.asset_or_liability === "asset"));
  const totalLiabilities = sumLatest(accounts.filter(a => a.asset_or_liability === "liability"));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="Assets today"      value={totalAssets}      tone="positive" />
        <SummaryCard label="Liabilities today" value={totalLiabilities} tone="negative" />
        <SummaryCard label="Net worth today"   value={totalAssets - totalLiabilities} tone="primary" signed />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs text-text-muted">From</label>
        <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        <label className="text-xs text-text-muted">To</label>
        <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
        <Button size="sm" onClick={() => void refresh()}>
          <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
        </Button>
      </div>

      <Card className="p-3">
        <div className="h-80">
          {series.length === 0
            ? <EmptyState>{loading ? "Loading…" : "No balance history in this range."}</EmptyState>
            : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#64748B" />
                  <YAxis tick={{ fontSize: 11 }} stroke="#64748B" tickFormatter={v => fmtUsd(v as number)} width={80} />
                  <Tooltip formatter={(v: number) => fmtUsd(v)} contentStyle={{ fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="net_worth" name="Net worth" stroke="#0F172A" strokeWidth={3} dot={false} isAnimationActive={false} />
                  {accounts.filter(a => visible.has(a.id)).map((a, i) => (
                    <Line
                      key={a.id}
                      type="monotone"
                      dataKey={a.id}
                      name={a.name}
                      stroke={LINE_COLORS[i % LINE_COLORS.length]}
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
        </div>
      </Card>

      <Card>
        <div className="px-4 py-2 bg-bg-elevated border-b border-border text-xs font-semibold uppercase tracking-wide text-text-muted">
          Account toggles
        </div>
        <div className="p-3 grid grid-cols-2 md:grid-cols-3 gap-2">
          {accounts.map(a => (
            <label key={a.id} className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={visible.has(a.id)}
                onChange={e => {
                  const next = new Set(visible);
                  if (e.target.checked) next.add(a.id); else next.delete(a.id);
                  setVisible(next);
                }}
              />
              <span className="truncate">{a.name}</span>
              <button onClick={() => setDetailId(a.id)} className="text-xs text-accent-primary hover:underline">detail</button>
            </label>
          ))}
        </div>
      </Card>

      {detailId && (
        <AccountDetail
          account={accounts.find(a => a.id === detailId)!}
          history={allHistories.get(detailId) ?? []}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  );
}

const LINE_COLORS = [
  "#4F46E5", "#059669", "#D97706", "#DC2626", "#7C3AED",
  "#0891B2", "#DB2777", "#65A30D", "#EA580C", "#475569",
];

// ── Account detail (modal) ──────────────────────────────────────────────────

function AccountDetail({
  account, history, onClose,
}: {
  account: ScenarioAccount;
  history: BalanceEntry[];
  onClose: () => void;
}) {
  const sorted = [...history].sort((a, b) => a.recorded_date.localeCompare(b.recorded_date));
  const [from, setFrom] = useState(sorted[0]?.recorded_date ?? "");
  const [to,   setTo]   = useState(sorted[sorted.length - 1]?.recorded_date ?? "");
  const [comparison, setComparison] = useState<{
    actual_rate: number | null; configured_rate_at_start: number | null;
    start_balance: number | null; end_balance: number | null; from: string; to: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const compare = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true);
    try {
      const res = await api.get<typeof comparison>(`/api/web/scenario-accounts/${account.id}/rate-comparison?from=${from}&to=${to}`);
      setComparison(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [account.id, from, to]);

  useEffect(() => { void compare(); }, [compare]);

  return (
    <Drawer open onClose={onClose} title={account.name}>
      <div className="space-y-4">
        <div>
          <div className="text-xs text-text-muted">Type</div>
          <div>{accountTypeLabel(account.type)} • {account.entity_name ?? "—"}</div>
        </div>

        <Section title="Rate comparison">
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-text-muted">From</label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
            <label className="text-xs text-text-muted">To</label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
            <Button size="sm" onClick={() => void compare()} disabled={loading}>
              <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
            </Button>
          </div>
          {comparison && comparison.actual_rate != null && (
            <div className="text-sm bg-bg-elevated/60 rounded p-3 space-y-1">
              <div>
                <Star className="w-3.5 h-3.5 inline -mt-0.5 mr-1 text-accent-warn fill-current" />
                From <span className="font-medium">{comparison.from}</span> to <span className="font-medium">{comparison.to}</span>:
              </div>
              <div>
                Actual rate <span className="font-semibold tabular-nums">{(comparison.actual_rate * 100).toFixed(2)}%</span>
                {comparison.configured_rate_at_start != null && (
                  <> vs. configured <span className="font-semibold tabular-nums">{(comparison.configured_rate_at_start * 100).toFixed(2)}%</span></>
                )}
              </div>
              <div className="text-xs text-text-muted">
                {fmtUsd(comparison.start_balance ?? 0)} → {fmtUsd(comparison.end_balance ?? 0)}
              </div>
            </div>
          )}
        </Section>

        <Section title={`Balance history (${sorted.length})`}>
          <table className="w-full text-sm">
            <thead className="text-xs text-text-muted uppercase tracking-wide bg-bg-elevated">
              <tr>
                <th className="text-left px-2 py-1">Date</th>
                <th className="text-right px-2 py-1">Balance</th>
                <th className="text-left px-2 py-1">Source</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(e => (
                <tr key={e.id} className="border-t border-border">
                  <td className="px-2 py-1 tabular-nums">{e.recorded_date}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(e.balance)}</td>
                  <td className="px-2 py-1 text-xs text-text-muted">{e.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>
    </Drawer>
  );
}
