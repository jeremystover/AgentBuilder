import { useRef, useState } from "react";
import { FileUp, RefreshCw, Trash2, Upload, ShoppingCart, Database } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Badge, Select, PageHeader, EmptyState, humanizeSlug,
} from "../ui";
import { useImports } from "../../hooks/useImports";
import { useAccounts } from "../../hooks/useAccounts";
import {
  importCsv, importAmazon, importTiller, deleteImport, deleteAllImports,
} from "../../api";
import type {
  ImportRecord, ImportStatus,
  CsvImportResult, AmazonImportResult, TillerImportResult,
} from "../../types";

type AnyResult =
  | ({ kind: "csv" } & CsvImportResult)
  | ({ kind: "amazon" } & AmazonImportResult)
  | ({ kind: "tiller" } & TillerImportResult);

export function ImportsView() {
  const { imports, loading, error, refresh } = useImports();
  const { accounts } = useAccounts();
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<AnyResult | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this import and all its transactions?\n\nLocked transactions will be skipped.")) return;
    setBusy(true);
    try {
      const r = await deleteImport(id);
      toast.success(
        `Deleted ${r.transactions_deleted} transaction${r.transactions_deleted !== 1 ? "s" : ""}` +
        (r.locked_transactions_skipped ? ` (${r.locked_transactions_skipped} locked, skipped)` : ""),
      );
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteAll = async () => {
    if (imports.length === 0) return;
    if (!confirm(
      `Delete ALL imported transactions (${imports.length} import${imports.length !== 1 ? "s" : ""})?\n\n` +
      `Locked transactions will be skipped. This cannot be undone.`,
    )) return;
    setBusy(true);
    try {
      const r = await deleteAllImports();
      toast.success(
        `Deleted ${r.transactions_deleted} transaction${r.transactions_deleted !== 1 ? "s" : ""} ` +
        `from ${r.imports_deleted ?? 0} import${r.imports_deleted !== 1 ? "s" : ""}` +
        (r.locked_transactions_skipped ? ` (${r.locked_transactions_skipped} locked, skipped)` : ""),
      );
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onUploaded = async (result: AnyResult) => {
    setLastResult(result);
    await refresh();
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="Imports"
        subtitle={
          loading ? "Loading…" :
          imports.length === 0 ? "No imports yet" :
          `${imports.length} recent import${imports.length !== 1 ? "s" : ""}`
        }
        actions={
          <>
            <Button variant="danger" onClick={() => void handleDeleteAll()} disabled={busy || imports.length === 0}>
              <Trash2 className="w-4 h-4" /> Delete all
            </Button>
            <Button onClick={() => void refresh()} title="Refresh">
              <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
            </Button>
          </>
        }
      />

      {error && (
        <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">
          {error}
        </Card>
      )}

      {/* Upload cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <CsvUploader
          accounts={accounts}
          busy={busy}
          setBusy={setBusy}
          onUploaded={onUploaded}
        />
        <AmazonUploader busy={busy} setBusy={setBusy} onUploaded={onUploaded} />
        <TillerUploader busy={busy} setBusy={setBusy} onUploaded={onUploaded} />
      </div>

      {lastResult && <ResultPanel result={lastResult} onDismiss={() => setLastResult(null)} />}

      {/* History table */}
      <h2 className="text-sm font-semibold text-text-primary mb-2 mt-6">History</h2>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border bg-bg-elevated">
                <th className="pl-4 py-2">When</th>
                <th>Source</th>
                <th>Account</th>
                <th className="text-right">Found</th>
                <th className="text-right">Imported</th>
                <th>Status</th>
                <th className="pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {imports.length === 0 ? (
                <tr><td colSpan={7}><EmptyState>{loading ? "Loading…" : "No imports yet — use the uploaders above."}</EmptyState></td></tr>
              ) : imports.map((imp) => (
                <ImportRow
                  key={imp.id}
                  imp={imp}
                  busy={busy}
                  onDelete={() => void handleDelete(imp.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── Upload cards ────────────────────────────────────────────────────────────

function UploadCard({
  icon, title, subtitle, children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {icon}
        <div>
          <div className="text-sm font-semibold text-text-primary">{title}</div>
          <div className="text-xs text-text-muted">{subtitle}</div>
        </div>
      </div>
      {children}
    </Card>
  );
}

function CsvUploader({
  accounts, busy, setBusy, onUploaded,
}: {
  accounts: ReturnType<typeof useAccounts>["accounts"];
  busy: boolean;
  setBusy(b: boolean): void;
  onUploaded(r: AnyResult): Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<"auto" | "generic" | "venmo" | "chase" | "amex" | "bofa">("auto");
  const [accountId, setAccountId] = useState("");

  const onPick = async (file: File) => {
    setBusy(true);
    try {
      const r = await importCsv({ file, format, account_id: accountId || undefined });
      toast.success(`Imported ${r.transactions_imported} (${r.duplicates_skipped} dupes)`);
      await onUploaded({ kind: "csv", ...r });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <UploadCard
      icon={<FileUp className="w-5 h-5 text-accent-primary" />}
      title="Generic CSV"
      subtitle="Bank/card export. Auto-detects Chase, Amex, Venmo, BofA."
    >
      <div>
        <label className="block text-xs text-text-muted mb-1">Format</label>
        <Select value={format} onChange={(e) => setFormat(e.target.value as typeof format)} className="w-full">
          <option value="auto">Auto-detect</option>
          <option value="generic">Generic (date, amount, description)</option>
          <option value="chase">Chase</option>
          <option value="amex">American Express</option>
          <option value="venmo">Venmo</option>
          <option value="bofa">Bank of America</option>
        </Select>
      </div>
      <div>
        <label className="block text-xs text-text-muted mb-1">Account (optional)</label>
        <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-full">
          <option value="">— none (manual rows) —</option>
          {accounts.filter((a) => a.is_active).map((a) => (
            <option key={a.id} value={a.id}>
              {a.institution_name ? `${a.institution_name} · ` : ""}{a.name}
            </option>
          ))}
        </Select>
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
      <Button variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
        <Upload className="w-4 h-4" /> Choose CSV
      </Button>
    </UploadCard>
  );
}

function AmazonUploader({
  busy, setBusy, onUploaded,
}: {
  busy: boolean;
  setBusy(b: boolean): void;
  onUploaded(r: AnyResult): Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  const onPick = async (file: File) => {
    setBusy(true);
    try {
      const r = await importAmazon(file);
      toast.success(
        `Imported ${r.amazon_orders_imported} orders, matched ${r.transactions_matched}, ` +
        `reclassified ${r.transactions_reclassified}`,
      );
      await onUploaded({ kind: "amazon", ...r });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <UploadCard
      icon={<ShoppingCart className="w-5 h-5 text-accent-warn" />}
      title="Amazon orders"
      subtitle="Order history CSV. Matched against existing transactions."
    >
      <div className="text-xs text-text-muted">
        Use Amazon's "Download order reports" export. Headers must include order id, dates, totals, products.
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
      <Button variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
        <Upload className="w-4 h-4" /> Choose Amazon CSV
      </Button>
    </UploadCard>
  );
}

function TillerUploader({
  busy, setBusy, onUploaded,
}: {
  busy: boolean;
  setBusy(b: boolean): void;
  onUploaded(r: AnyResult): Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  const onPick = async (file: File) => {
    setBusy(true);
    try {
      const r = await importTiller(file);
      toast.success(
        `Imported ${r.transactions_imported} pre-classified transactions, ` +
        `learned ${r.learned_rules_created} rule${r.learned_rules_created !== 1 ? "s" : ""}`,
      );
      await onUploaded({ kind: "tiller", ...r });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <UploadCard
      icon={<Database className="w-5 h-5 text-accent-success" />}
      title="Tiller export"
      subtitle="History from Tiller Money. Imports labels and learns rules."
    >
      <div className="text-xs text-text-muted">
        Columns: date, description, category, amount, (optional) full_description, account.
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
      <Button variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
        <Upload className="w-4 h-4" /> Choose Tiller CSV
      </Button>
    </UploadCard>
  );
}

// ── Result panel ────────────────────────────────────────────────────────────

function ResultPanel({ result, onDismiss }: { result: AnyResult; onDismiss(): void }) {
  return (
    <Card className="p-4 mb-4 border-accent-primary/40 bg-accent-primary/5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="text-sm font-semibold text-text-primary mb-2">
            {result.kind === "csv" && `CSV import — detected ${result.format}`}
            {result.kind === "amazon" && "Amazon import"}
            {result.kind === "tiller" && "Tiller import"}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            {result.kind === "csv" && (
              <>
                <Stat label="Rows parsed" value={result.rows_parsed} />
                <Stat label="Imported" value={result.transactions_imported} />
                <Stat label="Duplicates" value={result.duplicates_skipped} />
                <Stat label="Errors" value={result.errors.length} />
              </>
            )}
            {result.kind === "amazon" && (
              <>
                <Stat label="Rows parsed" value={result.rows_parsed} />
                <Stat label="Orders imported" value={result.amazon_orders_imported} />
                <Stat label="Tx matched" value={result.transactions_matched} />
                <Stat label="Reclassified" value={result.transactions_reclassified} />
              </>
            )}
            {result.kind === "tiller" && (
              <>
                <Stat label="Rows" value={result.total_rows} />
                <Stat label="Imported" value={result.transactions_imported} />
                <Stat label="Duplicates" value={result.duplicates_skipped} />
                <Stat label="Rules learned" value={result.learned_rules_created} />
              </>
            )}
          </div>

          {result.kind === "csv" && result.errors.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold text-text-muted mb-1">Errors (first 10)</div>
              <ul className="text-xs text-accent-danger space-y-0.5">
                {result.errors.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
            </div>
          )}

          {result.kind === "tiller" && result.unmapped_categories.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold text-text-muted mb-1">
                Unmapped Tiller categories — these rows were skipped
              </div>
              <div className="flex flex-wrap gap-1.5">
                {result.unmapped_categories.map((c) => (
                  <Badge key={c} tone="warn">{c}</Badge>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 text-xs text-text-muted">{result.message}</div>
        </div>
        <button
          className="text-text-muted hover:text-text-primary text-xs"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div className="text-lg tabular-nums text-text-primary">{value.toLocaleString()}</div>
    </div>
  );
}

// ── History row ─────────────────────────────────────────────────────────────

const SOURCE_TONE: Record<string, "info" | "ok" | "warn" | "neutral"> = {
  teller: "info",
  csv: "neutral",
  amazon: "warn",
  manual: "neutral",
  plaid: "info",
};

const STATUS_TONE: Record<ImportStatus, "ok" | "warn" | "danger" | "neutral"> = {
  completed: "ok",
  running: "warn",
  pending: "warn",
  failed: "danger",
};

function ImportRow({
  imp, busy, onDelete,
}: {
  imp: ImportRecord;
  busy: boolean;
  onDelete(): void;
}) {
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-bg-elevated/50">
      <td className="pl-4 py-2.5 text-text-muted whitespace-nowrap text-xs">
        {imp.completed_at ?? imp.created_at}
      </td>
      <td>
        <Badge tone={SOURCE_TONE[imp.source] ?? "neutral"}>{humanizeSlug(imp.source)}</Badge>
      </td>
      <td className="text-text-muted truncate max-w-[16rem]">
        {imp.account_name ?? <span className="text-text-subtle italic">—</span>}
      </td>
      <td className="text-right tabular-nums text-text-muted">{imp.transactions_found.toLocaleString()}</td>
      <td className="text-right tabular-nums text-text-primary">{imp.transactions_imported.toLocaleString()}</td>
      <td>
        <Badge tone={STATUS_TONE[imp.status]}>{imp.status}</Badge>
        {imp.error_message && (
          <div className="text-xs text-accent-danger mt-0.5 truncate max-w-[16rem]" title={imp.error_message}>
            {imp.error_message}
          </div>
        )}
      </td>
      <td className="pr-4">
        <Button size="sm" variant="danger" onClick={onDelete} disabled={busy}>
          <Trash2 className="w-3 h-3" />
        </Button>
      </td>
    </tr>
  );
}
