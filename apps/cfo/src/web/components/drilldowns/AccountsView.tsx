import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Building2 } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Select, Input, PageHeader, EmptyState,
} from "../ui";
import {
  listAccounts, updateAccount,
  getBankConfig, startBankConnect, completeBankConnect, bankSync,
  getTaxYearWorkflow, createTaxYearWorkflow,
} from "../../api";
import type { Account, BankConfig, TaxYearWorkflow } from "../../types";

// owner_tag is a polymorphic column today: legacy used it for entity
// purpose ("coaching_business", "airbnb_activity", "family_personal");
// SMS routing reuses the same column for ownership ("jeremy", "elyse").
// We expose all values so the user can pick whatever fits — the
// dropdown's subtitle explains the impact.
const OWNER_TAG_OPTIONS = [
  { value: "",                  label: "— Unassigned —" },
  { value: "jeremy",            label: "Jeremy (SMS routing)" },
  { value: "elyse",             label: "Elyse (SMS routing)" },
  { value: "coaching_business", label: "Coaching (legacy)" },
  { value: "airbnb_activity",   label: "Whitford House (legacy)" },
  { value: "family_personal",   label: "Family (legacy)" },
];

export function AccountsView() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [config, setConfig] = useState<BankConfig | null>(null);
  const [workflow, setWorkflow] = useState<TaxYearWorkflow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Load ───────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [a, c, w] = await Promise.all([listAccounts(), getBankConfig(), getTaxYearWorkflow()]);
      setAccounts(a.accounts);
      setConfig(c);
      setWorkflow(w);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // ── Tax year ───────────────────────────────────────────────────────────
  const [newYear, setNewYear] = useState<string>(() => String(new Date().getFullYear() - 1));
  const onCreateTaxYear = useCallback(async () => {
    const yr = parseInt(newYear, 10);
    if (!yr || yr < 2000 || yr > 2100) {
      toast.error("Tax year must be between 2000 and 2100");
      return;
    }
    if (!confirm(`Start the ${yr} tax year? This makes it the active workflow.`)) return;
    setBusy(true);
    try {
      await createTaxYearWorkflow({ tax_year: yr });
      toast.success(`Tax year ${yr} started`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [newYear, refresh]);

  // ── Connect bank (Teller) ──────────────────────────────────────────────
  const onConnect = useCallback(async () => {
    setBusy(true);
    try {
      const cfg = await startBankConnect("teller");
      await loadTellerScript();
      const win = window as unknown as { TellerConnect: { setup(opts: Record<string, unknown>): { open(): void } } };
      const handler = win.TellerConnect.setup({
        applicationId: cfg.application_id,
        environment: cfg.environment,
        products: cfg.products,
        selectAccount: cfg.select_account,
        onSuccess: async (enrollment: Record<string, unknown>) => {
          try {
            const accessToken = (enrollment.accessToken ?? (enrollment as Record<string, Record<string, unknown>>).enrollment?.accessToken) as string | undefined;
            const enrollmentObj = (enrollment.enrollment ?? {}) as Record<string, unknown>;
            const enrollmentId = (enrollmentObj.id ?? enrollment.enrollmentId) as string | undefined;
            const institutionObj = (enrollmentObj.institution ?? enrollment.institution ?? {}) as Record<string, unknown>;
            if (!accessToken || !enrollmentId) {
              throw new Error("Teller returned an unexpected enrollment payload");
            }
            const res = await completeBankConnect({
              provider: "teller",
              access_token: accessToken,
              enrollment_id: enrollmentId,
              institution_name: institutionObj.name ?? null,
              institution_id: institutionObj.id ?? null,
            });
            toast.success(`Connected ${res.accounts_linked} account${res.accounts_linked !== 1 ? "s" : ""} from ${res.institution ?? "your bank"}`);
            await refresh();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
          }
        },
        onExit: () => {},
        onFailure: (failure: { message?: string }) => {
          if (failure?.message) toast.error(failure.message);
        },
      });
      handler.open();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  // ── Sync (loops over teller accounts one at a time) ────────────────────
  const tellerAccounts = useMemo(
    () => (accounts ?? []).filter((a) => (a.provider === "teller" || a.teller_account_id) && a.is_active === 1),
    [accounts],
  );

  const onSync = useCallback(async () => {
    if (!workflow?.workflow) {
      toast.error("Create a tax year first");
      return;
    }
    if (tellerAccounts.length === 0) {
      toast.error("No active Teller accounts to sync");
      return;
    }
    setBusy(true);
    let totalImported = 0;
    let totalDupes = 0;
    let synced = 0;
    try {
      for (let i = 0; i < tellerAccounts.length; i++) {
        const acc = tellerAccounts[i]!;
        toast.message(`Syncing ${i + 1} of ${tellerAccounts.length}…`, { description: acc.name });
        const r = await bankSync({ provider: "teller", account_ids: [acc.id] });
        totalImported += r.transactions_imported ?? 0;
        totalDupes += r.duplicates_skipped ?? 0;
        synced += (r.account_ids_synced ?? []).length;
      }
      toast.success(`Imported ${totalImported}, ${totalDupes} duplicates skipped, ${synced} accounts`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [workflow, tellerAccounts, refresh]);

  // ── Owner-tag edit ─────────────────────────────────────────────────────
  const onTagChange = useCallback(async (id: string, value: string) => {
    try {
      await updateAccount(id, { owner_tag: value || null });
      // Optimistic update without a re-fetch.
      setAccounts((prev) => (prev ?? []).map((a) => a.id === id ? { ...a, owner_tag: value || null } : a));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const onRemove = useCallback(async (id: string, name: string) => {
    if (!confirm(`Remove ${name}? Existing transactions stay; the account just stops syncing.`)) return;
    try {
      await updateAccount(id, { is_active: 0 });
      toast.success("Account removed");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Accounts"
        subtitle="Connect banks, set per-account ownership, sync the active tax year."
        actions={
          <>
            <Button variant="primary" onClick={onConnect} disabled={busy}>
              <Plus className="w-4 h-4" /> Connect bank
            </Button>
            <Button variant="success" onClick={onSync} disabled={busy || tellerAccounts.length === 0 || !workflow?.workflow}>
              <RefreshCw className={"w-4 h-4 " + (busy ? "animate-spin" : "")} /> Sync tax year
            </Button>
            <Button onClick={() => void refresh()}><RefreshCw className="w-4 h-4" /></Button>
          </>
        }
      />

      {error && (
        <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">{error}</Card>
      )}

      {/* Tax year */}
      <div className="grid grid-cols-3 gap-4 mb-5">
        <Card className="p-4">
          <div className="text-xs text-text-muted">Active tax year</div>
          <div className="text-2xl font-semibold mt-0.5">{workflow?.workflow?.tax_year ?? "—"}</div>
          <div className="text-xs text-text-muted mt-2">
            {workflow?.workflow ? `Started ${new Date(workflow.workflow.started_at).toLocaleDateString()}` : "Create a tax year to start syncing."}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-text-muted">Connected accounts</div>
          <div className="text-2xl font-semibold mt-0.5">{accounts?.length ?? "—"}</div>
          <div className="text-xs text-text-muted mt-2">{tellerAccounts.length} Teller · {(accounts?.length ?? 0) - tellerAccounts.length} other</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-text-muted">Provider</div>
          <div className="text-2xl font-semibold mt-0.5 capitalize">{config?.current_provider ?? "—"}</div>
          <div className="text-xs text-text-muted mt-2">{config?.environment ?? ""}</div>
        </Card>
      </div>

      <Card className="p-4 mb-5">
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs text-text-muted mb-1">Create new tax year</label>
            <Input
              type="number"
              min={2000} max={2100}
              value={newYear}
              onChange={(e) => setNewYear(e.target.value)}
              className="w-32"
            />
          </div>
          <Button variant="primary" onClick={onCreateTaxYear} disabled={busy}>Start fresh year</Button>
          <p className="text-xs text-text-muted mt-1">Resets the year checklist; existing data is preserved.</p>
        </div>
      </Card>

      {/* Accounts list */}
      <Card className="overflow-hidden">
        <div className="px-5 py-3 border-b border-border">
          <div className="font-semibold text-text-primary flex items-center gap-2">
            <Building2 className="w-4 h-4 text-accent-primary" /> Connected accounts
          </div>
          <div className="text-xs text-text-muted mt-0.5">Includes linked banks and any manual CSV-only accounts.</div>
        </div>
        {accounts === null ? (
          <EmptyState>Loading…</EmptyState>
        ) : accounts.length === 0 ? (
          <EmptyState>No accounts yet — connect a bank to start.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border bg-bg-elevated">
                  <th className="pl-5 py-2">Institution</th>
                  <th>Account</th>
                  <th>Type</th>
                  <th>Mask</th>
                  <th>Owner / purpose</th>
                  <th className="pr-5"></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} className="border-b border-border last:border-b-0">
                    <td className="pl-5 py-2.5">
                      <div className="font-medium text-text-primary">{a.institution_name ?? "—"}</div>
                      <div className="text-xs text-text-subtle uppercase">{a.provider ?? "—"}</div>
                    </td>
                    <td>{a.name}</td>
                    <td className="text-text-muted capitalize">{a.subtype ?? a.type ?? "—"}</td>
                    <td className="text-text-muted">••{a.mask ?? "—"}</td>
                    <td>
                      <Select
                        value={a.owner_tag ?? ""}
                        onChange={(e) => void onTagChange(a.id, e.target.value)}
                        className="w-56 text-xs"
                      >
                        {OWNER_TAG_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </Select>
                    </td>
                    <td className="pr-5">
                      <Button size="sm" variant="ghost" onClick={() => void onRemove(a.id, a.name)}>Remove</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// Lazy Teller SDK loader.
function loadTellerScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as unknown as { TellerConnect?: unknown }).TellerConnect) return resolve();
    const s = document.createElement("script");
    s.src = "https://cdn.teller.io/connect/connect.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load Teller Connect SDK"));
    document.head.appendChild(s);
  });
}

