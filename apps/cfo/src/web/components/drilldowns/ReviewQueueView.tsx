import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, ArrowLeftRight, Sparkles, Clock } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Badge, Input, Select, Drawer, PageHeader, EmptyState,
  IndeterminateCheckbox, SortTh, fmtUsd,
} from "../ui";
import { txAmountColor } from "../../utils/txColor";
import {
  api, type Entity, type Category, type AccountRow, type ReviewRow, type ReviewListResponse,
} from "../../api";
import { ProposeRuleModal } from "../ProposeRuleModal";
import { CheckImagesPanel } from "../CheckImagesPanel";

const PAGE_SIZE = 50;

const ENTITY_TYPE_LABEL: Record<string, string> = {
  schedule_c: "(C)",
  schedule_e: "(SE)",
  personal: "(P)",
};

function categoryLabel(c: Category, ambiguous: Set<string>): string {
  if (!ambiguous.has(c.name)) return c.name;
  const suffix = ENTITY_TYPE_LABEL[c.entity_type];
  return suffix ? `${c.name} ${suffix}` : c.name;
}

function filterCategoriesByEntity(
  cats: Category[],
  entityId: string | null | undefined,
  entities: Entity[]
): Category[] {
  if (!entityId) return cats;
  const ent = entities.find(e => e.id === entityId);
  if (!ent) return cats;
  return cats.filter(c => c.entity_type === "all" || c.entity_type === ent.type);
}

type StatusTab = "staged" | "waiting";

interface Filters {
  q: string;
  date_from: string;
  date_to: string;
  entity_id: string;
  category_id: string;
  account_id: string;
}

const EMPTY_FILTERS: Filters = {
  q: "",
  date_from: "",
  date_to: "",
  entity_id: "",
  category_id: "",
  account_id: "",
};

function activeFilterCount(f: Filters): number {
  let n = 0;
  if (f.q) n++;
  if (f.date_from) n++;
  if (f.date_to) n++;
  if (f.entity_id) n++;
  if (f.category_id) n++;
  if (f.account_id) n++;
  return n;
}

function filtersToParams(f: Filters, status: StatusTab, sortBy: string, sortDir: "asc" | "desc", offset: number): URLSearchParams {
  const p = new URLSearchParams();
  p.set("status", status);
  if (f.q) p.set("q", f.q);
  if (f.date_from) p.set("date_from", f.date_from);
  if (f.date_to) p.set("date_to", f.date_to);
  if (f.entity_id) p.set("entity_id", f.entity_id);
  if (f.category_id) p.set("category_id", f.category_id);
  if (f.account_id) p.set("account_id", f.account_id);
  p.set("sort_by", sortBy);
  p.set("sort_dir", sortDir);
  p.set("offset", String(offset));
  p.set("limit", String(PAGE_SIZE));
  return p;
}

export function ReviewQueueView() {
  const [tab, setTab] = useState<StatusTab>("staged");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [debouncedQ, setDebouncedQ] = useState("");
  const [sortBy, setSortBy] = useState<string>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);

  const [data, setData] = useState<ReviewListResponse | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedAllFiltered, setSelectedAllFiltered] = useState(false);

  const [openRow, setOpenRow] = useState<ReviewRow | null>(null);
  const [proposeFor, setProposeFor] = useState<ReviewRow | null>(null);

  const [bulkEntityId, setBulkEntityId] = useState("");
  const [bulkCategoryId, setBulkCategoryId] = useState("");

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(filters.q), 200);
    return () => clearTimeout(t);
  }, [filters.q]);

  // Load lookups once
  useEffect(() => {
    (async () => {
      try {
        const [es, cs, as] = await Promise.all([
          api.get<{ entities: Entity[] }>("/api/web/entities").then(r => r.entities),
          api.get<{ categories: Category[] }>("/api/web/categories").then(r => r.categories),
          api.get<{ accounts: AccountRow[] }>("/api/web/accounts").then(r => r.accounts),
        ]);
        setEntities(es);
        setCategories(cs);
        setAccounts(as);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // Effective filters with debounced search
  const effectiveFilters = useMemo(() => ({ ...filters, q: debouncedQ }), [filters, debouncedQ]);

  // Reset offset when filters/tab/sort change
  useEffect(() => { setOffset(0); }, [tab, debouncedQ, filters.entity_id, filters.category_id, filters.account_id, filters.date_from, filters.date_to, sortBy, sortDir]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = filtersToParams(effectiveFilters, tab, sortBy, sortDir, offset);
      const res = await api.get<ReviewListResponse>(`/api/web/review?${params.toString()}`);
      setData(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [effectiveFilters, tab, sortBy, sortDir, offset]);

  useEffect(() => { void refresh(); }, [refresh]);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  // ── Selection helpers (3-state pattern) ────────────────────────────────
  const visibleIds = useMemo(() => rows.map(r => r.id), [rows]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some(id => selectedIds.has(id));
  const selectedCount = selectedIds.size;

  const toggleId = (id: string, on: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
    setSelectedAllFiltered(false);
  };

  const togglePage = (on: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const id of visibleIds) {
        if (on) next.add(id); else next.delete(id);
      }
      return next;
    });
    setSelectedAllFiltered(false);
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectedAllFiltered(false);
  };

  // ── Sort ───────────────────────────────────────────────────────────────
  const onSort = (col: string) => {
    if (sortBy === col) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortBy(col);
      setSortDir("desc");
    }
  };

  // ── Bulk actions ───────────────────────────────────────────────────────
  type BulkBody = {
    action: "set_entity" | "set_category" | "set_transfer" | "set_reimbursable" | "approve";
    entity_id?: string;
    category_id?: string;
    is_transfer?: boolean;
    is_reimbursable?: boolean;
    ids?: string[];
    apply_to_filtered?: boolean;
    filters?: Record<string, unknown>;
  };

  const runBulk = async (body: BulkBody) => {
    if (busy) return;
    if (!selectedAllFiltered && selectedCount === 0) {
      toast.error("Select at least one row.");
      return;
    }
    if (selectedAllFiltered) {
      const confirmed = confirm(`Apply ${body.action} to ALL ${total} matching rows?`);
      if (!confirmed) return;
    }
    setBusy(true);
    try {
      const payload: BulkBody = {
        ...body,
        ...(selectedAllFiltered
          ? { apply_to_filtered: true, filters: Object.fromEntries(filtersToParams(effectiveFilters, tab, sortBy, sortDir, 0)) }
          : { ids: Array.from(selectedIds) }),
      };
      const res = await api.post<{ updated: number }>("/api/web/review/bulk", payload);
      toast.success(`Updated ${res.updated} row${res.updated !== 1 ? "s" : ""}`);
      // Keep the selection after set_entity/set_category/etc. so the user can
      // chain edits; only 'approve' removes the rows from the queue.
      if (body.action === "approve") clearSelection();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const updateRow = async (id: string, body: Partial<ReviewRow>) => {
    setBusy(true);
    try {
      await api.put(`/api/web/review/${id}`, body);
      await refresh();
      if (openRow?.id === id) {
        const updated = await api.get<ReviewRow>(`/api/web/review/${id}`);
        setOpenRow(updated);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const approveOne = async (id: string) => {
    setBusy(true);
    try {
      await api.post(`/api/web/review/${id}/approve`);
      toast.success("Approved");
      setOpenRow(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const advanceWaiting = async (id: string) => {
    setBusy(true);
    try {
      await api.post(`/api/web/review/${id}/advance`);
      toast.success("Advanced");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const accountById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);

  const ambiguousCategoryNames = useMemo(() => {
    const byName = new Map<string, Set<string>>();
    for (const c of categories) {
      if (c.entity_type === "all") continue;
      if (!byName.has(c.name)) byName.set(c.name, new Set());
      byName.get(c.name)!.add(c.entity_type);
    }
    const s = new Set<string>();
    for (const [name, types] of byName) {
      if (types.size > 1) s.add(name);
    }
    return s;
  }, [categories]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Review queue"
        subtitle={
          loading ? "Loading…" :
          total === 0 ? `No ${tab === "staged" ? "pending review" : "waiting"} items` :
          `${total} ${tab === "staged" ? "to review" : "waiting"} item${total !== 1 ? "s" : ""}`
        }
        actions={
          <Button onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} /> Refresh
          </Button>
        }
      />

      {/* Tabs: pending / waiting */}
      <div className="flex items-center gap-1 mb-4 border-b border-border">
        <TabButton active={tab === "staged"} onClick={() => { setTab("staged"); clearSelection(); }}>
          <Inbox className="w-4 h-4" /> Pending review
        </TabButton>
        <TabButton active={tab === "waiting"} onClick={() => { setTab("waiting"); clearSelection(); }}>
          <Clock className="w-4 h-4" /> Holds
        </TabButton>
      </div>

      {/* Filter bar */}
      <Card className="p-4 mb-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs text-text-muted mb-1">Search</label>
            <Input
              type="text" placeholder="description or merchant"
              value={filters.q}
              onChange={e => setFilters(f => ({ ...f, q: e.target.value }))}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">From</label>
            <Input type="date" value={filters.date_from}
              onChange={e => setFilters(f => ({ ...f, date_from: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">To</label>
            <Input type="date" value={filters.date_to}
              onChange={e => setFilters(f => ({ ...f, date_to: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Entity</label>
            <Select value={filters.entity_id} onChange={e => setFilters(f => ({ ...f, entity_id: e.target.value }))}>
              <option value="">All entities</option>
              {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Category</label>
            <Select value={filters.category_id} onChange={e => setFilters(f => ({ ...f, category_id: e.target.value }))}>
              <option value="">All categories</option>
              {filterCategoriesByEntity(categories, filters.entity_id, entities).map(c =>
                <option key={c.id} value={c.id}>{categoryLabel(c, ambiguousCategoryNames)}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Account</label>
            <Select value={filters.account_id} onChange={e => setFilters(f => ({ ...f, account_id: e.target.value }))}>
              <option value="">All accounts</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </div>
          {activeFilterCount(filters) > 0 && (
            <div>
              <label className="block text-xs text-text-muted mb-1">&nbsp;</label>
              <Button onClick={() => setFilters(EMPTY_FILTERS)}>Clear ({activeFilterCount(filters)})</Button>
            </div>
          )}
        </div>
      </Card>

      {/* Bulk action bar */}
      {(selectedCount > 0 || selectedAllFiltered) && (
        <Card className="p-3 mb-4 border-accent-primary/30 bg-accent-primary/5">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-sm font-medium">
              {selectedAllFiltered ? `All ${total} matching rows selected.` : `${selectedCount} selected.`}
            </div>
            <Select value={bulkEntityId} onChange={e => setBulkEntityId(e.target.value)}>
              <option value="">Set entity…</option>
              {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
            <Button disabled={!bulkEntityId || busy} onClick={() => void runBulk({ action: "set_entity", entity_id: bulkEntityId })}>Apply entity</Button>
            <Select value={bulkCategoryId} onChange={e => setBulkCategoryId(e.target.value)}>
              <option value="">Set category…</option>
              {categories.map(c => <option key={c.id} value={c.id}>{categoryLabel(c, ambiguousCategoryNames)}</option>)}
            </Select>
            <Button disabled={!bulkCategoryId || busy} onClick={() => void runBulk({ action: "set_category", category_id: bulkCategoryId })}>Apply category</Button>
            <Button disabled={busy} onClick={() => void runBulk({ action: "set_transfer", is_transfer: true })}>Mark transfer</Button>
            <Button disabled={busy} onClick={() => void runBulk({ action: "set_reimbursable", is_reimbursable: true })}>Mark reimbursable</Button>
            <Button
              disabled={busy}
              onClick={() => {
                const source = rows.find(r => selectedIds.has(r.id)) ?? rows[0] ?? null;
                setProposeFor(source);
              }}
            >
              Propose rule
            </Button>
            <Button variant="success" disabled={busy} onClick={() => void runBulk({ action: "approve" })}>
              <Sparkles className="w-4 h-4" /> Approve
            </Button>
            <Button onClick={clearSelection}>Clear</Button>
          </div>
        </Card>
      )}

      {/* Select-all-filtered banner */}
      {allVisibleSelected && !selectedAllFiltered && total > rows.length && (
        <Card className="p-3 mb-4 text-sm flex items-center justify-between gap-3">
          <span>All {rows.length} rows on this page are selected.</span>
          <button
            className="text-accent-primary font-medium hover:underline"
            onClick={() => setSelectedAllFiltered(true)}
          >
            Select all {total} matching rows →
          </button>
        </Card>
      )}

      {/* Transactions table */}
      <Card>
        {rows.length === 0 && !loading
          ? <EmptyState>{tab === "staged" ? "No transactions waiting for review." : "No transactions on hold."}</EmptyState>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-text-muted bg-bg-elevated">
                  <tr>
                    <th className="px-3 py-2 w-8">
                      <IndeterminateCheckbox
                        checked={allVisibleSelected}
                        indeterminate={someVisibleSelected && !allVisibleSelected}
                        onChange={e => togglePage(e.target.checked)}
                      />
                    </th>
                    <SortTh col="date" currentSort={sortBy} currentDir={sortDir} onSort={onSort} className="px-3 py-2">Date</SortTh>
                    <th className="px-3 py-2">Description</th>
                    <SortTh col="amount" currentSort={sortBy} currentDir={sortDir} onSort={onSort} className="px-3 py-2 text-right">Amount</SortTh>
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2">Entity</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2 w-16"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const acct = r.account_id ? accountById.get(r.account_id) : null;
                    const acctType = acct?.type ?? null;
                    const effectiveEntityId = r.entity_id ?? acct?.entity_id ?? "";
                    return (
                      <tr key={r.id} className="border-t border-border hover:bg-bg-elevated/50">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(r.id)}
                            onChange={e => toggleId(r.id, e.target.checked)}
                            className="rounded border-border focus:ring-accent-primary"
                          />
                        </td>
                        <td className="px-3 py-2 text-text-muted whitespace-nowrap">{r.date}</td>
                        <td className="px-3 py-2 max-w-md">
                          <button
                            className="font-medium truncate hover:underline text-left w-full cursor-pointer"
                            onClick={() => setOpenRow(r)}
                          >
                            {r.description}
                          </button>
                          {r.merchant && <div className="text-xs text-text-muted truncate">{r.merchant}</div>}
                          {(r.is_transfer || r.is_reimbursable || r.waiting_for) && (
                            <div className="mt-1 flex gap-1">
                              {r.is_transfer && <Badge tone="info"><ArrowLeftRight className="w-3 h-3" /> transfer</Badge>}
                              {r.is_reimbursable && <Badge tone="warn">reimbursable</Badge>}
                              {r.waiting_for && <Badge tone="warn">waiting: {r.waiting_for}</Badge>}
                            </div>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${txAmountColor(r.amount, acctType, r.category_slug)}`}>
                          {fmtUsd(r.amount, { sign: true })}
                        </td>
                        <td className="px-3 py-2 text-text-muted truncate max-w-[140px]">{r.account_name ?? "—"}</td>
                        <td className="px-3 py-2 min-w-[140px]">
                          <Select value={effectiveEntityId} onChange={e => void updateRow(r.id, { entity_id: e.target.value || null })}>
                            <option value="">—</option>
                            {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                          </Select>
                        </td>
                        <td className="px-3 py-2 min-w-[180px]">
                          <Select value={r.category_id ?? ""} onChange={e => void updateRow(r.id, { category_id: e.target.value || null, classification_method: "manual" })}>
                            <option value="">—</option>
                            {filterCategoriesByEntity(categories, effectiveEntityId, entities).map(c =>
                              <option key={c.id} value={c.id}>{categoryLabel(c, ambiguousCategoryNames)}</option>)}
                          </Select>
                        </td>
                        <td className="px-3 py-2">
                          <Button size="sm" variant="success" disabled={busy} onClick={() => void approveOne(r.id)}>
                            <Sparkles className="w-4 h-4" />
                          </Button>
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

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-3 text-sm text-text-muted">
          <span>Showing {offset + 1}–{Math.min(offset + rows.length, total)} of {total}</span>
          <div className="flex items-center gap-2">
            <Button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>Prev</Button>
            <Button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}>Next</Button>
          </div>
        </div>
      )}

      {/* Detail drawer */}
      <Drawer
        open={openRow !== null}
        onClose={() => setOpenRow(null)}
        title={openRow ? `${openRow.date} · ${fmtUsd(openRow.amount, { sign: true })}` : ""}
        footer={openRow && (
          <div className="flex items-center justify-between">
            <button className="text-sm text-accent-primary hover:underline" onClick={() => setProposeFor(openRow)}>Propose rule</button>
            <div className="flex items-center gap-2">
              {openRow.status === "waiting" && (
                <Button onClick={() => void advanceWaiting(openRow.id)} disabled={busy}>Advance anyway</Button>
              )}
              <Button variant="success" disabled={busy} onClick={() => void approveOne(openRow.id)}>
                <Sparkles className="w-4 h-4" /> Approve
              </Button>
            </div>
          </div>
        )}
      >
        {openRow && <DetailDrawerBody row={openRow} entities={entities} categories={categories} accounts={accounts} onUpdate={updateRow} ambiguousCategories={ambiguousCategoryNames} />}
      </Drawer>

      {/* Propose rule modal */}
      <ProposeRuleModal
        open={proposeFor !== null}
        onClose={() => setProposeFor(null)}
        sourceRow={proposeFor}
        entities={entities}
        categories={categories}
        onCreated={() => { setProposeFor(null); toast.success("Rule created"); }}
      />
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px " +
        (active
          ? "border-accent-primary text-accent-primary"
          : "border-transparent text-text-muted hover:text-text-primary")
      }
    >
      {children}
    </button>
  );
}

function Inbox(props: { className?: string }) {
  // Inline SVG to avoid an extra lucide import name collision
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
    </svg>
  );
}

interface DetailProps {
  row: ReviewRow;
  entities: Entity[];
  categories: Category[];
  accounts: AccountRow[];
  onUpdate: (id: string, body: Partial<ReviewRow>) => Promise<void>;
  ambiguousCategories: Set<string>;
}

function DetailDrawerBody({ row, entities, categories, accounts, onUpdate, ambiguousCategories }: DetailProps) {
  const [notes, setNotes] = useState(row.human_notes ?? "");
  const [expenseFlag, setExpenseFlag] = useState<"cut" | "one_time" | "">(row.expense_flag ?? "");
  const account = row.account_id ? accounts.find(a => a.id === row.account_id) : null;
  const supplement = row.supplement_json;
  const effectiveEntityId = row.entity_id ?? account?.entity_id ?? "";

  return (
    <div className="space-y-4 text-sm">
      <section>
        <div className="text-xs uppercase text-text-muted mb-1">Transaction</div>
        <div className="font-medium">{row.description}</div>
        {row.merchant && <div className="text-text-muted">{row.merchant}</div>}
        <div className="mt-1 text-text-muted">
          {row.date} · {fmtUsd(row.amount, { sign: true })} · {account?.name ?? "—"}
        </div>
      </section>

      {supplement && Object.keys(supplement).length > 0 && (
        <section>
          <div className="text-xs uppercase text-text-muted mb-1">Email enrichment</div>
          <pre className="bg-bg-elevated rounded-lg p-3 text-xs whitespace-pre-wrap break-words">
            {JSON.stringify(supplement, null, 2)}
          </pre>
        </section>
      )}

      <CheckImagesPanel endpoint={`/api/web/review/${row.id}`} />


      {row.ai_notes && (
        <section>
          <div className="text-xs uppercase text-text-muted mb-1">AI reasoning</div>
          <div className="bg-bg-elevated rounded-lg p-3 text-text-muted">{row.ai_notes}</div>
        </section>
      )}

      <section className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs uppercase text-text-muted mb-1">Entity</label>
          <Select value={effectiveEntityId} onChange={e => void onUpdate(row.id, { entity_id: e.target.value || null })}>
            <option value="">—</option>
            {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </Select>
        </div>
        <div>
          <label className="block text-xs uppercase text-text-muted mb-1">Category</label>
          <Select value={row.category_id ?? ""} onChange={e => void onUpdate(row.id, { category_id: e.target.value || null, classification_method: "manual" })}>
            <option value="">—</option>
            {filterCategoriesByEntity(categories, effectiveEntityId, entities).map(c =>
              <option key={c.id} value={c.id}>{categoryLabel(c, ambiguousCategories)}</option>)}
          </Select>
        </div>
      </section>

      <section className="flex items-center gap-4">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={row.is_transfer}
            onChange={e => void onUpdate(row.id, { is_transfer: e.target.checked })}
          />
          Transfer
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={row.is_reimbursable}
            onChange={e => void onUpdate(row.id, { is_reimbursable: e.target.checked })}
          />
          Reimbursable
        </label>
      </section>

      <section>
        <label className="block text-xs uppercase text-text-muted mb-1">Flag</label>
        <Select
          value={expenseFlag}
          onChange={e => {
            const val = e.target.value as "cut" | "one_time" | "";
            setExpenseFlag(val);
            void onUpdate(row.id, { expense_flag: val || null });
          }}
        >
          <option value="">— none —</option>
          <option value="cut">To cut</option>
          <option value="one_time">One-time expense</option>
        </Select>
      </section>

      <section>
        <label className="block text-xs uppercase text-text-muted mb-1">Notes</label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          onBlur={() => { if (notes !== (row.human_notes ?? "")) void onUpdate(row.id, { human_notes: notes }); }}
          rows={3}
          className="w-full rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary"
        />
      </section>

      {row.waiting_for && (
        <section className="text-xs text-accent-warn">
          Waiting for: {row.waiting_for}
        </section>
      )}
    </div>
  );
}
