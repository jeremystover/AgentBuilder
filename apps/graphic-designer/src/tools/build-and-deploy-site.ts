/**
 * build_and_deploy_site — render HTML from a plan and deploy to Cloudflare Pages.
 *
 * Pipeline:
 *   1. Load project row (kind='site', must be planning|completed).
 *   2. If `feedback` + `deploymentId` supplied: run a "refine" LLM pass that
 *      produces an updated pages array, then persist it back to the project.
 *   3. For each section with mediaNeed, run search_media and record the
 *      resolved URL in a per-section map.
 *   4. renderSite() -> file map.
 *   5. CF Pages Direct Upload:
 *        a. Ensure Pages project exists.
 *        b. Hash every file (SHA-256, base64).
 *        c. Get upload JWT (upload-token).
 *        d. check-missing -> returns subset we still need to upload.
 *        e. Upload missing files as base64 payloads.
 *        f. POST deployment with manifest (JSON: path -> hash).
 *   6. Poll deployment status until `success` or `failure`.
 *   7. Persist site_deployments row, update project status='completed'.
 */

import { AgentError, createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../../worker-configuration';
import { renderSite } from '../lib/site-renderer.js';
import { searchMedia } from './search-media.js';
import type { SitePage, VisualLanguage } from './plan-site.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
const PAGES_ASSETS_API = 'https://api.cloudflare.com/client/v4/pages/assets';
const MAX_DEPLOY_POLL_MS = 120_000;
const DEPLOY_POLL_INTERVAL_MS = 3_000;

export interface BuildAndDeploySiteArgs {
  planId: string;
  projectName: string;
  feedback?: string;
  deploymentId?: string;
  userId?: string;
}

export interface BuildAndDeploySiteResult {
  ok: true;
  deploymentId: string;
  liveUrl: string;
  projectName: string;
  pagesDeployed: number;
  filesUploaded: number;
  iteration: number;
}

interface ProjectRow {
  id: string;
  user_id: string;
  brand_id: string | null;
  metadata: string;
}

interface PlanMetadata {
  siteType: string;
  outline: string;
  audience: string | null;
  visualLanguage: VisualLanguage;
  pages: SitePage[];
}

interface CfApiResponse<T> {
  success: boolean;
  errors?: Array<{ message: string; code?: number }>;
  result?: T;
}

export async function buildAndDeploySite(
  env: Env,
  args: BuildAndDeploySiteArgs,
): Promise<BuildAndDeploySiteResult> {
  const logger = createLogger({
    base: { agent: 'graphic-designer', tool: 'build_and_deploy_site' },
  });
  const userId = args.userId ?? 'default';

  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    throw new AgentError(
      'CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set. Grant Pages:Edit.',
      { code: 'internal' },
    );
  }
  if (!/^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/.test(args.projectName)) {
    throw new AgentError(
      'projectName must be kebab-case (a-z, 0-9, -), 3-58 chars.',
      { code: 'invalid_input' },
    );
  }

  // 1) Load project
  const project = await env.DB.prepare(
    `SELECT id, user_id, brand_id, metadata FROM projects
      WHERE id = ?1 AND user_id = ?2 AND kind = 'site'`,
  )
    .bind(args.planId, userId)
    .first<ProjectRow>();

  if (!project) {
    throw new AgentError(`Site plan "${args.planId}" not found.`, { code: 'not_found' });
  }

  let plan = safeJson<PlanMetadata>(project.metadata);
  if (!plan) throw new AgentError('Plan metadata malformed.', { code: 'internal' });

  // 2) Optional refine pass
  if (args.feedback && args.feedback.trim()) {
    logger.info('refine.start', { feedbackLen: args.feedback.length });
    plan = await refinePlan(env, plan, args.feedback);
    await env.DB.prepare(
      `UPDATE projects SET metadata = ?1, updated_at = ?2 WHERE id = ?3`,
    )
      .bind(JSON.stringify(plan), Date.now(), project.id)
      .run();
  }

  // 3) Source media per section
  const mediaUrls = new Map<string, string>();
  for (const page of plan.pages) {
    for (const section of page.sections) {
      if (!section.mediaNeed) continue;
      try {
        const res = await searchMedia(env, {
          query: section.mediaNeed.query,
          type: section.mediaNeed.kind,
          count: 1,
          brandId: project.brand_id ?? undefined,
          userId,
        });
        const pick = res.results[0];
        if (!pick) continue;
        const url = pick.url.startsWith('r2://')
          ? publicR2Url(env, pick.r2Key ?? pick.id)
          : pick.url;
        if (url) mediaUrls.set(section.id, url);
      } catch (err) {
        logger.warn('media.failed', {
          section: section.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 4) Render
  const rendered = renderSite({
    title: plan.pages[0]?.title ?? args.projectName,
    pages: plan.pages,
    visualLanguage: plan.visualLanguage,
    mediaUrls,
  });

  // 5) CF Pages Direct Upload
  await ensurePagesProject(env, args.projectName);
  const fileHashes = await hashFiles(rendered.files);
  const token = await getUploadToken(env, args.projectName);
  const missing = await checkMissingHashes(token, [...new Set(fileHashes.values())]);

  logger.info('deploy.upload', {
    files: rendered.files.size,
    missing: missing.length,
  });

  if (missing.length > 0) {
    await uploadMissingFiles(token, rendered.files, fileHashes, missing);
  }

  const manifest: Record<string, string> = {};
  for (const [path, hash] of fileHashes) manifest[path] = hash;

  const { deploymentId, deploymentUrl } = await createDeployment(env, args.projectName, manifest);
  await waitForDeployment(env, args.projectName, deploymentId);

  // 6) Persist
  const iteration = await nextIteration(env, project.id);
  const siteDeploymentId = `dep_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO site_deployments
       (id, project_id, pages_project_name, deployment_id, live_url, status, iteration, feedback, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'deployed', ?6, ?7, ?8)`,
  )
    .bind(
      siteDeploymentId,
      project.id,
      args.projectName,
      deploymentId,
      deploymentUrl,
      iteration,
      args.feedback ?? null,
      Date.now(),
    )
    .run();

  await env.DB.prepare(
    `UPDATE projects SET status = 'completed', output_url = ?1, updated_at = ?2 WHERE id = ?3`,
  )
    .bind(deploymentUrl, Date.now(), project.id)
    .run();

  logger.info('deploy.done', { deploymentId, url: deploymentUrl, iteration });

  return {
    ok: true,
    deploymentId,
    liveUrl: deploymentUrl,
    projectName: args.projectName,
    pagesDeployed: plan.pages.length,
    filesUploaded: missing.length,
    iteration,
  };
}

// ── Plan refinement ────────────────────────────────────────────────────────

const REFINE_SYSTEM = `You refine an existing site plan based on user feedback.

You receive the current plan JSON and the feedback. Produce an updated plan
in the SAME schema. Keep pages/sections the user didn't mention intact;
apply the feedback surgically (reword copy, swap media, restructure sections,
add/remove sections). Do NOT change the visualLanguage unless asked.

Output strict JSON only — the full updated plan, same top-level shape:
{ "title": "...", "visualLanguage": {...}, "pages": [...] }`;

async function refinePlan(env: Env, plan: PlanMetadata, feedback: string): Promise<PlanMetadata> {
  const llm = new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY, workersAi: env.AI });
  const res = await llm.complete({
    tier: 'deep',
    system: REFINE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Current plan:\n\n${JSON.stringify(plan, null, 2)}\n\nFeedback:\n${feedback}\n\nReturn the updated plan JSON.`,
      },
    ],
  });

  const trimmed = res.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last === -1) {
    throw new AgentError('Refine pass did not return JSON.', { code: 'tool_failure' });
  }
  let obj: Partial<PlanMetadata>;
  try {
    obj = JSON.parse(trimmed.slice(first, last + 1));
  } catch (err) {
    throw new AgentError(
      `Refined plan JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      { code: 'tool_failure' },
    );
  }

  if (!Array.isArray(obj.pages) || obj.pages.length === 0) {
    throw new AgentError('Refined plan has no pages.', { code: 'tool_failure' });
  }

  return {
    siteType: plan.siteType,
    outline: plan.outline,
    audience: plan.audience,
    visualLanguage: obj.visualLanguage ?? plan.visualLanguage,
    pages: obj.pages as SitePage[],
  };
}

// ── Cloudflare Pages: project, hashing, upload, deploy ─────────────────────

async function ensurePagesProject(env: Env, projectName: string): Promise<void> {
  // 409 (already exists) is fine. Any other non-2xx is an error.
  const res = await fetch(
    `${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: projectName,
        production_branch: 'main',
      }),
    },
  );
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as CfApiResponse<unknown>;
  const alreadyExists = body.errors?.some(
    (e) => e.code === 8000007 || /already exists/i.test(e.message ?? ''),
  );
  if (alreadyExists) return;
  throw new AgentError(
    `Create Pages project failed (${res.status}): ${JSON.stringify(body.errors ?? body)}`,
    { code: 'upstream_failure' },
  );
}

async function hashFiles(
  files: Map<string, { content: string | Uint8Array; contentType: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [path, file] of files) {
    const bytes = typeof file.content === 'string'
      ? new TextEncoder().encode(file.content)
      : file.content;
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    out.set(path, hex(digest));
  }
  return out;
}

function hex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const h = (bytes[i] ?? 0).toString(16).padStart(2, '0');
    s += h;
  }
  return s;
}

async function getUploadToken(env: Env, projectName: string): Promise<string> {
  const res = await fetch(
    `${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${projectName}/upload-token`,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    },
  );
  if (!res.ok) {
    throw new AgentError(
      `Upload token failed (${res.status}): ${await res.text()}`,
      { code: 'upstream_failure' },
    );
  }
  const body = (await res.json()) as CfApiResponse<{ jwt: string }>;
  if (!body.success || !body.result?.jwt) {
    throw new AgentError(`Upload token response malformed: ${JSON.stringify(body.errors)}`, {
      code: 'upstream_failure',
    });
  }
  return body.result.jwt;
}

async function checkMissingHashes(token: string, hashes: string[]): Promise<string[]> {
  const res = await fetch(`${PAGES_ASSETS_API}/check-missing`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hashes }),
  });
  if (!res.ok) {
    throw new AgentError(
      `check-missing failed (${res.status}): ${await res.text()}`,
      { code: 'upstream_failure' },
    );
  }
  const body = (await res.json()) as CfApiResponse<string[]>;
  return body.result ?? [];
}

async function uploadMissingFiles(
  token: string,
  files: Map<string, { content: string | Uint8Array; contentType: string }>,
  fileHashes: Map<string, string>,
  missingHashes: string[],
): Promise<void> {
  const missing = new Set(missingHashes);
  // Build hash -> { bytes, contentType } (dedup by hash).
  const byHash = new Map<string, { bytes: Uint8Array; contentType: string }>();
  for (const [path, file] of files) {
    const hash = fileHashes.get(path);
    if (!hash || !missing.has(hash)) continue;
    if (byHash.has(hash)) continue;
    const bytes = typeof file.content === 'string'
      ? new TextEncoder().encode(file.content)
      : file.content;
    byHash.set(hash, { bytes, contentType: file.contentType });
  }

  const payload = [...byHash.entries()].map(([hash, { bytes, contentType }]) => ({
    base64: true,
    key: hash,
    value: bytesToBase64(bytes),
    metadata: { contentType },
  }));

  // Upload in a single batch (keeps things simple; CF accepts up to ~5MB body).
  const res = await fetch(`${PAGES_ASSETS_API}/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new AgentError(
      `asset upload failed (${res.status}): ${await res.text()}`,
      { code: 'upstream_failure' },
    );
  }
}

async function createDeployment(
  env: Env,
  projectName: string,
  manifest: Record<string, string>,
): Promise<{ deploymentId: string; deploymentUrl: string }> {
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));

  const res = await fetch(
    `${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${projectName}/deployments`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      body: form,
    },
  );
  if (!res.ok) {
    throw new AgentError(
      `create deployment failed (${res.status}): ${await res.text()}`,
      { code: 'upstream_failure' },
    );
  }
  const body = (await res.json()) as CfApiResponse<{ id: string; url: string }>;
  if (!body.success || !body.result) {
    throw new AgentError(
      `deployment response malformed: ${JSON.stringify(body.errors)}`,
      { code: 'upstream_failure' },
    );
  }
  return { deploymentId: body.result.id, deploymentUrl: body.result.url };
}

async function waitForDeployment(env: Env, projectName: string, deploymentId: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < MAX_DEPLOY_POLL_MS) {
    const res = await fetch(
      `${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${projectName}/deployments/${deploymentId}`,
      { headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } },
    );
    if (res.ok) {
      const body = (await res.json()) as CfApiResponse<{
        latest_stage?: { status: string; name: string };
      }>;
      const stage = body.result?.latest_stage;
      if (stage?.status === 'success' && stage.name === 'deploy') return;
      if (stage?.status === 'failure') {
        throw new AgentError(`Deployment failed at stage ${stage.name}.`, {
          code: 'upstream_failure',
        });
      }
    }
    await sleep(DEPLOY_POLL_INTERVAL_MS);
  }
  // Soft-timeout: deployment may finish later. We'll return success anyway;
  // the URL becomes live when Cloudflare completes the deploy stage.
}

async function nextIteration(env: Env, projectId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(MAX(iteration), 0) AS m FROM site_deployments WHERE project_id = ?1`,
  )
    .bind(projectId)
    .first<{ m: number }>();
  return (row?.m ?? 0) + 1;
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

function publicR2Url(env: Env, key: string): string | null {
  const domain = env.R2_PUBLIC_BASE_URL;
  if (domain) return `${domain.replace(/\/$/, '')}/${key}`;
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
  return btoa(s);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
