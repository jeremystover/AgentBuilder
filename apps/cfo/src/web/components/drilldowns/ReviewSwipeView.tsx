import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, ArrowLeftRight, Check, X, RotateCcw, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge, Input, Select, fmtUsd } from "../ui";
import { txAmountColor } from "../../utils/txColor";
import {
  api, type Entity, type Category, type AccountRow, type ReviewRow, type ReviewListResponse,
} from "../../api";

// Mobile-only swipe triage for the review queue. One staged transaction per
// card: swipe right (or tap Approve) approves it; swipe left (or tap Skip)
// advances without touching it — skipped rows stay staged and reappear on
// refresh. The desktop ReviewQueueView is untouched.

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
  entities: Entity[],
): Category[] {
  if (!entityId) return cats;
  const ent = entities.find(e => e.id === entityId);
  if (!ent) return cats;
  return cats.filter(c => c.entity_type === "all" || c.entity_type === ent.type);
}

const SWIPE_THRESHOLD = 90;

export function ReviewSwipeView() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [cards, setCards] = useState<ReviewRow[]>([]);
  // Ids approved or skipped this session — removed from the deck either way.
  const [actedIds, setActedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [approved, setApproved] = useState(0);
  const [skipped, setSkipped] = useState(0);

  // Pending PUT chain — approve awaits it so an in-flight entity/category edit
  // lands before the row is promoted to the ledger.
  const savesRef = useRef<Promise<unknown>>(Promise.resolve());

  const loadCards = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<ReviewListResponse>(
        "/api/web/review?status=staged&sort_by=date&sort_dir=asc&limit=500&offset=0",
      );
      setCards(res.rows);
      setActedIds(new Set());
      setApproved(0);
      setSkipped(0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

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
    void loadCards();
  }, [loadCards]);

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

  const accountById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);

  // Deck = loaded cards not yet acted on, narrowed by the search box.
  const remaining = useMemo(() => cards.filter(c => !actedIds.has(c.id)), [cards, actedIds]);
  const deck = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return remaining;
    return remaining.filter(c =>
      c.description.toLowerCase().includes(q) ||
      (c.merchant?.toLowerCase().includes(q) ?? false),
    );
  }, [remaining, query]);
  const current = deck[0] ?? null;

  // Optimistic local edit + queued PUT.
  const updateCard = useCallback((id: string, patch: Partial<ReviewRow>) => {
    setCards(prev => prev.map(c => (c.id === id ? { ...c, ...patch } : c)));
    savesRef.current = savesRef.current
      .catch(() => {})
      .then(() => api.put(`/api/web/review/${id}`, patch))
      .catch(e => toast.error(e instanceof Error ? e.message : String(e)));
  }, []);

  const handleApprove = useCallback(() => {
    if (!current) return;
    const id = current.id;
    setActedIds(prev => new Set(prev).add(id));
    setApproved(n => n + 1);
    void (async () => {
      try {
        await savesRef.current;
        await api.post(`/api/web/review/${id}/approve`);
      } catch (e) {
        toast.error(`Approve failed: ${e instanceof Error ? e.message : String(e)}`);
        void loadCards();
      }
    })();
  }, [current, loadCards]);

  const handleSkip = useCallback(() => {
    if (!current) return;
    setActedIds(prev => new Set(prev).add(current.id));
    setSkipped(n => n + 1);
  }, [current]);

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return <div className="p-6 text-center text-sm text-text-muted">Loading review queue…</div>;
  }

  const total = cards.length;
  const trimmedQuery = query.trim();

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-surface">
        <div className="text-sm font-semibold">
          Review
          {current && (
            <span className="text-text-muted font-normal">
              {" · "}
              {trimmedQuery
                ? `${deck.length} match${deck.length === 1 ? "" : "es"}`
                : `${actedIds.size + 1} of ${total}`}
            </span>
          )}
        </div>
        <button
          onClick={() => void loadCards()}
          className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary"
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      <div className="px-4 py-2 border-b border-border bg-bg-surface">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
          <Input
            type="text"
            placeholder="Search description or merchant"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full pl-9 pr-9"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {total > 0 && (
        <div className="h-1 bg-bg-elevated">
          <div
            className="h-full bg-accent-primary transition-all"
            style={{ width: `${(actedIds.size / total) * 100}%` }}
          />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {current ? (
          <SwipeCard
            key={current.id}
            row={current}
            entities={entities}
            categories={categories}
            account={current.account_id ? accountById.get(current.account_id) ?? null : null}
            ambiguous={ambiguousCategoryNames}
            onUpdate={updateCard}
            onApprove={handleApprove}
            onSkip={handleSkip}
          />
        ) : (
          <EmptyDeck
            total={total}
            hasRemaining={remaining.length > 0}
            query={trimmedQuery}
            approved={approved}
            skipped={skipped}
            onClearSearch={() => setQuery("")}
            onRefresh={() => void loadCards()}
          />
        )}
      </div>
    </div>
  );
}

interface EmptyDeckProps {
  total: number;
  hasRemaining: boolean;
  query: string;
  approved: number;
  skipped: number;
  onClearSearch: () => void;
  onRefresh: () => void;
}

function EmptyDeck({ total, hasRemaining, query, approved, skipped, onClearSearch, onRefresh }: EmptyDeckProps) {
  // Search matched nothing, but there are still un-triaged cards.
  if (query && hasRemaining) {
    return (
      <div className="flex flex-col items-center justify-center text-center pt-16 gap-3">
        <div className="w-14 h-14 rounded-full bg-bg-elevated flex items-center justify-center">
          <Search className="w-6 h-6 text-text-muted" />
        </div>
        <div className="font-semibold">No matches for “{query}”</div>
        <button
          onClick={onClearSearch}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-accent-primary text-white px-4 py-2 text-sm font-medium"
        >
          Clear search
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center text-center pt-16 gap-3">
      <div className="w-14 h-14 rounded-full bg-accent-success/10 flex items-center justify-center">
        <Check className="w-7 h-7 text-accent-success" />
      </div>
      <div className="font-semibold">{total === 0 ? "Nothing to review" : "All caught up"}</div>
      {total > 0 && (
        <div className="text-sm text-text-muted">{approved} approved · {skipped} skipped</div>
      )}
      <button
        onClick={onRefresh}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-accent-primary text-white px-4 py-2 text-sm font-medium"
      >
        <RotateCcw className="w-4 h-4" /> {skipped > 0 ? "Review skipped" : "Refresh"}
      </button>
    </div>
  );
}

interface SwipeCardProps {
  row: ReviewRow;
  entities: Entity[];
  categories: Category[];
  account: AccountRow | null;
  ambiguous: Set<string>;
  onUpdate: (id: string, patch: Partial<ReviewRow>) => void;
  onApprove: () => void;
  onSkip: () => void;
}

function SwipeCard({ row, entities, categories, account, ambiguous, onUpdate, onApprove, onSkip }: SwipeCardProps) {
  const [dx, setDx] = useState(0);
  const [animate, setAnimate] = useState(false);
  const [exiting, setExiting] = useState(false);
  const drag = useRef<{ active: boolean; startX: number; startY: number; horiz: boolean | null }>({
    active: false, startX: 0, startY: 0, horiz: null,
  });

  const effectiveEntityId = row.entity_id ?? account?.entity_id ?? "";

  const commit = (dir: "approve" | "skip") => {
    if (exiting) return;
    setExiting(true);
    setAnimate(true);
    setDx(dir === "approve" ? window.innerWidth : -window.innerWidth);
    window.setTimeout(() => (dir === "approve" ? onApprove() : onSkip()), 200);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (exiting) return;
    drag.current = { active: true, startX: e.clientX, startY: e.clientY, horiz: null };
    setAnimate(false);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.active) return;
    const moveX = e.clientX - d.startX;
    const moveY = e.clientY - d.startY;
    if (d.horiz === null && (Math.abs(moveX) > 8 || Math.abs(moveY) > 8)) {
      d.horiz = Math.abs(moveX) > Math.abs(moveY);
    }
    if (d.horiz) setDx(moveX);
  };

  const onPointerUp = () => {
    const d = drag.current;
    if (!d.active) return;
    d.active = false;
    if (dx > SWIPE_THRESHOLD) {
      commit("approve");
    } else if (dx < -SWIPE_THRESHOLD) {
      commit("skip");
    } else {
      setAnimate(true);
      setDx(0);
    }
  };

  const intent = dx > 20 ? "approve" : dx < -20 ? "skip" : null;
  const overlayOpacity = Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD);
  const cats = filterCategoriesByEntity(categories, effectiveEntityId, entities);

  return (
    <div className="max-w-md mx-auto">
      <div
        className="relative rounded-2xl border border-border bg-bg-surface shadow-sm select-none"
        style={{
          transform: `translateX(${dx}px) rotate(${dx / 28}deg)`,
          transition: animate ? "transform 0.2s ease-out" : "none",
        }}
      >
        {/* Swipe-intent overlays */}
        <div
          className="absolute top-4 left-4 z-10 rounded-lg border-2 border-accent-success px-2 py-0.5 text-sm font-bold text-accent-success"
          style={{ opacity: intent === "approve" ? overlayOpacity : 0 }}
        >
          APPROVE
        </div>
        <div
          className="absolute top-4 right-4 z-10 rounded-lg border-2 border-text-muted px-2 py-0.5 text-sm font-bold text-text-muted"
          style={{ opacity: intent === "skip" ? overlayOpacity : 0 }}
        >
          SKIP
        </div>

        {/* Drag handle — transaction summary */}
        <div
          className="px-5 pt-5 pb-4 cursor-grab active:cursor-grabbing"
          style={{ touchAction: "pan-y" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-text-muted">{row.date}</span>
            <span className={`text-xl font-semibold ${txAmountColor(row.amount, account?.type ?? null, row.category_slug)}`}>
              {fmtUsd(row.amount, { sign: true })}
            </span>
          </div>
          <div className="mt-1 font-medium text-text-primary break-words">{row.description}</div>
          {row.merchant && row.merchant !== row.description && (
            <div className="text-sm text-text-muted break-words">{row.merchant}</div>
          )}
          <div className="mt-1 text-xs text-text-muted">{row.account_name ?? "—"}</div>
          {(row.is_transfer || row.is_reimbursable || row.waiting_for) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {row.is_transfer && <Badge tone="info"><ArrowLeftRight className="w-3 h-3" /> transfer</Badge>}
              {row.is_reimbursable && <Badge tone="warn">reimbursable</Badge>}
              {row.waiting_for && <Badge tone="warn">waiting: {row.waiting_for}</Badge>}
            </div>
          )}
          {row.ai_notes && (
            <div className="mt-2 rounded-lg bg-bg-elevated px-3 py-2 text-xs text-text-muted">
              {row.ai_notes}
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="border-t border-border px-5 py-4 space-y-3">
          <div>
            <label className="block text-xs uppercase text-text-muted mb-1">Entity</label>
            <Select
              className="w-full"
              value={effectiveEntityId}
              onChange={e => onUpdate(row.id, { entity_id: e.target.value || null })}
            >
              <option value="">—</option>
              {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-xs uppercase text-text-muted mb-1">Category</label>
            <Select
              className="w-full"
              value={row.category_id ?? ""}
              onChange={e => onUpdate(row.id, { category_id: e.target.value || null, classification_method: "manual" })}
            >
              <option value="">—</option>
              {cats.map(c => <option key={c.id} value={c.id}>{categoryLabel(c, ambiguous)}</option>)}
            </Select>
          </div>
          <div className="flex gap-2">
            <TogglePill
              active={row.is_transfer}
              onClick={() => onUpdate(row.id, { is_transfer: !row.is_transfer })}
            >
              <ArrowLeftRight className="w-4 h-4" /> Transfer
            </TogglePill>
            <TogglePill
              active={row.is_reimbursable}
              onClick={() => onUpdate(row.id, { is_reimbursable: !row.is_reimbursable })}
            >
              Reimbursable
            </TogglePill>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="mt-4 flex gap-3">
        <button
          onClick={() => commit("skip")}
          disabled={exiting}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-surface py-3 font-medium text-text-muted active:bg-bg-elevated disabled:opacity-40"
        >
          <X className="w-5 h-5" /> Skip
        </button>
        <button
          onClick={() => commit("approve")}
          disabled={exiting}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-accent-success py-3 font-medium text-white active:opacity-90 disabled:opacity-40"
        >
          <Check className="w-5 h-5" /> Approve
        </button>
      </div>
      <div className="mt-2 text-center text-xs text-text-subtle">
        Swipe right to approve · left to skip
      </div>
    </div>
  );
}

function TogglePill({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        "flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors " +
        (active
          ? "border-accent-primary bg-accent-primary/10 text-accent-primary"
          : "border-border text-text-muted")
      }
    >
      {children}
    </button>
  );
}
