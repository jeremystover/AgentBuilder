/**
 * plan_site — propose a reviewable static site structure from a content outline.
 *
 * Outputs an information architecture: page list, per-page section blocks,
 * visual language (tokens), and media needs. Stored as a `projects` row with
 * kind='site', status='planning' — build_and_deploy_site consumes it.
 *
 * Pipeline:
 *   1. Load brand guide (optional) for palette, typography, voice.
 *   2. Deep-tier LLM call with the outline + brand + siteType.
 *   3. Parse + validate the plan.
 *   4. Persist and return.
 */

import { AgentError, createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../../worker-configuration';

export type SiteType = 'landing' | 'multi-page' | 'portfolio' | 'docs';

export interface PlanSiteArgs {
  outline: string;
  brandId?: string;
  siteType?: SiteType;
  audience?: string;
  userId?: string;
}

export interface PlanSiteResult {
  ok: true;
  planId: string;
  siteType: SiteType;
  visualLanguage: VisualLanguage;
  pages: SitePage[];
}

export interface SitePage {
  slug: string;                  // e.g. "index", "about", "pricing"
  title: string;
  description: string;           // meta description
  sections: SiteSection[];
}

export interface SiteSection {
  block: SectionBlock;           // hero | features | testimonials | cta | text | gallery | contact | footer | header
  id: string;
  headline?: string;
  subhead?: string;
  body?: string;
  items?: Array<{ title: string; body: string; icon?: string }>;
  mediaNeed?: { kind: 'photo' | 'icon' | 'illustration'; query: string; placement: string };
  cta?: { label: string; href: string };
}

export type SectionBlock =
  | 'header'
  | 'hero'
  | 'features'
  | 'testimonials'
  | 'cta'
  | 'text'
  | 'gallery'
  | 'contact'
  | 'footer';

export interface VisualLanguage {
  palette: Record<string, string>;         // css variable name -> hex
  typography: { heading: string; body: string; scale: string };
  grid: { maxWidth: string; gutter: string; columns: number };
  tone: string;
}

interface BrandContext {
  name: string;
  palette: Record<string, string>;
  typography: { heading: string; body: string; display?: string; scale?: string };
  voice: { tone?: string; adjectives?: string[]; avoid?: string[] };
}

export async function planSite(env: Env, args: PlanSiteArgs): Promise<PlanSiteResult> {
  const logger = createLogger({ base: { agent: 'graphic-designer', tool: 'plan_site' } });
  const userId = args.userId ?? 'default';
  const siteType: SiteType = args.siteType ?? 'landing';

  if (!args.outline.trim()) {
    throw new AgentError('outline is required.', { code: 'invalid_input' });
  }

  const brand = args.brandId ? await loadBrand(env, userId, args.brandId) : null;

  logger.info('plan.start', { siteType, hasBrand: !!brand });

  const llm = new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY, workersAi: env.AI });
  const userPrompt = buildPrompt({
    outline: args.outline,
    audience: args.audience,
    siteType,
    brand,
  });

  const res = await llm.complete({
    tier: 'deep',
    system: SITE_PLANNER_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const parsed = parseAndValidate(res.text, siteType);
  const visualLanguage = mergeVisualLanguage(parsed.visualLanguage, brand);

  const planId = `prj_${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO projects
       (id, user_id, brand_id, name, kind, status, metadata, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'site', 'planning', ?5, ?6, ?6)`,
  )
    .bind(
      planId,
      userId,
      args.brandId ?? null,
      parsed.title ?? `Site — ${new Date(now).toISOString().slice(0, 10)}`,
      JSON.stringify({
        siteType,
        outline: args.outline,
        audience: args.audience ?? null,
        visualLanguage,
        pages: parsed.pages,
      }),
      now,
    )
    .run();

  logger.info('plan.done', { planId, pages: parsed.pages.length });

  return {
    ok: true,
    planId,
    siteType,
    visualLanguage,
    pages: parsed.pages,
  };
}

// ── LLM prompt ──────────────────────────────────────────────────────────────

const SITE_PLANNER_SYSTEM = `You are a web designer planning a static site.

Given a content outline, produce a complete site plan as strict JSON:
{
  "title": "short site name",
  "visualLanguage": {
    "palette": { "primary": "#HEX", "accent": "#HEX", "bg": "#HEX", "text": "#HEX", "muted": "#HEX" },
    "typography": { "heading": "<font>", "body": "<font>", "scale": "<e.g. 1.25>" },
    "grid": { "maxWidth": "1200px", "gutter": "24px", "columns": 12 },
    "tone": "one sentence"
  },
  "pages": [
    {
      "slug": "index | about | pricing | ...",
      "title": "page title",
      "description": "meta description (150 chars max)",
      "sections": [
        {
          "block": "header | hero | features | testimonials | cta | text | gallery | contact | footer",
          "id": "section-kebab-id",
          "headline": "...",
          "subhead": "...",
          "body": "paragraph or bullet list in markdown",
          "items": [ { "title": "...", "body": "...", "icon": "search-query for an icon" } ],
          "mediaNeed": { "kind": "photo|icon|illustration", "query": "...", "placement": "hero-background | inline" },
          "cta": { "label": "...", "href": "#id or /page or https://..." }
        }
      ]
    }
  ]
}

Rules:
- Landing: one page with slug "index", 5-7 sections (header, hero, features, testimonials, cta, footer is common).
- Multi-page: 3-6 pages, each with its own section list. Always include an "index".
- Portfolio: index + at least one "gallery" page with project cards as items.
- Docs: index (overview) + 2-5 topic pages with mostly "text" sections.
- Every page MUST have a "header" and "footer" section.
- "hero" sections typically include a mediaNeed with placement "hero-background".
- "features" sections use items[] (3-6 items).
- Only include fields relevant to the block — do not stuff every field into every section.
- Use the brand palette if provided; otherwise invent a coherent palette.

Output strict JSON, no prose, no markdown fences.`;

function buildPrompt(input: {
  outline: string;
  audience?: string;
  siteType: SiteType;
  brand: BrandContext | null;
}): string {
  const parts: string[] = [];
  parts.push(`# Site type\n${input.siteType}`);
  parts.push('');
  parts.push('# Outline');
  parts.push(input.outline);
  parts.push('');
  if (input.audience) {
    parts.push(`# Audience\n${input.audience}`);
    parts.push('');
  }
  if (input.brand) {
    parts.push('# Brand');
    parts.push(`Name: ${input.brand.name}`);
    parts.push(`Palette: ${JSON.stringify(input.brand.palette)}`);
    parts.push(`Typography: ${JSON.stringify(input.brand.typography)}`);
    if (input.brand.voice.tone) parts.push(`Voice: ${input.brand.voice.tone}`);
    if (input.brand.voice.adjectives?.length)
      parts.push(`Adjectives: ${input.brand.voice.adjectives.join(', ')}`);
    if (input.brand.voice.avoid?.length) parts.push(`Avoid: ${input.brand.voice.avoid.join(', ')}`);
    parts.push('');
  }
  parts.push('Return the JSON plan now.');
  return parts.join('\n');
}

// ── Parse + validate ────────────────────────────────────────────────────────

const VALID_BLOCKS: Set<SectionBlock> = new Set([
  'header', 'hero', 'features', 'testimonials', 'cta', 'text', 'gallery', 'contact', 'footer',
]);

function parseAndValidate(
  text: string,
  siteType: SiteType,
): { title?: string; visualLanguage: VisualLanguage; pages: SitePage[] } {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last === -1) {
    throw new AgentError('Site planner did not return JSON.', { code: 'tool_failure' });
  }
  let obj: {
    title?: string;
    visualLanguage?: Partial<VisualLanguage>;
    pages?: unknown[];
  };
  try {
    obj = JSON.parse(trimmed.slice(first, last + 1));
  } catch (err) {
    throw new AgentError(
      `Site plan JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      { code: 'tool_failure' },
    );
  }

  const pages = Array.isArray(obj.pages)
    ? obj.pages
        .map((p) => validatePage(p))
        .filter((p): p is SitePage => p !== null)
    : [];

  if (pages.length === 0) {
    throw new AgentError('Site plan has no valid pages.', { code: 'tool_failure' });
  }
  if (!pages.some((p) => p.slug === 'index')) {
    throw new AgentError('Site plan must include an "index" page.', { code: 'tool_failure' });
  }
  if (siteType === 'landing' && pages.length > 1) {
    // Keep only the index for landing
    const indexPage = pages.find((p) => p.slug === 'index');
    if (indexPage) pages.splice(0, pages.length, indexPage);
  }

  const vl = obj.visualLanguage ?? {};
  const visualLanguage: VisualLanguage = {
    palette: (vl.palette as Record<string, string>) ?? {
      primary: '#111111', accent: '#2563eb', bg: '#ffffff', text: '#111111', muted: '#6b7280',
    },
    typography: {
      heading: vl.typography?.heading ?? 'Inter',
      body: vl.typography?.body ?? 'Inter',
      scale: vl.typography?.scale ?? '1.25',
    },
    grid: {
      maxWidth: vl.grid?.maxWidth ?? '1200px',
      gutter: vl.grid?.gutter ?? '24px',
      columns: vl.grid?.columns ?? 12,
    },
    tone: vl.tone ?? '',
  };

  return { title: obj.title, visualLanguage, pages };
}

function validatePage(raw: unknown): SitePage | null {
  const p = raw as Partial<SitePage> & { sections?: unknown[] };
  if (!p || typeof p.slug !== 'string' || typeof p.title !== 'string') return null;
  const sections = Array.isArray(p.sections)
    ? p.sections
        .map((s) => validateSection(s))
        .filter((s): s is SiteSection => s !== null)
    : [];
  if (sections.length === 0) return null;
  return {
    slug: p.slug,
    title: p.title,
    description: typeof p.description === 'string' ? p.description : '',
    sections,
  };
}

function validateSection(raw: unknown): SiteSection | null {
  const s = raw as Partial<SiteSection>;
  if (!s || typeof s.block !== 'string' || !VALID_BLOCKS.has(s.block as SectionBlock)) return null;
  return {
    block: s.block as SectionBlock,
    id: typeof s.id === 'string' ? s.id : `sec-${crypto.randomUUID().slice(0, 8)}`,
    headline: typeof s.headline === 'string' ? s.headline : undefined,
    subhead: typeof s.subhead === 'string' ? s.subhead : undefined,
    body: typeof s.body === 'string' ? s.body : undefined,
    items: Array.isArray(s.items)
      ? s.items.filter((i): i is { title: string; body: string; icon?: string } =>
          !!i && typeof i === 'object' && typeof (i as { title?: unknown }).title === 'string',
        )
      : undefined,
    mediaNeed: s.mediaNeed,
    cta: s.cta,
  };
}

// ── Brand merge ────────────────────────────────────────────────────────────

function mergeVisualLanguage(vl: VisualLanguage, brand: BrandContext | null): VisualLanguage {
  if (!brand) return vl;
  return {
    palette: Object.keys(brand.palette).length > 0 ? brand.palette : vl.palette,
    typography: {
      heading: brand.typography.heading ?? vl.typography.heading,
      body: brand.typography.body ?? vl.typography.body,
      scale: brand.typography.scale ?? vl.typography.scale,
    },
    grid: vl.grid,
    tone: brand.voice.tone ?? vl.tone,
  };
}

async function loadBrand(env: Env, userId: string, brandId: string): Promise<BrandContext | null> {
  const row = await env.DB.prepare(
    `SELECT name, palette, typography, voice FROM brand_guides
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(brandId, userId)
    .first<{ name: string; palette: string; typography: string; voice: string | null }>();
  if (!row) return null;
  return {
    name: row.name,
    palette: (safeJson<Record<string, string>>(row.palette) ?? {}),
    typography: (safeJson<BrandContext['typography']>(row.typography) ?? { heading: 'Inter', body: 'Inter' }),
    voice: (safeJson<BrandContext['voice']>(row.voice) ?? {}),
  };
}

function safeJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
