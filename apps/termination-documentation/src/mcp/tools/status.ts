import type {
  CaseState,
  ChecklistCategory,
  ChecklistItem,
  ChecklistStatus,
  ClaimType,
  SignalFlag,
} from '../../lib/case-state.js';

export interface StatusInput {
  /** How many pending items to surface as "next up". Default 5. */
  next_up_limit?: number;
  /** How many top-scored items to surface. Default 10. */
  top_scored_limit?: number;
}

export interface StatusOutput {
  profile: CaseState['profile'];
  suspected_claims: ClaimType[];
  checklist_summary: {
    total: number;
    open: number;
    collected: number;
    by_status: Record<ChecklistStatus, number>;
    by_category: Record<string, { open: number; collected: number; total: number }>;
    by_signal_flag: Record<string, number>;
  };
  next_up: Array<ItemDigest>;
  top_scored: Array<ItemDigest & { composite_score: number }>;
  drive_folder_url: string | null;
  memo_doc_url: string | null;
  exit_progress: { total: number; done: number; remaining: number };
}

interface ItemDigest {
  id: string;
  category: ChecklistCategory;
  description: string;
  status: ChecklistStatus;
  statute_hook?: string;
  location_hint?: string;
  notes?: string;
  signal_flags?: SignalFlag[];
  scores?: ChecklistItem['scores'];
  why_it_matters?: string;
}

export function status(state: CaseState, input: StatusInput): StatusOutput {
  const nextUpLimit = clamp(input.next_up_limit ?? 5, 1, 50);
  const topScoredLimit = clamp(input.top_scored_limit ?? 10, 1, 50);

  const byStatus: Record<ChecklistStatus, number> = {
    pending: 0,
    have: 0,
    collected: 0,
    unavailable: 0,
    skipped: 0,
  };
  const byCategory: Record<string, { open: number; collected: number; total: number }> = {};
  const bySignalFlag: Record<string, number> = {};

  for (const item of state.checklist) {
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    const b =
      byCategory[item.category] ??
      (byCategory[item.category] = { open: 0, collected: 0, total: 0 });
    b.total++;
    if (item.status === 'pending' || item.status === 'have') b.open++;
    if (item.status === 'collected') b.collected++;
    for (const f of item.signalFlags ?? []) {
      bySignalFlag[f] = (bySignalFlag[f] ?? 0) + 1;
    }
  }

  const open = byStatus.pending + byStatus.have;
  const collected = byStatus.collected;

  // "Next up" — pending/have items, prioritized by (a) signal-flag presence, (b) pending over have, (c) catalog category order.
  const categoryOrder: ChecklistCategory[] = [
    'adverse-action-separation',
    'performance',
    'medical-leave-accommodation',
    'interactive-process',
    'age-evidence',
    'protected-activity',
    'hr-process',
    'employment-terms',
    'comms',
    'comparators',
    'financial',
    'witnesses',
    'exit-artifacts',
  ];

  const pendingOrHave = state.checklist.filter(
    (i) => i.status === 'pending' || i.status === 'have',
  );
  const nextUp = [...pendingOrHave]
    .sort((a, b) => {
      const aFlags = a.signalFlags?.length ?? 0;
      const bFlags = b.signalFlags?.length ?? 0;
      if (aFlags !== bFlags) return bFlags - aFlags;
      if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
      return categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
    })
    .slice(0, nextUpLimit)
    .map(toDigest);

  // Top-scored — collected items ranked by composite score. This is a
  // lightweight precursor to the dedicated generate_top_packet tool (step 5).
  const topScored = state.checklist
    .filter((i) => i.status === 'collected' || i.status === 'have')
    .map((i) => ({ item: i, score: compositeScore(i) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topScoredLimit)
    .map((x) => ({ ...toDigest(x.item), composite_score: x.score }));

  const driveFolderUrl = state.drive.rootFolderId
    ? `https://drive.google.com/drive/folders/${state.drive.rootFolderId}`
    : null;
  const memoDocUrl = state.memo.docId
    ? `https://docs.google.com/document/d/${state.memo.docId}/edit`
    : null;

  const exitDone = state.exitTasks.filter((t) => t.status === 'done').length;
  const exitTotal = state.exitTasks.length;

  return {
    profile: state.profile,
    suspected_claims: state.profile.suspectedClaims,
    checklist_summary: {
      total: state.checklist.length,
      open,
      collected,
      by_status: byStatus,
      by_category: byCategory,
      by_signal_flag: bySignalFlag,
    },
    next_up: nextUp,
    top_scored: topScored,
    drive_folder_url: driveFolderUrl,
    memo_doc_url: memoDocUrl,
    exit_progress: { total: exitTotal, done: exitDone, remaining: exitTotal - exitDone },
  };
}

function toDigest(item: ChecklistItem): ItemDigest {
  return {
    id: item.id,
    category: item.category,
    description: item.description,
    status: item.status,
    statute_hook: item.statuteHook,
    location_hint: item.locationHint,
    notes: item.notes,
    signal_flags: item.signalFlags,
    scores: item.scores,
    why_it_matters: item.whyItMatters,
  };
}

/**
 * Lightweight weighted score. Relevance/reliability/timingProximity add;
 * confidentialityRisk subtracts; signal-flag count adds a small bonus.
 * Intentionally conservative — the dedicated Top-N tool (step 5) will do
 * better grouping by signal-flag category.
 */
function compositeScore(item: ChecklistItem): number {
  const s = item.scores;
  if (!s && !item.signalFlags?.length) return 0;
  const rel = s?.relevance ?? 0;
  const rely = s?.reliability ?? 0;
  const tp = s?.timingProximity ?? 0;
  const risk = s?.confidentialityRisk ?? 0;
  const flagBonus = (item.signalFlags?.length ?? 0) * 0.5;
  return rel * 2 + rely + tp * 1.5 - risk * 0.5 + flagBonus;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
