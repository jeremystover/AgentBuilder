import { useCallback, useEffect, useState } from "react";
import { Search, RefreshCw, Split, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Select, Input, Badge, Drawer, PageHeader, EmptyState, fmtUsd, humanizeSlug,
} from "../ui";
import {
  listTransactions, classifyTransaction, splitTransaction, listAccounts,
} from "../../api";
import type { SplitItem } from "../../api";
import type { Transaction, Account } from "../../types";
import { CATEGORY_OPTIONS, ENTITY_OPTIONS } from "../../catalog";

const PAGE_SIZE = 50;

export function TransactionsView() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters.
  const [accountId, setAccountId] = useState("");
  const [categoryTax, setCategoryTax] = useState("");
  const [entity, setEntity] = useState("");
  const [search, setSearch] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const [openTx, setOpenTx] = useState<Transaction | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listTransactions({
        limit: PAGE_SIZE, offset,
        ...(accountId ? { account_id: accountId } : {}),
        ...(categoryTax ? { category_tax: categoryTax } : {}),
        ...(entity ? { entity } : {}),
        ...(search ? { q: search } : {}),
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
      });
      setItems(res.transactions ?? []);
      setTotal(res.total ?? 0);
      // Snap back if filters narrowed past offset.
      if ((res.total ?? 0) > 0 && offset >= (res.total ?? 0)) {
        const last = Math.max(0, Math.floor((res.total - 1) / PAGE_SIZE) * PAGE_SIZE);
        if (last !== offset) setOffset(last);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [offset, accountId, categoryTax, entity, search, start, end]);

  useEffect(() => { setOffset(0); }, [accountId, categoryTax, entity, search, start, end]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Load accounts once for the filter dropdown.
  useEffect(() => {
    listAccounts().then((r) => setAccounts(r.accounts)).catch(() => {});
  }, []);

  // Handle drawer save (manual classify).
  const onSaveTx = useCallback(async (id: string, input: { entity: string; category_tax?: string; category_budget?: string }) => {
    try {
      await classifyTransaction(id, input);
      toast.success("Classification saved");
      setOpenTx(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Transactions"
        subtitle={loading ? "Loading…" : `${total} transaction${total !== 1 ? "s" : ""}`}
        actions={<Button onClick={() => void refresh()}><RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} /></Button>}
      />

      {error && <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">{error}</Card>}

      <Card className="p-4 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <div className="col-span-2 md:col-span-2">
            <label className="block text-xs text-text-muted mb-1">Search</label>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-2 top-2 text-text-subtle" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="merchant or description" className="w-full pl-7" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Account</label>
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-full">
              <option value="">All</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Entity</label>
            <Select value={entity} onChange={(e) => setEntity(e.target.value)} className="w-full">
              <option value="">All</option>
              {ENTITY_OPTIONS.map(({ slug, label }) => <option key={slug} value={slug}>{label}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Category</label>
            <Select value={categoryTax} onChange={(e) => setCategoryTax(e.target.value)} className="w-full">
              <option value="">All</option>
              {CATEGORY_OPTIONS.map(({ slug, label }) => <option key={slug} value={slug}>{label}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Start</label>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-full" />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">End</label>
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full" />
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border bg-bg-elevated">
                <th className="pl-4 py-2">Date</th>
                <th>Merchant</th>
                <th>Amount</th>
                <th>Account</th>
                <th>Entity</th>
                <th>Category</th>
                <th className="pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan={7}><EmptyState>No transactions match these filters.</EmptyState></td></tr>
              ) : items.map((tx) => (
                <tr key={tx.id} className="border-b border-border last:border-b-0 hover:bg-bg-elevated/50">
                  <td className="pl-4 py-2.5 text-text-muted whitespace-nowrap">{tx.posted_date}</td>
                  <td className="max-w-[24rem]">
                    <div className="text-text-primary truncate">{tx.merchant_name ?? tx.description ?? "—"}</div>
                    {tx.description && tx.merchant_name && (
                      <div className="text-xs text-text-subtle truncate">{tx.description}</div>
                    )}
                  </td>
                  <td className={`tabular-nums ${tx.amount < 0 ? "text-accent-danger" : "text-accent-success"}`}>
                    {fmtUsd(tx.amount, { sign: true })}
                  </td>
                  <td className="text-text-muted">{tx.account_name ?? "—"}</td>
                  <td>
                    {tx.classification?.entity ? <Badge tone="neutral">{humanizeSlug(tx.classification.entity)}</Badge> : <span className="text-text-subtle">—</span>}
                  </td>
                  <td>
                    {tx.classification?.category_tax ? <Badge tone="info">{humanizeSlug(tx.classification.category_tax)}</Badge> : <span className="text-text-subtle">—</span>}
                  </td>
                  <td className="pr-4"><Button size="sm" onClick={() => setOpenTx(tx)}>Edit</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="flex items-center justify-between mt-4 text-sm text-text-muted">
        <div>{total === 0 ? "" : `Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}</div>
        <div className="flex gap-1.5">
          <Button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>← Prev</Button>
          <Button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}>Next →</Button>
        </div>
      </div>

      <TransactionDrawer tx={openTx} onClose={() => setOpenTx(null)} onSave={onSaveTx} onAfterSplit={refresh} />
    </div>
  );
}

type DrawerMode = "classify" | "split";

function TransactionDrawer({
  tx, onClose, onSave, onAfterSplit,
}: {
  tx: Transaction | null;
  onClose(): void;
  onSave(id: string, input: { entity: string; category_tax?: string; category_budget?: string }): Promise<void>;
  onAfterSplit(): Promise<void>;
}) {
  const [mode, setMode] = useState<DrawerMode>("classify");
  const [entity, setEntity] = useState<string>(tx?.classification?.entity ?? "elyse_coaching");
  const [categoryTax, setCategoryTax] = useState<string>(tx?.classification?.category_tax ?? "");
  const [categoryBudget, setCategoryBudget] = useState<string>(tx?.classification?.category_budget ?? "");
  const [busy, setBusy] = useState(false);

  // Re-sync state when a different tx is opened.
  useEffect(() => {
    if (tx) {
      setMode("classify");
      setEntity(tx.classification?.entity ?? "elyse_coaching");
      setCategoryTax(tx.classification?.category_tax ?? "");
      setCategoryBudget(tx.classification?.category_budget ?? "");
    }
  }, [tx?.id]);

  if (!tx) return null;

  return (
    <Drawer
      open={!!tx}
      onClose={onClose}
      title={tx.merchant_name ?? tx.description ?? "Transaction"}
      footer={
        mode === "classify" ? (
          <div className="flex justify-between gap-2">
            <Button onClick={() => setMode("split")} disabled={busy}>
              <Split className="w-4 h-4" /> Split…
            </Button>
            <div className="flex gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button
                variant="primary"
                disabled={busy || !categoryTax}
                onClick={async () => {
                  setBusy(true);
                  try { await onSave(tx.id, { entity, category_tax: categoryTax, category_budget: categoryBudget || undefined }); }
                  finally { setBusy(false); }
                }}
              >
                Save classification
              </Button>
            </div>
          </div>
        ) : null
        // Split mode renders its own footer inside SplitForm (the
        // running-total + Save are tightly coupled to the row state).
      }
    >
      <dl className="grid grid-cols-2 gap-3 text-sm mb-4">
        <div><dt className="text-xs text-text-muted">Date</dt><dd className="text-text-primary">{tx.posted_date}</dd></div>
        <div><dt className="text-xs text-text-muted">Amount</dt><dd className={`text-text-primary tabular-nums ${tx.amount < 0 ? "text-accent-danger" : "text-accent-success"}`}>{fmtUsd(tx.amount, { sign: true })}</dd></div>
        <div><dt className="text-xs text-text-muted">Account</dt><dd className="text-text-primary">{tx.account_name ?? "—"}</dd></div>
        <div><dt className="text-xs text-text-muted">Currency</dt><dd className="text-text-primary">{tx.currency}</dd></div>
        <div className="col-span-2"><dt className="text-xs text-text-muted">Description</dt><dd className="text-text-primary">{tx.description ?? "—"}</dd></div>
      </dl>

      {mode === "classify" && (
        <ClassifyForm
          tx={tx}
          entity={entity} setEntity={setEntity}
          categoryTax={categoryTax} setCategoryTax={setCategoryTax}
          categoryBudget={categoryBudget} setCategoryBudget={setCategoryBudget}
        />
      )}

      {mode === "split" && (
        <SplitForm
          tx={tx}
          onCancel={() => setMode("classify")}
          onSubmitted={async () => {
            await onAfterSplit();
            onClose();
          }}
        />
      )}
    </Drawer>
  );
}

// ── Classify form ──────────────────────────────────────────────────────────

function ClassifyForm({
  tx,
  entity, setEntity,
  categoryTax, setCategoryTax,
  categoryBudget, setCategoryBudget,
}: {
  tx: Transaction;
  entity: string; setEntity(v: string): void;
  categoryTax: string; setCategoryTax(v: string): void;
  categoryBudget: string; setCategoryBudget(v: string): void;
}) {
  return (
    <>
      {tx.classification && (
        <div className="mb-4 text-xs text-text-muted">
          Current: {humanizeSlug(tx.classification.entity)} · {humanizeSlug(tx.classification.category_tax)} · {tx.classification.method ?? "—"} · {tx.classification.confidence != null ? `${Math.round(tx.classification.confidence * 100)}%` : "—"}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-text-muted mb-1">Entity</label>
          <Select value={entity} onChange={(e) => setEntity(e.target.value)} className="w-full">
            {ENTITY_OPTIONS.map(({ slug, label }) => <option key={slug} value={slug}>{label}</option>)}
          </Select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Tax category</label>
          <Select value={categoryTax} onChange={(e) => setCategoryTax(e.target.value)} className="w-full">
            <option value="">— select —</option>
            {CATEGORY_OPTIONS.map(({ slug, label }) => <option key={slug} value={slug}>{label}</option>)}
          </Select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Budget category (optional)</label>
          <Select value={categoryBudget} onChange={(e) => setCategoryBudget(e.target.value)} className="w-full">
            <option value="">— none —</option>
            {CATEGORY_OPTIONS.filter((c) => c.kind === "budget").map(({ slug, label }) => <option key={slug} value={slug}>{label}</option>)}
          </Select>
        </div>
      </div>
    </>
  );
}

// ── Split form ─────────────────────────────────────────────────────────────
// Server validates that the abs sum of all rows equals abs(tx.amount)
// within $0.02. We mirror that check in the UI so the Save button only
// enables on valid totals — and surface a running total + delta so the
// user can see how far off they are.

interface SplitDraft {
  amount: string;          // Stored as string so the user can type "1.5" mid-edit.
  entity: SplitItem["entity"];
  category_tax: string;
  note: string;
}

function emptyDraft(entity: SplitItem["entity"] = "family_personal"): SplitDraft {
  return { amount: "", entity, category_tax: "", note: "" };
}

function SplitForm({
  tx, onCancel, onSubmitted,
}: {
  tx: Transaction;
  onCancel(): void;
  onSubmitted(): Promise<void>;
}) {
  const target = Math.abs(tx.amount);
  const initialEntity: SplitItem["entity"] =
    (tx.classification?.entity as SplitItem["entity"]) ?? "family_personal";

  // Pre-seed two rows so the user has something to edit immediately.
  const [rows, setRows] = useState<SplitDraft[]>(() => [emptyDraft(initialEntity), emptyDraft(initialEntity)]);
  const [busy, setBusy] = useState(false);

  const totals = rows.reduce((acc, r) => {
    const n = parseFloat(r.amount);
    return acc + (Number.isFinite(n) ? Math.abs(n) : 0);
  }, 0);
  const delta = target - totals;
  const valid = Math.abs(delta) <= 0.02
    && rows.length >= 2
    && rows.every((r) => {
      const n = parseFloat(r.amount);
      return Number.isFinite(n) && n > 0 && r.entity;
    });

  const updateRow = (i: number, patch: Partial<SplitDraft>) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const addRow = () => setRows((prev) => [...prev, emptyDraft(initialEntity)]);
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, j) => j !== i));

  // Fill the last empty row with the remaining amount when the user hits
  // the convenience button.
  const fillRemaining = () => {
    const lastIdx = rows.findIndex((r, i) => i === rows.length - 1 && !parseFloat(r.amount));
    if (lastIdx < 0) {
      // No empty trailing row — append one with the remainder.
      setRows((prev) => [...prev, { ...emptyDraft(initialEntity), amount: delta > 0 ? delta.toFixed(2) : "" }]);
      return;
    }
    setRows((prev) => prev.map((r, i) =>
      i === lastIdx ? { ...r, amount: (delta > 0 ? delta : 0).toFixed(2) } : r,
    ));
  };

  const onSubmit = async () => {
    if (!valid) return;
    // The server expects amount with the same sign as the original tx
    // (negative for expenses). Reapply the sign on submit.
    const sign = tx.amount < 0 ? -1 : 1;
    const splits: SplitItem[] = rows.map((r) => ({
      entity: r.entity,
      category_tax: r.category_tax || undefined,
      amount: sign * Math.abs(parseFloat(r.amount)),
      note: r.note.trim() || undefined,
    }));
    setBusy(true);
    try {
      await splitTransaction(tx.id, splits);
      toast.success(`Split into ${splits.length} pieces`);
      await onSubmitted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-3 text-xs text-text-muted">
        Split this transaction across multiple entity/category buckets. Amounts must sum to {fmtUsd(target)} (sign reapplied automatically).
      </div>

      <div className="flex flex-col gap-2 mb-3">
        {rows.map((row, i) => (
          <SplitRow
            key={i}
            row={row}
            onChange={(patch) => updateRow(i, patch)}
            onRemove={rows.length > 2 ? () => removeRow(i) : undefined}
          />
        ))}
      </div>

      <div className="flex items-center justify-between mb-3 text-xs">
        <Button size="sm" onClick={addRow}>
          <Plus className="w-3.5 h-3.5" /> Add row
        </Button>
        <Button size="sm" onClick={fillRemaining} disabled={Math.abs(delta) < 0.005}>
          Fill remaining
        </Button>
      </div>

      {/* Running total */}
      <Card className={"p-3 mb-4 " + (Math.abs(delta) <= 0.02 ? "border-accent-success/40 bg-accent-success/5" : "border-accent-warn/40 bg-accent-warn/5")}>
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-muted">Total</span>
          <span className="tabular-nums font-medium">{fmtUsd(totals)} / {fmtUsd(target)}</span>
        </div>
        <div className="flex items-center justify-between text-xs mt-1">
          <span className="text-text-muted">Remaining</span>
          <span className={"tabular-nums " + (Math.abs(delta) <= 0.02 ? "text-accent-success" : "text-accent-warn")}>
            {delta > 0 ? "+" : ""}{fmtUsd(delta)}
          </span>
        </div>
      </Card>

      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Back</Button>
        <Button variant="primary" disabled={busy || !valid} onClick={() => void onSubmit()}>
          {busy ? "Saving…" : "Save split"}
        </Button>
      </div>
    </div>
  );
}

function SplitRow({
  row, onChange, onRemove,
}: {
  row: SplitDraft;
  onChange(patch: Partial<SplitDraft>): void;
  onRemove?: () => void;
}) {
  return (
    <Card className="p-3">
      <div className="grid grid-cols-12 gap-2 items-end">
        <div className="col-span-3">
          <label className="block text-[11px] text-text-muted mb-0.5">Amount</label>
          <Input
            type="number" step="0.01" min="0"
            value={row.amount}
            onChange={(e) => onChange({ amount: e.target.value })}
            className="w-full text-right tabular-nums"
            placeholder="0.00"
          />
        </div>
        <div className="col-span-4">
          <label className="block text-[11px] text-text-muted mb-0.5">Entity</label>
          <Select value={row.entity} onChange={(e) => onChange({ entity: e.target.value as SplitItem["entity"] })} className="w-full">
            {ENTITY_OPTIONS.map(({ slug, label }) => <option key={slug} value={slug}>{label}</option>)}
          </Select>
        </div>
        <div className="col-span-4">
          <label className="block text-[11px] text-text-muted mb-0.5">Tax category</label>
          <Select value={row.category_tax} onChange={(e) => onChange({ category_tax: e.target.value })} className="w-full">
            <option value="">—</option>
            {CATEGORY_OPTIONS.filter((c) => c.kind === "tax").map(({ slug, label }) => <option key={slug} value={slug}>{label}</option>)}
          </Select>
        </div>
        <div className="col-span-1 flex justify-end">
          {onRemove && (
            <Button size="sm" variant="ghost" onClick={onRemove} title="Remove">
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
        <div className="col-span-12">
          <label className="block text-[11px] text-text-muted mb-0.5">Note (optional)</label>
          <Input
            value={row.note}
            onChange={(e) => onChange({ note: e.target.value })}
            className="w-full"
            placeholder="why this slice?"
          />
        </div>
      </div>
    </Card>
  );
}
