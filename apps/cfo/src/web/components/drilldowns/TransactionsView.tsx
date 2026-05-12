import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, ChevronDown, ChevronUp, Lock, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { txAmountColor } from "../../utils/txColor";
import { toast } from "sonner";
import {
  Button, Card, Badge, Select, Input, Drawer, PageHeader, EmptyState, fmtUsd, humanizeSlug,
} from "../ui";
import { useTransactions } from "../../hooks/useTransactions";
import { useAccounts } from "../../hooks/useAccounts";
import { classifyTransaction, deleteTransaction, getTransaction, reclassifyWithAI, updateTransactionNote } from "../../api";
import type {
  EntitySlug, Transaction, TransactionDetail, CutStatus, ExpenseType,
} from "../../types";
import { ENTITY_OPTIONS, type OptionCategory } from "../../catalog";
import { useCategoryOptions } from "../../hooks/useCategoryOptions";
import { ProposeRuleModal, buildRuleProposal, type RuleProposal } from "../ProposeRuleModal";

const PAGE_SIZE = 100;

function SortTh({ col, label, sortBy, sortDir, onSort, className = "" }: {
  col: string; label: string; sortBy: string; sortDir: "asc" | "desc";
  onSort: (col: string) => void; className?: string;
}) {
  const active = sortBy === col;
  const Icon = active && sortDir === "asc" ? ChevronUp : ChevronDown;
  return (
    <th
      className={`cursor-pointer select-none hover:text-text-primary transition-colors ${className}`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        <Icon className={`w-3 h-3 ${active ? "opacity-100" : "opacity-25"}`} />
      </span>
    </th>
  );
}

interface FiltersState {
  date_from: string;
  date_to: string;
  account_id: string;
  entity: string;
  category_tax: string;
  review_only: boolean;
  unclassified_only: boolean;
  cut_status: "" | "flagged" | "complete" | "any" | "none";
}

const EMPTY_FILTERS: FiltersState = {
  date_from: "",
  date_to: "",
  account_id: "",
  entity: "",
  category_tax: "",
  review_only: false,
  unclassified_only: false,
  cut_status: "",
};

export function TransactionsView() {
  const { accounts } = useAccounts();
  const { budgetOptions, taxOptions, allOptions } = useCategoryOptions();
  const [filters, setFilters] = useState<FiltersState>(EMPTY_FILTERS);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortBy, setSortBy] = useState("posted_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [suggestRules, setSuggestRules] = useState(() => {
    try { return localStorage.getItem("cfo_suggest_rules") !== "false"; }
    catch { return true; }
  });
  const [pendingRuleProposal, setPendingRuleProposal] = useState<RuleProposal | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const apiFilters = useMemo(() => ({
    date_from: filters.date_from || undefined,
    date_to: filters.date_to || undefined,
    account_id: filters.account_id || undefined,
    entity: (filters.entity || undefined) as EntitySlug | undefined,
    category_tax: filters.category_tax || undefined,
    review_required: filters.review_only ? true : undefined,
    unclassified: filters.unclassified_only || undefined,
    cut_status: filters.cut_status || undefined,
    q: debouncedSearch || undefined,
    sort_by: sortBy,
    sort_dir: sortDir,
  }), [filters, debouncedSearch, sortBy, sortDir]);

  const { data, offset, setOffset, loading, error, refresh } = useTransactions({
    filters: apiFilters,
    pageSize: PAGE_SIZE,
  });

  const transactions = data?.transactions ?? [];
  const total = data?.total ?? 0;

  const [openId, setOpenId] = useState<string | null>(null);

  const updateFilter = <K extends keyof FiltersState>(key: K, value: FiltersState[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSearch("");
  };

  const onSort = (col: string) => {
    if (sortBy === col) {
      setSortDir((d) => d === "asc" ? "desc" : "asc");
    } else {
      setSortBy(col);
      setSortDir("desc");
    }
    setOffset(0);
  };

  const hasFilters =
    filters.date_from || filters.date_to || filters.account_id || filters.entity ||
    filters.category_tax || filters.review_only || filters.unclassified_only ||
    filters.cut_status || search;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Transactions"
        subtitle={
          loading ? "Loading…" :
          total === 0 ? "No transactions" :
          `${total.toLocaleString()} total${hasFilters ? " (filtered)" : ""}`
        }
        actions={
          <>
            {hasFilters && (
              <Button onClick={clearFilters}>Clear filters</Button>
            )}
            <label className="flex items-center gap-1.5 text-sm text-text-muted cursor-pointer select-none" title="After reclassifying, propose a rule for future transactions">
              <button
                role="switch"
                aria-checked={suggestRules}
                onClick={() => {
                  const next = !suggestRules;
                  setSuggestRules(next);
                  try { localStorage.setItem("cfo_suggest_rules", next ? "true" : "false"); } catch {}
                }}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${suggestRules ? "bg-accent-primary" : "bg-bg-elevated border border-border"}`}
              >
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${suggestRules ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
              Suggest rules
            </label>
            <Button onClick={() => void refresh()} title="Refresh">
              <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
            </Button>
          </>
        }
      />

      <Card className="p-4 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <div>
            <label className="block text-xs text-text-muted mb-1">From</label>
            <Input
              type="date"
              value={filters.date_from}
              onChange={(e) => updateFilter("date_from", e.target.value)}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">To</label>
            <Input
              type="date"
              value={filters.date_to}
              onChange={(e) => updateFilter("date_to", e.target.value)}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Account</label>
            <Select
              value={filters.account_id}
              onChange={(e) => updateFilter("account_id", e.target.value)}
              className="w-full"
            >
              <option value="">All accounts</option>
              {accounts.filter((a) => a.is_active).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.institution_name ? `${a.institution_name} · ` : ""}{a.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Entity</label>
            <Select
              value={filters.entity}
              onChange={(e) => updateFilter("entity", e.target.value)}
              className="w-full"
            >
              <option value="">All entities</option>
              {ENTITY_OPTIONS.map(({ slug, label }) => (
                <option key={slug} value={slug}>{label}</option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Category</label>
            <Select
              value={filters.category_tax}
              onChange={(e) => updateFilter("category_tax", e.target.value)}
              className="w-full"
            >
              <option value="">All categories</option>
              {allOptions.map(({ slug, label }) => (
                <option key={slug} value={slug}>{label}</option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Search</label>
            <Input
              type="text"
              placeholder="merchant or description"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full"
            />
          </div>
        </div>
        <div className="flex items-center gap-4 mt-3 text-xs text-text-muted flex-wrap">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={filters.review_only}
              onChange={(e) => updateFilter("review_only", e.target.checked)}
            />
            Needs review
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={filters.unclassified_only}
              onChange={(e) => updateFilter("unclassified_only", e.target.checked)}
            />
            Unclassified
          </label>
          <label className="flex items-center gap-1.5">
            <span>Cuts:</span>
            <Select
              value={filters.cut_status}
              onChange={(e) => updateFilter("cut_status", e.target.value as FiltersState["cut_status"])}
              className="text-xs py-1"
            >
              <option value="">All</option>
              <option value="any">Any flag</option>
              <option value="flagged">Flagged to cut</option>
              <option value="complete">Cut complete</option>
              <option value="none">Unflagged only</option>
            </Select>
          </label>
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
                <SortTh col="posted_date"   label="Date"     sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="pl-4 py-2" />
                <SortTh col="merchant_name" label="Merchant" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                <SortTh col="account_name"  label="Account"  sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                <SortTh col="amount"        label="Amount"   sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="text-right" />
                <th>Entity</th>
                <SortTh col="category_tax"  label="Category" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                <th>Method</th>
                <th className="pr-4">Conf.</th>
              </tr>
            </thead>
            <tbody>
              {transactions.length === 0 ? (
                <tr><td colSpan={8}><EmptyState>{loading ? "Loading…" : "No transactions match these filters."}</EmptyState></td></tr>
              ) : transactions.map((t) => (
                <TransactionRow key={t.id} tx={t} onOpen={() => setOpenId(t.id)} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="flex items-center justify-between mt-4 text-sm text-text-muted">
        <div>
          {total === 0 ? "" : `Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total.toLocaleString()}`}
        </div>
        <div className="flex gap-1.5">
          <Button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>← Prev</Button>
          <Button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}>Next →</Button>
        </div>
      </div>

      <TransactionDrawer
        txId={openId}
        budgetOptions={budgetOptions}
        taxOptions={taxOptions}
        onClose={() => setOpenId(null)}
        onChanged={refresh}
        onPropose={suggestRules ? (p) => setPendingRuleProposal(p) : undefined}
      />

      {pendingRuleProposal && (
        <ProposeRuleModal
          proposal={pendingRuleProposal}
          onDismiss={() => setPendingRuleProposal(null)}
          onSaved={() => { setPendingRuleProposal(null); void refresh(); }}
        />
      )}
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────

function TransactionRow({ tx, onOpen }: { tx: Transaction; onOpen(): void }) {
  const amtCls = txAmountColor(tx.amount ?? 0, tx.account_type ?? null, tx.category_tax ?? null);
  const confTone =
    tx.confidence == null ? "neutral" :
    tx.confidence >= 0.9 ? "ok" :
    tx.confidence >= 0.7 ? "warn" : "danger";

  return (
    <tr
      className="border-b border-border last:border-b-0 hover:bg-bg-elevated/50 cursor-pointer"
      onClick={onOpen}
    >
      <td className="pl-4 py-2.5 text-text-muted whitespace-nowrap">{tx.posted_date ?? "—"}</td>
      <td className="max-w-[20rem]">
        <div className="text-text-primary truncate flex items-center gap-1.5">
          {tx.is_locked ? <Lock className="w-3 h-3 text-text-subtle flex-none" /> : null}
          {tx.merchant_name ?? tx.description ?? "—"}
          {tx.cut_status === "flagged" && <Badge tone="warn">Flagged to cut</Badge>}
          {tx.cut_status === "complete" && <Badge tone="ok">Cut</Badge>}
        </div>
        {tx.description && tx.merchant_name && tx.description !== tx.merchant_name && (
          <div className="text-xs text-text-subtle truncate">{tx.description}</div>
        )}
      </td>
      <td className="text-text-muted truncate max-w-[10rem]">{tx.account_name ?? "—"}</td>
      <td className={`tabular-nums text-right ${amtCls}`}>{fmtUsd(tx.amount, { sign: true })}</td>
      <td>
        {tx.entity ? <Badge tone="info">{humanizeSlug(tx.entity)}</Badge> : <span className="text-text-subtle">—</span>}
      </td>
      <td>
        {tx.category_tax || tx.category_budget ? (
          <div className="flex flex-col gap-0.5">
            {tx.category_tax && <span className="text-text-primary">{humanizeSlug(tx.category_tax)}</span>}
            {tx.category_budget && <span className="text-text-muted italic text-xs">{humanizeSlug(tx.category_budget)}</span>}
          </div>
        ) : (
          <span className="text-text-subtle">—</span>
        )}
      </td>
      <td className="text-xs text-text-muted">{tx.method ?? "—"}</td>
      <td className="pr-4">
        {tx.confidence != null ? <Badge tone={confTone}>{Math.round(tx.confidence * 100)}%</Badge> : <span className="text-text-subtle">—</span>}
      </td>
    </tr>
  );
}

// ── Drawer ──────────────────────────────────────────────────────────────────

function TransactionDrawer({
  txId, budgetOptions, taxOptions, onClose, onChanged, onPropose,
}: {
  txId: string | null;
  budgetOptions: OptionCategory[];
  taxOptions: OptionCategory[];
  onClose(): void;
  onChanged(): Promise<void>;
  onPropose?: (proposal: RuleProposal) => void;
}) {
  const [detail, setDetail] = useState<TransactionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState(false);

  const [entity, setEntity] = useState<EntitySlug>("family_personal");
  const [categoryTax, setCategoryTax] = useState("");
  const [categoryBudget, setCategoryBudget] = useState("");
  const [expenseType, setExpenseType] = useState<ExpenseType | null>(null);
  const [cutStatus, setCutStatus] = useState<CutStatus | null>(null);
  const [note, setNote] = useState<string>("");

  useEffect(() => {
    if (!txId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    void (async () => {
      try {
        const d = await getTransaction(txId);
        if (cancelled) return;
        setDetail(d);
        setEntity((d.transaction.entity ?? "family_personal") as EntitySlug);
        setCategoryTax(d.transaction.category_tax ?? "");
        setCategoryBudget(d.transaction.category_budget ?? "");
        setExpenseType(d.transaction.expense_type ?? null);
        setCutStatus(d.transaction.cut_status ?? null);
        setNote(d.transaction.note ?? "");
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    })();
    return () => { cancelled = true; };
  }, [txId]);

  const handleSave = async () => {
    if (!detail) return;
    setBusy(true);
    const tx = detail.transaction;
    try {
      await classifyTransaction(tx.id, {
        entity,
        category_tax: categoryTax || undefined,
        category_budget: categoryBudget || undefined,
        expense_type: expenseType,
        cut_status: cutStatus,
        note,
      });
      toast.success("Reclassified");
      await onChanged();
      onClose();
      if (onPropose) {
        const proposal = buildRuleProposal({
          merchantName: tx.merchant_name,
          description: tx.description,
          entity,
          categoryTax,
          categoryBudget: categoryBudget || null,
        });
        if (proposal) onPropose(proposal);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleMarkTransfer = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await classifyTransaction(detail.transaction.id, { category_tax: 'transfer' });
      toast.success("Marked as transfer");
      await onChanged();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    if (!confirm(`Delete this transaction? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await deleteTransaction(detail.transaction.id);
      toast.success("Transaction deleted");
      await onChanged();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleReclassify = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await reclassifyWithAI(detail.transaction.id);
      // Console output for debugging
      if (result.method === 'rule') {
        console.log(
          `[CFO classify] Rule: "${result.rule}" → ${result.entity ?? '—'} / ${result.category_tax ?? '—'}` +
          (result.category_budget ? ` (budget: ${result.category_budget})` : ''),
        );
      } else if (result._debug) {
        console.group(`[CFO classify] ${detail.transaction.merchant_name ?? detail.transaction.description}`);
        console.log('Pass:', result._debug.pass);
        console.log('Prompt (user message):\n', result._debug.userMessage);
        console.log('Raw API response:', result._debug.rawResponse);
        console.groupEnd();
      }
      // Reload form fields before refreshing the parent list — this ensures
      // no re-render from onChanged() can run after our state updates.
      const d = await getTransaction(detail.transaction.id);
      setDetail(d);
      setEntity((d.transaction.entity ?? 'family_personal') as EntitySlug);
      setCategoryTax(d.transaction.category_tax ?? '');
      setCategoryBudget(d.transaction.category_budget ?? '');
      setExpenseType(d.transaction.expense_type ?? null);
      setCutStatus(d.transaction.cut_status ?? null);
      setNote(d.transaction.note ?? '');
      toast.success(`Reclassified via ${result.method}`);
      void onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!txId) return null;

  const tx = detail?.transaction;
  const locked = !!tx?.is_locked;

  return (
    <Drawer
      open={!!txId}
      onClose={onClose}
      title={tx?.merchant_name ?? tx?.description ?? "Transaction"}
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="danger"
            onClick={() => void handleDelete()}
            disabled={busy || !tx || locked}
            title={locked ? "Locked transactions cannot be deleted" : undefined}
          >
            <Trash2 className="w-4 h-4" /> Delete
          </Button>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => void handleMarkTransfer()}
              disabled={busy || !tx || locked}
              title="Mark as a transfer between accounts"
            >
              <ArrowLeftRight className="w-4 h-4" /> Transfer
            </Button>
            <Button
              variant="ghost"
              onClick={() => void handleReclassify()}
              disabled={busy || !tx || locked}
              title="Re-run AI classifier on this transaction (check browser console for prompt + response)"
            >
              <Sparkles className="w-4 h-4" /> Reclassify
            </Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={busy || !tx || locked}
              title={locked ? "Locked transactions cannot be reclassified" : undefined}
            >
              Save
            </Button>
          </div>
        </div>
      }
    >
      {loadingDetail || !detail || !tx ? (
        <div className="text-sm text-text-muted">Loading…</div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 text-sm mb-4">
            <div><dt className="text-xs text-text-muted">Date</dt><dd className="text-text-primary">{tx.posted_date ?? "—"}</dd></div>
            <div>
              <dt className="text-xs text-text-muted">Amount</dt>
              <dd className="text-text-primary tabular-nums">{fmtUsd(tx.amount, { sign: true })}</dd>
            </div>
            <div><dt className="text-xs text-text-muted">Account</dt><dd className="text-text-primary">{tx.account_name ?? "—"}</dd></div>
            <div><dt className="text-xs text-text-muted">Owner</dt><dd className="text-text-primary">{tx.owner_tag ?? "—"}</dd></div>
            <div className="col-span-2">
              <dt className="text-xs text-text-muted">Description</dt>
              <dd className="text-text-primary break-words">{tx.description ?? "—"}</dd>
            </div>
            {tx.method && (
              <div><dt className="text-xs text-text-muted">Classified by</dt><dd className="text-text-primary">{tx.method}</dd></div>
            )}
            {tx.confidence != null && (
              <div>
                <dt className="text-xs text-text-muted">Confidence</dt>
                <dd className="text-text-primary">{Math.round(tx.confidence * 100)}%</dd>
              </div>
            )}
          </dl>

          <div className="mb-4">
            <label className="block text-xs text-text-muted mb-1">Note</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note…"
              rows={3}
              disabled={locked}
              className="w-full rounded-md border border-border bg-surface-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-subtle resize-none focus:outline-none focus:ring-1 focus:ring-accent-primary disabled:opacity-50"
            />
          </div>

          {locked && (
            <Card className="p-3 mb-4 border-accent-warn/40 bg-accent-warn/5 text-sm text-accent-warn flex items-center gap-2">
              <Lock className="w-4 h-4" />
              Locked in a filing snapshot — read-only.
            </Card>
          )}

          <div className="mb-5">
            <h3 className="text-sm font-semibold text-text-primary mb-2">Reclassify</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs text-text-muted mb-1">Entity</label>
                <Select
                  value={entity}
                  onChange={(e) => setEntity(e.target.value as EntitySlug)}
                  className="w-full"
                  disabled={locked}
                >
                  {ENTITY_OPTIONS.map(({ slug, label }) => (
                    <option key={slug} value={slug}>{label}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Tax category</label>
                <Select
                  value={categoryTax}
                  onChange={(e) => setCategoryTax(e.target.value)}
                  className="w-full"
                  disabled={locked}
                >
                  <option value="">— select —</option>
                  {taxOptions.map(({ slug, label }) => (
                    <option key={slug} value={slug}>{label}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Budget category (optional)</label>
                <Select
                  value={categoryBudget}
                  onChange={(e) => setCategoryBudget(e.target.value)}
                  className="w-full"
                  disabled={locked}
                >
                  <option value="">— none —</option>
                  {budgetOptions.map(({ slug, label }) => (
                    <option key={slug} value={slug}>{label}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Frequency</label>
                <Select
                  value={expenseType ?? ""}
                  onChange={(e) => setExpenseType((e.target.value || null) as ExpenseType | null)}
                  className="w-full"
                  disabled={locked}
                >
                  <option value="">Recurring (default)</option>
                  <option value="one_time">One-time (exclude from forecast)</option>
                </Select>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Cut tracking</label>
                <Select
                  value={cutStatus ?? ""}
                  onChange={(e) => setCutStatus((e.target.value || null) as CutStatus | null)}
                  className="w-full"
                  disabled={locked}
                >
                  <option value="">Unflagged</option>
                  <option value="flagged">Flag to cut</option>
                  <option value="complete">Cut complete</option>
                </Select>
              </div>
            </div>
          </div>

          {detail.splits.length > 0 && (
            <div className="mb-5">
              <h3 className="text-sm font-semibold text-text-primary mb-2">Splits</h3>
              <div className="rounded-md border border-border divide-y divide-border">
                {detail.splits.map((s) => (
                  <div key={s.id} className="px-3 py-2 flex items-center justify-between text-sm">
                    <div>
                      <div className="text-text-primary">{humanizeSlug(s.entity)}</div>
                      {s.category_tax && <div className="text-xs text-text-muted">{humanizeSlug(s.category_tax)}</div>}
                      {s.note && <div className="text-xs text-text-subtle italic">{s.note}</div>}
                    </div>
                    <div className="tabular-nums text-text-primary">{fmtUsd(s.amount)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {detail.amazon_matches.length > 0 && (
            <div className="mb-5">
              <h3 className="text-sm font-semibold text-text-primary mb-2">Amazon orders</h3>
              <div className="space-y-2">
                {detail.amazon_matches.map((m) => (
                  <div key={m.order_id} className="rounded-md border border-border p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <div className="text-text-primary font-medium">Order {m.order_id}</div>
                      <div className="tabular-nums text-text-muted">{fmtUsd(m.total_amount)}</div>
                    </div>
                    {m.product_names && (
                      <div className="text-xs text-text-muted mt-1 line-clamp-2">{m.product_names}</div>
                    )}
                    <div className="text-xs text-text-subtle mt-1">
                      {m.order_date ?? "—"} · {m.match_method ?? "match"}
                      {m.match_score != null && ` · ${Math.round(m.match_score * 100)}%`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {detail.history.length > 0 && (
            <div className="mb-5">
              <h3 className="text-sm font-semibold text-text-primary mb-2">History</h3>
              <ol className="space-y-1.5 text-xs text-text-muted">
                {detail.history.map((h) => (
                  <li key={h.id} className="flex items-start gap-2">
                    <span className="text-text-subtle whitespace-nowrap">{h.changed_at}</span>
                    <span>
                      {h.entity ? humanizeSlug(h.entity) : "—"}
                      {h.category_tax ? ` · ${humanizeSlug(h.category_tax)}` : ""}
                      {h.method ? ` (${h.method})` : ""}
                      {h.changed_by ? ` by ${h.changed_by}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {detail.attachments.length > 0 && (
            <div className="mb-5">
              <h3 className="text-sm font-semibold text-text-primary mb-2">Attachments</h3>
              <ul className="text-sm">
                {detail.attachments.map((a) => (
                  <li key={a.id} className="text-text-primary">
                    {a.filename}
                    {a.size_bytes != null && <span className="text-text-muted text-xs"> · {Math.round(a.size_bytes / 1024)} KB</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
