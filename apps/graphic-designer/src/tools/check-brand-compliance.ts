/**
 * check_brand_compliance — audit a Google Doc or Slides file against a brand guide.
 *
 * Pipeline:
 *   1. Load the brand guide (palette, typography, voice, logo usage, spacing).
 *   2. Fetch the file metadata via Drive API to determine type (doc vs slides).
 *   3. Fetch the full document:
 *        - Docs: GET documents/{id} — extract text styles, named styles, inline images
 *        - Slides: GET presentations/{id} — extract page element styles, colors, fonts
 *   4. Build a compact style summary: fonts used, hex colors used, text samples.
 *   5. Deep-tier LLM compares the summary against the brand guide and produces
 *      a structured violation report.
 *   6. Persist the report in compliance_reports and return it.
 */

import { AgentError, createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../../worker-configuration';
import { GoogleClient } from '../lib/google-client.js';

const DOCS_API = 'https://docs.googleapis.com/v1';
const SLIDES_API = 'https://slides.googleapis.com/v1';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

export interface CheckBrandComplianceArgs {
  fileId: string;
  brandId: string;
  userId?: string;
}

export interface Violation {
  rule: string;
  location: string;
  severity: 'error' | 'warning' | 'info';
  suggestion: string;
}

export interface CheckBrandComplianceResult {
  ok: true;
  reportId: string;
  fileId: string;
  fileType: 'doc' | 'slides';
  brandId: string;
  score: number;
  violations: Violation[];
  summary: string;
}

interface BrandGuideRow {
  id: string;
  name: string;
  palette: string;
  typography: string;
  voice: string | null;
  logo_usage: string | null;
  spacing: string | null;
}

export async function checkBrandCompliance(
  env: Env,
  args: CheckBrandComplianceArgs,
): Promise<CheckBrandComplianceResult> {
  const logger = createLogger({
    base: { agent: 'graphic-designer', tool: 'check_brand_compliance' },
  });
  const userId = args.userId ?? 'default';

  // 1) Load brand guide
  const brand = await env.DB.prepare(
    `SELECT id, name, palette, typography, voice, logo_usage, spacing
       FROM brand_guides WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(args.brandId, userId)
    .first<BrandGuideRow>();

  if (!brand) {
    throw new AgentError(`Brand "${args.brandId}" not found.`, { code: 'not_found' });
  }

  const google = new GoogleClient({ env, userId });

  // 2) Determine file type
  const fileType = await detectFileType(google, args.fileId);
  logger.info('compliance.start', { fileId: args.fileId, fileType, brandId: brand.id });

  // 3) Extract style summary
  const styleSummary =
    fileType === 'doc'
      ? await extractDocStyles(google, args.fileId)
      : await extractSlidesStyles(google, args.fileId);

  // 4) LLM audit
  const llm = new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY, workersAi: env.AI });
  const { score, violations, summary } = await auditWithLlm(llm, brand, styleSummary, fileType);

  // 5) Persist report
  const reportId = `rpt_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO compliance_reports
       (id, user_id, brand_id, file_id, file_type, score, violations, summary, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      reportId,
      userId,
      brand.id,
      args.fileId,
      fileType,
      score,
      JSON.stringify(violations),
      summary,
      Date.now(),
    )
    .run();

  logger.info('compliance.done', { reportId, score, violations: violations.length });

  return {
    ok: true,
    reportId,
    fileId: args.fileId,
    fileType,
    brandId: brand.id,
    score,
    violations,
    summary,
  };
}

// ── File type detection ─────────────────────────────────────────────────────

async function detectFileType(
  google: GoogleClient,
  fileId: string,
): Promise<'doc' | 'slides'> {
  const res = await google.gfetch(
    `${DRIVE_API}/files/${fileId}?fields=mimeType&supportsAllDrives=true`,
  );
  if (!res.ok) {
    throw new AgentError(`Drive metadata fetch failed (${res.status}): ${await res.text()}`, {
      code: 'upstream_failure',
    });
  }
  const file = (await res.json()) as { mimeType?: string };
  if (file.mimeType === 'application/vnd.google-apps.presentation') return 'slides';
  if (file.mimeType === 'application/vnd.google-apps.document') return 'doc';
  throw new AgentError(
    `Unsupported file type: ${file.mimeType}. Only Google Docs and Slides are supported.`,
    { code: 'invalid_input' },
  );
}

// ── Style extraction: Docs ──────────────────────────────────────────────────

interface StyleSummary {
  fontsUsed: string[];
  colorsUsed: string[];
  textSamples: Array<{ text: string; font?: string; fontSize?: number; color?: string }>;
  imageCount: number;
  pageCount?: number;
}

async function extractDocStyles(google: GoogleClient, fileId: string): Promise<StyleSummary> {
  const res = await google.gfetch(
    `${DOCS_API}/documents/${fileId}?fields=body(content(paragraph(elements(textRun(content,textStyle(fontFamily,fontSize,foregroundColor))),paragraphStyle(namedStyleType)))),inlineObjects`,
  );
  if (!res.ok) {
    throw new AgentError(`Docs API failed (${res.status}): ${await res.text()}`, {
      code: 'upstream_failure',
    });
  }

  const doc = (await res.json()) as {
    body?: { content?: DocContent[] };
    inlineObjects?: Record<string, unknown>;
  };

  const fonts = new Set<string>();
  const colors = new Set<string>();
  const samples: StyleSummary['textSamples'] = [];
  let imageCount = 0;

  for (const block of doc.body?.content ?? []) {
    for (const el of block.paragraph?.elements ?? []) {
      const run = el.textRun;
      if (!run) continue;
      const style = run.textStyle;
      if (style?.fontFamily) fonts.add(style.fontFamily);
      const fg = style?.foregroundColor?.color?.rgbColor;
      const hex = fg ? rgbToHex(fg) : undefined;
      if (hex) colors.add(hex);

      const text = (run.content ?? '').trim();
      if (text && samples.length < 20) {
        samples.push({
          text: text.slice(0, 100),
          font: style?.fontFamily,
          fontSize: style?.fontSize?.magnitude,
          color: hex,
        });
      }
    }
  }

  if (doc.inlineObjects) {
    imageCount = Object.keys(doc.inlineObjects).length;
  }

  return {
    fontsUsed: [...fonts],
    colorsUsed: [...colors],
    textSamples: samples,
    imageCount,
  };
}

interface DocContent {
  paragraph?: {
    elements?: Array<{
      textRun?: {
        content?: string;
        textStyle?: {
          fontFamily?: string;
          fontSize?: { magnitude?: number };
          foregroundColor?: { color?: { rgbColor?: RgbColor } };
        };
      };
    }>;
    paragraphStyle?: { namedStyleType?: string };
  };
}

interface RgbColor {
  red?: number;
  green?: number;
  blue?: number;
}

// ── Style extraction: Slides ────────────────────────────────────────────────

async function extractSlidesStyles(google: GoogleClient, fileId: string): Promise<StyleSummary> {
  const res = await google.gfetch(
    `${SLIDES_API}/presentations/${fileId}?fields=slides(pageElements(shape(text(textElements(textRun(content,style(fontFamily,fontSize,foregroundColor)))),shapeType,shapeProperties(shapeBackgroundFill)),image))`,
  );
  if (!res.ok) {
    throw new AgentError(`Slides API failed (${res.status}): ${await res.text()}`, {
      code: 'upstream_failure',
    });
  }

  const pres = (await res.json()) as { slides?: SlidesPageRaw[] };
  const fonts = new Set<string>();
  const colors = new Set<string>();
  const samples: StyleSummary['textSamples'] = [];
  let imageCount = 0;

  for (const slide of pres.slides ?? []) {
    for (const el of slide.pageElements ?? []) {
      if (el.image) { imageCount++; continue; }
      const bgFill = el.shape?.shapeProperties?.shapeBackgroundFill;
      if (bgFill?.solidFill?.color?.rgbColor) {
        colors.add(rgbToHex(bgFill.solidFill.color.rgbColor));
      }
      for (const te of el.shape?.text?.textElements ?? []) {
        const run = te.textRun;
        if (!run) continue;
        const style = run.style;
        if (style?.fontFamily) fonts.add(style.fontFamily);
        const fg = style?.foregroundColor?.opaqueColor?.rgbColor;
        if (fg) colors.add(rgbToHex(fg));

        const text = (run.content ?? '').trim();
        if (text && samples.length < 30) {
          samples.push({
            text: text.slice(0, 100),
            font: style?.fontFamily,
            fontSize: style?.fontSize?.magnitude,
            color: fg ? rgbToHex(fg) : undefined,
          });
        }
      }
    }
  }

  return {
    fontsUsed: [...fonts],
    colorsUsed: [...colors],
    textSamples: samples,
    imageCount,
    pageCount: pres.slides?.length,
  };
}

interface SlidesPageRaw {
  pageElements?: Array<{
    shape?: {
      text?: {
        textElements?: Array<{
          textRun?: {
            content?: string;
            style?: {
              fontFamily?: string;
              fontSize?: { magnitude?: number };
              foregroundColor?: { opaqueColor?: { rgbColor?: RgbColor } };
            };
          };
        }>;
      };
      shapeType?: string;
      shapeProperties?: {
        shapeBackgroundFill?: {
          solidFill?: { color?: { rgbColor?: RgbColor } };
        };
      };
    };
    image?: unknown;
  }>;
}

// ── LLM audit ───────────────────────────────────────────────────────────────

const AUDIT_SYSTEM = `You are a brand compliance auditor. Given a brand style guide and a
document's extracted styles, produce a structured audit report.

Check for:
- **Colour compliance**: colours used vs brand palette. Flag off-brand hex values.
- **Typography compliance**: fonts used vs brand heading/body/display fonts.
- **Voice & tone**: do text samples match the brand voice adjectives? Flag language
  that contradicts the brand's avoid list.
- **Logo & spacing**: note any potential issues based on logo_usage rules.
- **Consistency**: mixed font families, inconsistent font sizes, too many colours.

Output strict JSON:
{
  "score": <0-100 integer, 100 = fully compliant>,
  "summary": "<2-3 sentence overall assessment>",
  "violations": [
    {
      "rule": "<which brand rule is violated>",
      "location": "<where in the document — e.g. 'slide 3', 'paragraph 5', 'throughout'>",
      "severity": "error | warning | info",
      "suggestion": "<specific fix>"
    }
  ]
}

Scoring guide:
- 90-100: fully compliant, minor suggestions only
- 70-89: mostly compliant, a few off-brand elements
- 50-69: significant deviations
- below 50: major brand violations

No prose, no markdown fences. Output only the JSON object.`;

interface AuditResult {
  score: number;
  violations: Violation[];
  summary: string;
}

async function auditWithLlm(
  llm: LLMClient,
  brand: BrandGuideRow,
  styles: StyleSummary,
  fileType: 'doc' | 'slides',
): Promise<AuditResult> {
  const brandSpec = {
    name: brand.name,
    palette: safeJson(brand.palette),
    typography: safeJson(brand.typography),
    voice: safeJson(brand.voice),
    logoUsage: safeJson(brand.logo_usage),
    spacing: safeJson(brand.spacing),
  };

  const userPrompt = `# Brand guide
${JSON.stringify(brandSpec, null, 2)}

# Document style summary (${fileType})
- Fonts used: ${styles.fontsUsed.join(', ') || 'none detected'}
- Colours used: ${styles.colorsUsed.join(', ') || 'none detected'}
- Images: ${styles.imageCount}
${styles.pageCount ? `- Pages/slides: ${styles.pageCount}` : ''}

## Text samples
${styles.textSamples.map((s, i) => `${i + 1}. "${s.text}" [font: ${s.font ?? '?'}, size: ${s.fontSize ?? '?'}, color: ${s.color ?? '?'}]`).join('\n')}

Produce the compliance audit JSON.`;

  const res = await llm.complete({
    tier: 'deep',
    system: AUDIT_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return parseAuditResult(res.text);
}

function parseAuditResult(text: string): AuditResult {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last === -1) {
    throw new AgentError('Audit LLM did not return JSON.', { code: 'tool_failure' });
  }
  let obj: Partial<AuditResult>;
  try {
    obj = JSON.parse(trimmed.slice(first, last + 1));
  } catch (err) {
    throw new AgentError(
      `Audit JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      { code: 'tool_failure' },
    );
  }

  const score = typeof obj.score === 'number' ? Math.min(100, Math.max(0, Math.round(obj.score))) : 50;
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const violations = Array.isArray(obj.violations)
    ? obj.violations
        .map((v) => {
          const o = v as Partial<Violation>;
          if (!o.rule || !o.location) return null;
          return {
            rule: o.rule,
            location: o.location,
            severity: (['error', 'warning', 'info'].includes(o.severity ?? '') ? o.severity : 'warning') as Violation['severity'],
            suggestion: o.suggestion ?? '',
          };
        })
        .filter((v): v is Violation => v !== null)
    : [];

  return { score, violations, summary };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function rgbToHex(rgb: RgbColor): string {
  const r = Math.round((rgb.red ?? 0) * 255);
  const g = Math.round((rgb.green ?? 0) * 255);
  const b = Math.round((rgb.blue ?? 0) * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function safeJson(s: string | null | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
