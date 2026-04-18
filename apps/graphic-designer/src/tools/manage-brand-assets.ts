/**
 * manage_brand_assets — CRUD for brand guides, templates, logo packages, and projects.
 *
 * All reads are scoped by userId to prevent cross-user leaks.
 * Returns shape: { ok: true, data: ... } or { ok: false, error: string }.
 */

import { AgentError } from '@agentbuilder/core';
import type { Env } from '../../worker-configuration';

type AssetType = 'brand_guide' | 'template' | 'logo_package' | 'project';
type Action = 'list' | 'get' | 'create' | 'update' | 'delete';

export interface ManageBrandAssetsArgs {
  action: Action;
  assetType: AssetType;
  id?: string;
  data?: Record<string, unknown>;
  userId?: string;
}

export async function manageBrandAssets(
  env: Env,
  args: ManageBrandAssetsArgs,
): Promise<Record<string, unknown>> {
  const userId = args.userId ?? 'default';

  switch (args.assetType) {
    case 'brand_guide':
      return handleBrandGuide(env, userId, args);
    case 'template':
      return handleTemplate(env, userId, args);
    case 'logo_package':
      return handleLogoPackage(env, userId, args);
    case 'project':
      return handleProject(env, userId, args);
    default:
      throw new AgentError(`Unknown assetType: ${args.assetType}`, { code: 'invalid_input' });
  }
}

// ── brand_guides ────────────────────────────────────────────────────────────

async function handleBrandGuide(
  env: Env,
  userId: string,
  args: ManageBrandAssetsArgs,
): Promise<Record<string, unknown>> {
  switch (args.action) {
    case 'list': {
      const { results } = await env.DB.prepare(
        `SELECT id, name, created_at, updated_at
         FROM brand_guides
         WHERE user_id = ?1
         ORDER BY updated_at DESC`,
      )
        .bind(userId)
        .all();
      return { ok: true, data: results };
    }
    case 'get': {
      requireId(args);
      const row = await env.DB.prepare(
        `SELECT * FROM brand_guides WHERE id = ?1 AND user_id = ?2`,
      )
        .bind(args.id, userId)
        .first();
      if (!row) throw new AgentError('Brand guide not found', { code: 'not_found' });
      return { ok: true, data: hydrateBrandGuide(row) };
    }
    case 'create': {
      const data = requireData(args);
      const id = data.id as string | undefined ?? `brand_${crypto.randomUUID()}`;
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO brand_guides
          (id, user_id, name, palette, typography, voice, logo_usage, spacing, extras,
           created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
        .bind(
          id,
          userId,
          requireString(data, 'name'),
          JSON.stringify(data.palette ?? {}),
          JSON.stringify(data.typography ?? {}),
          data.voice ? JSON.stringify(data.voice) : null,
          data.logo_usage ? JSON.stringify(data.logo_usage) : null,
          data.spacing ? JSON.stringify(data.spacing) : null,
          data.extras ? JSON.stringify(data.extras) : null,
          now,
          now,
        )
        .run();
      return { ok: true, data: { id } };
    }
    case 'update': {
      requireId(args);
      const data = requireData(args);
      const fields: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const key of ['name', 'palette', 'typography', 'voice', 'logo_usage', 'spacing', 'extras']) {
        if (key in data) {
          fields.push(`${key} = ?${i++}`);
          values.push(key === 'name' ? data[key] : JSON.stringify(data[key]));
        }
      }
      if (fields.length === 0) throw new AgentError('No fields to update', { code: 'invalid_input' });
      fields.push(`updated_at = ?${i++}`);
      values.push(Date.now());
      values.push(args.id, userId);
      await env.DB.prepare(
        `UPDATE brand_guides SET ${fields.join(', ')} WHERE id = ?${i++} AND user_id = ?${i}`,
      )
        .bind(...values)
        .run();
      return { ok: true, data: { id: args.id } };
    }
    case 'delete': {
      requireId(args);
      await env.DB.prepare(`DELETE FROM brand_guides WHERE id = ?1 AND user_id = ?2`)
        .bind(args.id, userId)
        .run();
      return { ok: true, data: { deleted: args.id } };
    }
  }
}

// ── templates ───────────────────────────────────────────────────────────────

async function handleTemplate(
  env: Env,
  userId: string,
  args: ManageBrandAssetsArgs,
): Promise<Record<string, unknown>> {
  switch (args.action) {
    case 'list': {
      const { results } = await env.DB.prepare(
        `SELECT id, name, google_slides_id, is_default, analyzed_at, created_at
         FROM templates
         WHERE user_id = ?1
         ORDER BY is_default DESC, updated_at DESC`,
      )
        .bind(userId)
        .all();
      return { ok: true, data: results };
    }
    case 'get': {
      requireId(args);
      const row = await env.DB.prepare(
        `SELECT * FROM templates WHERE id = ?1 AND user_id = ?2`,
      )
        .bind(args.id, userId)
        .first();
      if (!row) throw new AgentError('Template not found', { code: 'not_found' });
      const layouts = await env.DB.prepare(
        `SELECT * FROM template_layouts WHERE template_id = ?1 ORDER BY name`,
      )
        .bind(args.id)
        .all();
      return { ok: true, data: { ...row, layouts: layouts.results } };
    }
    case 'create': {
      const data = requireData(args);
      const id = (data.id as string | undefined) ?? `tpl_${crypto.randomUUID()}`;
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO templates
          (id, user_id, brand_id, google_slides_id, name, description, is_default,
           created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
        .bind(
          id,
          userId,
          data.brand_id ?? null,
          requireString(data, 'google_slides_id'),
          requireString(data, 'name'),
          data.description ?? null,
          data.is_default ? 1 : 0,
          now,
          now,
        )
        .run();
      return { ok: true, data: { id } };
    }
    case 'update': {
      requireId(args);
      const data = requireData(args);
      const fields: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const key of ['name', 'description', 'brand_id', 'is_default']) {
        if (key in data) {
          fields.push(`${key} = ?${i++}`);
          values.push(data[key]);
        }
      }
      if (fields.length === 0) throw new AgentError('No fields to update', { code: 'invalid_input' });
      fields.push(`updated_at = ?${i++}`);
      values.push(Date.now());
      values.push(args.id, userId);
      await env.DB.prepare(
        `UPDATE templates SET ${fields.join(', ')} WHERE id = ?${i++} AND user_id = ?${i}`,
      )
        .bind(...values)
        .run();
      return { ok: true, data: { id: args.id } };
    }
    case 'delete': {
      requireId(args);
      await env.DB.prepare(`DELETE FROM templates WHERE id = ?1 AND user_id = ?2`)
        .bind(args.id, userId)
        .run();
      return { ok: true, data: { deleted: args.id } };
    }
  }
}

// ── logo_packages (projects where kind='logo' and status='completed') ───────

async function handleLogoPackage(
  env: Env,
  userId: string,
  args: ManageBrandAssetsArgs,
): Promise<Record<string, unknown>> {
  switch (args.action) {
    case 'list': {
      const { results } = await env.DB.prepare(
        `SELECT id, name, status, output_url, created_at, updated_at
         FROM projects
         WHERE user_id = ?1 AND kind = 'logo'
         ORDER BY updated_at DESC`,
      )
        .bind(userId)
        .all();
      return { ok: true, data: results };
    }
    case 'get': {
      requireId(args);
      const row = await env.DB.prepare(
        `SELECT * FROM projects WHERE id = ?1 AND user_id = ?2 AND kind = 'logo'`,
      )
        .bind(args.id, userId)
        .first();
      if (!row) throw new AgentError('Logo package not found', { code: 'not_found' });
      return { ok: true, data: row };
    }
    default:
      throw new AgentError(
        'Logo packages are created by finalize_logo_package; only list/get are supported here.',
        { code: 'invalid_input' },
      );
  }
}

// ── projects ────────────────────────────────────────────────────────────────

async function handleProject(
  env: Env,
  userId: string,
  args: ManageBrandAssetsArgs,
): Promise<Record<string, unknown>> {
  switch (args.action) {
    case 'list': {
      const { results } = await env.DB.prepare(
        `SELECT id, name, kind, status, output_url, created_at, updated_at
         FROM projects
         WHERE user_id = ?1
         ORDER BY updated_at DESC`,
      )
        .bind(userId)
        .all();
      return { ok: true, data: results };
    }
    case 'get': {
      requireId(args);
      const row = await env.DB.prepare(
        `SELECT * FROM projects WHERE id = ?1 AND user_id = ?2`,
      )
        .bind(args.id, userId)
        .first();
      if (!row) throw new AgentError('Project not found', { code: 'not_found' });
      return { ok: true, data: row };
    }
    case 'create': {
      const data = requireData(args);
      const id = (data.id as string | undefined) ?? `prj_${crypto.randomUUID()}`;
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO projects
          (id, user_id, brand_id, name, kind, status, metadata, output_url,
           created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
        .bind(
          id,
          userId,
          data.brand_id ?? null,
          requireString(data, 'name'),
          requireString(data, 'kind'),
          (data.status as string | undefined) ?? 'draft',
          data.metadata ? JSON.stringify(data.metadata) : null,
          data.output_url ?? null,
          now,
          now,
        )
        .run();
      return { ok: true, data: { id } };
    }
    case 'update': {
      requireId(args);
      const data = requireData(args);
      const fields: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const key of ['name', 'status', 'metadata', 'output_url', 'brand_id']) {
        if (key in data) {
          fields.push(`${key} = ?${i++}`);
          values.push(key === 'metadata' ? JSON.stringify(data[key]) : data[key]);
        }
      }
      if (fields.length === 0) throw new AgentError('No fields to update', { code: 'invalid_input' });
      fields.push(`updated_at = ?${i++}`);
      values.push(Date.now());
      values.push(args.id, userId);
      await env.DB.prepare(
        `UPDATE projects SET ${fields.join(', ')} WHERE id = ?${i++} AND user_id = ?${i}`,
      )
        .bind(...values)
        .run();
      return { ok: true, data: { id: args.id } };
    }
    case 'delete': {
      requireId(args);
      await env.DB.prepare(`DELETE FROM projects WHERE id = ?1 AND user_id = ?2`)
        .bind(args.id, userId)
        .run();
      return { ok: true, data: { deleted: args.id } };
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function requireId(args: ManageBrandAssetsArgs): void {
  if (!args.id) throw new AgentError(`${args.action} requires "id"`, { code: 'invalid_input' });
}

function requireData(args: ManageBrandAssetsArgs): Record<string, unknown> {
  if (!args.data) throw new AgentError(`${args.action} requires "data"`, { code: 'invalid_input' });
  return args.data;
}

function requireString(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new AgentError(`"${key}" is required`, { code: 'invalid_input' });
  }
  return v;
}

function hydrateBrandGuide(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    palette: parseJson(row.palette),
    typography: parseJson(row.typography),
    voice: parseJson(row.voice),
    logo_usage: parseJson(row.logo_usage),
    spacing: parseJson(row.spacing),
    extras: parseJson(row.extras),
  };
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
