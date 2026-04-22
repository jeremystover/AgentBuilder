import {
  type CaseState,
  type ChecklistCategory,
  type ChecklistItem,
  makeChecklistId,
} from '../../lib/case-state.js';
import { catalogFor } from '../../lib/checklist-catalog.js';

export interface BuildEvidencePlanInput {
  /** If true, drop still-pending catalog-derived items and reseed. Custom items and collected items are always preserved. */
  reseed?: boolean;
}

export interface BuildEvidencePlanOutput {
  created_item_count: number;
  skipped_existing_count: number;
  total_items: number;
  items_by_category: Record<string, number>;
  drive_setup_pending: true;
  notes_to_user: string[];
}

/**
 * Seeds the checklist from the curated CA + federal catalog based on the
 * user's suspected claim types. Catalog items ship with any default signal
 * flags the entry defines (e.g. a "recent praise from manager" item ships
 * tagged `praise-before-termination` on collection).
 *
 * Does NOT touch Google Drive in this build — that lands once OAuth is wired.
 */
export function buildEvidencePlan(
  state: CaseState,
  input: BuildEvidencePlanInput,
): { state: CaseState; output: BuildEvidencePlanOutput } {
  const existing = state.checklist;
  const keep: ChecklistItem[] = input.reseed
    ? existing.filter((i) => i.custom || i.status === 'collected' || i.status === 'have')
    : [...existing];

  const existingDescriptions = new Set(keep.map((i) => normalize(i.description)));

  const entries = catalogFor(state.profile.suspectedClaims);
  let created = 0;
  let skipped = 0;
  const next: ChecklistItem[] = [...keep];

  for (const { category, entry } of entries) {
    if (existingDescriptions.has(normalize(entry.description))) {
      skipped++;
      continue;
    }
    next.push({
      id: makeChecklistId(),
      category,
      description: entry.description,
      statuteHook: entry.statuteHook,
      status: 'pending',
      claimTags: entry.relevantTo === 'always' ? undefined : [...entry.relevantTo],
      signalFlags: entry.defaultSignalFlags ? [...entry.defaultSignalFlags] : undefined,
    });
    created++;
  }

  const byCategory: Record<string, number> = {};
  const grouped = groupByCategory(next);
  for (const cat of Object.keys(grouped) as ChecklistCategory[]) {
    byCategory[cat] = grouped[cat]?.length ?? 0;
  }

  const notesToUser: string[] = [];
  if (state.profile.suspectedClaims.length === 0) {
    notesToUser.push(
      'No suspected claims recorded yet — seeded only the "always" catalog entries. Re-run after intake_interview captures suspected_claims for a fully tailored list.',
    );
  }
  notesToUser.push(
    'Drive folder creation is not wired up yet. The checklist is tracked in the Durable Object; the next release will auto-create the Drive case folder.',
  );

  return {
    state: { ...state, checklist: next },
    output: {
      created_item_count: created,
      skipped_existing_count: skipped,
      total_items: next.length,
      items_by_category: byCategory,
      drive_setup_pending: true,
      notes_to_user: notesToUser,
    },
  };
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function groupByCategory(
  items: ChecklistItem[],
): Partial<Record<ChecklistCategory, ChecklistItem[]>> {
  const out: Partial<Record<ChecklistCategory, ChecklistItem[]>> = {};
  for (const item of items) {
    const bucket = out[item.category] ?? [];
    bucket.push(item);
    out[item.category] = bucket;
  }
  return out;
}
