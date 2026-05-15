import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Edit2 } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Card, Badge, Input, Select, Drawer, PageHeader, EmptyState, SortTh, fmtUsd,
} from "../ui";
import { txAmountColor } from "../../utils/txColor";
import { api, type Entity, type Category, type AccountRow, type TransactionRow, type TransactionListResponse } from "../../api";
import { CheckImagesPanel } from "../CheckImagesPanel";

const PAGE_SIZE = 50;

export function TransactionsView() {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [entityId, setEntityId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [sortBy, setSortBy] = useState("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);

  const [data, setData] = useState<TransactionListResponse | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [openRow, setOpenRow] = useState<TransactionRow | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    (async () => {
      try {
        const [es, cs, as] = await Promise.all([
          api.get<{ entities: Entity[] }>("/api/web/entities").then(r => r.entities),
          api.get<{ categories: Category[] }>("/api/web/categories").then(r => r.categories),
          api.get<{ accounts: AccountRow[] }>("/api/web/accounts").then(r => r.accounts),
        ]);
        setEntities(es); setCategories(cs); setAccounts(as);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => { setOffset(0); }, [debouncedQ, dateFrom, dateTo, entityId, categoryId, accountId, sortBy, sortDir]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (debouncedQ) p.set("q", debouncedQ);
      if (dateFrom) p.set("date_from", dateFrom);
      if (dateTo) p.set("date_to", dateTo);
      if (entityId) p.set("entity_id", entityId);
      if (categoryId) p.set("category_id", categoryId);
      if (accountId) p.set("account_id", accountId);
      p.set("sort_by", sortBy);
      p.set("sort_dir", sortDir);
      p.set("offset", String(offset));
      p.set("limit", String(PAGE_SIZE));
      const res = await api.get<TransactionListResponse>(`/api/web/transactions?${p.toString()}`);
      setData(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, dateFrom, dateTo, entityId, categoryId, accountId, sortBy, sortDir, offset]);

  useEffect(() => { void refresh(); }, [refresh]);

  const reopen = async (id: string) => {
    setBusy(true);
    try {
      await api.put(`/api/web/transactions/${id}`, { status: "pending_review" });
      toast.success("Re-opened for review");
      setOpenRow(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSort = (col: string) => {
    if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortBy(col); setSortDir("desc"); }
  };

  const accountById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Transactions"
        subtitle={loading ? "Loading…" : `${total} approved transaction${total !== 1 ? "s" : ""}`}
        actions={<Button onClick={() => void refresh()} disabled={loading}><RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} /> Refresh</Button>}
      />

      <Card className="p-4 mb-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs text-text-muted mb-1">Search</label>
            <Input className="w-full" placeholder="description or merchant" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">From</label>
            <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">To</label>
            <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Entity</label>
            <Select value={entityId} onChange={e => setEntityId(e.target.value)}>
              <option value="">All</option>
              {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Category</label>
            <Select value={categoryId} onChange={e => setCategoryId(e.target.value)}>
              <option value="">All</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Account</label>
            <Select value={accountId} onChange={e => setAccountId(e.target.value)}>
              <option value="">All</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </div>
        </div>
      </Card>

      <Card>
        {rows.length === 0 && !loading
          ? <EmptyState>No approved transactions yet.</EmptyState>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-text-muted bg-bg-elevated">
                  <tr>
                    <SortTh col="date" currentSort={sortBy} currentDir={sortDir} onSort={onSort} className="px-3 py-2">Date</SortTh>
                    <th className="px-3 py-2">Description</th>
                    <SortTh col="amount" currentSort={sortBy} currentDir={sortDir} onSort={onSort} className="px-3 py-2 text-right">Amount</SortTh>
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2">Entity</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const acct = r.account_id ? accountById.get(r.account_id) : null;
                    return (
                      <tr key={r.id} className="border-t border-border hover:bg-bg-elevated/50 cursor-pointer" onClick={() => setOpenRow(r)}>
                        <td className="px-3 py-2 text-text-muted whitespace-nowrap">{r.date}</td>
                        <td className="px-3 py-2 max-w-md">
                          <div className="font-medium truncate">{r.description}</div>
                          {r.merchant && <div className="text-xs text-text-muted truncate">{r.merchant}</div>}
                          {(r.is_transfer || r.is_reimbursable) && (
                            <div className="mt-1 flex gap-1">
                              {r.is_transfer && <Badge tone="info">transfer</Badge>}
                              {r.is_reimbursable && <Badge tone="warn">reimbursable</Badge>}
                            </div>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${txAmountColor(r.amount, acct?.type ?? null, r.category_slug)}`}>
                          {fmtUsd(r.amount, { sign: true })}
                        </td>
                        <td className="px-3 py-2 text-text-muted truncate max-w-[140px]">{r.account_name ?? "—"}</td>
                        <td className="px-3 py-2 text-text-muted">{r.entity_name ?? "—"}</td>
                        <td className="px-3 py-2 text-text-muted">{r.category_name ?? "—"}</td>
                        <td className="px-3 py-2"><Edit2 className="w-3.5 h-3.5 text-text-muted" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </Card>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-3 text-sm text-text-muted">
          <span>Showing {offset + 1}–{Math.min(offset + rows.length, total)} of {total}</span>
          <div className="flex items-center gap-2">
            <Button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>Prev</Button>
            <Button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}>Next</Button>
          </div>
        </div>
      )}

      <Drawer
        open={openRow !== null}
        onClose={() => setOpenRow(null)}
        title={openRow ? `${openRow.date} · ${fmtUsd(openRow.amount, { sign: true })}` : ""}
        footer={openRow && (
          <div className="flex justify-end">
            <Button onClick={() => void reopen(openRow.id)} disabled={busy}>
              <Edit2 className="w-4 h-4" /> Re-open for edit
            </Button>
          </div>
        )}
      >
        {openRow && (
          <div className="space-y-4 text-sm">
            <section>
              <div className="text-xs uppercase text-text-muted mb-1">Transaction</div>
              <div className="font-medium">{openRow.description}</div>
              {openRow.merchant && <div className="text-text-muted">{openRow.merchant}</div>}
              <div className="mt-1 text-text-muted">
                {openRow.date} · {fmtUsd(openRow.amount, { sign: true })} · {openRow.account_name ?? "—"}
              </div>
            </section>
            <section className="grid grid-cols-2 gap-3">
              <Field label="Entity">{openRow.entity_name ?? "—"}</Field>
              <Field label="Category">{openRow.category_name ?? "—"}</Field>
              <Field label="Method">{openRow.classification_method ?? "—"}</Field>
              <Field label="Approved at">{openRow.approved_at ?? "—"}</Field>
            </section>
            {openRow.ai_notes && (
              <section>
                <div className="text-xs uppercase text-text-muted mb-1">AI reasoning</div>
                <div className="bg-bg-elevated rounded-lg p-3 text-text-muted">{openRow.ai_notes}</div>
              </section>
            )}
            {openRow.human_notes && (
              <section>
                <div className="text-xs uppercase text-text-muted mb-1">Notes</div>
                <div className="bg-bg-elevated rounded-lg p-3">{openRow.human_notes}</div>
              </section>
            )}
            <CheckImagesPanel endpoint={`/api/web/transactions/${openRow.id}`} />
          </div>
        )}
      </Drawer>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase text-text-muted mb-1">{label}</div>
      <div>{children}</div>
    </div>
  );
}
