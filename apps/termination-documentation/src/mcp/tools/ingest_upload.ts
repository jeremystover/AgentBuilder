import {
  ALL_CATEGORIES,
  ALL_CLAIM_TYPES,
  ALL_SIGNAL_FLAGS,
  ALL_SOURCE_TYPES,
  type CaseState,
  type ChecklistCategory,
  type ChecklistItem,
  type ClaimType,
  type ItemScores,
  type SignalFlag,
  type SourceType,
} from '../../lib/case-state.js';
import { uploadFile } from '../../lib/google/drive.js';
import { resolveGoogleAccessToken } from '../../lib/google/token-resolver.js';
import type { Env } from '../../../worker-configuration';

export interface IngestUploadInput {
  user_id: string;
  file_name: string;
  mime_type: string;
  /** Base64-encoded file contents as provided by Claude.ai file uploads. */
  content_base64: string;

  /** Which category this belongs in. Required — classification is the caller's job. */
  category: ChecklistCategory;

  /** If provided, mark this checklist item collected and attach the file to it. Otherwise create a new custom item. */
  checklist_item_id?: string;

  /** Short description (required if creating a new item). */
  description?: string;

  // Evidence-index metadata
  source_type?: SourceType;
  date_created?: string;
  date_event?: string;
  author?: { name?: string; role?: string; is_decisionmaker?: boolean };
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

  /** Set to true if the user confirms the material is lawful for them to possess. Gates the upload. */
  lawful_to_possess_confirmation?: boolean;
}

export interface IngestUploadOutput {
  status: 'uploaded' | 'local-only';
  item: ChecklistItem;
  drive_file_id?: string;
  drive_file_url?: string;
  file_size_bytes: number;
  notes_to_user: string[];
  /** Non-fatal reasons why Drive upload was skipped or failed. */
  drive_skip_reason?: string;
}

const CATEGORY_SET = new Set<ChecklistCategory>(ALL_CATEGORIES);
const CLAIM_SET = new Set<ClaimType>(ALL_CLAIM_TYPES);
const SIGNAL_SET = new Set<SignalFlag>(ALL_SIGNAL_FLAGS);
const SOURCE_SET = new Set<SourceType>(ALL_SOURCE_TYPES);

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB cap per file

export async function ingestUpload(
  state: CaseState,
  input: IngestUploadInput,
  env: Env,
): Promise<{ state: CaseState; output: IngestUploadOutput }> {
  if (!CATEGORY_SET.has(input.category)) {
    throw new Error(`Invalid category. One of: ${ALL_CATEGORIES.join(', ')}`);
  }
  if (!input.file_name || !input.mime_type || !input.content_base64) {
    throw new Error('file_name, mime_type, and content_base64 are required');
  }
  if (!input.lawful_to_possess_confirmation) {
    throw new Error(
      'lawful_to_possess_confirmation=true is required. Before uploading, confirm the file is yours (your own reviews/comms/pay records/notes), not attorney-client privileged, not an HR investigation record, not another employee\'s personnel/medical/comp data, and not trade-secret / confidential business material unrelated to your own employment.',
    );
  }

  const bytes = base64Decode(input.content_base64);
  if (bytes.length === 0) throw new Error('Decoded file is empty');
  if (bytes.length > MAX_BYTES)
    throw new Error(`File exceeds ${MAX_BYTES} bytes (got ${bytes.length}).`);

  // ── 1. Resolve or create the checklist item ───────────────────────────────
  const checklist = [...state.checklist];
  let idx: number;
  let item: ChecklistItem;

  if (input.checklist_item_id) {
    idx = checklist.findIndex((i) => i.id === input.checklist_item_id);
    if (idx < 0) throw new Error(`No checklist item with id=${input.checklist_item_id}`);
    item = { ...checklist[idx]! };
  } else {
    if (!input.description || input.description.trim().length === 0) {
      throw new Error(
        'When checklist_item_id is omitted, description is required (the new custom item needs a one-line description).',
      );
    }
    item = {
      id: `ci_${crypto.randomUUID().slice(0, 8)}`,
      category: input.category,
      description: input.description.trim(),
      status: 'pending',
      custom: true,
    };
    checklist.push(item);
    idx = checklist.length - 1;
  }

  // Apply metadata
  item.status = 'collected';
  item.fileName = input.file_name;
  if (input.source_type && SOURCE_SET.has(input.source_type)) item.sourceType = input.source_type;
  if (input.date_created) item.dateCreated = input.date_created;
  if (input.date_event) item.dateEvent = input.date_event;
  if (input.author) {
    item.author = {
      name: input.author.name,
      role: input.author.role,
      isDecisionmaker: input.author.is_decisionmaker,
    };
  }
  if (input.recipients) item.recipients = [...input.recipients];
  if (input.exact_quotes) item.exactQuotes = [...input.exact_quotes];
  if (input.why_it_matters !== undefined) item.whyItMatters = input.why_it_matters;
  if (input.claim_tags) {
    const valid = input.claim_tags.filter((c) => CLAIM_SET.has(c as ClaimType)) as ClaimType[];
    if (valid.length) item.claimTags = valid;
  }
  if (input.scores) {
    const scores: ItemScores = { ...(item.scores ?? {}) };
    const rel = clampScore(input.scores.relevance);
    const rely = clampScore(input.scores.reliability);
    const tp = clampScore(input.scores.timing_proximity);
    const cr = clampScore(input.scores.confidentiality_risk);
    if (rel !== undefined) scores.relevance = rel;
    if (rely !== undefined) scores.reliability = rely;
    if (tp !== undefined) scores.timingProximity = tp;
    if (cr !== undefined) scores.confidentialityRisk = cr;
    item.scores = scores;
  }
  if (input.preserve_original !== undefined) item.preserveOriginal = input.preserve_original;
  if (input.authenticity_notes !== undefined) item.authenticityNotes = input.authenticity_notes;
  if (input.signal_flags) {
    const valid = input.signal_flags.filter((f) => SIGNAL_SET.has(f as SignalFlag)) as SignalFlag[];
    if (valid.length) item.signalFlags = Array.from(new Set([...(item.signalFlags ?? []), ...valid]));
  }

  // ── 2. Try Drive upload ──────────────────────────────────────────────────
  const notes: string[] = [];
  let driveFileId: string | undefined;
  let driveFileUrl: string | undefined;
  let driveSkipReason: string | undefined;

  const parentId = state.drive.subfolderIds[input.category] ?? state.drive.rootFolderId;
  if (!parentId) {
    driveSkipReason =
      'No Drive folder configured for this case yet. Call build_evidence_plan first with create_drive_folder=true to provision the case folder. The checklist entry has still been saved.';
  } else {
    const tok = await resolveGoogleAccessToken(env, input.user_id);
    if (!tok.ok) {
      driveSkipReason = tok.reason;
    } else {
      try {
        const uploaded = await uploadFile(tok.token, {
          fileName: input.file_name,
          mimeType: input.mime_type,
          parentId,
          content: bytes,
        });
        driveFileId = uploaded.id;
        driveFileUrl = uploaded.webViewLink ?? `https://drive.google.com/file/d/${uploaded.id}/view`;
        item.driveFileId = uploaded.id;
        notes.push(`Uploaded to Drive: ${uploaded.name} (${bytes.length} bytes).`);
      } catch (err) {
        driveSkipReason = err instanceof Error ? err.message : String(err);
      }
    }
  }

  if (driveSkipReason) {
    notes.push(
      `Drive upload skipped — ${driveSkipReason}. The checklist item is marked collected locally; re-run ingest_upload after fixing the Drive setup if you want the file in Drive too.`,
    );
  }

  checklist[idx] = item;
  const nextState: CaseState = { ...state, checklist };

  return {
    state: nextState,
    output: {
      status: driveFileId ? 'uploaded' : 'local-only',
      item,
      drive_file_id: driveFileId,
      drive_file_url: driveFileUrl,
      file_size_bytes: bytes.length,
      notes_to_user: notes,
      drive_skip_reason: driveSkipReason,
    },
  };
}

function base64Decode(b64: string): Uint8Array {
  // Tolerate data-URI prefix ("data:image/png;base64,...") from Claude.ai uploads.
  const comma = b64.indexOf(',');
  const clean = comma >= 0 && b64.slice(0, comma).includes('base64') ? b64.slice(comma + 1) : b64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function clampScore(n: number | undefined): 1 | 2 | 3 | 4 | 5 | undefined {
  if (n === undefined) return undefined;
  const r = Math.round(n);
  if (r < 1 || r > 5) return undefined;
  return r as 1 | 2 | 3 | 4 | 5;
}
