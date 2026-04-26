import { useCallback, useEffect, useState } from "react";
import { Upload, Trash2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Select, Input, Badge, PageHeader, EmptyState } from "../ui";
import {
  listImports, deleteImport, deleteAllImports,
  importCsv, importAmazon, importTiller,
  listAccounts,
} from "../../api";
import type { Account } from "../../types";
import type { ImportRecord } from "../../api";

export function ImportsView() {
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [i, a] = await Promise.all([listImports(), listAccounts()]);
      setImports(i.imports);
      setAccounts(a.accounts);
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
        title="Imports"
        subtitle="CSV, Tiller, and Amazon order imports for the active tax year."
        actions={<Button onClick={() => void refresh()}><RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} /></Button>}
      />

      {error && <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">{error}</Card>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
        <CsvImportCard accounts={accounts} onDone={refresh} />
        <TillerImportCard onDone={refresh} />
        <AmazonImportCard onDone={refresh} />
      </div>

      <Card className="overflow-hidden">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <div>
            <div className="font-semibold text-text-primary">Import history</div>
            <div className="text-xs text-text-muted mt-0.5">Each row imports against the current tax year.</div>
          </div>
          {imports.length > 0 && (
            <Button variant="danger" size="sm" onClick={async () => {
              if (!confirm("Delete ALL imports + their transactions? Locked transactions are preserved.")) return;
              try {
                const r = await deleteAllImports();
                toast.success(`Deleted ${r.transactions_deleted} txns; ${r.locked_transactions_skipped} locked kept`);
                await refresh();
              } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
            }}>
              <Trash2 className="w-4 h-4" /> Delete all
            </Button>
          )}
        </div>
        {imports.length === 0 ? (
          <EmptyState>No imports yet. Upload a CSV to get started.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border bg-bg-elevated">
                <th className="pl-5 py-2">Source</th>
                <th>Account</th>
                <th>Period</th>
                <th>Imported</th>
                <th>Status</th>
                <th>Created</th>
                <th className="pr-5"></th>
              </tr>
            </thead>
            <tbody>
              {imports.map((imp) => (
                <tr key={imp.id} className="border-b border-border last:border-b-0">
                  <td className="pl-5 py-2.5 capitalize text-text-primary">{imp.source}</td>
                  <td className="text-text-muted">{accounts.find((a) => a.id === imp.account_id)?.name ?? imp.account_id ?? "—"}</td>
                  <td className="text-text-muted">{imp.date_from ?? "—"} → {imp.date_to ?? "—"}</td>
                  <td className="text-text-muted tabular-nums">{imp.transactions_imported} / {imp.transactions_found}</td>
                  <td>
                    <Badge tone={imp.status === "completed" ? "ok" : imp.status === "failed" ? "danger" : imp.status === "running" ? "warn" : "neutral"}>
                      {imp.status}
                    </Badge>
                  </td>
                  <td className="text-text-muted whitespace-nowrap">{imp.created_at.slice(0, 10)}</td>
                  <td className="pr-5">
                    <Button size="sm" variant="ghost" onClick={async () => {
                      if (!confirm(`Delete this ${imp.source} import?`)) return;
                      try {
                        const r = await deleteImport(imp.id);
                        toast.success(`Deleted ${r.transactions_deleted} txns; ${r.locked_transactions_skipped} locked kept`);
                        await refresh();
                      } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
                    }}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ── Per-source upload cards ──────────────────────────────────────────────

function CsvImportCard({ accounts, onDone }: { accounts: Account[]; onDone(): Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-2">
        <Upload className="w-4 h-4 text-accent-primary" />
        <div className="font-semibold text-text-primary">Bank CSV</div>
      </div>
      <p className="text-xs text-text-muted mb-3">Most banks export CSV with columns: Date, Description, Amount.</p>
      <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-full mb-2">
        <option value="">Pick an account…</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </Select>
      <Input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="w-full mb-3" />
      <Button
        variant="primary"
        disabled={busy || !file || !accountId}
        onClick={async () => {
          if (!file || !accountId) return;
          setBusy(true);
          try {
            const r = await importCsv(file, accountId);
            toast.success(`Imported ${r.transactions_imported}, ${r.duplicates_skipped} duplicates skipped`);
            setFile(null);
            await onDone();
          } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
          finally { setBusy(false); }
        }}
      >
        {busy ? "Uploading…" : "Upload CSV"}
      </Button>
    </Card>
  );
}

function TillerImportCard({ onDone }: { onDone(): Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-2">
        <Upload className="w-4 h-4 text-accent-primary" />
        <div className="font-semibold text-text-primary">Tiller</div>
      </div>
      <p className="text-xs text-text-muted mb-3">Export the Transactions sheet from your Tiller spreadsheet.</p>
      <Input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="w-full mb-3" />
      <Button
        variant="primary"
        disabled={busy || !file}
        onClick={async () => {
          if (!file) return;
          setBusy(true);
          try {
            const r = await importTiller(file);
            const u = r.unmapped_categories?.length ? ` (${r.unmapped_categories.length} unmapped categories went to family/other)` : "";
            toast.success(`Imported ${r.transactions_imported}${u}`);
            setFile(null);
            await onDone();
          } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
          finally { setBusy(false); }
        }}
      >
        {busy ? "Uploading…" : "Upload Tiller CSV"}
      </Button>
    </Card>
  );
}

function AmazonImportCard({ onDone }: { onDone(): Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-2">
        <Upload className="w-4 h-4 text-accent-primary" />
        <div className="font-semibold text-text-primary">Amazon orders</div>
      </div>
      <p className="text-xs text-text-muted mb-3">Order history export — used to enrich ambiguous Amazon transactions.</p>
      <Input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="w-full mb-3" />
      <Button
        variant="primary"
        disabled={busy || !file}
        onClick={async () => {
          if (!file) return;
          setBusy(true);
          try {
            const r = await importAmazon(file);
            toast.success(`Imported ${r.orders_imported} orders`);
            setFile(null);
            await onDone();
          } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
          finally { setBusy(false); }
        }}
      >
        {busy ? "Uploading…" : "Upload Amazon CSV"}
      </Button>
    </Card>
  );
}
