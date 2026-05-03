/**
 * canva_export — push a finalised logo package to Canva Connect.
 *
 * Canva's Connect API (as of this writing) does NOT expose programmatic Brand
 * Kit creation — colors and fonts are only editable in the Canva UI. What we
 * CAN do:
 *
 *   1. Upload logo PNG assets as Canva Assets (via the async asset-uploads job).
 *   2. Create or reuse a folder named "<BrandName> — Brand Kit".
 *   3. Return a manifest with:
 *        - asset ids you can drag into designs
 *        - hex palette + font specs formatted for copy-paste into
 *          Canva's Brand Kit UI.
 *
 * Auth: uses OAuth tokens stored in canva_tokens (D1) with auto-refresh.
 * Complete OAuth at /api/auth/canva/start first.
 */

import { AgentError, createLogger } from '@agentbuilder/core';
import type { Env } from '../../worker-configuration';
import { getCanvaAccessToken } from '../lib/canva-oauth.js';

const CANVA_API = 'https://api.canva.com/rest/v1';
const MAX_POLL_MS = 30_000;
const POLL_INTERVAL_MS = 1500;

export interface CanvaExportArgs {
  brandId: string;
  includeLogos?: boolean;
  includeColors?: boolean;
  includeFonts?: boolean;
  userId?: string;
}

export interface CanvaExportResult {
  ok: true;
  folderId: string | null;
  uploadedAssets: CanvaAsset[];
  paletteManifest: Array<{ name: string; hex: string }>;
  fontManifest: { heading: string; body: string; display?: string };
  nextSteps: string;
}

export interface CanvaAsset {
  kind: 'master' | 'monochrome' | 'reversed' | 'favicon';
  canvaAssetId: string;
  r2Key: string;
}

interface BrandRow {
  id: string;
  user_id: string;
  name: string;
  palette: string;
  typography: string;
}

interface ProjectRow {
  id: string;
  output_url: string | null;
}

interface AssetUploadJob {
  job?: { id: string; status: string; asset?: { id: string } };
}

export async function canvaExport(
  env: Env,
  args: CanvaExportArgs,
): Promise<CanvaExportResult> {
  const logger = createLogger({ base: { agent: 'graphic-designer', tool: 'canva_export' } });
  const userId = args.userId ?? 'default';

  const canvaToken = await getCanvaAccessToken(env, userId);

  const brand = await env.DB.prepare(
    `SELECT id, user_id, name, palette, typography FROM brand_guides
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(args.brandId, userId)
    .first<BrandRow>();

  if (!brand) {
    throw new AgentError(`Brand "${args.brandId}" not found.`, { code: 'not_found' });
  }

  const includeLogos = args.includeLogos !== false;
  const includeColors = args.includeColors !== false;
  const includeFonts = args.includeFonts !== false;

  logger.info('export.start', { brandId: brand.id, includeLogos, includeColors, includeFonts });

  // 1) Create/reuse a folder
  let folderId: string | null = null;
  try {
    folderId = await ensureFolder(canvaToken, `${brand.name} — Brand Kit`);
  } catch (err) {
    logger.warn('folder.failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // 2) Upload logo assets if requested
  const uploadedAssets: CanvaAsset[] = [];
  if (includeLogos) {
    const project = await env.DB.prepare(
      `SELECT id, output_url FROM projects
        WHERE brand_id = ?1 AND user_id = ?2 AND kind = 'logo'
        ORDER BY updated_at DESC LIMIT 1`,
    )
      .bind(brand.id, userId)
      .first<ProjectRow>();

    if (!project) {
      logger.warn('no.project', { brandId: brand.id });
    } else {
      const kinds: CanvaAsset['kind'][] = ['master', 'monochrome', 'reversed', 'favicon'];
      for (const kind of kinds) {
        const r2Key =
          kind === 'master'
            ? await findMasterKey(env, project.id)
            : `logo-packages/${project.id}/${kind}.png`;
        if (!r2Key) continue;

        try {
          const assetId = await uploadAsset(env, canvaToken, r2Key, `${brand.name} — ${kind}.png`, folderId);
          uploadedAssets.push({ kind, canvaAssetId: assetId, r2Key });
        } catch (err) {
          logger.warn('asset.failed', {
            kind,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // 3) Palette + font manifests
  const paletteManifest = includeColors
    ? Object.entries(safeJson<Record<string, string>>(brand.palette) ?? {})
        .filter((kv): kv is [string, string] => typeof kv[1] === 'string')
        .map(([name, hex]) => ({ name, hex }))
    : [];

  const typ = safeJson<{ heading?: string; body?: string; display?: string }>(brand.typography);
  const fontManifest = includeFonts
    ? {
        heading: typ?.heading ?? 'Inter',
        body: typ?.body ?? 'Inter',
        display: typ?.display,
      }
    : { heading: '', body: '' };

  const nextSteps = buildNextSteps({
    colorCount: paletteManifest.length,
    fontsIncluded: includeFonts,
    assetsUploaded: uploadedAssets.length,
    folderId,
  });

  logger.info('export.done', {
    assets: uploadedAssets.length,
    colors: paletteManifest.length,
  });

  return {
    ok: true,
    folderId,
    uploadedAssets,
    paletteManifest,
    fontManifest,
    nextSteps,
  };
}

// ── Canva API helpers ─────────────────────────────────────────────────────

async function ensureFolder(token: string, name: string): Promise<string> {
  // Canva Connect doesn't support listing folders by name; always create a new
  // one. Duplicates are acceptable — Canva shows them side-by-side.
  const res = await fetch(`${CANVA_API}/folders`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name, parent_folder_id: 'root' }),
  });
  if (!res.ok) {
    throw new AgentError(`Canva folder create failed (${res.status}): ${await res.text()}`, {
      code: 'upstream_failure',
    });
  }
  const json = (await res.json()) as { folder?: { id: string } };
  if (!json.folder?.id) {
    throw new AgentError('Canva folder response missing id.', { code: 'upstream_failure' });
  }
  return json.folder.id;
}

async function uploadAsset(
  env: Env,
  token: string,
  r2Key: string,
  name: string,
  folderId: string | null,
): Promise<string> {
  const obj = await env.BUCKET.get(r2Key);
  if (!obj) throw new AgentError(`R2 object missing: ${r2Key}`, { code: 'not_found' });
  const bytes = new Uint8Array(await obj.arrayBuffer());

  // Kick off the async upload job. Canva accepts the file body with a
  // JSON metadata header.
  const metadata = {
    name_base64: btoa(name),
    ...(folderId ? { parent_folder_id: folderId } : {}),
  };

  const createRes = await fetch(`${CANVA_API}/asset-uploads`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'asset-upload-metadata': JSON.stringify(metadata),
    },
    body: bytes,
  });

  if (!createRes.ok) {
    throw new AgentError(
      `Canva asset-upload create failed (${createRes.status}): ${await createRes.text()}`,
      { code: 'upstream_failure' },
    );
  }

  const initial = (await createRes.json()) as AssetUploadJob;
  const jobId = initial.job?.id;
  if (!jobId) {
    throw new AgentError('Canva upload job missing id.', { code: 'upstream_failure' });
  }
  if (initial.job?.status === 'success' && initial.job.asset?.id) {
    return initial.job.asset.id;
  }

  // Poll for completion
  const start = Date.now();
  while (Date.now() - start < MAX_POLL_MS) {
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await fetch(`${CANVA_API}/asset-uploads/${jobId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!pollRes.ok) continue;
    const poll = (await pollRes.json()) as AssetUploadJob;
    if (poll.job?.status === 'success' && poll.job.asset?.id) {
      return poll.job.asset.id;
    }
    if (poll.job?.status === 'failed') {
      throw new AgentError('Canva upload job failed.', { code: 'upstream_failure' });
    }
  }

  throw new AgentError('Canva upload job timed out.', { code: 'upstream_failure' });
}

async function findMasterKey(env: Env, projectId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT image_r2_key FROM logo_concepts
       WHERE project_id = ?1 AND selected = 1
       LIMIT 1`,
  )
    .bind(projectId)
    .first<{ image_r2_key: string }>();
  return row?.image_r2_key ?? null;
}

// ── Manifest text ─────────────────────────────────────────────────────────

function buildNextSteps(input: {
  colorCount: number;
  fontsIncluded: boolean;
  assetsUploaded: number;
  folderId: string | null;
}): string {
  const lines: string[] = [];
  if (input.assetsUploaded > 0) {
    lines.push(
      `${input.assetsUploaded} logo asset(s) uploaded to Canva${input.folderId ? ' in the Brand Kit folder' : ''}. Drag them into any design.`,
    );
  }
  if (input.colorCount > 0) {
    lines.push(
      `${input.colorCount} colour(s) ready. In Canva: Brand Kit → Brand colours → Add colour, then paste each hex from paletteManifest.`,
    );
  }
  if (input.fontsIncluded) {
    lines.push(
      'Fonts listed in fontManifest. In Canva: Brand Kit → Brand fonts → Upload a font or pick from Canva library.',
    );
  }
  if (lines.length === 0) lines.push('Nothing to export with the flags provided.');
  return lines.join(' ');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
