import {
  ALL_CATEGORIES,
  type CaseState,
  type ChecklistCategory,
  type ChecklistItem,
  type ChecklistStatus,
  type LocationHint,
  makeChecklistId,
} from '../../lib/case-state.js';

export type UpdateChecklistAction =
  | 'add'
  | 'update'
  | 'mark_have'
  | 'mark_collected'
  | 'mark_unavailable'
  | 'skip'
  | 'restore';

export interface UpdateChecklistInput {
  action: UpdateChecklistAction;
  /** Required for update / mark_* / skip / restore. */
  id?: string;
  /** Required for add. */
  category?: ChecklistCategory;
  /** Required for add; optional for update. */
  description?: string;
  statute_hook?: string;
  status?: ChecklistStatus;
  location_hint?: LocationHint;
  drive_file_id?: string;
  notes?: string;
}

export interface UpdateChecklistOutput {
  item: ChecklistItem;
  open_item_count: number;
  collected_item_count: number;
}

const CATEGORY_SET = new Set<ChecklistCategory>(ALL_CATEGORIES);

export function updateChecklist(
  state: CaseState,
  input: UpdateChecklistInput,
): { state: CaseState; output: UpdateChecklistOutput } {
  const checklist = [...state.checklist];

  if (input.action === 'add') {
    if (!input.category || !CATEGORY_SET.has(input.category)) {
      throw new Error(
        `add requires a valid category (one of ${ALL_CATEGORIES.join(', ')})`,
      );
    }
    if (!input.description || input.description.trim().length === 0) {
      throw new Error('add requires a non-empty description');
    }
    const item: ChecklistItem = {
      id: makeChecklistId(),
      category: input.category,
      description: input.description.trim(),
      statuteHook: input.statute_hook,
      status: input.status ?? 'pending',
      locationHint: input.location_hint,
      driveFileId: input.drive_file_id,
      notes: input.notes,
      custom: true,
    };
    checklist.push(item);
    return buildOutput(state, checklist, item);
  }

  if (!input.id) {
    throw new Error(`action=${input.action} requires id`);
  }
  const idx = checklist.findIndex((i) => i.id === input.id);
  if (idx < 0) throw new Error(`No checklist item with id=${input.id}`);
  const current = checklist[idx]!;

  const merged: ChecklistItem = { ...current };

  switch (input.action) {
    case 'update':
      if (input.description !== undefined) merged.description = input.description;
      if (input.statute_hook !== undefined) merged.statuteHook = input.statute_hook;
      if (input.status !== undefined) merged.status = input.status;
      if (input.location_hint !== undefined) merged.locationHint = input.location_hint;
      if (input.drive_file_id !== undefined) merged.driveFileId = input.drive_file_id;
      if (input.notes !== undefined) merged.notes = input.notes;
      break;
    case 'mark_have':
      merged.status = 'have';
      if (input.location_hint) merged.locationHint = input.location_hint;
      if (input.notes !== undefined) merged.notes = input.notes;
      break;
    case 'mark_collected':
      merged.status = 'collected';
      if (input.drive_file_id !== undefined) merged.driveFileId = input.drive_file_id;
      if (input.notes !== undefined) merged.notes = input.notes;
      break;
    case 'mark_unavailable':
      merged.status = 'unavailable';
      if (input.notes !== undefined) merged.notes = input.notes;
      break;
    case 'skip':
      merged.status = 'skipped';
      if (input.notes !== undefined) merged.notes = input.notes;
      break;
    case 'restore':
      merged.status = 'pending';
      break;
  }

  checklist[idx] = merged;
  return buildOutput(state, checklist, merged);
}

function buildOutput(
  state: CaseState,
  checklist: ChecklistItem[],
  item: ChecklistItem,
): { state: CaseState; output: UpdateChecklistOutput } {
  const open = checklist.filter(
    (i) => i.status === 'pending' || i.status === 'have',
  ).length;
  const collected = checklist.filter((i) => i.status === 'collected').length;
  return {
    state: { ...state, checklist },
    output: {
      item,
      open_item_count: open,
      collected_item_count: collected,
    },
  };
}
