/**
 * plan_presentation — turn a content outline into a reviewable slide plan.
 *
 * Inputs:
 *   - outline     (prose or bullets)
 *   - templateId  (must have been analyzed — we read template_layouts)
 *   - audience, goal, brandId (optional context)
 *
 * Pipeline:
 *   1. Load the template + its analyzed layouts from D1.
 *   2. Optionally load brand voice for tone alignment.
 *   3. Ask the LLM (deep tier) to produce a slide-by-slide plan:
 *        - story arc (one-line synopsis per slide)
 *        - layoutObjectId per slide (chosen from available layouts)
 *        - text blocks (title, body, etc.)
 *        - image/icon needs (search queries for search_media)
 *        - speaker notes beat
 *   4. Persist the plan as a project row (kind='presentation', status='planning').
 *   5. Return the plan + planId for user review.
 */

import { AgentError, createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../../worker-configuration';

export interface PlanPresentationArgs {
  outline: string;
  templateId: string;
  brandId?: string;
  audience?: string;
  goal?: string;
  userId?: string;
}

export interface SlidePlan {
  index: number;
  layoutObjectId: string;
  layoutDisplayName: string;
  intent: string;
  synopsis: string;
  text: Record<string, string>;      // slot type -> copy (e.g. { TITLE: "...", BODY: "..." })
  mediaNeeds: MediaNeed[];
  speakerNotes: string;
}

export interface MediaNeed {
  kind: 'photo' | 'icon' | 'illustration';
  query: string;
  placement: string;                 // which slot or region: "image_slot_1", "background", etc.
}

export interface PlanPresentationResult {
  ok: true;
  planId: string;
  templateId: string;
  slideCount: number;
  storyArc: string[];
  slides: SlidePlan[];
}

interface LayoutRow {
  layout_object_id: string;
  name: string;
  display_name: string | null;
  slot_types: string;
  text_capacity: number | null;
  image_slots: number;
  best_fit_intents: string | null;
}

interface TemplateRow {
  id: string;
  google_slides_id: string;
  name: string;
  analyzed_at: number | null;
}

export async function planPresentation(
  env: Env,
  args: PlanPresentationArgs,
): Promise<PlanPresentationResult> {
  const logger = createLogger({ base: { agent: 'graphic-designer', tool: 'plan_presentation' } });
  const userId = args.userId ?? 'default';

  if (!args.outline.trim()) {
    throw new AgentError('outline is required and non-empty.', { code: 'invalid_input' });
  }

  const template = await env.DB.prepare(
    `SELECT id, google_slides_id, name, analyzed_at
       FROM templates
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(args.templateId, userId)
    .first<TemplateRow>();

  if (!template) {
    throw new AgentError(`Template "${args.templateId}" not found for user.`, { code: 'not_found' });
  }
  if (!template.analyzed_at) {
    throw new AgentError('Template has not been analyzed. Run analyze_template first.', {
      code: 'invalid_input',
    });
  }

  const layoutRows = await env.DB.prepare(
    `SELECT layout_object_id, name, display_name, slot_types, text_capacity, image_slots, best_fit_intents
       FROM template_layouts
      WHERE template_id = ?1`,
  )
    .bind(template.id)
    .all<LayoutRow>();

  const layouts = layoutRows.results ?? [];
  if (layouts.length === 0) {
    throw new AgentError('Template has no analyzed layouts.', { code: 'invalid_input' });
  }

  const brandHint = args.brandId ? await loadBrandVoice(env, userId, args.brandId) : null;

  logger.info('plan.start', {
    outlineLen: args.outline.length,
    layoutCount: layouts.length,
    brand: !!brandHint,
  });

  const llm = new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY, workersAi: env.AI });

  const layoutCatalog = layouts.map((l) => ({
    layoutObjectId: l.layout_object_id,
    displayName: l.display_name ?? l.name,
    intents: safeJsonArray(l.best_fit_intents).filter(
      (x): x is string => typeof x === 'string',
    ),
    textCapacity: l.text_capacity ?? 0,
    imageSlots: l.image_slots,
    slots: (safeJsonArray(l.slot_types) as SlotInfo[]).map((s) => ({
      type: s.type,
      textCapacity: s.textCapacity,
    })),
  }));

  const userPrompt = buildPlannerPrompt({
    outline: args.outline,
    audience: args.audience,
    goal: args.goal,
    brandVoice: brandHint,
    layouts: layoutCatalog,
  });

  const res = await llm.complete({
    tier: 'deep',
    system: PLANNER_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const parsed = parsePlannerOutput(res.text);
  const slides = normaliseSlides(parsed.slides, layouts);

  const planId = `prj_${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO projects
       (id, user_id, brand_id, name, kind, status, metadata, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'presentation', 'planning', ?5, ?6, ?6)`,
  )
    .bind(
      planId,
      userId,
      args.brandId ?? null,
      parsed.title ?? `Presentation — ${new Date(now).toISOString().slice(0, 10)}`,
      JSON.stringify({
        templateId: template.id,
        googleSlidesId: template.google_slides_id,
        outline: args.outline,
        audience: args.audience ?? null,
        goal: args.goal ?? null,
        storyArc: parsed.storyArc,
        slides,
      }),
      now,
    )
    .run();

  logger.info('plan.done', { planId, slides: slides.length });

  return {
    ok: true,
    planId,
    templateId: template.id,
    slideCount: slides.length,
    storyArc: parsed.storyArc,
    slides,
  };
}

// ── LLM prompt ─────────────────────────────────────────────────────────────

const PLANNER_SYSTEM = `You are a presentation planner. You map a content outline to a slide deck,
using ONLY the layouts supplied in the template catalog.

For each slide, pick the best layoutObjectId from the catalog. Match intent to
bestFitIntents. Respect each slot's textCapacity — do not exceed it. Prefer
shorter, punchier copy (audiences read slides at a glance).

Output strict JSON with this exact shape — no prose, no markdown fences:
{
  "title": "<short deck title>",
  "storyArc": ["<one-line synopsis per slide in order>", ...],
  "slides": [
    {
      "index": 0,
      "layoutObjectId": "<from catalog>",
      "intent": "<one of the intent enum values>",
      "synopsis": "<one-liner>",
      "text": { "TITLE": "...", "BODY": "...", "SUBTITLE": "..." },
      "mediaNeeds": [
        { "kind": "photo|icon|illustration", "query": "...", "placement": "image_slot_1" }
      ],
      "speakerNotes": "<2-4 sentences the speaker would say>"
    }
  ]
}

Rules:
- Every slide's layoutObjectId MUST exist in the template catalog.
- Use text slot names that appear in that layout's slots (e.g. TITLE, BODY, SUBTITLE, CENTERED_TITLE).
- mediaNeeds is only populated for layouts with imageSlots > 0.
- 8-16 slides typical. Include a title slide, section breaks, and a closing.
- Speaker notes are what the speaker says out loud — not a rehash of the slide copy.`;

interface LayoutCatalogEntry {
  layoutObjectId: string;
  displayName: string;
  intents: string[];
  textCapacity: number;
  imageSlots: number;
  slots: Array<{ type: string; textCapacity: number }>;
}

function buildPlannerPrompt(input: {
  outline: string;
  audience?: string;
  goal?: string;
  brandVoice: BrandVoiceHint | null;
  layouts: LayoutCatalogEntry[];
}): string {
  const parts: string[] = [];
  parts.push('# Outline');
  parts.push(input.outline);
  parts.push('');

  if (input.audience) {
    parts.push(`# Audience\n${input.audience}`);
    parts.push('');
  }
  if (input.goal) {
    parts.push(`# Goal\n${input.goal}`);
    parts.push('');
  }
  if (input.brandVoice) {
    parts.push('# Brand voice');
    if (input.brandVoice.tone) parts.push(`Tone: ${input.brandVoice.tone}`);
    if (input.brandVoice.adjectives?.length)
      parts.push(`Adjectives: ${input.brandVoice.adjectives.join(', ')}`);
    if (input.brandVoice.avoid?.length) parts.push(`Avoid: ${input.brandVoice.avoid.join(', ')}`);
    parts.push('');
  }

  parts.push('# Template layout catalog');
  parts.push(JSON.stringify(input.layouts, null, 2));
  parts.push('');
  parts.push('Return the JSON plan now.');
  return parts.join('\n');
}

// ── Parsing + validation ───────────────────────────────────────────────────

interface ParsedPlan {
  title?: string;
  storyArc: string[];
  slides: SlidePlan[];
}

function parsePlannerOutput(text: string): ParsedPlan {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last === -1) {
    throw new AgentError('Planner did not return JSON.', { code: 'tool_failure' });
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed.slice(first, last + 1));
  } catch (err) {
    throw new AgentError(
      `Planner JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      { code: 'tool_failure' },
    );
  }
  const obj = json as Partial<ParsedPlan>;
  if (!Array.isArray(obj.slides) || obj.slides.length === 0) {
    throw new AgentError('Planner returned no slides.', { code: 'tool_failure' });
  }
  return {
    title: obj.title,
    storyArc: Array.isArray(obj.storyArc) ? obj.storyArc : [],
    slides: obj.slides,
  };
}

function normaliseSlides(slides: SlidePlan[], layouts: LayoutRow[]): SlidePlan[] {
  const layoutById = new Map(
    layouts.map((l) => [l.layout_object_id, l] as const),
  );

  return slides.map((s, i) => {
    const match = layoutById.get(s.layoutObjectId);
    if (!match) {
      throw new AgentError(
        `Slide ${i}: layoutObjectId "${s.layoutObjectId}" not in template.`,
        { code: 'tool_failure' },
      );
    }
    return {
      index: typeof s.index === 'number' ? s.index : i,
      layoutObjectId: s.layoutObjectId,
      layoutDisplayName: match.display_name ?? match.name,
      intent: s.intent ?? 'single-idea',
      synopsis: s.synopsis ?? '',
      text: s.text ?? {},
      mediaNeeds: Array.isArray(s.mediaNeeds) ? s.mediaNeeds : [],
      speakerNotes: s.speakerNotes ?? '',
    };
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface SlotInfo {
  type: string;
  textCapacity: number;
}

interface BrandVoiceHint {
  tone?: string;
  adjectives?: string[];
  avoid?: string[];
}

async function loadBrandVoice(
  env: Env,
  userId: string,
  brandId: string,
): Promise<BrandVoiceHint | null> {
  const row = await env.DB.prepare(
    `SELECT voice FROM brand_guides WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(brandId, userId)
    .first<{ voice: string | null }>();
  if (!row?.voice) return null;
  try {
    return JSON.parse(row.voice) as BrandVoiceHint;
  } catch {
    return null;
  }
}

function safeJsonArray(s: string | null): unknown[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
