import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Plus, RefreshCw, Trash2, Save, Edit2, Archive, Star,
} from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Badge, Select, Input, Drawer, Modal, PageHeader, EmptyState, fmtUsd,
} from "../ui";
import { api, type Entity } from "../../api";

type Tab = "accounts" | "networth" | "scenarios" | "tax";

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
        <TabButton active={tab === "tax"}       onClick={() => setTab("tax")}>Tax &amp; Profile</TabButton>
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
      {tab === "tax" && <TaxProfileTab />}
      {tab === "scenarios" && (
        <ScenariosTab accounts={accounts} />
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
  const [sellModalOpen, setSellModalOpen] = useState(false);

  // Form state — synced from `account` when loaded.
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [entityId, setEntityId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [config, setConfig] = useState<Record<string, unknown>>({});

  const sellable = type === "real_estate_primary" || type === "real_estate_investment" || type === "private_equity";

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
    <>
    <Drawer
      open={open}
      onClose={onClose}
      title={creating ? "New account" : (account?.name ?? "Account")}
      footer={
        <div className="flex gap-2 w-full justify-end">
          {!creating && sellable && accountId && (
            <Button onClick={() => setSellModalOpen(true)} disabled={busy}>
              Sell on date…
            </Button>
          )}
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
    <SellOnDateModal
      account={account}
      open={sellModalOpen}
      onClose={() => setSellModalOpen(false)}
    />
    </>
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

// ── Scenarios tab — list + editor + results ─────────────────────────────────

interface ScenarioListItem {
  id: string;
  name: string;
  status: 'draft' | 'running' | 'complete' | 'failed' | 'stale';
  plan_id: string | null;
  plan_name: string | null;
  start_date: string;
  end_date: string;
  end_state_net_worth: number | null;
  last_run_at: string | null;
  latest_snapshot_id: string | null;
  account_ids_json: string[] | null;
  allocation_rules_json: unknown | null;
}

interface PlanRow { id: string; name: string }

function ScenariosTab({ accounts }: { accounts: ScenarioAccount[] }) {
  const [scenarios, setScenarios] = useState<ScenarioListItem[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([
        api.get<{ scenarios: ScenarioListItem[] }>("/api/web/scenarios").then(r => r.scenarios),
        api.get<{ plans: PlanRow[] }>("/api/web/plans").then(r => r.plans),
      ]);
      setScenarios(s);
      setPlans(p);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while any scenario is queued/running.
  useEffect(() => {
    const running = scenarios.some(s => s.status === "running");
    if (!running) return;
    const t = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(t);
  }, [scenarios, refresh]);

  const run = async (id: string) => {
    try {
      await api.post(`/api/web/scenarios/${id}/run`);
      toast.success("Run queued");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this scenario?")) return;
    try {
      await api.del(`/api/web/scenarios/${id}`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-3">
        <div className="text-xs text-text-muted">{scenarios.length} scenarios</div>
        <div className="flex gap-2">
          <Button onClick={() => setComparing(true)} disabled={scenarios.filter(s => s.latest_snapshot_id).length < 2}>
            Compare…
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="w-4 h-4" /> New scenario
          </Button>
        </div>
      </div>

      <Card>
        {scenarios.length === 0
          ? <EmptyState>{loading ? "Loading…" : "No scenarios yet."}</EmptyState>
          : (
            <table className="w-full text-sm">
              <thead className="text-xs text-text-muted uppercase tracking-wide bg-bg-elevated">
                <tr>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Range</th>
                  <th className="text-left px-3 py-2">Plan</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">End-state NW</th>
                  <th className="text-right px-3 py-2">Last run</th>
                  <th className="text-right px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {scenarios.map(s => (
                  <tr key={s.id} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">{s.name}</td>
                    <td className="px-3 py-2 text-xs">{s.start_date} → {s.end_date}</td>
                    <td className="px-3 py-2 text-text-muted">{s.plan_name ?? "—"}</td>
                    <td className="px-3 py-2"><StatusBadge status={s.status} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.end_state_net_worth != null ? fmtUsd(s.end_state_net_worth, { sign: true }) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-text-muted">
                      {s.last_run_at ? s.last_run_at.slice(0, 16).replace("T", " ") : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex gap-1 justify-end">
                        <Button size="sm" variant="ghost" onClick={() => setViewingId(s.id)} disabled={!s.latest_snapshot_id}>Results</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(s.id)}><Edit2 className="w-3.5 h-3.5" /></Button>
                        <Button size="sm" variant="primary" onClick={() => void run(s.id)} disabled={s.status === "running"}>
                          Run
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => void remove(s.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      <ScenarioEditor
        scenarioId={editingId}
        accounts={accounts}
        plans={plans}
        open={editingId !== null || creating}
        creating={creating}
        onClose={() => { setEditingId(null); setCreating(false); }}
        onSaved={async (id) => { await refresh(); setEditingId(id); setCreating(false); }}
      />

      {viewingId && (
        <ScenarioResultsDrawer
          scenario={scenarios.find(s => s.id === viewingId)!}
          onClose={() => setViewingId(null)}
        />
      )}

      {comparing && (
        <ScenarioComparisonDrawer
          scenarios={scenarios.filter(s => s.latest_snapshot_id)}
          onClose={() => setComparing(false)}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ScenarioListItem["status"] }) {
  const tone = status === "complete" ? "ok"
             : status === "failed"   ? "danger"
             : status === "running"  ? "warn"
             : status === "stale"    ? "warn"
             : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

// ── Scenario editor ─────────────────────────────────────────────────────────

interface AllocRulesShape {
  surplus: Array<{ kind: string; max_per_year?: number; rate_threshold?: number }>;
  deficit: Array<{ kind: string }>;
}

const DEFAULT_ALLOC: AllocRulesShape = {
  surplus: [
    { kind: "emergency_reserve" },
    { kind: "retirement", max_per_year: 23000 },
    { kind: "high_interest_paydown", rate_threshold: 0.06 },
    { kind: "taxable_brokerage" },
  ],
  deficit: [
    { kind: "checking" },
    { kind: "taxable_brokerage" },
    { kind: "roth_contributions" },
    { kind: "traditional_retirement" },
  ],
};

interface ScenarioEditBody {
  name: string;
  start_date: string;
  end_date: string;
  plan_id: string | null;
  account_ids: string[];
  allocation_rules: AllocRulesShape;
}

function ScenarioEditor({
  scenarioId, accounts, plans, open, creating, onClose, onSaved,
}: {
  scenarioId: string | null;
  accounts: ScenarioAccount[];
  plans: PlanRow[];
  open: boolean;
  creating: boolean;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const today = new Date();
  const inTenYears = new Date(today); inTenYears.setUTCFullYear(today.getUTCFullYear() + 10);
  const defaultStart = today.toISOString().slice(0, 10);
  const defaultEnd = inTenYears.toISOString().slice(0, 10);

  const [body, setBody] = useState<ScenarioEditBody>({
    name: "", start_date: defaultStart, end_date: defaultEnd,
    plan_id: null, account_ids: accounts.map(a => a.id), allocation_rules: DEFAULT_ALLOC,
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (creating) {
      setBody({
        name: "", start_date: defaultStart, end_date: defaultEnd,
        plan_id: plans[0]?.id ?? null,
        account_ids: accounts.map(a => a.id),
        allocation_rules: DEFAULT_ALLOC,
      });
      return;
    }
    if (!scenarioId) return;
    try {
      const s = await api.get<{
        name: string; start_date: string; end_date: string;
        plan_id: string | null; account_ids_json: string[] | null;
        allocation_rules_json: AllocRulesShape | null;
      }>(`/api/web/scenarios/${scenarioId}`);
      setBody({
        name: s.name,
        start_date: s.start_date, end_date: s.end_date,
        plan_id: s.plan_id,
        account_ids: s.account_ids_json ?? [],
        allocation_rules: s.allocation_rules_json ?? DEFAULT_ALLOC,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId, creating]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const save = async () => {
    if (!body.name.trim()) return;
    setBusy(true);
    try {
      if (creating) {
        const res = await api.post<{ id: string }>("/api/web/scenarios", body);
        toast.success("Scenario created");
        await onSaved(res.id);
      } else if (scenarioId) {
        await api.put(`/api/web/scenarios/${scenarioId}`, body);
        toast.success("Saved");
        await onSaved(scenarioId);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const toggleAccount = (id: string) => {
    setBody(b => ({
      ...b,
      account_ids: b.account_ids.includes(id) ? b.account_ids.filter(x => x !== id) : [...b.account_ids, id],
    }));
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={creating ? "New scenario" : "Edit scenario"}
      footer={
        <div className="flex gap-2 w-full justify-end">
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !body.name.trim()}>
            <Save className="w-4 h-4" /> Save
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <Section title="Basics">
          <Field label="Name">
            <Input className="w-full" value={body.name} onChange={e => setBody(b => ({ ...b, name: e.target.value }))} />
          </Field>
          <div className="flex gap-2">
            <Field label="Start">
              <Input type="date" value={body.start_date} onChange={e => setBody(b => ({ ...b, start_date: e.target.value }))} />
            </Field>
            <Field label="End">
              <Input type="date" value={body.end_date} onChange={e => setBody(b => ({ ...b, end_date: e.target.value }))} />
            </Field>
          </div>
          <Field label="Plan">
            <Select value={body.plan_id ?? ""} onChange={e => setBody(b => ({ ...b, plan_id: e.target.value || null }))}>
              <option value="">— Select plan —</option>
              {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        </Section>

        <Section title="Accounts included">
          <div className="grid grid-cols-2 gap-1 text-sm">
            {accounts.map(a => (
              <label key={a.id} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={body.account_ids.includes(a.id)}
                  onChange={() => toggleAccount(a.id)}
                />
                <span className="truncate">{a.name}</span>
              </label>
            ))}
          </div>
        </Section>

        <Section title="Surplus waterfall (top priority first)">
          <WaterfallList
            items={body.allocation_rules.surplus.map(s => s.kind)}
            options={["emergency_reserve", "retirement", "high_interest_paydown", "taxable_brokerage"]}
            onChange={kinds => setBody(b => ({
              ...b,
              allocation_rules: {
                ...b.allocation_rules,
                surplus: kinds.map(k => {
                  const existing = b.allocation_rules.surplus.find(s => s.kind === k);
                  return existing ?? { kind: k };
                }),
              },
            }))}
          />
        </Section>
        <Section title="Deficit waterfall (top priority first)">
          <WaterfallList
            items={body.allocation_rules.deficit.map(d => d.kind)}
            options={["checking", "taxable_brokerage", "roth_contributions", "traditional_retirement"]}
            onChange={kinds => setBody(b => ({
              ...b,
              allocation_rules: { ...b.allocation_rules, deficit: kinds.map(k => ({ kind: k })) },
            }))}
          />
        </Section>
      </div>
    </Drawer>
  );
}

function WaterfallList({
  items, options, onChange,
}: { items: string[]; options: string[]; onChange: (next: string[]) => void }) {
  const moveUp   = (i: number) => i > 0 && onChange([...items.slice(0, i - 1), items[i]!, items[i - 1]!, ...items.slice(i + 1)]);
  const moveDown = (i: number) => i < items.length - 1 && onChange([...items.slice(0, i), items[i + 1]!, items[i]!, ...items.slice(i + 2)]);
  const remove   = (i: number) => onChange(items.filter((_, j) => j !== i));
  const add      = (kind: string) => !items.includes(kind) && onChange([...items, kind]);
  const remaining = options.filter(o => !items.includes(o));
  return (
    <div className="space-y-1">
      {items.map((k, i) => (
        <div key={k} className="flex items-center gap-2 bg-bg-elevated/40 rounded px-2 py-1">
          <span className="flex-1 text-sm font-mono">{i + 1}. {k}</span>
          <Button size="sm" variant="ghost" onClick={() => moveUp(i)} disabled={i === 0}>↑</Button>
          <Button size="sm" variant="ghost" onClick={() => moveDown(i)} disabled={i === items.length - 1}>↓</Button>
          <Button size="sm" variant="danger" onClick={() => remove(i)}><Trash2 className="w-3.5 h-3.5" /></Button>
        </div>
      ))}
      {remaining.length > 0 && (
        <Select value="" onChange={e => { if (e.target.value) add(e.target.value); }}>
          <option value="">+ Add step</option>
          {remaining.map(o => <option key={o} value={o}>{o}</option>)}
        </Select>
      )}
    </div>
  );
}

// ── Results drawer ──────────────────────────────────────────────────────────

interface SnapshotPeriodRow {
  period_date: string;
  period_type: "month" | "year";
  gross_income: number; total_expenses: number;
  net_cash_pretax: number; estimated_tax: number; net_cash_aftertax: number;
  total_asset_value: number; total_liability_value: number; net_worth: number;
  account_balances_json: Record<string, number>;
}

interface SnapshotFlagRow {
  period_date: string; flag_type: string; description: string;
  severity: "info" | "warning" | "critical";
}

interface RothProposal {
  year: number; conversion_amount: number;
  current_marginal_rate: number; projected_rmd_rate: number;
  tax_cost_now: number; npv_savings: number; net_benefit: number;
  rationale: string;
}

interface Pass2Diff {
  period_date: string;
  pass1_action: string; pass2_action: string;
  net_worth_impact: number; rationale: string;
}

interface SnapshotResultsJson {
  pass2_diffs?: Pass2Diff[];
  improvement?: number;
  roth_proposals?: RothProposal[];
  end_state_net_worth?: number;
}

function ScenarioResultsDrawer({
  scenario, onClose,
}: {
  scenario: ScenarioListItem;
  onClose: () => void;
}) {
  const [periods, setPeriods] = useState<SnapshotPeriodRow[]>([]);
  const [flags, setFlags] = useState<SnapshotFlagRow[]>([]);
  const [snapshotMeta, setSnapshotMeta] = useState<{ pass: number; results_json: SnapshotResultsJson } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!scenario.latest_snapshot_id) return;
    setLoading(true);
    try {
      const res = await api.get<{
        periods: SnapshotPeriodRow[]; flags: SnapshotFlagRow[];
        snapshot: { pass: number; results_json: SnapshotResultsJson };
      }>(`/api/web/scenarios/${scenario.id}/snapshots/${scenario.latest_snapshot_id}`);
      setPeriods(res.periods);
      setFlags(res.flags);
      setSnapshotMeta(res.snapshot);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [scenario]);

  const acceptRoth = async (proposal: RothProposal) => {
    try {
      await api.post(`/api/web/scenarios/${scenario.id}/roth-proposals/accept`, {
        year: proposal.year, conversion_amount: proposal.conversion_amount,
      });
      toast.success(`Added Roth conversion to plan for ${proposal.year}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { void load(); }, [load]);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <Drawer open onClose={onClose} title={`Results: ${scenario.name}`}>
      <div className="space-y-4">
        <div className="text-xs text-text-muted">
          {scenario.start_date} → {scenario.end_date} • {periods.length} periods • {flags.length} flags
        </div>

        {loading
          ? <EmptyState>Loading…</EmptyState>
          : periods.length === 0
            ? <EmptyState>No results yet — run the scenario.</EmptyState>
            : (
              <>
                <Card className="p-3">
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={periods}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="period_date" tick={{ fontSize: 10 }} stroke="#64748B" />
                        <YAxis tickFormatter={v => fmtUsd(v as number)} tick={{ fontSize: 10 }} stroke="#64748B" width={80} />
                        <Tooltip formatter={(v: number) => fmtUsd(v)} contentStyle={{ fontSize: 12 }} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Line type="monotone" dataKey="net_worth" name="Net worth" stroke="#0F172A" strokeWidth={3} dot={false} isAnimationActive={false} />
                        <Line type="monotone" dataKey="total_asset_value" name="Assets" stroke="#059669" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                        <Line type="monotone" dataKey="total_liability_value" name="Liabilities" stroke="#DC2626" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                        {periods.find(p => p.period_date >= today) && (
                          <ReferenceLine x={today} stroke="#94A3B8" strokeDasharray="3 3" label={{ value: "Today", fontSize: 10 }} />
                        )}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </Card>

                <Section title="Annual summary">
                  <div className="max-h-72 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="text-text-muted uppercase tracking-wide bg-bg-elevated sticky top-0">
                        <tr>
                          <th className="text-left px-2 py-1">Period</th>
                          <th className="text-right px-2 py-1">Income</th>
                          <th className="text-right px-2 py-1">Expenses</th>
                          <th className="text-right px-2 py-1">Tax</th>
                          <th className="text-right px-2 py-1">Net</th>
                          <th className="text-right px-2 py-1">Net worth</th>
                        </tr>
                      </thead>
                      <tbody>
                        {periods.map(p => (
                          <tr key={p.period_date} className="border-t border-border">
                            <td className="px-2 py-1">{p.period_date}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(p.gross_income)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(p.total_expenses)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(p.estimated_tax)}</td>
                            <td className={"px-2 py-1 text-right tabular-nums " + (p.net_cash_aftertax >= 0 ? "text-accent-success" : "text-accent-danger")}>
                              {fmtUsd(p.net_cash_aftertax, { sign: true })}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums font-medium">{fmtUsd(p.net_worth)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Section>

                <Section title={`Flags (${flags.length})`}>
                  {flags.length === 0
                    ? <div className="text-xs text-text-muted">No flags.</div>
                    : (
                      <div className="space-y-1">
                        {flags.map((f, i) => (
                          <div key={i} className="flex items-center gap-2 text-sm">
                            <Badge tone={f.severity === "critical" ? "danger" : f.severity === "warning" ? "warn" : "neutral"}>
                              {f.flag_type}
                            </Badge>
                            <span className="text-xs text-text-muted">{f.period_date}</span>
                            <span className="text-xs">{f.description}</span>
                          </div>
                        ))}
                      </div>
                    )}
                </Section>

                {snapshotMeta && <OptimizationSummary snapshot={snapshotMeta} onAcceptRoth={acceptRoth} />}
              </>
            )}
      </div>
    </Drawer>
  );
}

function OptimizationSummary({
  snapshot, onAcceptRoth,
}: {
  snapshot: { pass: number; results_json: SnapshotResultsJson };
  onAcceptRoth: (proposal: RothProposal) => Promise<void>;
}) {
  const r = snapshot.results_json;
  const diffs = r.pass2_diffs ?? [];
  const proposals = r.roth_proposals ?? [];
  const improvement = r.improvement ?? 0;
  if (snapshot.pass === 1 && diffs.length === 0 && proposals.length === 0) return null;
  return (
    <Section title="Optimization">
      {snapshot.pass === 2 && (
        <div className="text-sm bg-bg-elevated/40 rounded p-2">
          Pass 2 optimization improved end-state net worth by <span className={"font-semibold tabular-nums " + (improvement >= 0 ? "text-accent-success" : "text-accent-danger")}>{fmtUsd(improvement, { sign: true })}</span>.
        </div>
      )}

      {diffs.length > 0 && (
        <div>
          <div className="text-xs text-text-muted mb-1">{diffs.length} allocation change{diffs.length !== 1 ? "s" : ""}</div>
          <table className="w-full text-xs">
            <thead className="text-text-muted uppercase tracking-wide bg-bg-elevated">
              <tr>
                <th className="text-left px-2 py-1">Year</th>
                <th className="text-left px-2 py-1">Pass 1</th>
                <th className="text-left px-2 py-1">Pass 2</th>
                <th className="text-right px-2 py-1">Δ NW</th>
              </tr>
            </thead>
            <tbody>
              {diffs.slice(0, 10).map((d, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-2 py-1">{d.period_date.slice(0, 7)}</td>
                  <td className="px-2 py-1 text-xs">{d.pass1_action}</td>
                  <td className="px-2 py-1 text-xs">{d.pass2_action}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(d.net_worth_impact, { sign: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {proposals.length > 0 && (
        <div>
          <div className="text-xs text-text-muted mb-1">{proposals.length} Roth conversion proposal{proposals.length !== 1 ? "s" : ""}</div>
          <table className="w-full text-xs">
            <thead className="text-text-muted uppercase tracking-wide bg-bg-elevated">
              <tr>
                <th className="text-left px-2 py-1">Year</th>
                <th className="text-right px-2 py-1">Convert</th>
                <th className="text-right px-2 py-1">Tax cost now</th>
                <th className="text-right px-2 py-1">NPV savings</th>
                <th className="text-right px-2 py-1">Net</th>
                <th className="text-left px-2 py-1">Rate now → RMD</th>
                <th className="text-right px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-2 py-1">{p.year}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(p.conversion_amount)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(p.tax_cost_now)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(p.npv_savings)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-accent-success font-medium">{fmtUsd(p.net_benefit, { sign: true })}</td>
                  <td className="px-2 py-1">{(p.current_marginal_rate * 100).toFixed(1)}% → {(p.projected_rmd_rate * 100).toFixed(1)}%</td>
                  <td className="px-2 py-1 text-right">
                    <Button size="sm" variant="primary" onClick={() => void onAcceptRoth(p)}>Accept</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ── Tax & Profile tab ───────────────────────────────────────────────────────

interface ProfileRow {
  id: string;
  name: string;
  role: string;
  date_of_birth: string;
  expected_retirement_date: string | null;
}

interface StateTimelineEntry { id?: string; state: string; effective_date: string }

interface TaxBracketRow {
  id: string;
  year: number;
  filing_status: string;
  jurisdiction: string;
  brackets_json: Array<{ floor: number; ceiling: number | null; rate: number }>;
  standard_deduction: number | null;
}

interface DeductionRow {
  id: string;
  type: "salt" | "charitable" | "mortgage_interest" | "other";
  label: string | null;
  annual_amount: number;
  effective_date: string;
  source: string;
}

function TaxProfileTab() {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [timeline, setTimeline] = useState<StateTimelineEntry[]>([]);
  const [brackets, setBrackets] = useState<TaxBracketRow[]>([]);
  const [deductions, setDeductions] = useState<DeductionRow[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [pr, tl, br, dd] = await Promise.all([
        api.get<{ profiles: ProfileRow[] }>("/api/web/profiles").then(r => r.profiles),
        api.get<{ entries: StateTimelineEntry[] }>("/api/web/state-timeline").then(r => r.entries),
        api.get<{ brackets: TaxBracketRow[] }>("/api/web/tax-brackets").then(r => r.brackets),
        api.get<{ deductions: DeductionRow[] }>("/api/web/deductions").then(r => r.deductions),
      ]);
      setProfiles(pr);
      setTimeline(tl);
      setBrackets(br);
      setDeductions(dd);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const updateProfile = async (id: string, patch: Partial<ProfileRow>) => {
    try {
      await api.put(`/api/web/profiles/${id}`, patch);
      setProfiles(p => p.map(x => x.id === id ? { ...x, ...patch } : x));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const saveTimeline = async () => {
    try {
      await api.put("/api/web/state-timeline", { entries: timeline });
      toast.success("State timeline saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const saveDeductions = async () => {
    try {
      await api.put("/api/web/deductions", { entries: deductions });
      toast.success("Deductions saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-3">User profiles</div>
        {profiles.length === 0
          ? <EmptyState>{loading ? "Loading…" : "No profiles"}</EmptyState>
          : (
            <div className="space-y-3">
              {profiles.map(p => (
                <div key={p.id} className="flex items-center gap-3 text-sm">
                  <div className="font-medium w-20">{p.name}</div>
                  <div className="text-xs text-text-muted w-14">{p.role}</div>
                  <label className="text-xs text-text-muted">DOB</label>
                  <Input type="date" value={p.date_of_birth} onChange={e => void updateProfile(p.id, { date_of_birth: e.target.value })} />
                  <label className="text-xs text-text-muted">Retire</label>
                  <Input type="date" value={p.expected_retirement_date ?? ""}
                    onChange={e => void updateProfile(p.id, { expected_retirement_date: e.target.value || null })} />
                </div>
              ))}
            </div>
          )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">State residence timeline</div>
          <Button size="sm" variant="primary" onClick={() => void saveTimeline()}><Save className="w-3.5 h-3.5" /> Save</Button>
        </div>
        <div className="space-y-2">
          {timeline.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={t.state}
                onChange={e => setTimeline(tl => tl.map((x, j) => j === i ? { ...x, state: e.target.value } : x))}
                className="w-16"
              />
              <Input
                type="date" value={t.effective_date}
                onChange={e => setTimeline(tl => tl.map((x, j) => j === i ? { ...x, effective_date: e.target.value } : x))}
              />
              <Button size="sm" variant="danger" onClick={() => setTimeline(tl => tl.filter((_, j) => j !== i))}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
          <Button size="sm" onClick={() => setTimeline(tl => [...tl, { state: "", effective_date: new Date().toISOString().slice(0, 10) }])}>
            <Plus className="w-3.5 h-3.5" /> Add entry
          </Button>
        </div>
      </Card>

      <Card className="p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-3">Tax brackets</div>
        <table className="w-full text-xs">
          <thead className="text-text-muted uppercase tracking-wide bg-bg-elevated">
            <tr>
              <th className="text-left px-2 py-1">Year</th>
              <th className="text-left px-2 py-1">Filing</th>
              <th className="text-left px-2 py-1">Jurisdiction</th>
              <th className="text-right px-2 py-1">Std deduction</th>
              <th className="text-left px-2 py-1">Bracket count</th>
              <th className="text-left px-2 py-1">Source</th>
            </tr>
          </thead>
          <tbody>
            {brackets.map(b => (
              <tr key={b.id} className="border-t border-border">
                <td className="px-2 py-1">{b.year}</td>
                <td className="px-2 py-1">{b.filing_status}</td>
                <td className="px-2 py-1">{b.jurisdiction}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {b.standard_deduction != null ? fmtUsd(b.standard_deduction) : "—"}
                </td>
                <td className="px-2 py-1">{b.brackets_json?.length ?? 0}</td>
                <td className="px-2 py-1 text-text-muted">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">Deductions</div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setDeductions(d => [...d, {
              id: "", type: "charitable", label: "", annual_amount: 0,
              effective_date: new Date().toISOString().slice(0, 10), source: "manual",
            }])}><Plus className="w-3.5 h-3.5" /> Add</Button>
            <Button size="sm" variant="primary" onClick={() => void saveDeductions()}>
              <Save className="w-3.5 h-3.5" /> Save
            </Button>
          </div>
        </div>
        {deductions.length === 0
          ? <div className="text-xs text-text-muted">No deductions configured.</div>
          : (
            <div className="space-y-2">
              {deductions.map((d, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <Select value={d.type} onChange={e => setDeductions(arr => arr.map((x, j) => j === i ? { ...x, type: e.target.value as DeductionRow["type"] } : x))}>
                    <option value="salt">SALT</option>
                    <option value="charitable">Charitable</option>
                    <option value="mortgage_interest">Mortgage interest</option>
                    <option value="other">Other</option>
                  </Select>
                  <Input
                    placeholder="Label"
                    value={d.label ?? ""}
                    onChange={e => setDeductions(arr => arr.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                  />
                  <Input
                    type="number" step="100"
                    value={d.annual_amount}
                    onChange={e => setDeductions(arr => arr.map((x, j) => j === i ? { ...x, annual_amount: Number(e.target.value) } : x))}
                    className="w-32 text-right tabular-nums"
                  />
                  <Input
                    type="date" value={d.effective_date}
                    onChange={e => setDeductions(arr => arr.map((x, j) => j === i ? { ...x, effective_date: e.target.value } : x))}
                  />
                  <Button size="sm" variant="danger" onClick={() => setDeductions(arr => arr.filter((_, j) => j !== i))}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
      </Card>
    </div>
  );
}

// ── Scenario comparison drawer ──────────────────────────────────────────────

function ScenarioComparisonDrawer({
  scenarios, onClose,
}: {
  scenarios: ScenarioListItem[];
  onClose: () => void;
}) {
  const [aId, setAId] = useState<string>(scenarios[0]?.id ?? "");
  const [bId, setBId] = useState<string>(scenarios[1]?.id ?? scenarios[0]?.id ?? "");
  const [aData, setADData] = useState<SnapshotPeriodRow[]>([]);
  const [bData, setBData] = useState<SnapshotPeriodRow[]>([]);
  const [loading, setLoading] = useState(false);

  const a = scenarios.find(s => s.id === aId);
  const b = scenarios.find(s => s.id === bId);

  const load = useCallback(async () => {
    if (!a?.latest_snapshot_id || !b?.latest_snapshot_id) return;
    setLoading(true);
    try {
      const [resA, resB] = await Promise.all([
        api.get<{ periods: SnapshotPeriodRow[] }>(`/api/web/scenarios/${a.id}/snapshots/${a.latest_snapshot_id}`),
        api.get<{ periods: SnapshotPeriodRow[] }>(`/api/web/scenarios/${b.id}/snapshots/${b.latest_snapshot_id}`),
      ]);
      setADData(resA.periods);
      setBData(resB.periods);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [a, b]);

  useEffect(() => { void load(); }, [load]);

  // Merge on period_date; both sides are typically yearly.
  const merged = useMemo(() => {
    const byDate = new Map<string, { date: string; a?: number; b?: number }>();
    for (const r of aData) byDate.set(r.period_date, { date: r.period_date, a: r.net_worth });
    for (const r of bData) {
      const existing = byDate.get(r.period_date);
      if (existing) existing.b = r.net_worth;
      else byDate.set(r.period_date, { date: r.period_date, b: r.net_worth });
    }
    return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
  }, [aData, bData]);

  // Identify divergence point: first row where |b - a| > 25_000.
  const divergence = merged.find(r => r.a != null && r.b != null && Math.abs((r.b - r.a)) > 25000);

  return (
    <Drawer open onClose={onClose} title="Compare scenarios">
      <div className="space-y-4">
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-xs text-text-muted mb-1">Scenario A (solid)</label>
            <Select value={aId} onChange={e => setAId(e.target.value)}>
              {scenarios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
          <div className="flex-1">
            <label className="block text-xs text-text-muted mb-1">Scenario B (dashed)</label>
            <Select value={bId} onChange={e => setBId(e.target.value)}>
              {scenarios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
        </div>

        {loading
          ? <EmptyState>Loading…</EmptyState>
          : merged.length === 0
            ? <EmptyState>No overlapping periods.</EmptyState>
            : (
              <>
                <Card className="p-3">
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={merged}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="#64748B" />
                        <YAxis tickFormatter={v => fmtUsd(v as number)} tick={{ fontSize: 10 }} stroke="#64748B" width={80} />
                        <Tooltip formatter={(v: number) => fmtUsd(v)} contentStyle={{ fontSize: 12 }} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Line type="monotone" dataKey="a" name={a?.name ?? "A"} stroke="#4F46E5" strokeWidth={2} dot={false} isAnimationActive={false} />
                        <Line type="monotone" dataKey="b" name={b?.name ?? "B"} stroke="#059669" strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
                        {divergence && (
                          <ReferenceLine x={divergence.date} stroke="#D97706" strokeDasharray="3 3" label={{ value: "Diverges", fontSize: 10, fill: "#D97706" }} />
                        )}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </Card>

                {divergence && (
                  <div className="text-sm bg-accent-warn/10 border border-accent-warn/30 rounded p-2">
                    Scenarios diverge significantly in <span className="font-medium">{divergence.date.slice(0, 4)}</span> — net worth gap exceeds $25K.
                  </div>
                )}

                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="text-text-muted uppercase tracking-wide bg-bg-elevated sticky top-0">
                      <tr>
                        <th className="text-left px-2 py-1">Year</th>
                        <th className="text-right px-2 py-1">NW (A)</th>
                        <th className="text-right px-2 py-1">NW (B)</th>
                        <th className="text-right px-2 py-1">Δ (B − A)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {merged.map(r => {
                        const delta = r.a != null && r.b != null ? r.b - r.a : null;
                        const big = delta != null && Math.abs(delta) > 50000;
                        return (
                          <tr key={r.date} className={"border-t border-border " + (big ? "bg-accent-warn/5" : "")}>
                            <td className="px-2 py-1">{r.date.slice(0, 7)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{r.a != null ? fmtUsd(r.a) : "—"}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{r.b != null ? fmtUsd(r.b) : "—"}</td>
                            <td className={"px-2 py-1 text-right tabular-nums " + (delta != null && delta >= 0 ? "text-accent-success" : delta != null ? "text-accent-danger" : "")}>
                              {delta != null ? fmtUsd(delta, { sign: true }) : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
      </div>
    </Drawer>
  );
}

// ── Sell-on-date modal ──────────────────────────────────────────────────────

interface SaleCalcResult {
  estimated_market_value: number;
  cost_basis: number;
  total_gain: number;
  depreciation_recapture_gain: number;
  capital_gain: number;
  estimated_recapture_tax: number;
  estimated_capital_gains_tax: number;
  section_121_exclusion: number;
  estimated_net_proceeds: number;
  assumptions: string[];
}

export function SellOnDateModal({
  account, open, onClose,
}: {
  account: ScenarioAccount | null;
  open: boolean;
  onClose: () => void;
}) {
  const inFiveYears = new Date(); inFiveYears.setUTCFullYear(inFiveYears.getUTCFullYear() + 5);
  const [saleDate, setSaleDate] = useState(inFiveYears.toISOString().slice(0, 10));
  const [otherIncome, setOtherIncome] = useState("0");
  const [result, setResult] = useState<SaleCalcResult | null>(null);
  const [busy, setBusy] = useState(false);

  const compute = async () => {
    if (!account) return;
    setBusy(true);
    try {
      const res = await api.post<SaleCalcResult>(`/api/web/scenario-accounts/${account.id}/sale-calc`, {
        sale_date: saleDate,
        other_taxable_income: Number(otherIncome) || 0,
        primary_residence_years_used: 2,
      });
      setResult(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Sell on date: ${account?.name ?? ""}`} width="max-w-xl">
      <div className="space-y-4">
        <div className="flex gap-2 items-end">
          <Field label="Sale date">
            <Input type="date" value={saleDate} onChange={e => setSaleDate(e.target.value)} />
          </Field>
          <Field label="Other taxable income (year)">
            <Input type="number" step="1000" value={otherIncome} onChange={e => setOtherIncome(e.target.value)} className="w-40" />
          </Field>
          <Button variant="primary" onClick={() => void compute()} disabled={busy}>
            <RefreshCw className={"w-4 h-4 " + (busy ? "animate-spin" : "")} /> Calculate
          </Button>
        </div>
        {result && (
          <div className="space-y-2 text-sm">
            <Row label="Estimated market value" value={fmtUsd(result.estimated_market_value)} />
            <Row label="Cost basis"             value={fmtUsd(result.cost_basis)} />
            <Row label="Total gain"             value={fmtUsd(result.total_gain)} />
            {result.depreciation_recapture_gain > 0 && (
              <Row label="Depreciation recapture gain" value={fmtUsd(result.depreciation_recapture_gain)} />
            )}
            {result.section_121_exclusion > 0 && (
              <Row label="§121 exclusion" value={`− ${fmtUsd(result.section_121_exclusion)}`} />
            )}
            <Row label="Capital gain (taxable)"  value={fmtUsd(result.capital_gain)} />
            {result.estimated_recapture_tax > 0 && (
              <Row label="Recapture tax (25%)" value={`− ${fmtUsd(result.estimated_recapture_tax)}`} />
            )}
            <Row label="Federal LTCG tax"       value={`− ${fmtUsd(result.estimated_capital_gains_tax)}`} />
            <div className="border-t border-border pt-2 flex justify-between font-semibold">
              <span>Estimated net proceeds</span>
              <span className="tabular-nums text-accent-success">{fmtUsd(result.estimated_net_proceeds)}</span>
            </div>
            <div className="pt-2 space-y-0.5">
              {result.assumptions.map((a, i) => (
                <div key={i} className="text-xs text-text-muted">• {a}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-text-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
