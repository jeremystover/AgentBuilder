/**
 * finalize_logo_package — ship a selected logo concept as a full brand package.
 *
 * Produces:
 *   - Master PNG (1024x1024, the selected concept itself)
 *   - Monochrome black-on-white variant
 *   - Reversed (white-on-dark) variant
 *   - Favicon-sized 256x256 variant
 *   - Brand style guide (palette, typography, voice, logo usage) — persisted
 *     to brand_guides and exported as a Markdown doc
 *
 * Variants are regenerated via OpenAI gpt-image-1 rather than pixel-resized,
 * because Workers have no native raster scaling. The master acts as the
 * reference through the prompt.
 *
 * Storage:
 *   - All artefacts saved to R2 under logo-packages/<projectId>/
 *   - If folderId provided, uploaded to Google Drive as well
 *
 * Side effects:
 *   - Marks the selected concept row selected=1 (clears others for project)
 *   - Creates a brand_guides row and links it to the project
 *   - Updates project status='completed', output_url=Drive folder or R2 prefix
 */

import { AgentError, createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../../worker-configuration';
import { GoogleClient } from '../lib/google-client.js';

const OPENAI_IMAGES_API = 'https://api.openai.com/v1/images/generations';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

export interface FinalizeLogoPackageArgs {
  conceptId: string;
  companyName: string;
  folderId?: string;
  userId?: string;
}

export interface FinalizeLogoPackageResult {
  ok: true;
  projectId: string;
  brandId: string;
  assets: PackagedAsset[];
  driveFolderUrl: string | null;
  brandGuide: BrandGuide;
}

export interface PackagedAsset {
  kind: 'master' | 'monochrome' | 'reversed' | 'favicon' | 'style-guide-md';
  r2Key: string;
  driveFileId?: string;
  contentType: string;
}

export interface BrandGuide {
  name: string;
  palette: Record<string, string>;
  typography: { heading: string; body: string; display?: string; scale: string };
  voice: { tone: string; adjectives: string[]; avoid: string[] };
  logoUsage: { clearspace: string; minSize: string; placements: string[]; reversedAllowed: boolean };
  spacing: { unit: string; grid: string };
}

interface ConceptRow {
  id: string;
  project_id: string;
  style: string;
  prompt: string;
  image_r2_key: string;
}

interface ProjectRow {
  id: string;
  user_id: string;
  metadata: string;
}

export async function finalizeLogoPackage(
  env: Env,
  args: FinalizeLogoPackageArgs,
): Promise<FinalizeLogoPackageResult> {
  const logger = createLogger({
    base: { agent: 'graphic-designer', tool: 'finalize_logo_package' },
  });
  const userId = args.userId ?? 'default';

  if (!env.OPENAI_API_KEY) {
    throw new AgentError('OPENAI_API_KEY not set.', { code: 'internal' });
  }

  // 1) Load the concept + project
  const concept = await env.DB.prepare(
    `SELECT id, project_id, style, prompt, image_r2_key FROM logo_concepts WHERE id = ?1`,
  )
    .bind(args.conceptId)
    .first<ConceptRow>();
  if (!concept) {
    throw new AgentError(`Concept "${args.conceptId}" not found.`, { code: 'not_found' });
  }

  const project = await env.DB.prepare(
    `SELECT id, user_id, metadata FROM projects WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(concept.project_id, userId)
    .first<ProjectRow>();
  if (!project) {
    throw new AgentError('Project not found for concept.', { code: 'not_found' });
  }

  const meta = safeJson<{ brief?: Record<string, unknown> }>(project.metadata) ?? {};
  const brief = (meta.brief ?? {}) as {
    moodWords?: string[];
    colorPreferences?: string[];
    audience?: string;
    industry?: string;
    avoid?: string[];
  };

  logger.info('finalize.start', { conceptId: concept.id, projectId: project.id });

  // 2) Mark the concept as selected (single-selection per project)
  await env.DB.prepare(
    `UPDATE logo_concepts SET selected = 0 WHERE project_id = ?1`,
  )
    .bind(project.id)
    .run();
  await env.DB.prepare(
    `UPDATE logo_concepts SET selected = 1 WHERE id = ?1`,
  )
    .bind(concept.id)
    .run();

  // 3) Regenerate variants in parallel
  const variantDefs: Array<{ kind: PackagedAsset['kind']; prompt: string }> = [
    {
      kind: 'monochrome',
      prompt: `${concept.prompt}\n\nRender as a solid black monochrome version on a pure white background. No gradients, no colours.`,
    },
    {
      kind: 'reversed',
      prompt: `${concept.prompt}\n\nRender as a solid white monochrome version on a pure black background. No gradients.`,
    },
    {
      kind: 'favicon',
      prompt: `${concept.prompt}\n\nSimplified icon-only form suitable for a 256x256 favicon. Minimal details, high legibility at small sizes, centered, strong silhouette.`,
    },
  ];

  const variantSettled = await Promise.allSettled(
    variantDefs.map((v) => generateVariant(env, v.kind, v.prompt, project.id)),
  );

  const assets: PackagedAsset[] = [
    { kind: 'master', r2Key: concept.image_r2_key, contentType: 'image/png' },
  ];
  for (let i = 0; i < variantSettled.length; i++) {
    const s = variantSettled[i];
    const def = variantDefs[i];
    if (!s || !def) continue;
    if (s.status === 'fulfilled') assets.push(s.value);
    else logger.warn('variant.failed', { kind: def.kind, reason: String(s.reason) });
  }

  // 4) Draft the brand style guide via LLM
  const llm = new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY, workersAi: env.AI });
  const brandGuide = await draftBrandGuide(llm, args.companyName, brief);

  // Persist the brand guide + save a Markdown export
  const brandId = await persistBrandGuide(env.DB, userId, brandGuide);
  const mdKey = `logo-packages/${project.id}/style-guide.md`;
  const md = renderStyleGuideMarkdown(brandGuide, args.companyName);
  await env.BUCKET.put(mdKey, md, {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
  });
  assets.push({ kind: 'style-guide-md', r2Key: mdKey, contentType: 'text/markdown' });

  // 5) Optional Drive upload
  let driveFolderUrl: string | null = null;
  if (args.folderId) {
    const google = new GoogleClient({ env, userId });
    driveFolderUrl = `https://drive.google.com/drive/folders/${args.folderId}`;
    for (const asset of assets) {
      try {
        const driveId = await uploadAssetToDrive(env, google, asset, args.folderId, args.companyName);
        if (driveId) asset.driveFileId = driveId;
      } catch (err) {
        logger.warn('drive.upload.failed', {
          kind: asset.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 6) Finalise the project
  await env.DB.prepare(
    `UPDATE projects
        SET brand_id = ?1,
            status = 'completed',
            output_url = ?2,
            updated_at = ?3
      WHERE id = ?4`,
  )
    .bind(brandId, driveFolderUrl ?? `r2://logo-packages/${project.id}/`, Date.now(), project.id)
    .run();

  logger.info('finalize.done', { projectId: project.id, brandId, assets: assets.length });

  return {
    ok: true,
    projectId: project.id,
    brandId,
    assets,
    driveFolderUrl,
    brandGuide,
  };
}

// ── Variant generation ─────────────────────────────────────────────────────

async function generateVariant(
  env: Env,
  kind: PackagedAsset['kind'],
  prompt: string,
  projectId: string,
): Promise<PackagedAsset> {
  const res = await fetch(OPENAI_IMAGES_API, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size: kind === 'favicon' ? '1024x1024' : '1024x1024',
      n: 1,
    }),
  });

  if (!res.ok) {
    throw new AgentError(`OpenAI variant gen failed (${res.status}): ${await res.text()}`, {
      code: 'upstream_failure',
    });
  }

  const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const first = json.data?.[0];
  if (!first) throw new AgentError('OpenAI returned empty.', { code: 'upstream_failure' });

  let bytes: Uint8Array;
  if (first.b64_json) {
    bytes = base64ToBytes(first.b64_json);
  } else if (first.url) {
    const imgRes = await fetch(first.url);
    bytes = new Uint8Array(await imgRes.arrayBuffer());
  } else {
    throw new AgentError('OpenAI missing image.', { code: 'upstream_failure' });
  }

  const r2Key = `logo-packages/${projectId}/${kind}.png`;
  await env.BUCKET.put(r2Key, bytes, {
    httpMetadata: { contentType: 'image/png' },
    customMetadata: { kind },
  });

  return { kind, r2Key, contentType: 'image/png' };
}

// ── Brand guide draft ──────────────────────────────────────────────────────

const BRAND_GUIDE_SYSTEM = `You are a brand designer drafting a practical style guide.
Given a company's design brief, produce a JSON object:
{
  "name": "<companyName>",
  "palette": {
    "primary": "#HEX",
    "secondary": "#HEX",
    "accent": "#HEX",
    "neutralDark": "#HEX",
    "neutralLight": "#HEX",
    "background": "#HEX"
  },
  "typography": {
    "heading": "<font family>",
    "body": "<font family>",
    "display": "<optional>",
    "scale": "<e.g. '1.25 modular scale, 16px base'>"
  },
  "voice": {
    "tone": "<one sentence>",
    "adjectives": ["3-5 words"],
    "avoid": ["3-5 things"]
  },
  "logoUsage": {
    "clearspace": "<e.g. 'minimum x-height of the mark on all sides'>",
    "minSize": "<e.g. '24px square for digital, 0.5in for print'>",
    "placements": ["2-4 recommended placements"],
    "reversedAllowed": true
  },
  "spacing": { "unit": "8px grid", "grid": "12-column, 72px gutters" }
}

Output strict JSON only — no prose, no markdown fences.`;

async function draftBrandGuide(
  llm: LLMClient,
  companyName: string,
  brief: {
    moodWords?: string[];
    colorPreferences?: string[];
    audience?: string;
    industry?: string;
    avoid?: string[];
  },
): Promise<BrandGuide> {
  const userPrompt = `Company name: ${companyName}
Industry: ${brief.industry ?? '(unspecified)'}
Audience: ${brief.audience ?? '(unspecified)'}
Mood words: ${brief.moodWords?.join(', ') ?? '(unspecified)'}
Color preferences: ${brief.colorPreferences?.join(', ') ?? '(no specific preferences)'}
Things to avoid: ${brief.avoid?.join(', ') ?? 'none'}

Produce the brand style guide JSON.`;

  const res = await llm.complete({
    tier: 'default',
    system: BRAND_GUIDE_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const obj = parseJsonObject(res.text);
  return normaliseGuide(obj, companyName);
}

function normaliseGuide(obj: Record<string, unknown>, companyName: string): BrandGuide {
  const palette = (obj.palette ?? {}) as Record<string, unknown>;
  const typography = (obj.typography ?? {}) as Record<string, unknown>;
  const voice = (obj.voice ?? {}) as Record<string, unknown>;
  const logoUsage = (obj.logoUsage ?? {}) as Record<string, unknown>;
  const spacing = (obj.spacing ?? {}) as Record<string, unknown>;

  return {
    name: typeof obj.name === 'string' ? obj.name : companyName,
    palette: Object.fromEntries(
      Object.entries(palette).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>,
    typography: {
      heading: typeof typography.heading === 'string' ? typography.heading : 'Inter',
      body: typeof typography.body === 'string' ? typography.body : 'Inter',
      display: typeof typography.display === 'string' ? typography.display : undefined,
      scale: typeof typography.scale === 'string' ? typography.scale : '1.25 modular scale, 16px base',
    },
    voice: {
      tone: typeof voice.tone === 'string' ? voice.tone : '',
      adjectives: Array.isArray(voice.adjectives)
        ? (voice.adjectives as unknown[]).filter((s): s is string => typeof s === 'string')
        : [],
      avoid: Array.isArray(voice.avoid)
        ? (voice.avoid as unknown[]).filter((s): s is string => typeof s === 'string')
        : [],
    },
    logoUsage: {
      clearspace: typeof logoUsage.clearspace === 'string' ? logoUsage.clearspace : '',
      minSize: typeof logoUsage.minSize === 'string' ? logoUsage.minSize : '',
      placements: Array.isArray(logoUsage.placements)
        ? (logoUsage.placements as unknown[]).filter((s): s is string => typeof s === 'string')
        : [],
      reversedAllowed: logoUsage.reversedAllowed !== false,
    },
    spacing: {
      unit: typeof spacing.unit === 'string' ? spacing.unit : '8px grid',
      grid: typeof spacing.grid === 'string' ? spacing.grid : '12-column',
    },
  };
}

async function persistBrandGuide(
  db: D1Database,
  userId: string,
  guide: BrandGuide,
): Promise<string> {
  const id = `brand_${crypto.randomUUID()}`;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO brand_guides
         (id, user_id, name, palette, typography, voice, logo_usage, spacing, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    )
    .bind(
      id,
      userId,
      guide.name,
      JSON.stringify(guide.palette),
      JSON.stringify(guide.typography),
      JSON.stringify(guide.voice),
      JSON.stringify(guide.logoUsage),
      JSON.stringify(guide.spacing),
      now,
    )
    .run();
  return id;
}

// ── Markdown export ────────────────────────────────────────────────────────

function renderStyleGuideMarkdown(g: BrandGuide, companyName: string): string {
  const lines: string[] = [];
  lines.push(`# ${companyName} — Brand Style Guide`);
  lines.push('');
  lines.push('## Palette');
  for (const [name, hex] of Object.entries(g.palette)) {
    lines.push(`- **${name}**: \`${hex}\``);
  }
  lines.push('');
  lines.push('## Typography');
  lines.push(`- **Heading**: ${g.typography.heading}`);
  lines.push(`- **Body**: ${g.typography.body}`);
  if (g.typography.display) lines.push(`- **Display**: ${g.typography.display}`);
  lines.push(`- **Scale**: ${g.typography.scale}`);
  lines.push('');
  lines.push('## Voice');
  lines.push(`- **Tone**: ${g.voice.tone}`);
  lines.push(`- **Adjectives**: ${g.voice.adjectives.join(', ')}`);
  if (g.voice.avoid.length > 0) lines.push(`- **Avoid**: ${g.voice.avoid.join(', ')}`);
  lines.push('');
  lines.push('## Logo Usage');
  lines.push(`- **Clearspace**: ${g.logoUsage.clearspace}`);
  lines.push(`- **Minimum size**: ${g.logoUsage.minSize}`);
  lines.push(`- **Placements**: ${g.logoUsage.placements.join(', ')}`);
  lines.push(`- **Reversed allowed**: ${g.logoUsage.reversedAllowed ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Spacing');
  lines.push(`- **Unit**: ${g.spacing.unit}`);
  lines.push(`- **Grid**: ${g.spacing.grid}`);
  return lines.join('\n');
}

// ── Drive multipart upload ─────────────────────────────────────────────────

async function uploadAssetToDrive(
  env: Env,
  google: GoogleClient,
  asset: PackagedAsset,
  folderId: string,
  companyName: string,
): Promise<string | null> {
  const obj = await env.BUCKET.get(asset.r2Key);
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());

  const filename = `${companyName} — ${asset.kind}${asset.kind === 'style-guide-md' ? '.md' : '.png'}`;

  const meta = {
    name: filename,
    parents: [folderId],
    mimeType: asset.contentType,
  };

  const boundary = `bd_${crypto.randomUUID().replace(/-/g, '')}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${asset.contentType}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);

  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);

  const res = await google.gfetch(
    `${DRIVE_UPLOAD_API}?uploadType=multipart&supportsAllDrives=true&fields=id`,
    {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body,
    },
  );

  if (!res.ok) {
    throw new AgentError(`Drive upload failed (${res.status}): ${await res.text()}`, {
      code: 'upstream_failure',
    });
  }

  const json = (await res.json()) as { id?: string };
  return json.id ?? null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last === -1) {
    throw new AgentError('Brand guide JSON missing.', { code: 'tool_failure' });
  }
  try {
    return JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>;
  } catch (err) {
    throw new AgentError(
      `Brand guide parse failed: ${err instanceof Error ? err.message : String(err)}`,
      { code: 'tool_failure' },
    );
  }
}

function safeJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
