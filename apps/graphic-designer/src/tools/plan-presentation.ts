/**
 * plan_presentation — map an outline onto an analyzed template.
 *
 * Pipeline:
 *   1. Parse the outline (JSON array, JSON string, or markdown)
 *   2. Resolve the template (accepts our `tpl_*` id or a raw Google Slides ID)
 *   3. Load `template_layouts` rows (produced by analyze_template)
 *   4. For each slide: pick a layoutObjectId via the intent map +
 *      best-fit fallback; record warnings for anything that fell back
 *   5. Persist the plan in `projects.metadata` and return the planId
 */

import { AgentError, createLogger } from '@agentbuilder/core';
import type { Env } from '../../worker-configuration';
import {
  DEFAULT_LAYOUT_MAP,
  selectLayoutForIntent,
  type TemplateLayout,
} from '../lib/layout-map.js';
import { parseOutline, type OutlineSlide } from '../lib/outline.js';

export interface PlanPresentationArgs {
  outline: unknown;
  templateId: string;
  brandId?: string;
  audience?: string;
  goal?: string;
  layoutOverrides?: Record<string, string>;
  userId?: string;
}

export interface PlannedSlide {
  index: number;
  intent: string;
  layoutObjectId: string | null;
  layoutStrategy: string;
  title?: string;
  subtitle?: string;
  body?: string[];
  speakerNotes?: string;
}

export interface PlanPresentationResult {
  ok: true;
  planId: string;
  templateId: string;
  googleSlidesId: string;
  slideCount: number;
  plan: PlannedSlide[];
  warnings: string[];
}

interface TemplateRow {
  id: string;
  google_slides_id: string;
  name: string;
}

interface LayoutRow {
  layout_object_id: string;
  name: string;
  display_name: string | null;
  best_fit_intents: string | null;
}

export async function planPresentation(
  env: Env,
  args: PlanPresentationArgs,
): Promise<PlanPresentationResult> {
  const logger = createLogger({ base: { agent: 'graphic-designer', tool: 'plan_presentation' } });
  const userId = args.userId ?? 'default';

  const slides = parseOutline(args.outline);
  if (slides.length === 0) {
    throw new AgentError('Outline contains no slides.', { code: 'invalid_input' });
  }

  logger.info('outline.parsed', {
    slideCount: slides.length,
    perSlide: slides.map((s, i) => ({
      index: i,
      intent: s.intent,
      titleLen: s.title?.length ?? 0,
      subtitleLen: s.subtitle?.length ?? 0,
      bodyCount: s.body?.length ?? 0,
      bodyChars: s.body?.reduce((n, b) => n + b.length, 0) ?? 0,
      notesLen: s.speakerNotes?.length ?? 0,
    })),
  });

  const template = await resolveTemplate(env.DB, userId, args.templateId);
  const layouts = await loadLayouts(env.DB, template.id);

  const warnings: string[] = [];
  if (layouts.length === 0) {
    warnings.push(
      `Template ${template.id} has no layout analysis — run analyze_template first for best-fit fallback.`,
    );
  }

  const overrides = args.layoutOverrides ?? {};
  const plan: PlannedSlide[] = slides.map((slide, i) => buildSlidePlan(slide, i, layouts, overrides, warnings));

  const planId = `prj_${crypto.randomUUID()}`;
  const now = Date.now();
  const metadata = {
    kind: 'presentation',
    outline: slides,
    plan,
    templateId: template.id,
    googleSlidesId: template.google_slides_id,
    brandId: args.brandId ?? null,
    audience: args.audience ?? null,
    goal: args.goal ?? null,
    layoutOverrides: overrides,
  };

  await env.DB.prepare(
    `INSERT INTO projects
       (id, user_id, brand_id, name, kind, status, metadata, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'presentation', 'planning', ?5, ?6, ?6)`,
  )
    .bind(
      planId,
      userId,
      args.brandId ?? null,
      projectName(slides),
      JSON.stringify(metadata),
      now,
    )
    .run();

  logger.info('plan.saved', {
    planId,
    slideCount: plan.length,
    templateId: template.id,
    warningCount: warnings.length,
  });

  return {
    ok: true,
    planId,
    templateId: template.id,
    googleSlidesId: template.google_slides_id,
    slideCount: plan.length,
    plan,
    warnings,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildSlidePlan(
  slide: OutlineSlide,
  index: number,
  layouts: TemplateLayout[],
  overrides: Record<string, string>,
  warnings: string[],
): PlannedSlide {
  const selection = selectLayoutForIntent(slide.intent, layouts, overrides);

  if (selection.strategy === 'fallback') {
    warnings.push(`Slide ${index + 1} (${slide.intent}): ${selection.reason}`);
  } else if (selection.strategy === 'blank' && slide.intent !== 'big-number') {
    warnings.push(`Slide ${index + 1} (${slide.intent}): ${selection.reason}`);
  } else if (
    selection.strategy === 'explicit' &&
    layouts.length === 0 &&
    DEFAULT_LAYOUT_MAP[slide.intent] === selection.layoutObjectId
  ) {
    warnings.push(
      `Slide ${index + 1}: using default-map layout ${selection.layoutObjectId} for "${slide.intent}" without template analysis — run analyze_template to verify.`,
    );
  }

  // Explicitly assemble the plan object so undefined fields aren't silently
  // dropped by JSON.stringify. Empty string / empty array are safe sentinels
  // that survive round-tripping and clearly distinguish "no content" from
  // "serialization lost the field".
  const planned: PlannedSlide = {
    index,
    intent: slide.intent,
    layoutObjectId: selection.layoutObjectId,
    layoutStrategy: selection.strategy,
    title: slide.title ?? '',
    subtitle: slide.subtitle ?? '',
    body: slide.body ?? [],
    speakerNotes: slide.speakerNotes ?? '',
  };
  return planned;
}

async function resolveTemplate(
  db: D1Database,
  userId: string,
  idOrSlidesId: string,
): Promise<TemplateRow> {
  const extracted = extractPresentationId(idOrSlidesId);
  const byLocal = await db
    .prepare(
      `SELECT id, google_slides_id, name FROM templates
       WHERE user_id = ?1 AND (id = ?2 OR google_slides_id = ?3)`,
    )
    .bind(userId, idOrSlidesId, extracted)
    .first<TemplateRow>();
  if (byLocal) return byLocal;

  throw new AgentError(
    `Template not found for user "${userId}": ${idOrSlidesId}. ` +
      `Register it via manage_brand_assets or run analyze_template first.`,
    { code: 'not_found' },
  );
}

async function loadLayouts(db: D1Database, templateId: string): Promise<TemplateLayout[]> {
  const { results } = await db
    .prepare(
      `SELECT layout_object_id, name, display_name, best_fit_intents
         FROM template_layouts
        WHERE template_id = ?1`,
    )
    .bind(templateId)
    .all<LayoutRow>();

  return (results ?? []).map((row) => ({
    layoutObjectId: row.layout_object_id,
    name: row.name,
    displayName: row.display_name ?? undefined,
    bestFitIntents: parseIntents(row.best_fit_intents),
  }));
}

function parseIntents(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function projectName(slides: OutlineSlide[]): string {
  const first = slides.find((s) => s.title);
  return (first?.title ?? 'Untitled presentation').slice(0, 200);
}

function extractPresentationId(input: string): string {
  const match = input.match(/\/presentations\/([a-zA-Z0-9_-]+)/);
  return match ? (match[1] ?? input) : input;
}
