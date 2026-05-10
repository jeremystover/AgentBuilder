import { useState } from "react";
import { Plus, RefreshCw, Sparkles, Building2, CreditCard } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Badge, Select, PageHeader, EmptyState, humanizeSlug } from "../ui";
import { useAccounts } from "../../hooks/useAccounts";
import {
  startBankConnect, completeBankConnect, bankSync, updateAccount, runClassification,
} from "../../api";
import type { Account } from "../../types";

// ── Teller Connect ambient type ─────────────────────────────────────────────
interface TellerEnrollment {
  accessToken: string;
  enrollment: { id: string; institution: { name: string; id: string } };
  user: { id: string };
}

interface TellerConnectInstance {
  open(): void;
  destroy(): void;
}

interface TellerConnectSetup {
  applicationId: string;
  environment: string;
  products: string[];
  selectAccount: string;
  onSuccess(enrollment: TellerEnrollment): void;
  onExit?(): void;
}

declare global {
  interface Window {
    TellerConnect?: { setup(opts: TellerConnectSetup): TellerConnectInstance };
  }
}

function loadTellerConnectScript(): Promise<NonNullable<typeof window.TellerConnect>> {
  if (window.TellerConnect) return Promise.resolve(window.TellerConnect);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.teller.io/connect/connect.js";
    script.onload = () => {
      if (window.TellerConnect) resolve(window.TellerConnect);
      else reject(new Error("TellerConnect not available after script load"));
    };
    script.onerror = () => reject(new Error("Failed to load Teller Connect script"));
    document.head.appendChild(script);
  });
}

// ── Main view ───────────────────────────────────────────────────────────────

export function AccountsView() {
  const { accounts, config, loading, error, refresh } = useAccounts();
  const [busy, setBusy] = useState(false);

  const tellerConfigured = config?.providers.teller.configured ?? false;
  const isSandbox = config?.providers.teller.sandbox_shortcut ?? false;

  // Group accounts by institution
  const groups = groupByInstitution(accounts);

  const handleConnect = async () => {
    setBusy(true);
    let connectCfg: Awaited<ReturnType<typeof startBankConnect>>;
    try {
      connectCfg = await startBankConnect();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    setBusy(false);

    let tc: NonNullable<typeof window.TellerConnect>;
    try {
      tc = await loadTellerConnectScript();
    } catch {
      toast.error("Could not load Teller Connect widget. Check your network and try again.");
      return;
    }

    const instance = tc.setup({
      applicationId: connectCfg.application_id,
      environment: connectCfg.environment,
      products: connectCfg.products,
      selectAccount: connectCfg.select_account,
      onSuccess: async (enrollment) => {
        setBusy(true);
        try {
          const result = await completeBankConnect({
            access_token: enrollment.accessToken,
            enrollment_id: enrollment.enrollment.id,
            institution_name: enrollment.enrollment.institution.name ?? null,
            institution_id: enrollment.enrollment.institution.id ?? null,
          });
          toast.success(
            `Connected ${result.institution ?? "bank"} — ${result.accounts_linked} account${result.accounts_linked !== 1 ? "s" : ""} linked`,
          );
          await refresh();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      },
      onExit: () => {},
    });
    instance.open();
  };

  const handleSyncAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await bankSync();
      toast.success(`Sync complete — ${result.transactions_imported} new, ${result.duplicates_skipped} dupes skipped`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleSyncGroup = async (accountIds: string[]) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await bankSync(accountIds);
      toast.success(`Synced — ${result.transactions_imported} new`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleClassify = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await runClassification();
      toast.success(`Classified ${r.total ?? 0}: rules ${r.rules ?? 0}, AI ${r.ai ?? 0}, review ${r.review_required ?? 0}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        title="Accounts"
        subtitle={
          loading ? "Loading…" :
          accounts.length === 0 ? "No accounts connected" :
          `${accounts.length} account${accounts.length !== 1 ? "s" : ""} across ${groups.length} institution${groups.length !== 1 ? "s" : ""}`
        }
        actions={
          <>
            <Button onClick={handleClassify} disabled={busy || accounts.length === 0}>
              <Sparkles className="w-4 h-4" /> Classify
            </Button>
            <Button onClick={handleSyncAll} disabled={busy || accounts.length === 0}>
              <RefreshCw className={"w-4 h-4 " + (busy ? "animate-spin" : "")} /> Sync all
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleConnect()}
              disabled={busy || !tellerConfigured}
              title={!tellerConfigured ? "TELLER_APPLICATION_ID is not configured" : undefined}
            >
              <Plus className="w-4 h-4" /> Connect a bank
            </Button>
          </>
        }
      />

      {isSandbox && (
        <Card className="p-3 mb-4 border-accent-warn/40 bg-accent-warn/5 text-sm text-accent-warn">
          Teller is running in <strong>sandbox</strong> mode — use test credentials, not real bank logins.
        </Card>
      )}

      {error && (
        <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">
          {error}
        </Card>
      )}

      {!loading && accounts.length === 0 && (
        <Card className="p-10 text-center">
          <Building2 className="w-10 h-10 mx-auto mb-3 text-text-subtle" />
          <p className="text-text-muted text-sm mb-4">No accounts connected yet.</p>
          <Button
            variant="primary"
            onClick={() => void handleConnect()}
            disabled={busy || !tellerConfigured}
          >
            <Plus className="w-4 h-4" /> Connect your first bank
          </Button>
        </Card>
      )}

      {groups.map((group) => (
        <InstitutionCard
          key={group.institution}
          group={group}
          busy={busy}
          onSync={() => void handleSyncGroup(group.accounts.map((a) => a.id))}
          onUpdate={refresh}
        />
      ))}
    </div>
  );
}

// ── Institution card ────────────────────────────────────────────────────────

interface AccountGroup {
  institution: string;
  accounts: Account[];
}

function groupByInstitution(accounts: Account[]): AccountGroup[] {
  const map = new Map<string, Account[]>();
  for (const a of accounts) {
    const key = a.institution_name ?? "Manual / unknown";
    const arr = map.get(key) ?? [];
    arr.push(a);
    map.set(key, arr);
  }
  return Array.from(map.entries()).map(([institution, accs]) => ({ institution, accounts: accs }));
}

function InstitutionCard({
  group, busy, onSync, onUpdate,
}: {
  group: AccountGroup;
  busy: boolean;
  onSync(): void;
  onUpdate(): Promise<void>;
}) {
  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-elevated">
        <div className="flex items-center gap-2">
          <Building2 className="w-4 h-4 text-text-muted" />
          <span className="font-medium text-text-primary text-sm">{group.institution}</span>
          <span className="text-xs text-text-muted">({group.accounts.length})</span>
        </div>
        <Button size="sm" onClick={onSync} disabled={busy}>
          <RefreshCw className="w-3 h-3" /> Sync
        </Button>
      </div>
      <div className="divide-y divide-border">
        {group.accounts.map((account) => (
          <AccountRow key={account.id} account={account} busy={busy} onUpdate={onUpdate} />
        ))}
      </div>
    </Card>
  );
}

// ── Account row ─────────────────────────────────────────────────────────────

const ENTITY_OPTIONS = [
  { value: "", label: "— none —" },
  { value: "elyse_coaching", label: "Elyse's Coaching" },
  { value: "jeremy_coaching", label: "Jeremy's Coaching" },
  { value: "airbnb_activity", label: "Whitford House" },
  { value: "family_personal", label: "Family / Personal" },
];

const ENTITY_LABELS: Record<string, string> = {
  elyse_coaching: "Elyse's Coaching",
  jeremy_coaching: "Jeremy's Coaching",
  airbnb_activity: "Whitford House",
  family_personal: "Family / Personal",
};

function AccountRow({
  account, busy, onUpdate,
}: {
  account: Account;
  busy: boolean;
  onUpdate(): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [ownerTag, setOwnerTag] = useState(account.owner_tag ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateAccount(account.id, {
        name: name !== account.name ? name : undefined,
        owner_tag: ownerTag !== (account.owner_tag ?? "") ? (ownerTag || null) : undefined,
      });
      toast.success("Account updated");
      setEditing(false);
      await onUpdate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async () => {
    if (!confirm(`Deactivate "${account.name}"? It will be hidden and excluded from future syncs.`)) return;
    setSaving(true);
    try {
      await updateAccount(account.id, { is_active: false });
      toast.success("Account deactivated");
      await onUpdate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const typeBadgeTone = account.type === "depository" ? "ok" :
    account.type === "credit" ? "warn" : "neutral";

  return (
    <div className="px-4 py-3 flex items-center gap-4 flex-wrap">
      <CreditCard className="w-4 h-4 text-text-subtle flex-none" />

      {/* Name / edit */}
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            className="rounded-md border border-border bg-bg-surface px-2 py-1 text-sm w-full focus:outline-none focus:ring-1 focus:ring-accent-primary"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        ) : (
          <div className="text-sm font-medium text-text-primary truncate">{account.name}</div>
        )}
        <div className="text-xs text-text-muted mt-0.5">
          {account.mask ? `····${account.mask}` : null}
          {account.mask && account.subtype ? " · " : null}
          {account.subtype ? humanizeSlug(account.subtype) : null}
        </div>
      </div>

      {/* Type badge */}
      <Badge tone={typeBadgeTone}>{humanizeSlug(account.type)}</Badge>

      {/* Owner tag */}
      {editing ? (
        <Select
          value={ownerTag}
          onChange={(e) => setOwnerTag(e.target.value)}
          className="w-40"
        >
          {ENTITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
      ) : (
        <span className="text-xs text-text-muted w-28 text-right">
          {account.owner_tag
            ? (ENTITY_LABELS[account.owner_tag] ?? account.owner_tag)
            : <span className="italic">no owner</span>}
        </span>
      )}

      {/* Actions */}
      {editing ? (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="primary" onClick={() => void handleSave()} disabled={saving}>Save</Button>
          <Button size="sm" onClick={() => { setEditing(false); setName(account.name); setOwnerTag(account.owner_tag ?? ""); }}>Cancel</Button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <Button size="sm" onClick={() => setEditing(true)} disabled={busy || saving}>Edit</Button>
          <Button size="sm" variant="danger" onClick={() => void handleDeactivate()} disabled={busy || saving}>Remove</Button>
        </div>
      )}
    </div>
  );
}
