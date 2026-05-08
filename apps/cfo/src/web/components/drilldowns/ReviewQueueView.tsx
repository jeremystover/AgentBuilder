import { useCallback, useMemo, useState } from "react";
import { Sparkles, RefreshCw, Loader2 } from "lucide-react";
import { txAmountColor } from "../../utils/txColor";
import { toast } from "sonner";
import {
  Button, Card, Badge, Select, Drawer, PageHeader, EmptyState, fmtUsd, humanizeSlug,
} from "../ui";
import { useReviewQueue } from "../../hooks/useReviewQueue";
import { resolveReview, bulkResolveReview, runClassification } from "../../api";
import type { ReviewItem, ReviewStatus, ResolveAction } from "../../types";
import { CATEGORY_OPTIONS, ENTITY_OPTIONS } from "../../catalog";

const PAGE_SIZE = 50;

type CategoryFilter = "" | "__uncategorized__" | string; // tax category slug

export function ReviewQueueView() {
  const [status, setStatus] = useState<ReviewStatus>("pending");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("");

  const { data, offset, setOffset, loading, error, refresh } = useReviewQueue({
    status,
    category_tax: categoryFilter || null,
    pageSize: PAGE_SIZE,
  });
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  // Selection state — tracks IDs visible-page-only by default; "select
  // filtered" flips selectedAllFiltered, which the bulk apply path
  // forwards as apply_to_filtered=true.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedAllFiltered, setSelectedAllFiltered] = useState(false);

  // Open drawer for a single item.
  const [openItem, setOpenItem] = useState<ReviewItem | null>(null);

  // Bulk reclassify form state.
  const [bulkEntity, setBulkEntity] = useState<string>("elyse_coaching");
  const [bulkCategory, setBulkCategory] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // Classify flow: null = idle, "picking" = scope picker visible, "running" = in-flight
  type ClassifyState = null | "picking" | "running";
  const [classifyState, setClassifyState] = useState<ClassifyState>(null);
  const [classifyStatus, setClassifyStatus] = useState("");

  // ── Selection helpers ──────────────────────────────────────────────────
  const visibleIds = useMemo(() => items.map((it) => it.id), [items]);
  const selectedCount = selectedIds.size;
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id));

  const toggleId = (id: string, on: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
    setSelectedAllFiltered(false);
  };

  const toggleAllVisible = (on: boolean) => {
    setSelectedIds((prev) => {
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

  // ── Actions ────────────────────────────────────────────────────────────
  const onBulk = useCallback(async (action: ResolveAction, applyToFiltered = false) => {
    if (busy) return;
    const target = applyToFiltered
      ? `all ${total} ${status} item${total !== 1 ? "s" : ""}`
      : `${selectedCount} item${selectedCount !== 1 ? "s" : ""}`;
    if (!applyToFiltered && selectedCount === 0) {
      toast.error("Select at least one item.");
      return;
    }
    if (!confirm(`Apply ${action} to ${target}?`)) return;
    setBusy(true);
    try {
      const res = await bulkResolveReview({
        action,
        review_ids: applyToFiltered ? undefined : Array.from(selectedIds),
        apply_to_filtered: applyToFiltered || undefined,
        status,
        filter_category_tax: categoryFilter || undefined,
        ...(action === "classify" ? {
          entity: bulkEntity,
          category_tax: bulkCategory || undefined,
        } : {}),
      });
      toast.success(`Updated ${res.updated} item${res.updated !== 1 ? "s" : ""}`);
      clearSelection();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, total, status, selectedCount, selectedIds, categoryFilter, bulkEntity, bulkCategory, refresh]);

  const runClassify = useCallback(async (transactionIds?: string[]) => {
    const count = transactionIds ? transactionIds.length : total;
    setClassifyState("running");
    setClassifyStatus(`Classifying ${count} transaction${count !== 1 ? "s" : ""}…`);
    setBusy(true);
    try {
      const r = await runClassification(transactionIds);
      const processed = r.total_processed ?? 0;
      const byRules = r.classified_by_rules ?? 0;
      const byAI = r.classified_by_ai ?? 0;
      const needsReview = r.queued_for_review ?? 0;
      if (processed === 0) {
        toast.success("Nothing to classify — all transactions already have a category.");
      } else {
        toast.success(
          `Classified ${processed}: ${byRules} by rules, ${byAI} by AI` +
          (needsReview > 0 ? `, ${needsReview} need review` : ""),
        );
      }
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setClassifyState(null);
      setClassifyStatus("");
    }
  }, [total, refresh]);

  const onResolveOne = useCallback(async (id: string, input: Parameters<typeof resolveReview>[1]) => {
    setBusy(true);
    try {
      await resolveReview(id, input);
      toast.success(`${input.action} applied`);
      setOpenItem(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Review queue"
        subtitle={
          loading ? "Loading…" :
          total === 0 ? `No ${status} items` :
          `${total} ${status} item${total !== 1 ? "s" : ""}${categoryFilter === "__uncategorized__" ? " (uncategorized)" : categoryFilter ? ` (${humanizeSlug(categoryFilter)})` : ""}`
        }
        actions={
          <>
            {classifyState === "picking" ? (
              <>
                <span className="text-sm text-text-muted self-center">Classify:</span>
                <Button
                  variant="primary"
                  onClick={() => void runClassify(items.map(it => it.transaction_id))}
                  disabled={items.length === 0}
                >
                  This page ({items.length})
                </Button>
                <Button variant="primary" onClick={() => void runClassify()}>
                  All unclassified ({total})
                </Button>
                <Button variant="ghost" onClick={() => setClassifyState(null)}>Cancel</Button>
              </>
            ) : (
              <Button
                variant="primary"
                onClick={() => setClassifyState("picking")}
                disabled={busy || total === 0}
              >
                <Sparkles className="w-4 h-4" /> Classify unclassified
              </Button>
            )}
            <Button onClick={() => void refresh()} title="Refresh" disabled={busy}>
              <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
            </Button>
          </>
        }
      />

      {classifyState === "running" && (
        <div className="flex items-center gap-3 px-4 py-3 mb-4 rounded-lg bg-accent-primary/10 border border-accent-primary/20 text-sm text-accent-primary">
          <Loader2 className="w-4 h-4 animate-spin flex-none" />
          <span>{classifyStatus}</span>
          <span className="text-text-muted ml-auto">This may take 30–60 seconds for large batches</span>
        </div>
      )}

      <Card className="p-4 mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <label className="block text-xs text-text-muted mb-1">Status</label>
            <Select value={status} onChange={(e) => setStatus(e.target.value as ReviewStatus)}>
              <option value="pending">Pending</option>
              <option value="resolved">Resolved</option>
              <option value="skipped">Skipped</option>
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Category</label>
            <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="">All categories</option>
              <option value="__uncategorized__">Uncategorized</option>
              {CATEGORY_OPTIONS.map(({ slug, label }) => (
                <option key={slug} value={slug}>{label}</option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      {error && (
        <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">
          {error}
        </Card>
      )}

      {/* Bulk action bar */}
      <Card className="p-4 mb-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm">
            <div className="font-semibold text-text-primary">Bulk actions</div>
            <div className="text-text-muted text-xs">
              {selectedAllFiltered
                ? `Targeting all ${total} filtered.`
                : selectedCount > 0
                  ? `${selectedCount} selected.`
                  : "Select rows below or apply to all filtered."}
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Button onClick={() => toggleAllVisible(!allVisibleSelected)} disabled={visibleIds.length === 0}>
              {allVisibleSelected ? "Deselect visible" : "Select visible"}
            </Button>
            <Button onClick={() => setSelectedAllFiltered(true)} disabled={total === 0}>
              Select filtered ({total})
            </Button>
            <Button onClick={clearSelection} disabled={selectedCount === 0 && !selectedAllFiltered}>
              Clear
            </Button>
          </div>
        </div>
        <div className="flex items-end gap-2 mt-3 flex-wrap">
          <Button variant="success" disabled={status !== "pending" || busy || (!selectedAllFiltered && selectedCount === 0)} onClick={() => onBulk("accept")}>
            Accept selected
          </Button>
          <Button disabled={(status !== "resolved" && status !== "skipped") || busy || (!selectedAllFiltered && selectedCount === 0)} onClick={() => onBulk("reopen")}>
            Reopen selected
          </Button>
          <div className="h-6 border-l border-border mx-1" />
          <div>
            <label className="block text-[11px] text-text-muted mb-0.5">Bulk entity</label>
            <Select value={bulkEntity} onChange={(e) => setBulkEntity(e.target.value)}>
              {ENTITY_OPTIONS.map(({ slug, label }) => (
                <option key={slug} value={slug}>{label}</option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-[11px] text-text-muted mb-0.5">Bulk category</label>
            <Select value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)}>
              <option value="">— select —</option>
              {CATEGORY_OPTIONS.map(({ slug, label }) => (
                <option key={slug} value={slug}>{label}</option>
              ))}
            </Select>
          </div>
          <Button variant="primary" disabled={status !== "pending" || busy || !bulkCategory || (!selectedAllFiltered && selectedCount === 0)} onClick={() => onBulk("classify")}>
            Reclassify selected
          </Button>
        </div>
      </Card>

      {/* Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border bg-bg-elevated">
                <th className="pl-4 py-2 w-10">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected;
                    }}
                    onChange={(e) => toggleAllVisible(e.target.checked)}
                  />
                </th>
                <th className="py-2">Date</th>
                <th>Merchant</th>
                <th>Amount</th>
                <th>Account</th>
                <th>Suggested</th>
                <th>Conf.</th>
                <th className="pr-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan={8}><EmptyState>Nothing in queue.</EmptyState></td></tr>
              ) : items.map((it) => (
                <ReviewRow
                  key={it.id}
                  item={it}
                  selected={selectedIds.has(it.id)}
                  onToggle={(on) => toggleId(it.id, on)}
                  onOpen={() => setOpenItem(it)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4 text-sm text-text-muted">
        <div>
          {total === 0 ? "" : `Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
        </div>
        <div className="flex gap-1.5">
          <Button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>← Prev</Button>
          <Button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}>Next →</Button>
        </div>
      </div>

      <ReviewDrawer
        item={openItem}
        onClose={() => setOpenItem(null)}
        onResolve={onResolveOne}
        busy={busy}
      />
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────

function ReviewRow({
  item, selected, onToggle, onOpen,
}: { item: ReviewItem; selected: boolean; onToggle(on: boolean): void; onOpen(): void }) {
  const amtCls = txAmountColor(item.amount ?? 0, item.account_type ?? null, item.current_category_tax ?? null);
  const sug = item.suggested_category_tax ?? item.current_category_tax;
  const conf = item.suggested_confidence ?? item.current_confidence;
  const confTone =
    conf == null ? "neutral" :
    conf >= 0.9 ? "ok" :
    conf >= 0.7 ? "warn" : "danger";

  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-bg-elevated/50">
      <td className="pl-4 py-2.5">
        <input type="checkbox" checked={selected} onChange={(e) => onToggle(e.target.checked)} />
      </td>
      <td className="py-2.5 text-text-muted whitespace-nowrap">{item.posted_date ?? "—"}</td>
      <td className="max-w-[24rem]">
        <div className="text-text-primary truncate">{item.merchant_name ?? item.description ?? "—"}</div>
        {item.description && item.merchant_name && (
          <div className="text-xs text-text-subtle truncate">{item.description}</div>
        )}
      </td>
      <td className={`tabular-nums ${amtCls}`}>{fmtUsd(item.amount, { sign: true })}</td>
      <td className="text-text-muted">{item.account_name ?? "—"}</td>
      <td>
        {sug ? (
          <Badge tone="info">{humanizeSlug(sug)}</Badge>
        ) : (
          <span className="text-text-subtle">—</span>
        )}
      </td>
      <td>
        {conf != null ? <Badge tone={confTone}>{Math.round(conf * 100)}%</Badge> : <span className="text-text-subtle">—</span>}
      </td>
      <td className="pr-4">
        <Button size="sm" onClick={onOpen}>Open</Button>
      </td>
    </tr>
  );
}

// ── Drawer ──────────────────────────────────────────────────────────────────

function ReviewDrawer({
  item, onClose, onResolve, busy,
}: {
  item: ReviewItem | null;
  onClose(): void;
  onResolve(id: string, input: { action: ResolveAction; entity?: string; category_tax?: string; category_budget?: string }): Promise<void>;
  busy: boolean;
}) {
  const [entity, setEntity] = useState(item?.suggested_entity ?? item?.current_entity ?? "elyse_coaching");
  const [categoryTax, setCategoryTax] = useState(item?.suggested_category_tax ?? item?.current_category_tax ?? "");
  const [categoryBudget, setCategoryBudget] = useState(item?.suggested_category_budget ?? "");

  // Sync state when a different item is opened.
  useMemo(() => {
    if (item) {
      setEntity(item.suggested_entity ?? item.current_entity ?? "elyse_coaching");
      setCategoryTax(item.suggested_category_tax ?? item.current_category_tax ?? "");
      setCategoryBudget(item.suggested_category_budget ?? "");
    }
  }, [item?.id]);

  if (!item) return null;

  return (
    <Drawer
      open={!!item}
      onClose={onClose}
      title={item.merchant_name ?? item.description ?? "Review"}
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button onClick={() => void onResolve(item.id, { action: "skip" })} disabled={busy}>Skip</Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              variant="success"
              onClick={() => void onResolve(item.id, { action: "accept" })}
              disabled={busy || !item.suggested_entity}
              title={!item.suggested_entity ? "No suggestion to accept — pick a category and use Apply" : ""}
            >
              Accept suggestion
            </Button>
            <Button
              variant="primary"
              onClick={() => void onResolve(item.id, { action: "classify", entity, category_tax: categoryTax || undefined, category_budget: categoryBudget || undefined })}
              disabled={busy || !categoryTax}
            >
              Apply override
            </Button>
          </div>
        </div>
      }
    >
      <dl className="grid grid-cols-2 gap-3 text-sm mb-4">
        <div><dt className="text-xs text-text-muted">Date</dt><dd className="text-text-primary">{item.posted_date ?? "—"}</dd></div>
        <div><dt className="text-xs text-text-muted">Amount</dt><dd className="text-text-primary tabular-nums">{fmtUsd(item.amount, { sign: true })}</dd></div>
        <div><dt className="text-xs text-text-muted">Account</dt><dd className="text-text-primary">{item.account_name ?? "—"}</dd></div>
        <div><dt className="text-xs text-text-muted">Owner</dt><dd className="text-text-primary">{item.owner_tag ?? "—"}</dd></div>
        <div className="col-span-2"><dt className="text-xs text-text-muted">Description</dt><dd className="text-text-primary">{item.description ?? "—"}</dd></div>
      </dl>

      {item.details && (
        <div className="mb-4">
          <div className="text-xs text-text-muted mb-1">Why this is in the queue</div>
          <pre className="whitespace-pre-wrap text-sm bg-bg-elevated rounded-md p-3 text-text-primary">{item.details}</pre>
        </div>
      )}

      {item.needs_input && (
        <div className="mb-4">
          <div className="text-xs text-text-muted mb-1">What I need from you</div>
          <p className="text-sm text-text-primary">{item.needs_input}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-text-muted mb-1">Entity</label>
          <Select value={entity} onChange={(e) => setEntity(e.target.value)} className="w-full">
            {ENTITY_OPTIONS.map(({ slug, label }) => (
              <option key={slug} value={slug}>{label}</option>
            ))}
          </Select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Tax category</label>
          <Select value={categoryTax} onChange={(e) => setCategoryTax(e.target.value)} className="w-full">
            <option value="">— none —</option>
            {CATEGORY_OPTIONS.map(({ slug, label }) => (
              <option key={slug} value={slug}>{label}</option>
            ))}
          </Select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Budget category (optional)</label>
          <Select value={categoryBudget} onChange={(e) => setCategoryBudget(e.target.value)} className="w-full">
            <option value="">— none —</option>
            {CATEGORY_OPTIONS.filter((c) => c.kind === "budget").map(({ slug, label }) => (
              <option key={slug} value={slug}>{label}</option>
            ))}
          </Select>
        </div>
      </div>
    </Drawer>
  );
}
