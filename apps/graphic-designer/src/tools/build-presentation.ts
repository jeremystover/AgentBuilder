/**
 * build_presentation — execute an approved plan against Google Slides.
 *
 * Pipeline:
 *   1. Load plan from `projects.metadata`
 *   2. Drive v3 `files.copy` → new presentation file (optionally under folderId)
 *   3. Slides batchUpdate #1: delete every existing slide; create one new
 *      slide per plan entry using the stored layoutObjectId (or predefinedLayout
 *      BLANK for big-number)
 *   4. GET presentation to resolve placeholder objectIds (TITLE/SUBTITLE/BODY)
 *      and notesProperties.speakerNotesObjectId for each new slide
 *   5. Slides batchUpdate #2: insertText for each text slot + speaker notes;
 *      createShape + insertText + style updates for big-number slides
 *   6. Update project row: status=completed, output_url=editUrl
 */

import { AgentError, createLogger } from '@agentbuilder/core';
import type { Env } from '../../worker-configuration';
import { GoogleClient } from '../lib/google-client.js';
import type { PlannedSlide } from './plan-presentation.js';

const SLIDES_API = 'https://slides.googleapis.com/v1';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

export interface BuildPresentationArgs {
  planId: string;
  title: string;
  folderId?: string;
  userId?: string;
}

export interface BuildPresentationResult {
  ok: true;
  planId: string;
  presentationId: string;
  editUrl: string;
  title: string;
  slideCount: number;
  warnings: string[];
}

interface ProjectRow {
  id: string;
  metadata: string;
  status: string;
  name: string;
}

interface PresentationMetadata {
  plan: PlannedSlide[];
  googleSlidesId: string;
}

interface SlidesPage {
  objectId: string;
  pageElements?: PageElement[];
  layoutProperties?: { name?: string; displayName?: string; masterObjectId?: string };
  slideProperties?: {
    notesPage?: {
      pageElements?: PageElement[];
      notesProperties?: { speakerNotesObjectId?: string };
    };
  };
}

interface PageElement {
  objectId: string;
  shape?: {
    placeholder?: { type?: string; index?: number };
  };
}

interface PresentationResource {
  presentationId: string;
  slides?: SlidesPage[];
  layouts?: SlidesPage[];
  masters?: SlidesPage[];
}

export async function buildPresentation(
  env: Env,
  args: BuildPresentationArgs,
): Promise<BuildPresentationResult> {
  const logger = createLogger({ base: { agent: 'graphic-designer', tool: 'build_presentation' } });
  const userId = args.userId ?? 'default';
  const warnings: string[] = [];

  const project = await loadProject(env.DB, userId, args.planId);
  const metadata = parseMetadata(project.metadata);
  const { plan, googleSlidesId } = metadata;

  if (plan.length === 0) {
    throw new AgentError(`Plan ${args.planId} has no slides.`, { code: 'invalid_input' });
  }

  const google = new GoogleClient({ env, userId });

  // 1. Copy template -----------------------------------------------------
  logger.info('drive.copy', { templateId: googleSlidesId, title: args.title });
  const copyBody: Record<string, unknown> = { name: args.title };
  if (args.folderId) copyBody.parents = [args.folderId];

  const copyRes = await google.gfetch(`${DRIVE_API}/files/${googleSlidesId}/copy`, {
    method: 'POST',
    body: JSON.stringify(copyBody),
  });
  if (!copyRes.ok) {
    throw new AgentError(
      `Drive copy failed (${copyRes.status}): ${await copyRes.text()}`,
      { code: 'upstream_failure' },
    );
  }
  const copied = (await copyRes.json()) as { id: string; name?: string; mimeType?: string };
  const newPresentationId = copied.id;

  // Source === target would mean we're about to mutate the template in place.
  // That's never what we want — fail loudly rather than corrupting the template.
  if (newPresentationId === googleSlidesId) {
    throw new AgentError(
      `Drive copy returned the source file's ID (${googleSlidesId}) — refusing to mutate the template. ` +
        `This indicates an unexpected API response; check Drive API status and scopes.`,
      { code: 'upstream_failure' },
    );
  }

  // Diagnostic: explicitly record that this deck came from drive.files.copy,
  // not presentations.create, plus the source → target mapping. If these two
  // IDs are ever equal, or if this line is missing from logs entirely, the
  // deploy is stale — the fix lives in this path.
  logger.info('build.copy.success', {
    method: 'drive.files.copy',
    sourceTemplateId: googleSlidesId,
    newPresentationId,
    name: copied.name,
    mimeType: copied.mimeType,
  });

  // 2. Fetch copy to discover existing slide IDs + actual layout IDs ----
  const initial = await getPresentation(google, newPresentationId);
  const existingSlideIds = (initial.slides ?? []).map((s) => s.objectId);
  const availableLayoutIds = new Set((initial.layouts ?? []).map((l) => l.objectId));
  const availableMasterIds = new Set((initial.masters ?? []).map((m) => m.objectId));

  // Multi-master templates (e.g. Gong's dark/light/accent masters) require
  // createSlide to specify BOTH the layoutId AND its owning masterId — the
  // layout-only form fails with "object not found" because each layout only
  // exists under one master.
  const layoutToMaster = new Map<string, string>();
  for (const l of initial.layouts ?? []) {
    const masterId = l.layoutProperties?.masterObjectId;
    if (masterId) layoutToMaster.set(l.objectId, masterId);
  }

  logger.info('build.copy.inspected', {
    newPresentationId,
    slidesInCopy: existingSlideIds.length,
    layoutsInCopy: availableLayoutIds.size,
    mastersInCopy: availableMasterIds.size,
    // Full list, not a sample — we need this to debug "object not found" on createSlide.
    allLayoutIds: Array.from(availableLayoutIds),
    allMasterIds: Array.from(availableMasterIds),
    planLayoutIds: plan.map((p) => p.layoutObjectId ?? null),
  });

  // 3. Batch #1 — create new slides (BEFORE deleting old ones)
  //
  // IMPORTANT: creates must happen before deletes in a separate batch call.
  // If deletes and creates run in the same batchUpdate, Google garbage-collects
  // layout objects once all slides referencing them are deleted — causing every
  // subsequent createSlide in the same batch to fail with "object not found"
  // even though the layout appeared in the GET response moments earlier.
  // By creating first (while old slides still hold references to the layouts)
  // and deleting in a second batch, we avoid that GC window entirely.
  const slideIdFor = (i: number) => `gdslide_${i}`;

  // Track which slides will end up BLANK because their layout was missing.
  const blankSlides = new Set<number>();

  const slideDecisions: Array<{
    index: number;
    intent: string;
    plannedLayoutId: string | null;
    decision: 'layout' | 'blank';
    layoutIdSent: string | null;
    masterIdSent: string | null;
  }> = [];

  const createRequests: Record<string, unknown>[] = [];

  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i]!;
    const slideObjectId = slideIdFor(i);

    let useLayoutId: string | null = null;
    let masterForLog: string | null = null;
    if (entry.layoutObjectId) {
      if (availableLayoutIds.has(entry.layoutObjectId)) {
        useLayoutId = entry.layoutObjectId;
        masterForLog = layoutToMaster.get(entry.layoutObjectId) ?? null;
      } else {
        warnings.push(
          `Slide ${i + 1} (${entry.intent}): layout ${entry.layoutObjectId} not present in copied template ` +
            `(${availableLayoutIds.size} layouts available) — falling back to predefinedLayout BLANK. ` +
            `Run analyze_template against this template or adjust the intent map.`,
        );
      }
    }

    if (useLayoutId) {
      createRequests.push({
        createSlide: {
          objectId: slideObjectId,
          insertionIndex: i,
          slideLayoutReference: { layoutId: useLayoutId },
        },
      });
      slideDecisions.push({
        index: i,
        intent: entry.intent,
        plannedLayoutId: entry.layoutObjectId ?? null,
        decision: 'layout',
        layoutIdSent: useLayoutId,
        masterIdSent: masterForLog,
      });
    } else {
      blankSlides.add(i);
      createRequests.push({
        createSlide: {
          objectId: slideObjectId,
          insertionIndex: i,
          slideLayoutReference: { predefinedLayout: 'BLANK' },
        },
      });
      slideDecisions.push({
        index: i,
        intent: entry.intent,
        plannedLayoutId: entry.layoutObjectId ?? null,
        decision: 'blank',
        layoutIdSent: null,
        masterIdSent: null,
      });
    }
  }

  logger.info('slides.layouts.validated', {
    availableLayouts: availableLayoutIds.size,
    slidesFallingBackToBlank: blankSlides.size,
    decisions: slideDecisions,
  });

  logger.info('slides.batchUpdate.creates', { creates: plan.length });
  await batchUpdate(google, newPresentationId, createRequests);

  // 3b. Batch #2 — delete old slides (now safe: new slides hold layout refs)
  if (existingSlideIds.length > 0) {
    const deleteRequests = existingSlideIds.map((id) => ({ deleteObject: { objectId: id } }));
    logger.info('slides.batchUpdate.deletes', { deletes: existingSlideIds.length });
    await batchUpdate(google, newPresentationId, deleteRequests);
  }

  // 4. Re-fetch to discover placeholder IDs + speaker-notes IDs ----------
  const populated = await getPresentation(google, newPresentationId);
  const slidesById = new Map((populated.slides ?? []).map((s) => [s.objectId, s]));

  // 5. Batch #2 — fill text, speaker notes, and big-number shapes --------
  const textRequests: Record<string, unknown>[] = [];

  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i]!;
    const slideObjectId = slideIdFor(i);
    const slide = slidesById.get(slideObjectId);
    if (!slide) {
      warnings.push(`Slide ${i + 1} (${entry.intent}): newly created slide not found on re-fetch.`);
      continue;
    }

    const placeholders = collectPlaceholders(slide);
    const isBlankFallback = blankSlides.has(i);

    // Slides that fell back to BLANK (either big-number by design, or a missing
    // layout) have no placeholders. Render all of their text via text-boxes so
    // nothing is lost.
    if (isBlankFallback) {
      textRequests.push(...renderBlankSlide(slideObjectId, i, entry));
    } else {
      // Title
      if (entry.title) {
        const titleId = pickPlaceholder(placeholders, ['TITLE', 'CENTERED_TITLE']);
        if (titleId) {
          textRequests.push({ insertText: { objectId: titleId, text: entry.title } });
        } else {
          warnings.push(`Slide ${i + 1}: no TITLE placeholder; skipped title "${truncate(entry.title)}".`);
        }
      }

      // Subtitle
      if (entry.subtitle) {
        const subId = pickPlaceholder(placeholders, ['SUBTITLE']);
        if (subId) {
          textRequests.push({ insertText: { objectId: subId, text: entry.subtitle } });
        } else {
          warnings.push(`Slide ${i + 1}: no SUBTITLE placeholder; skipped subtitle "${truncate(entry.subtitle)}".`);
        }
      }

      // Body — distribute across all BODY placeholders (supports two-columns, three-ideas).
      if (entry.body && entry.body.length > 0) {
        const bodyIds = placeholders.filter((p) => p.type === 'BODY').map((p) => p.objectId);
        if (bodyIds.length > 0) {
          const chunks = distribute(entry.body, bodyIds.length);
          for (let c = 0; c < bodyIds.length; c++) {
            const text = chunks[c]?.join('\n') ?? '';
            if (text.length > 0) {
              textRequests.push({ insertText: { objectId: bodyIds[c]!, text } });
            }
          }
        } else {
          warnings.push(
            `Slide ${i + 1}: no BODY placeholder on layout; skipped ${entry.body.length} body item(s).`,
          );
        }
      }
    }

    // Speaker notes
    if (entry.speakerNotes) {
      const notesObjectId = slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
      if (notesObjectId) {
        textRequests.push({ insertText: { objectId: notesObjectId, text: entry.speakerNotes } });
      } else {
        warnings.push(`Slide ${i + 1}: no speaker-notes shape; skipped ${entry.speakerNotes.length} chars of notes.`);
      }
    }
  }

  if (textRequests.length > 0) {
    logger.info('slides.batchUpdate.text', { requests: textRequests.length });
    await batchUpdate(google, newPresentationId, textRequests);
  }

  // 6. Mark project complete --------------------------------------------
  const editUrl = `https://docs.google.com/presentation/d/${newPresentationId}/edit`;
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE projects SET status = 'completed', output_url = ?1, updated_at = ?2 WHERE id = ?3`,
  )
    .bind(editUrl, now, project.id)
    .run();

  logger.info('build.done', { planId: args.planId, presentationId: newPresentationId, slides: plan.length });

  return {
    ok: true,
    planId: args.planId,
    presentationId: newPresentationId,
    editUrl,
    title: args.title,
    slideCount: plan.length,
    warnings,
  };
}

// ── Google API helpers ──────────────────────────────────────────────────────

async function getPresentation(
  google: GoogleClient,
  presentationId: string,
): Promise<PresentationResource> {
  const fields =
    'presentationId,' +
    'masters(objectId),' +
    'layouts(objectId,layoutProperties(name,displayName,masterObjectId)),' +
    'slides(objectId,pageElements(objectId,shape(placeholder)),' +
    'slideProperties(notesPage(pageElements(objectId,shape(placeholder)),notesProperties)))';
  const res = await google.gfetch(
    `${SLIDES_API}/presentations/${presentationId}?fields=${encodeURIComponent(fields)}`,
  );
  if (!res.ok) {
    throw new AgentError(
      `Slides GET failed (${res.status}): ${await res.text()}`,
      { code: 'upstream_failure' },
    );
  }
  return (await res.json()) as PresentationResource;
}

async function batchUpdate(
  google: GoogleClient,
  presentationId: string,
  requests: Record<string, unknown>[],
): Promise<void> {
  if (requests.length === 0) return;
  const res = await google.gfetch(`${SLIDES_API}/presentations/${presentationId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    throw new AgentError(
      `Slides batchUpdate failed (${res.status}): ${await res.text()}`,
      { code: 'upstream_failure' },
    );
  }
}

// ── Placeholder helpers ─────────────────────────────────────────────────────

interface PlaceholderInfo {
  objectId: string;
  type: string;
  index: number;
}

function collectPlaceholders(slide: SlidesPage): PlaceholderInfo[] {
  const out: PlaceholderInfo[] = [];
  for (const el of slide.pageElements ?? []) {
    const ph = el.shape?.placeholder;
    if (!ph?.type) continue;
    out.push({ objectId: el.objectId, type: ph.type, index: ph.index ?? 0 });
  }
  // Stable ordering: by type then index so "two-columns" bodies fill left→right.
  out.sort((a, b) => (a.type === b.type ? a.index - b.index : a.type.localeCompare(b.type)));
  return out;
}

function pickPlaceholder(placeholders: PlaceholderInfo[], types: string[]): string | null {
  for (const t of types) {
    const match = placeholders.find((p) => p.type === t);
    if (match) return match.objectId;
  }
  return null;
}

function distribute<T>(items: T[], buckets: number): T[][] {
  const out: T[][] = Array.from({ length: buckets }, () => []);
  if (buckets === 0) return out;
  const per = Math.ceil(items.length / buckets);
  for (let i = 0; i < items.length; i++) {
    const b = Math.min(Math.floor(i / per), buckets - 1);
    out[b]!.push(items[i]!);
  }
  return out;
}

// ── big-number + blank-fallback rendering ───────────────────────────────────

// Standard widescreen slide is 10" x 5.625" at 914400 EMU/inch = 9144000 x 5143500.
// Centered textbox ≈ 8" wide x 2.5" tall, positioned ~1.56" from top.
const BIG_NUMBER_FONT_PT = 140;
const BIG_NUMBER_WIDTH_EMU = 7315200; // 8 inches
const BIG_NUMBER_HEIGHT_EMU = 2286000; // 2.5 inches
const BIG_NUMBER_TRANSLATE_X_EMU = 914400; // 1 inch from left
const BIG_NUMBER_TRANSLATE_Y_EMU = 1428750; // ~1.56 inches from top (vertically centered-ish)

// For plain blank-fallback slides we stack a title, subtitle, and body box top→down.
const BLANK_MARGIN_X_EMU = 457200; // 0.5 inch
const BLANK_INNER_WIDTH_EMU = 8229600; // 9 inches
const BLANK_TITLE_Y_EMU = 457200;
const BLANK_TITLE_H_EMU = 914400;
const BLANK_SUBTITLE_Y_EMU = 1371600;
const BLANK_SUBTITLE_H_EMU = 457200;
const BLANK_BODY_Y_EMU = 1905000;
const BLANK_BODY_H_EMU = 2743200;

function renderBlankSlide(
  slideObjectId: string,
  slideIndex: number,
  entry: { intent: string; title?: string; subtitle?: string; body?: string[] },
): Record<string, unknown>[] {
  const reqs: Record<string, unknown>[] = [];

  // big-number: one huge centered shape carrying either the body (e.g. "40%")
  // or the title when no body is present.
  if (entry.intent === 'big-number') {
    const text = entry.body && entry.body.length > 0
      ? entry.body.join('\n')
      : (entry.title ?? '');
    if (text) {
      const shapeId = `gdbignum_${slideIndex}`;
      reqs.push(...bigNumberShapeRequests(slideObjectId, shapeId, text));
    }
    return reqs;
  }

  // Anything else that landed on BLANK: stack title/subtitle/body.
  if (entry.title) {
    const id = `gdbtitle_${slideIndex}`;
    reqs.push(
      stackedTextBox(id, slideObjectId, BLANK_TITLE_Y_EMU, BLANK_TITLE_H_EMU),
      { insertText: { objectId: id, text: entry.title } },
      styleText(id, { bold: true, fontSize: 36 }),
    );
  }
  if (entry.subtitle) {
    const id = `gdbsub_${slideIndex}`;
    reqs.push(
      stackedTextBox(id, slideObjectId, BLANK_SUBTITLE_Y_EMU, BLANK_SUBTITLE_H_EMU),
      { insertText: { objectId: id, text: entry.subtitle } },
      styleText(id, { fontSize: 20 }),
    );
  }
  if (entry.body && entry.body.length > 0) {
    const id = `gdbbody_${slideIndex}`;
    reqs.push(
      stackedTextBox(id, slideObjectId, BLANK_BODY_Y_EMU, BLANK_BODY_H_EMU),
      { insertText: { objectId: id, text: entry.body.join('\n') } },
      styleText(id, { fontSize: 14 }),
    );
  }
  return reqs;
}

function stackedTextBox(
  objectId: string,
  pageObjectId: string,
  translateY: number,
  height: number,
): Record<string, unknown> {
  return {
    createShape: {
      objectId,
      shapeType: 'TEXT_BOX',
      elementProperties: {
        pageObjectId,
        size: {
          width: { magnitude: BLANK_INNER_WIDTH_EMU, unit: 'EMU' },
          height: { magnitude: height, unit: 'EMU' },
        },
        transform: {
          scaleX: 1,
          scaleY: 1,
          translateX: BLANK_MARGIN_X_EMU,
          translateY,
          unit: 'EMU',
        },
      },
    },
  };
}

function styleText(
  objectId: string,
  opts: { bold?: boolean; fontSize?: number },
): Record<string, unknown> {
  const fields: string[] = [];
  const style: Record<string, unknown> = {};
  if (opts.bold !== undefined) {
    style.bold = opts.bold;
    fields.push('bold');
  }
  if (opts.fontSize !== undefined) {
    style.fontSize = { magnitude: opts.fontSize, unit: 'PT' };
    fields.push('fontSize');
  }
  return {
    updateTextStyle: {
      objectId,
      textRange: { type: 'ALL' },
      style,
      fields: fields.join(','),
    },
  };
}

function bigNumberShapeRequests(
  slideObjectId: string,
  shapeObjectId: string,
  text: string,
): Record<string, unknown>[] {
  return [
    {
      createShape: {
        objectId: shapeObjectId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: slideObjectId,
          size: {
            width: { magnitude: BIG_NUMBER_WIDTH_EMU, unit: 'EMU' },
            height: { magnitude: BIG_NUMBER_HEIGHT_EMU, unit: 'EMU' },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: BIG_NUMBER_TRANSLATE_X_EMU,
            translateY: BIG_NUMBER_TRANSLATE_Y_EMU,
            unit: 'EMU',
          },
        },
      },
    },
    { insertText: { objectId: shapeObjectId, text } },
    {
      updateTextStyle: {
        objectId: shapeObjectId,
        textRange: { type: 'ALL' },
        style: {
          bold: true,
          fontSize: { magnitude: BIG_NUMBER_FONT_PT, unit: 'PT' },
        },
        fields: 'bold,fontSize',
      },
    },
    {
      updateParagraphStyle: {
        objectId: shapeObjectId,
        textRange: { type: 'ALL' },
        style: { alignment: 'CENTER' },
        fields: 'alignment',
      },
    },
  ];
}

// ── Project / metadata helpers ──────────────────────────────────────────────

async function loadProject(
  db: D1Database,
  userId: string,
  planId: string,
): Promise<ProjectRow> {
  const row = await db
    .prepare(
      `SELECT id, metadata, status, name FROM projects
       WHERE id = ?1 AND user_id = ?2 AND kind = 'presentation'`,
    )
    .bind(planId, userId)
    .first<ProjectRow>();
  if (!row) {
    throw new AgentError(`Plan "${planId}" not found for user "${userId}".`, { code: 'not_found' });
  }
  return row;
}

function parseMetadata(raw: string | null): PresentationMetadata {
  if (!raw) {
    throw new AgentError('Plan has no metadata.', { code: 'invalid_input' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AgentError(
      `Plan metadata is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { code: 'invalid_input' },
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new AgentError('Plan metadata is not an object.', { code: 'invalid_input' });
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.plan) || typeof obj.googleSlidesId !== 'string') {
    throw new AgentError(
      'Plan metadata missing `plan` array or `googleSlidesId`.',
      { code: 'invalid_input' },
    );
  }
  return { plan: obj.plan as PlannedSlide[], googleSlidesId: obj.googleSlidesId };
}

function truncate(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
