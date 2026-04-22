import {
  type CaseState,
  type ChecklistCategory,
  type ChecklistItem,
  type DriveRefs,
  makeChecklistId,
} from '../../lib/case-state.js';
import { catalogFor } from '../../lib/checklist-catalog.js';
import { createFolder } from '../../lib/google/drive.js';
import { resolveGoogleAccessToken } from '../../lib/google/token-resolver.js';
import type { Env } from '../../../worker-configuration';

export interface BuildEvidencePlanInput {
  /** If true, drop still-pending catalog-derived items and reseed. Custom items and collected items are always preserved. */
  reseed?: boolean;
  /** If true, attempt to create the Drive case folder and category subfolders. Default true when Google is configured. */
  create_drive_folder?: boolean;
  /** User identifier for Google OAuth token lookup. Required if create_drive_folder and Google is configured. */
  user_id?: string;
}

export interface BuildEvidencePlanOutput {
  created_item_count: number;
  skipped_existing_count: number;
  total_items: number;
  items_by_category: Record<string, number>;
  drive_folder_url: string | null;
  drive_folder_id: string | null;
  drive_status: 'created' | 'already-existed' | 'skipped' | 'error';
  drive_error?: string;
  notes_to_user: string[];
}

const CATEGORY_LABELS: Record<ChecklistCategory, string> = {
  'employment-terms': 'A — Employment terms',
  performance: 'B — Performance and praise',
  'adverse-action-separation': 'C — Adverse action and separation',
  'medical-leave-accommodation': 'D — Medical, leave and accommodation',
  'interactive-process': 'E — Interactive process',
  'age-evidence': 'F — Age-related evidence',
  comms: 'G — Communications',
  'hr-process': 'H — HR process',
  'protected-activity': 'I — Protected activity',
  comparators: 'J — Comparators and replacement',
  financial: 'K — Damages',
  witnesses: 'L — Witnesses',
  'exit-artifacts': 'M — Exit artifacts',
};

/**
 * Seeds the checklist from the curated CA + federal catalog and — when
 * Google OAuth is wired up — creates a Drive case folder with one
 * subfolder per evidence category.
 *
 * Safe to re-run: custom checklist items and collected items are preserved,
 * and existing Drive folders on the state are reused.
 */
export async function buildEvidencePlan(
  state: CaseState,
  input: BuildEvidencePlanInput,
  env: Env,
): Promise<{ state: CaseState; output: BuildEvidencePlanOutput }> {
  // ── 1. Checklist seeding (pure local, always runs) ────────────────────────
  const existing = state.checklist;
  const keep: ChecklistItem[] = input.reseed
    ? existing.filter((i) => i.custom || i.status === 'collected' || i.status === 'have')
    : [...existing];

  const existingDescriptions = new Set(keep.map((i) => normalize(i.description)));
  const entries = catalogFor(state.profile.suspectedClaims);
  let created = 0;
  let skipped = 0;
  const nextChecklist: ChecklistItem[] = [...keep];

  for (const { category, entry } of entries) {
    if (existingDescriptions.has(normalize(entry.description))) {
      skipped++;
      continue;
    }
    nextChecklist.push({
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
  for (const item of nextChecklist) {
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
  }

  // ── 2. Drive folder creation (optional, best-effort) ─────────────────────
  const notes: string[] = [];
  let drive: DriveRefs = {
    rootFolderId: state.drive.rootFolderId,
    subfolderIds: { ...state.drive.subfolderIds },
  };
  let driveStatus: BuildEvidencePlanOutput['drive_status'] = 'skipped';
  let driveError: string | undefined;

  const tryDrive = input.create_drive_folder !== false;
  if (tryDrive) {
    if (drive.rootFolderId) {
      driveStatus = 'already-existed';
      notes.push(
        `Drive case folder already exists (id=${drive.rootFolderId}). Re-run with reseed=true to recreate.`,
      );
    } else if (!input.user_id) {
      notes.push(
        'Drive folder creation skipped: pass user_id on this tool call so the Google OAuth token can be looked up.',
      );
    } else {
      const tok = await resolveGoogleAccessToken(env, input.user_id);
      if (!tok.ok) {
        driveStatus = 'skipped';
        notes.push(`Drive folder creation skipped — ${tok.reason}`);
      } else {
        try {
          const rootName = caseFolderName(state);
          const root = await createFolder(tok.token, rootName);
          drive = { rootFolderId: root.id, subfolderIds: {} };

          // Create one subfolder per category we actually have items in.
          const activeCategories = Array.from(
            new Set(nextChecklist.map((i) => i.category)),
          ) as ChecklistCategory[];
          activeCategories.sort((a, b) =>
            (CATEGORY_LABELS[a] ?? a).localeCompare(CATEGORY_LABELS[b] ?? b),
          );

          for (const cat of activeCategories) {
            const sub = await createFolder(
              tok.token,
              CATEGORY_LABELS[cat] ?? cat,
              root.id,
            );
            drive.subfolderIds[cat] = sub.id;
          }
          driveStatus = 'created';
          notes.push(
            `Created Drive case folder "${rootName}" with ${activeCategories.length} category subfolders.`,
          );
        } catch (err) {
          driveStatus = 'error';
          driveError = err instanceof Error ? err.message : String(err);
          notes.push(`Drive folder creation failed: ${driveError}`);
        }
      }
    }
  }

  if (state.profile.suspectedClaims.length === 0) {
    notes.push(
      'No suspected claims recorded yet — seeded only the "always" catalog entries. Re-run after intake_interview captures suspected_claims for a fully tailored list.',
    );
  }

  const driveFolderUrl = drive.rootFolderId
    ? `https://drive.google.com/drive/folders/${drive.rootFolderId}`
    : null;

  return {
    state: { ...state, checklist: nextChecklist, drive },
    output: {
      created_item_count: created,
      skipped_existing_count: skipped,
      total_items: nextChecklist.length,
      items_by_category: byCategory,
      drive_folder_url: driveFolderUrl,
      drive_folder_id: drive.rootFolderId ?? null,
      drive_status: driveStatus,
      drive_error: driveError,
      notes_to_user: notes,
    },
  };
}

function caseFolderName(state: CaseState): string {
  const employer = state.profile.employer.name ?? 'employer-unknown';
  const end = state.profile.employee.endDate?.slice(0, 10) ?? 'pending';
  return `Termination Evidence — ${employer} — ${end}`;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}
