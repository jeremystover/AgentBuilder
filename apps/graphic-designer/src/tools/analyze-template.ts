/**
 * analyze_template — inspect a Google Slides template and store per-layout analysis.
 *
 * Pipeline:
 *   1. Resolve presentationId (accepts full URL or raw ID)
 *   2. Fetch the Presentation resource via Slides API
 *   3. For each layout page, extract shape types + bounds into a compact summary
 *   4. LLM classifies the layout: display name, best-fit intents, text capacity
 *   5. Persist templates row (upsert) + template_layouts rows; return summary
 */

import { AgentError, createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../../worker-configuration';
import { GoogleClient } from '../lib/google-client.js';

const SLIDES_API = 'https://slides.googleapis.com/v1';

export interface AnalyzeTemplateArgs {
  presentationId: string;
  brandId?: string;
  userId?: string;
}

export interface AnalyzeTemplateResult {
  ok: true;
  templateId: string;
  googleSlidesId: string;
  name: string;
  layoutCount: number;
  layouts: LayoutAnalysis[];
}

interface LayoutAnalysis {
  layoutObjectId: string;
  name: string;
  displayName: string;
  slotTypes: SlotDescriptor[];
  textCapacity: number;
  imageSlots: number;
  bestFitIntents: string[];
}

interface SlotDescriptor {
  type: string;                 // placeholder type or shape type
  shape: string;                // rectangle, text_box, image, etc.
  textCapacity: number;         // approx char capacity
  bounds?: { x: number; y: number; width: number; height: number };
}

interface SlidesPage {
  objectId: string;
  pageType?: string;
  layoutProperties?: { name?: string; displayName?: string };
  pageElements?: PageElement[];
}

interface PageElement {
  objectId: string;
  size?: { width?: { magnitude?: number }; height?: { magnitude?: number } };
  transform?: { translateX?: number; translateY?: number };
  shape?: {
    shapeType?: string;
    placeholder?: { type?: string };
  };
  image?: unknown;
  video?: unknown;
  table?: unknown;
}

interface PresentationResource {
  presentationId: string;
  title: string;
  layouts?: SlidesPage[];
  masters?: SlidesPage[];
}

export async function analyzeTemplate(
  env: Env,
  args: AnalyzeTemplateArgs,
): Promise<AnalyzeTemplateResult> {
  const logger = createLogger({ base: { agent: 'graphic-designer', tool: 'analyze_template' } });
  const userId = args.userId ?? 'default';
  const presentationId = extractPresentationId(args.presentationId);

  logger.info('fetch.presentation', { presentationId });

  const google = new GoogleClient({ env, userId });
  const res = await google.gfetch(
    `${SLIDES_API}/presentations/${presentationId}?fields=presentationId,title,layouts(objectId,pageType,layoutProperties,pageElements(objectId,size,transform,shape(shapeType,placeholder),image,video,table)),masters(objectId)`,
  );

  if (!res.ok) {
    const body = await res.text();
    throw new AgentError(`Slides API error (${res.status}): ${body}`, { code: 'upstream_failure' });
  }

  const pres = (await res.json()) as PresentationResource;
  const layouts = pres.layouts ?? [];

  if (layouts.length === 0) {
    throw new AgentError('Presentation has no layouts to analyze.', { code: 'invalid_input' });
  }

  // Compact summaries for the LLM
  const layoutSummaries = layouts.map((layout) => summarizeLayout(layout));

  const llm = new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY, workersAi: env.AI });
  const classified = await classifyLayouts(llm, layoutSummaries);

  // Upsert template row
  const templateId = await upsertTemplate(env.DB, {
    userId,
    googleSlidesId: presentationId,
    name: pres.title,
    brandId: args.brandId ?? null,
    layoutCount: classified.length,
  });

  // Replace layout rows
  await env.DB.prepare(`DELETE FROM template_layouts WHERE template_id = ?1`)
    .bind(templateId)
    .run();

  const now = Date.now();
  for (const layout of classified) {
    await env.DB.prepare(
      `INSERT INTO template_layouts
        (id, template_id, layout_object_id, name, display_name, slot_types,
         text_capacity, image_slots, best_fit_intents, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(
        `lyt_${crypto.randomUUID()}`,
        templateId,
        layout.layoutObjectId,
        layout.name,
        layout.displayName,
        JSON.stringify(layout.slotTypes),
        layout.textCapacity,
        layout.imageSlots,
        JSON.stringify(layout.bestFitIntents),
        now,
      )
      .run();
  }

  logger.info('analyze.done', { templateId, layoutCount: classified.length });

  return {
    ok: true,
    templateId,
    googleSlidesId: presentationId,
    name: pres.title,
    layoutCount: classified.length,
    layouts: classified,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractPresentationId(input: string): string {
  // Accept full URL or raw ID
  const match = input.match(/\/presentations\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1] ?? input;
  return input;
}

function summarizeLayout(layout: SlidesPage): {
  layoutObjectId: string;
  name: string;
  slotTypes: SlotDescriptor[];
  imageSlots: number;
} {
  const elements = layout.pageElements ?? [];
  const slotTypes: SlotDescriptor[] = [];
  let imageSlots = 0;

  for (const el of elements) {
    if (el.image) {
      imageSlots++;
      slotTypes.push({
        type: 'IMAGE',
        shape: 'image',
        textCapacity: 0,
        bounds: extractBounds(el),
      });
      continue;
    }
    if (el.shape) {
      const phType = el.shape.placeholder?.type ?? 'NONE';
      const shapeType = el.shape.shapeType ?? 'UNKNOWN';
      const bounds = extractBounds(el);
      const capacity = estimateTextCapacity(bounds, phType);
      slotTypes.push({
        type: phType,
        shape: shapeType.toLowerCase(),
        textCapacity: capacity,
        bounds,
      });
      continue;
    }
    if (el.table) {
      slotTypes.push({ type: 'TABLE', shape: 'table', textCapacity: 200 });
    }
  }

  return {
    layoutObjectId: layout.objectId,
    name: layout.layoutProperties?.name ?? layout.objectId,
    slotTypes,
    imageSlots,
  };
}

function extractBounds(
  el: PageElement,
): { x: number; y: number; width: number; height: number } | undefined {
  const w = el.size?.width?.magnitude;
  const h = el.size?.height?.magnitude;
  const tx = el.transform?.translateX ?? 0;
  const ty = el.transform?.translateY ?? 0;
  if (typeof w !== 'number' || typeof h !== 'number') return undefined;
  return { x: tx, y: ty, width: w, height: h };
}

function estimateTextCapacity(
  bounds: { x: number; y: number; width: number; height: number } | undefined,
  phType: string,
): number {
  if (!bounds) return 0;
  // EMU units — rough: 914400 EMU = 1 inch. Heuristic for how much text fits.
  const area = (bounds.width * bounds.height) / (914400 * 914400);
  const base = phType === 'TITLE' || phType === 'CENTERED_TITLE' ? 80 : 400;
  return Math.max(20, Math.round(base * Math.max(1, area)));
}

// ── LLM classification ─────────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You analyze Google Slides layout metadata and classify each layout
by its best-fit content intents. For each layout, produce:
  - displayName: a short human label (e.g. "Title + two-column body", "Section break", "Big-number quote")
  - bestFitIntents: 2-5 content intents this layout suits. Choose from:
    ["title-slide", "section-break", "single-idea", "two-ideas", "three-ideas",
     "bullets", "quote", "big-number", "timeline", "comparison", "image-hero",
     "image-with-caption", "team", "closing", "agenda", "data-chart"]
  - textCapacity: integer estimate of total comfortable character capacity across all text slots

Return ONLY a JSON array, one object per layout, in the same order as input.
No prose, no markdown fences.`;

const BATCH_SIZE = 15;
const MAX_RETRIES = 2;

async function classifyLayouts(
  llm: LLMClient,
  summaries: ReturnType<typeof summarizeLayout>[],
): Promise<LayoutAnalysis[]> {
  const logger = createLogger({ base: { agent: 'graphic-designer', tool: 'classify_layouts' } });
  const input = summaries.map((s, i) => ({
    index: i,
    layoutObjectId: s.layoutObjectId,
    name: s.name,
    slotCount: s.slotTypes.length,
    imageSlots: s.imageSlots,
    placeholders: s.slotTypes.map((slot) => ({
      type: slot.type,
      shape: slot.shape,
      textCapacity: slot.textCapacity,
    })),
  }));

  logger.info('classify.start', { totalLayouts: input.length, batchSize: BATCH_SIZE });

  const batches = chunkArray(input, BATCH_SIZE);
  const results: Array<{
    displayName?: string;
    bestFitIntents?: string[];
    textCapacity?: number;
  }> = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx]!;
    const batchStart = batchIdx * BATCH_SIZE;
    let batchResults: Array<{
      displayName?: string;
      bestFitIntents?: string[];
      textCapacity?: number;
    }> | null = null;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await llm.complete({
          tier: 'default',
          system: CLASSIFY_SYSTEM,
          messages: [
            {
              role: 'user',
              content: `Classify these ${batch.length} layouts (batch ${batchIdx + 1}/${batches.length}):\n\n${JSON.stringify(batch, null, 2)}`,
            },
          ],
        });

        const parsed = parseLlmArray(res.text);
        if (!Array.isArray(parsed)) {
          throw new Error('LLM returned non-array response');
        }
        if (parsed.length !== batch.length) {
          throw new Error(
            `Batch ${batchIdx + 1}: expected ${batch.length} results, got ${parsed.length}`,
          );
        }

        batchResults = parsed as Array<{
          displayName?: string;
          bestFitIntents?: string[];
          textCapacity?: number;
        }>;

        logger.info('classify.batch.ok', {
          batchIndex: batchIdx,
          batchSize: batch.length,
          attempt,
        });
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn('classify.batch.retry', {
          batchIndex: batchIdx,
          attempt,
          error: lastError.message,
        });

        if (attempt === MAX_RETRIES) {
          throw new AgentError(
            `Layout batch ${batchIdx + 1} classification failed after ${MAX_RETRIES + 1} attempts: ${lastError.message}`,
            { code: 'tool_failure' },
          );
        }
      }
    }

    if (batchResults) {
      results.push(...batchResults);
    }
  }

  if (results.length !== summaries.length) {
    throw new AgentError(
      `Classification returned ${results.length} results for ${summaries.length} layouts.`,
      { code: 'tool_failure' },
    );
  }

  logger.info('classify.complete', { totalLayouts: results.length });

  return summaries.map((s, i) => {
    const c = results[i] as {
      displayName?: string;
      bestFitIntents?: string[];
      textCapacity?: number;
    };
    return {
      layoutObjectId: s.layoutObjectId,
      name: s.name,
      displayName: c.displayName ?? s.name,
      slotTypes: s.slotTypes,
      textCapacity: c.textCapacity ?? sumTextCapacity(s.slotTypes),
      imageSlots: s.imageSlots,
      bestFitIntents: Array.isArray(c.bestFitIntents) ? c.bestFitIntents : [],
    };
  });
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sumTextCapacity(slots: SlotDescriptor[]): number {
  return slots.reduce((acc, slot) => acc + slot.textCapacity, 0);
}

function parseLlmArray(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1) {
    throw new Error('Classifier response did not contain a JSON array.');
  }

  const jsonSlice = trimmed.slice(firstBracket, lastBracket + 1);
  try {
    return JSON.parse(jsonSlice);
  } catch (err) {
    throw new Error(
      `Failed to parse JSON array at position ${firstBracket}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Upsert helpers ──────────────────────────────────────────────────────────

async function upsertTemplate(
  db: D1Database,
  input: {
    userId: string;
    googleSlidesId: string;
    name: string;
    brandId: string | null;
    layoutCount: number;
  },
): Promise<string> {
  const existing = await db
    .prepare(
      `SELECT id FROM templates WHERE user_id = ?1 AND google_slides_id = ?2`,
    )
    .bind(input.userId, input.googleSlidesId)
    .first<{ id: string }>();

  const now = Date.now();
  const summary = JSON.stringify({ layoutCount: input.layoutCount });

  if (existing) {
    await db
      .prepare(
        `UPDATE templates
         SET name = ?1, brand_id = ?2, analyzed_at = ?3, analysis_summary = ?4, updated_at = ?5
         WHERE id = ?6`,
      )
      .bind(input.name, input.brandId, now, summary, now, existing.id)
      .run();
    return existing.id;
  }

  const id = `tpl_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO templates
        (id, user_id, brand_id, google_slides_id, name, is_default,
         analyzed_at, analysis_summary, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?8)`,
    )
    .bind(id, input.userId, input.brandId, input.googleSlidesId, input.name, now, summary, now)
    .run();
  return id;
}
