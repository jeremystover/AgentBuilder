/**
 * build_presentation — execute an approved plan into a real Google Slides deck.
 *
 * Pipeline:
 *   1. Load project row (from plan_presentation) + verify kind='presentation'.
 *   2. Copy the source template via Drive API `files.copy`.
 *   3. Read the copied presentation to enumerate its existing slides (the copy
 *      inherits layout pages from the template). We'll drive inserts against
 *      those layouts by objectId.
 *   4. For each slide in the plan:
 *        a. createSlide with slideLayoutReference.layoutId.
 *        b. populate each text slot via insertText (using placeholder types).
 *        c. for each mediaNeed, call search_media, take the top result, and
 *           insert via createImage on that slide.
 *        d. write speaker notes via insertText on notesPage.
 *   5. Delete the original slides that came pre-populated with the template.
 *   6. Move the file to the target Drive folder (if folderId provided).
 *   7. Update project row: status='completed', output_url.
 *
 * All Slides mutations are batched into a single `presentations.batchUpdate`
 * per slide to keep latency down (Slides writes are slow).
 */

import { AgentError, createLogger } from '@agentbuilder/core';
import type { Env } from '../../worker-configuration';
import { GoogleClient } from '../lib/google-client.js';
import { searchMedia } from './search-media.js';

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
  presentationId: string;
  url: string;
  title: string;
  slideCount: number;
  mediaInserted: number;
}

interface ProjectRow {
  id: string;
  user_id: string;
  brand_id: string | null;
  name: string;
  kind: string;
  status: string;
  metadata: string;
}

interface PlanMetadata {
  templateId: string;
  googleSlidesId: string;
  outline: string;
  audience: string | null;
  goal: string | null;
  storyArc: string[];
  slides: PlanSlide[];
}

interface PlanSlide {
  index: number;
  layoutObjectId: string;
  layoutDisplayName: string;
  intent: string;
  synopsis: string;
  text: Record<string, string>;
  mediaNeeds: Array<{ kind: 'photo' | 'icon' | 'illustration'; query: string; placement: string }>;
  speakerNotes: string;
}

interface SlidesPage {
  objectId: string;
  pageElements?: PageElement[];
  slideProperties?: { notesPage?: { objectId?: string; pageElements?: PageElement[] } };
  pageType?: string;
}

interface PageElement {
  objectId: string;
  shape?: {
    placeholder?: { type?: string };
    shapeType?: string;
  };
  size?: { width?: { magnitude?: number }; height?: { magnitude?: number } };
  transform?: { translateX?: number; translateY?: number };
  image?: unknown;
}

interface PresentationResource {
  presentationId: string;
  title: string;
  slides?: SlidesPage[];
  layouts?: SlidesPage[];
}

export async function buildPresentation(
  env: Env,
  args: BuildPresentationArgs,
): Promise<BuildPresentationResult> {
  const logger = createLogger({ base: { agent: 'graphic-designer', tool: 'build_presentation' } });
  const userId = args.userId ?? 'default';

  const project = await env.DB.prepare(
    `SELECT id, user_id, brand_id, name, kind, status, metadata
       FROM projects
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(args.planId, userId)
    .first<ProjectRow>();

  if (!project) {
    throw new AgentError(`Plan "${args.planId}" not found.`, { code: 'not_found' });
  }
  if (project.kind !== 'presentation') {
    throw new AgentError(`Plan "${args.planId}" is not a presentation plan.`, {
      code: 'invalid_input',
    });
  }

  const plan = safeJson<PlanMetadata>(project.metadata);
  if (!plan) {
    throw new AgentError('Plan metadata is malformed.', { code: 'internal' });
  }

  logger.info('build.start', {
    planId: args.planId,
    source: plan.googleSlidesId,
    slides: plan.slides.length,
  });

  const google = new GoogleClient({ env, userId });

  // 1) Copy the template
  const copyRes = await google.gfetch(
    `${DRIVE_API}/files/${plan.googleSlidesId}/copy?supportsAllDrives=true&fields=id,name,webViewLink`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: args.title,
        ...(args.folderId ? { parents: [args.folderId] } : {}),
      }),
    },
  );
  if (!copyRes.ok) {
    throw new AgentError(`Drive copy failed (${copyRes.status}): ${await copyRes.text()}`, {
      code: 'upstream_failure',
    });
  }
  const copy = (await copyRes.json()) as { id: string; name: string; webViewLink?: string };
  logger.info('build.copied', { newPresentationId: copy.id });

  // 2) Read the copy to enumerate pre-existing slides + layouts
  const presRes = await google.gfetch(
    `${SLIDES_API}/presentations/${copy.id}?fields=presentationId,title,slides(objectId),layouts(objectId,layoutProperties,pageElements(objectId,shape(placeholder,shapeType)))`,
  );
  if (!presRes.ok) {
    throw new AgentError(`Slides read failed (${presRes.status}): ${await presRes.text()}`, {
      code: 'upstream_failure',
    });
  }
  const pres = (await presRes.json()) as PresentationResource;
  const preExisting = (pres.slides ?? []).map((s) => s.objectId);

  // Build a layout lookup: layoutObjectId -> placeholder types present
  const layoutPlaceholders = new Map<string, Array<{ objectId: string; type: string }>>();
  for (const layout of pres.layouts ?? []) {
    const phs: Array<{ objectId: string; type: string }> = [];
    for (const el of layout.pageElements ?? []) {
      const t = el.shape?.placeholder?.type;
      if (t) phs.push({ objectId: el.objectId, type: t });
    }
    layoutPlaceholders.set(layout.objectId, phs);
  }

  // 3) Insert new slides per plan
  let mediaInserted = 0;
  const newSlideIds: string[] = [];

  for (const slide of plan.slides) {
    const newSlideId = `slide_${slide.index}_${shortId()}`;
    newSlideIds.push(newSlideId);

    // Build placeholder mapping from layout's placeholders to new slide.
    // We need to request the specific placeholder types we intend to fill.
    const layoutPh = layoutPlaceholders.get(slide.layoutObjectId) ?? [];
    const phMappings: Array<{ layoutPlaceholder: { type: string }; objectId: string }> = [];
    const filledTypes = new Set<string>();
    for (const ph of layoutPh) {
      if (filledTypes.has(ph.type)) continue;  // one per type
      if (!(ph.type in slide.text)) continue;
      filledTypes.add(ph.type);
      phMappings.push({
        layoutPlaceholder: { type: ph.type },
        objectId: `${newSlideId}_${ph.type.toLowerCase()}`,
      });
    }

    const createRequest = {
      createSlide: {
        objectId: newSlideId,
        slideLayoutReference: { layoutId: slide.layoutObjectId },
        placeholderIdMappings: phMappings,
      },
    };

    // Text insert requests per filled placeholder
    const textRequests = phMappings.map((m) => ({
      insertText: {
        objectId: m.objectId,
        text: slide.text[m.layoutPlaceholder.type] ?? '',
        insertionIndex: 0,
      },
    }));

    const firstBatch = await batchUpdate(google, copy.id, [createRequest, ...textRequests]);
    if (!firstBatch.ok) {
      logger.warn('build.slide.createFailed', {
        slide: slide.index,
        error: firstBatch.error,
      });
      continue;
    }

    // 4) Media: search + insert
    for (let i = 0; i < slide.mediaNeeds.length; i++) {
      const need = slide.mediaNeeds[i];
      if (!need) continue;
      try {
        const results = await searchMedia(env, {
          query: need.query,
          type: need.kind,
          count: 3,
          brandId: project.brand_id ?? undefined,
          userId,
        });
        const pick = results.results[0];
        if (!pick) continue;
        const imageUrl = pick.url.startsWith('r2://')
          ? await publicR2Url(env, pick.r2Key ?? pick.id)
          : pick.url;
        if (!imageUrl) continue;

        const imageId = `img_${newSlideId}_${i}`;
        const insertRes = await batchUpdate(google, copy.id, [
          {
            createImage: {
              objectId: imageId,
              url: imageUrl,
              elementProperties: {
                pageObjectId: newSlideId,
                size: { width: { magnitude: 3_000_000, unit: 'EMU' }, height: { magnitude: 2_000_000, unit: 'EMU' } },
                transform: {
                  scaleX: 1, scaleY: 1,
                  translateX: 500_000 + i * 200_000,
                  translateY: 500_000 + i * 200_000,
                  unit: 'EMU',
                },
              },
            },
          },
        ]);
        if (insertRes.ok) mediaInserted++;
        else logger.warn('build.image.insertFailed', { slide: slide.index, error: insertRes.error });
      } catch (err) {
        logger.warn('build.image.searchFailed', {
          slide: slide.index,
          query: need.query,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 5) Speaker notes — write to the slide's notesPage
    if (slide.speakerNotes) {
      const notesSlideRes = await google.gfetch(
        `${SLIDES_API}/presentations/${copy.id}/pages/${newSlideId}?fields=slideProperties(notesPage(objectId,pageElements(objectId,shape(placeholder))))`,
      );
      if (notesSlideRes.ok) {
        const notesPage = (await notesSlideRes.json()) as SlidesPage;
        const notesBody = notesPage.slideProperties?.notesPage?.pageElements?.find(
          (el) => el.shape?.placeholder?.type === 'BODY',
        );
        if (notesBody) {
          await batchUpdate(google, copy.id, [
            {
              insertText: {
                objectId: notesBody.objectId,
                text: slide.speakerNotes,
                insertionIndex: 0,
              },
            },
          ]);
        }
      }
    }
  }

  // 6) Delete pre-existing template slides (the copy included them)
  if (preExisting.length > 0) {
    await batchUpdate(
      google,
      copy.id,
      preExisting.map((objectId) => ({ deleteObject: { objectId } })),
    );
  }

  // 7) Finalise
  const url = copy.webViewLink ?? `https://docs.google.com/presentation/d/${copy.id}/edit`;

  await env.DB.prepare(
    `UPDATE projects SET status = 'completed', output_url = ?1, updated_at = ?2 WHERE id = ?3`,
  )
    .bind(url, Date.now(), args.planId)
    .run();

  logger.info('build.done', { presentationId: copy.id, mediaInserted });

  return {
    ok: true,
    presentationId: copy.id,
    url,
    title: args.title,
    slideCount: newSlideIds.length,
    mediaInserted,
  };
}

// ── Slides batchUpdate wrapper ──────────────────────────────────────────────

async function batchUpdate(
  google: GoogleClient,
  presentationId: string,
  requests: unknown[],
): Promise<{ ok: true; replies: unknown[] } | { ok: false; error: string }> {
  if (requests.length === 0) return { ok: true, replies: [] };
  const res = await google.gfetch(
    `${SLIDES_API}/presentations/${presentationId}:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({ requests }),
    },
  );
  if (!res.ok) {
    return { ok: false, error: `batchUpdate ${res.status}: ${await res.text()}` };
  }
  const json = (await res.json()) as { replies?: unknown[] };
  return { ok: true, replies: json.replies ?? [] };
}

// ── R2 public URL ─────────────────────────────────────────────────────────
//
// For AI-generated images we stored in R2, Slides' createImage needs a
// publicly reachable URL. We upload to R2 then serve via a signed-like
// short-lived presigned GET. For now we expect the R2 bucket to have a
// public custom domain bound, and just construct <domain>/<key>. If that's
// not configured we skip the insert.

async function publicR2Url(env: Env, key: string): Promise<string | null> {
  const domain = (env as unknown as { R2_PUBLIC_BASE_URL?: string }).R2_PUBLIC_BASE_URL;
  if (domain) return `${domain.replace(/\/$/, '')}/${key}`;
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function safeJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}
