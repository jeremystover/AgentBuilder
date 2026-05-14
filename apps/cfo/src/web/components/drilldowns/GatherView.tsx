import { useEffect, useState } from "react";
import { RefreshCw, AlertCircle, CheckCircle } from "lucide-react";
import { toast } from "sonner";
import { api, type GatherStatus, type AccountRow, type Entity } from "../../api";
import { Card, Button, Badge, Select, PageHeader, EmptyState } from "../ui";

const STALE_HOURS = 36;

function ageHours(iso: string | null): number | null {
  if (!iso) return null;
  return (Date.now() - Date.parse(iso)) / (1000 * 60 * 60);
}

function formatTime(iso: string | null): string {
  if (!iso) return "Never";
  const ms = Date.parse(iso);
  return new Date(ms).toLocaleString();
}

export function GatherView() {
  const [status, setStatus] = useState<GatherStatus | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const [busySource, setBusySource] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [s, accts, ents] = await Promise.all([
        api.get<GatherStatus>("/api/web/gather/status"),
        api.get<{ accounts: AccountRow[] }>("/api/web/accounts").then(r => r.accounts),
        api.get<{ entities: Entity[] }>("/api/web/entities").then(r => r.entities),
      ]);
      setStatus(s);
      setAccounts(accts);
      setEntities(ents);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const updateAccount = async (id: string, body: Partial<{ entity_id: string | null; is_active: boolean }>) => {
    try {
      await api.put(`/api/web/accounts/${id}`, body);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const runSync = async (source: string) => {
    setBusySource(source);
    try {
      await api.post(`/api/web/gather/sync/${source}`);
      toast.success(`Sync started: ${source}`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusySource(null);
    }
  };

  const allSynced = (status?.recent_log ?? []).slice(0, 5).every(r => r.status === "completed" || r.status === "running");

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Gather"
        subtitle="Connection health, accounts, sync schedule"
        actions={<Button onClick={() => void refresh()} disabled={loading}><RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} /> Refresh</Button>}
      />

      {/* Connection Health Banner */}
      <Card className={`p-4 mb-5 ${allSynced ? "border-accent-success/30 bg-accent-success/5" : "border-accent-warn/30 bg-accent-warn/5"}`}>
        <div className="flex items-center gap-3">
          {allSynced
            ? <CheckCircle className="w-5 h-5 text-accent-success" />
            : <AlertCircle className="w-5 h-5 text-accent-warn" />}
          <div className="text-sm">
            <div className="font-semibold">
              {allSynced ? "All sources synced" : "Some sources need attention"}
            </div>
            <div className="text-text-muted">
              Last 5 runs:{" "}
              {(status?.recent_log ?? []).slice(0, 5).map(r => r.source).join(", ") || "none"}
            </div>
          </div>
        </div>
      </Card>

      {/* Accounts table */}
      <Card className="mb-5">
        <div className="px-4 py-3 border-b border-border font-semibold text-text-primary">Accounts</div>
        {accounts.length === 0
          ? <EmptyState>No accounts configured. Connect Teller to start.</EmptyState>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-text-muted bg-bg-elevated">
                  <tr>
                    <th className="px-4 py-2">Account</th>
                    <th className="px-4 py-2">Source</th>
                    <th className="px-4 py-2">Type</th>
                    <th className="px-4 py-2">Entity</th>
                    <th className="px-4 py-2">Last sync</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Active</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map(a => {
                    const hours = ageHours(a.last_synced_at);
                    const stale = hours !== null && hours > STALE_HOURS;
                    return (
                      <tr key={a.id} className="border-t border-border">
                        <td className="px-4 py-2">
                          <div className="font-medium">{a.name}</div>
                          <div className="text-xs text-text-muted">{a.institution ?? ""}</div>
                        </td>
                        <td className="px-4 py-2"><Badge tone="info">{a.source}</Badge></td>
                        <td className="px-4 py-2 capitalize text-text-muted">{a.type}</td>
                        <td className="px-4 py-2">
                          <Select
                            value={a.entity_id ?? ""}
                            onChange={e => void updateAccount(a.id, { entity_id: e.target.value || null })}
                          >
                            <option value="">— unassigned —</option>
                            {entities.map(ent => <option key={ent.id} value={ent.id}>{ent.name}</option>)}
                          </Select>
                        </td>
                        <td className="px-4 py-2 text-text-muted">{formatTime(a.last_synced_at)}</td>
                        <td className="px-4 py-2">
                          {stale
                            ? <Badge tone="warn">Stale</Badge>
                            : a.last_synced_at
                              ? <Badge tone="ok">Connected</Badge>
                              : <Badge tone="neutral">Never synced</Badge>}
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="checkbox"
                            checked={a.is_active}
                            onChange={e => void updateAccount(a.id, { is_active: e.target.checked })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </Card>

      {/* Email vendors */}
      <Card className="mb-5">
        <div className="px-4 py-3 border-b border-border font-semibold text-text-primary">Email enrichment</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-text-muted bg-bg-elevated">
              <tr>
                <th className="px-4 py-2">Vendor</th>
                <th className="px-4 py-2">Last processed</th>
                <th className="px-4 py-2">Parse failures</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(status?.email ?? []).map(v => (
                <tr key={v.vendor} className="border-t border-border">
                  <td className="px-4 py-2 capitalize font-medium">{v.vendor}</td>
                  <td className="px-4 py-2 text-text-muted">{formatTime(v.last_processed_at)}</td>
                  <td className="px-4 py-2">
                    {v.unresolved_failures > 0
                      ? <Badge tone="warn">{v.unresolved_failures}</Badge>
                      : <Badge tone="ok">0</Badge>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      onClick={() => void runSync(`email:${v.vendor}`)}
                      disabled={busySource === `email:${v.vendor}`}
                    >
                      {busySource === `email:${v.vendor}` ? "Running…" : "Run now"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Sync schedule */}
      <Card className="mb-5">
        <div className="px-4 py-3 border-b border-border font-semibold text-text-primary">Schedule</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-text-muted bg-bg-elevated">
              <tr>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Cron</th>
                <th className="px-4 py-2">Run now</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border">
                <td className="px-4 py-2 font-medium">Teller</td>
                <td className="px-4 py-2 text-text-muted">Daily at 9:00 UTC (~05:00 ET)</td>
                <td className="px-4 py-2">
                  <Button onClick={() => void runSync("teller")} disabled={busySource === "teller"}>
                    {busySource === "teller" ? "Running…" : "Run now"}
                  </Button>
                </td>
              </tr>
              <tr className="border-t border-border">
                <td className="px-4 py-2 font-medium">Email (all vendors)</td>
                <td className="px-4 py-2 text-text-muted">Daily at 9:00 UTC (after Teller)</td>
                <td className="px-4 py-2">
                  <Button onClick={() => void runSync("email")} disabled={busySource === "email"}>
                    {busySource === "email" ? "Running…" : "Run now"}
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      {/* Recent sync log */}
      <Card>
        <div className="px-4 py-3 border-b border-border font-semibold text-text-primary">Recent syncs</div>
        {(status?.recent_log ?? []).length === 0
          ? <EmptyState>No sync runs recorded.</EmptyState>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-text-muted bg-bg-elevated">
                  <tr>
                    <th className="px-4 py-2">Started</th>
                    <th className="px-4 py-2">Source</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Found</th>
                    <th className="px-4 py-2">New</th>
                    <th className="px-4 py-2">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {(status?.recent_log ?? []).map(r => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-4 py-2 text-text-muted">{formatTime(r.started_at)}</td>
                      <td className="px-4 py-2">{r.source}</td>
                      <td className="px-4 py-2">
                        {r.status === "completed" && <Badge tone="ok">completed</Badge>}
                        {r.status === "running" && <Badge tone="info">running</Badge>}
                        {r.status === "failed" && <Badge tone="danger">failed</Badge>}
                      </td>
                      <td className="px-4 py-2">{r.transactions_found}</td>
                      <td className="px-4 py-2">{r.transactions_new}</td>
                      <td className="px-4 py-2 text-xs text-accent-danger truncate max-w-xs">{r.error_message ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Card>
    </div>
  );
}
