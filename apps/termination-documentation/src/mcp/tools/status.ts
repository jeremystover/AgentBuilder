import type {
  CaseState,
  ChecklistCategory,
  ChecklistItem,
  ChecklistStatus,
} from '../../lib/case-state.js';

export interface StatusInput {
  /** How many pending items to surface as "next up". Default 5. */
  next_up_limit?: number;
}

export interface StatusOutput {
  profile: CaseState['profile'];
  checklist_summary: {
    total: number;
    open: number;
    collected: number;
    by_status: Record<ChecklistStatus, number>;
    by_category: Record<string, { open: number; collected: number; total: number }>;
  };
  next_up: Array<{
    id: string;
    category: ChecklistCategory;
    description: string;
    statute_hook?: string;
    location_hint?: string;
    notes?: string;
  }>;
  drive_folder_url: string | null;
  memo_doc_url: string | null;
  exit_progress: {
    total: number;
    done: number;
    remaining: number;
  };
}

export function status(state: CaseState, input: StatusInput): StatusOutput {
  const limit = Math.max(1, Math.min(50, input.next_up_limit ?? 5));

  const byStatus: Record<ChecklistStatus, number> = {
    pending: 0,
    have: 0,
    collected: 0,
    unavailable: 0,
    skipped: 0,
  };
  const byCategory: Record<string, { open: number; collected: number; total: number }> = {};

  for (const item of state.checklist) {
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    const b =
      byCategory[item.category] ??
      (byCategory[item.category] = { open: 0, collected: 0, total: 0 });
    b.total++;
    if (item.status === 'pending' || item.status === 'have') b.open++;
    if (item.status === 'collected') b.collected++;
  }

  const open = byStatus.pending + byStatus.have;
  const collected = byStatus.collected;

  // "Next up" prioritizes pending before have, and within that category-order from the catalog.
  const categoryOrder: ChecklistCategory[] = [
    'employment-terms',
    'hr-process',
    'performance',
    'protected-activity',
    'comms',
    'comparators',
    'financial',
    'medical',
    'witnesses',
    'exit-artifacts',
  ];
  const prioritized = [...state.checklist]
    .filter((i) => i.status === 'pending' || i.status === 'have')
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
      return categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
    })
    .slice(0, limit)
    .map((i: ChecklistItem) => ({
      id: i.id,
      category: i.category,
      description: i.description,
      statute_hook: i.statuteHook,
      location_hint: i.locationHint,
      notes: i.notes,
    }));

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
    checklist_summary: {
      total: state.checklist.length,
      open,
      collected,
      by_status: byStatus,
      by_category: byCategory,
    },
    next_up: prioritized,
    drive_folder_url: driveFolderUrl,
    memo_doc_url: memoDocUrl,
    exit_progress: {
      total: exitTotal,
      done: exitDone,
      remaining: exitTotal - exitDone,
    },
  };
}
