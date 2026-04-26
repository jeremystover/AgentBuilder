import {
  ALL_CATEGORIES,
  ALL_CLAIM_TYPES,
  ALL_SIGNAL_FLAGS,
  ALL_SOURCE_TYPES,
  type CaseState,
  type ChecklistCategory,
  type ChecklistItem,
  type ChecklistStatus,
  type ClaimType,
  type ItemAuthor,
  type ItemScores,
  type LocationHint,
  type Score,
  type SignalFlag,
  type SourceType,
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

  // v2 evidence-index fields
  file_name?: string;
  source_type?: SourceType;
  date_created?: string;
  date_event?: string;
  author?: {
    name?: string;
    role?: string;
    is_decisionmaker?: boolean;
  };
  recipients?: string[];
  exact_quotes?: string[];
  why_it_matters?: string;
  claim_tags?: string[];
  scores?: {
    relevance?: number;
    reliability?: number;
    timing_proximity?: number;
    confidentiality_risk?: number;
  };
  preserve_original?: boolean;
  authenticity_notes?: string;
  signal_flags?: string[];
}

export interface UpdateChecklistOutput {
  item: ChecklistItem;
  open_item_count: number;
  collected_item_count: number;
}

const CATEGORY_SET = new Set<ChecklistCategory>(ALL_CATEGORIES);
const CLAIM_SET = new Set<ClaimType>(ALL_CLAIM_TYPES);
const SIGNAL_SET = new Set<SignalFlag>(ALL_SIGNAL_FLAGS);
const SOURCE_SET = new Set<SourceType>(ALL_SOURCE_TYPES);

function clampScore(n: number | undefined): Score | undefined {
  if (n === undefined) return undefined;
  const r = Math.round(n);
  if (r < 1 || r > 5) return undefined;
  return r as Score;
}

function coerceClaimTags(input: string[] | undefined): ClaimType[] | undefined {
  if (!input) return undefined;
  const out = input.filter((c) => CLAIM_SET.has(c as ClaimType)) as ClaimType[];
  return out.length ? Array.from(new Set(out)) : undefined;
}

function coerceSignalFlags(input: string[] | undefined): SignalFlag[] | undefined {
  if (!input) return undefined;
  const out = input.filter((f) => SIGNAL_SET.has(f as SignalFlag)) as SignalFlag[];
  return out.length ? Array.from(new Set(out)) : undefined;
}

function coerceSourceType(input: SourceType | undefined): SourceType | undefined {
  if (!input) return undefined;
  return SOURCE_SET.has(input) ? input : undefined;
}

/** Apply the v2 evidence-index fields in the input to an item, mutating in place. */
function applyRichFields(target: ChecklistItem, input: UpdateChecklistInput): void {
  if (input.file_name !== undefined) target.fileName = input.file_name;
  const srcType = coerceSourceType(input.source_type);
  if (srcType !== undefined) target.sourceType = srcType;
  if (input.date_created !== undefined) target.dateCreated = input.date_created;
  if (input.date_event !== undefined) target.dateEvent = input.date_event;

  if (input.author !== undefined) {
    const author: ItemAuthor = { ...(target.author ?? {}) };
    if (input.author.name !== undefined) author.name = input.author.name;
    if (input.author.role !== undefined) author.role = input.author.role;
    if (input.author.is_decisionmaker !== undefined)
      author.isDecisionmaker = input.author.is_decisionmaker;
    target.author = author;
  }

  if (input.recipients !== undefined) target.recipients = [...input.recipients];
  if (input.exact_quotes !== undefined) target.exactQuotes = [...input.exact_quotes];
  if (input.why_it_matters !== undefined) target.whyItMatters = input.why_it_matters;

  const claimTags = coerceClaimTags(input.claim_tags);
  if (claimTags !== undefined) target.claimTags = claimTags;

  if (input.scores !== undefined) {
    const scores: ItemScores = { ...(target.scores ?? {}) };
    const rel = clampScore(input.scores.relevance);
    const rely = clampScore(input.scores.reliability);
    const tp = clampScore(input.scores.timing_proximity);
    const cr = clampScore(input.scores.confidentiality_risk);
    if (rel !== undefined) scores.relevance = rel;
    if (rely !== undefined) scores.reliability = rely;
    if (tp !== undefined) scores.timingProximity = tp;
    if (cr !== undefined) scores.confidentialityRisk = cr;
    target.scores = scores;
  }

  if (input.preserve_original !== undefined) target.preserveOriginal = input.preserve_original;
  if (input.authenticity_notes !== undefined) target.authenticityNotes = input.authenticity_notes;

  const signalFlags = coerceSignalFlags(input.signal_flags);
  if (signalFlags !== undefined) target.signalFlags = signalFlags;
}

export function updateChecklist(
  state: CaseState,
  input: UpdateChecklistInput,
): { state: CaseState; output: UpdateChecklistOutput } {
  const checklist = [...state.checklist];

  if (input.action === 'add') {
    if (!input.category || !CATEGORY_SET.has(input.category)) {
      throw new Error(`add requires a valid category (one of ${ALL_CATEGORIES.join(', ')})`);
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
    applyRichFields(item, input);
    checklist.push(item);
    return buildOutput(state, checklist, item);
  }

  if (!input.id) throw new Error(`action=${input.action} requires id`);
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
      applyRichFields(merged, input);
      break;
    case 'mark_have':
      merged.status = 'have';
      if (input.location_hint) merged.locationHint = input.location_hint;
      if (input.notes !== undefined) merged.notes = input.notes;
      applyRichFields(merged, input);
      break;
    case 'mark_collected':
      merged.status = 'collected';
      if (input.drive_file_id !== undefined) merged.driveFileId = input.drive_file_id;
      if (input.notes !== undefined) merged.notes = input.notes;
      applyRichFields(merged, input);
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
  const open = checklist.filter((i) => i.status === 'pending' || i.status === 'have').length;
  const collected = checklist.filter((i) => i.status === 'collected').length;
  return {
    state: { ...state, checklist },
    output: { item, open_item_count: open, collected_item_count: collected },
  };
}
