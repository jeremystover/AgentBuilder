import {
  type CaseState,
  type ChecklistCategory,
  type ChecklistItem,
  makeChecklistId,
} from '../../lib/case-state.js';
import { catalogFor } from '../../lib/checklist-catalog.js';

export interface BuildEvidencePlanInput {
  /** If true, replace any existing catalog-derived items. Defaults to false (preserves user-added items and collected status). */
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
 * Seeds the in-memory checklist from the curated catalog based on the user's
 * suspected claim types. Intentionally does NOT touch Google Drive yet —
 * that comes in a later commit once OAuth is wired up.
 *
 * Custom items (added via update_checklist with action='add') are preserved
 * across re-runs. Items already collected keep their collected status.
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
    });
    created++;
  }

  const byCategory: Record<string, number> = {};
  for (const cat of Object.keys(groupByCategory(next))) {
    byCategory[cat] = groupByCategory(next)[cat as ChecklistCategory]?.length ?? 0;
  }

  const notesToUser: string[] = [];
  if (state.profile.suspectedClaims.length === 0) {
    notesToUser.push(
      'No suspected claims recorded yet — seeded the "always" portion of the catalog. Re-run after intake_interview captures suspected_claims for a tailored list.',
    );
  }
  notesToUser.push(
    'Drive folder creation is not wired up yet in this build. The checklist is tracked locally in the Durable Object; the next agent release will auto-create the Drive case folder.',
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

function groupByCategory(items: ChecklistItem[]): Partial<Record<ChecklistCategory, ChecklistItem[]>> {
  const out: Partial<Record<ChecklistCategory, ChecklistItem[]>> = {};
  for (const item of items) {
    const bucket = out[item.category] ?? [];
    bucket.push(item);
    out[item.category] = bucket;
  }
  return out;
}
