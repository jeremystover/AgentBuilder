/**
 * lab-api.ts — REST endpoints for The Lab SPA.
 *
 * Routes (all prefixed /api/lab):
 *
 *   GET    /api/lab/ideas
 *   POST   /api/lab/ideas
 *   PATCH  /api/lab/ideas/:id
 *   DELETE /api/lab/ideas/:id
 *   POST   /api/lab/ideas/:id/promote
 *   GET    /api/lab/articles?window=7d|30d|all&limit=50
 *   GET    /api/lab/projects             (proxies chief-of-staff list_projects)
 *
 *   POST   /api/lab/v1/ideas             (external bearer-auth surface)
 *
 * Chat is in lab-chat.ts because it has its own streaming concerns.
 *
 * Auth contract: index.ts gates everything under /api/lab/* with the
 * web-ui-kit's requireApiAuth (cookie session OR EXTERNAL_API_KEY bearer).
 * Handlers here trust the caller and just do the work.
 */

import type { Env } from "./types";

// ── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeParseArray(s: unknown): unknown[] {
  if (typeof s !== "string" || !s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// ── Idea row shape ─────────────────────────────────────────────────────────

interface IdeaRow {
  id: string;
  title: string;
  body: string;
  status: "spark" | "developing" | "ready" | "promoted";
  tags: string;
  linked_article_ids: string;
  chat_thread: string;
  promoted_to: string | null;
  created_at: string;
  updated_at: string;
}

interface IdeaDto {
  id: string;
  title: string;
  body: string;
  status: IdeaRow["status"];
  tags: string[];
  linked_article_ids: string[];
  chat_thread: unknown[];
  promoted_to: unknown | null;
  created_at: string;
  updated_at: string;
}

function ideaRowToDto(row: IdeaRow): IdeaDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    tags: safeParseArray(row.tags) as string[],
    linked_article_ids: safeParseArray(row.linked_article_ids) as string[],
    chat_thread: safeParseArray(row.chat_thread),
    promoted_to: row.promoted_to ? safeParse(row.promoted_to) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ── Chief-of-staff MCP helpers ─────────────────────────────────────────────
// We call CoS server-to-server with the bearer key in CHIEF_OF_STAFF_MCP_KEY.
// This shape matches the CoS /mcp JSON-RPC contract.

async function callCoSTool(
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const url = env.CHIEF_OF_STAFF_MCP_URL || "https://chief-of-staff.jsstover.workers.dev/mcp";
  const key = env.CHIEF_OF_STAFF_MCP_KEY || "";
  if (!key) throw new Error("CHIEF_OF_STAFF_MCP_KEY not configured");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`chief-of-staff ${name} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
  if (json.error) throw new Error(`chief-of-staff ${name}: ${json.error.message}`);
  const text = json.result?.content?.[0]?.text;
  if (typeof text !== "string") return json.result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Two-step: propose_X then commit_changeset against chief-of-staff.
async function cosProposeAndCommit(
  env: Env,
  proposeName: string,
  proposeArgs: Record<string, unknown>,
): Promise<unknown> {
  const proposed = (await callCoSTool(env, proposeName, proposeArgs)) as { changesetId?: string; error?: string };
  if (proposed?.error) throw new Error(String(proposed.error));
  if (!proposed?.changesetId) throw new Error(`${proposeName} did not return a changesetId`);
  return await callCoSTool(env, "commit_changeset", { changesetId: proposed.changesetId });
}

// ── Route handlers ─────────────────────────────────────────────────────────

export async function handleLabApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // ── Ideas CRUD ───────────────────────────────────────────────────────────
  if (path === "/api/lab/ideas" && method === "GET") {
    return handleListIdeas(env);
  }
  if (path === "/api/lab/ideas" && method === "POST") {
    return handleCreateIdea(request, env);
  }
  {
    const m = path.match(/^\/api\/lab\/ideas\/([^/]+)$/);
    if (m && method === "PATCH") return handleUpdateIdea(m[1] as string, request, env);
    if (m && method === "DELETE") return handleDeleteIdea(m[1] as string, env);
  }
  {
    const m = path.match(/^\/api\/lab\/ideas\/([^/]+)\/promote$/);
    if (m && method === "POST") return handlePromoteIdea(m[1] as string, request, env);
  }

  // ── Articles list (powers Research Feed + Digest scope) ──────────────────
  if (path === "/api/lab/articles" && method === "GET") {
    return handleListArticles(url, env);
  }

  // ── Projects proxy (powers PromoteModal's project picker) ────────────────
  if (path === "/api/lab/projects" && method === "GET") {
    return handleListProjects(env);
  }

  // ── External bearer-auth surface (for other apps to create ideas) ────────
  if (path === "/api/lab/v1/ideas" && method === "POST") {
    return handleCreateIdea(request, env, { external: true });
  }

  return null;
}

// ── Ideas handlers ─────────────────────────────────────────────────────────

async function handleListIdeas(env: Env): Promise<Response> {
  const result = await env.CONTENT_DB.prepare(
    `SELECT id, title, body, status, tags, linked_article_ids, chat_thread,
            promoted_to, created_at, updated_at
       FROM ideas
       ORDER BY datetime(updated_at) DESC`,
  ).all<IdeaRow>();
  const ideas = (result.results ?? []).map(ideaRowToDto);
  return jsonResponse({ ideas });
}

interface CreateIdeaBody {
  title?: string;
  body?: string;
  status?: IdeaRow["status"];
  tags?: string[];
  linked_article_ids?: string[];
  chat_thread?: unknown[];
}

async function handleCreateIdea(
  request: Request,
  env: Env,
  opts: { external?: boolean } = {},
): Promise<Response> {
  const body = await readJson<CreateIdeaBody>(request);
  const title = String(body.title || "").trim();
  if (!title) return jsonResponse({ error: "title is required" }, 400);

  const id = generateId("idea");
  const now = nowIso();
  const status = body.status && ["spark", "developing", "ready", "promoted"].includes(body.status)
    ? body.status
    : "spark";

  await env.CONTENT_DB.prepare(
    `INSERT INTO ideas (id, title, body, status, tags, linked_article_ids,
                        chat_thread, promoted_to, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).bind(
    id,
    title,
    String(body.body || ""),
    status,
    JSON.stringify(Array.isArray(body.tags) ? body.tags : []),
    JSON.stringify(Array.isArray(body.linked_article_ids) ? body.linked_article_ids : []),
    JSON.stringify(Array.isArray(body.chat_thread) ? body.chat_thread : []),
    now,
    now,
  ).run();

  const row = await env.CONTENT_DB.prepare(
    `SELECT id, title, body, status, tags, linked_article_ids, chat_thread,
            promoted_to, created_at, updated_at FROM ideas WHERE id = ?`,
  ).bind(id).first<IdeaRow>();
  if (!row) return jsonResponse({ error: "insert failed" }, 500);
  return jsonResponse({ idea: ideaRowToDto(row) }, opts.external ? 201 : 200);
}

interface PatchIdeaBody {
  title?: string;
  body?: string;
  status?: IdeaRow["status"];
  tags?: string[];
  linked_article_ids?: string[];
  chat_thread?: unknown[];
}

async function handleUpdateIdea(id: string, request: Request, env: Env): Promise<Response> {
  const body = await readJson<PatchIdeaBody>(request);
  const existing = await env.CONTENT_DB.prepare(`SELECT id FROM ideas WHERE id = ?`).bind(id).first();
  if (!existing) return jsonResponse({ error: "idea not found" }, 404);

  const sets: string[] = [];
  const args: unknown[] = [];
  if (typeof body.title === "string") { sets.push("title = ?"); args.push(body.title); }
  if (typeof body.body === "string") { sets.push("body = ?"); args.push(body.body); }
  if (typeof body.status === "string" && ["spark", "developing", "ready", "promoted"].includes(body.status)) {
    sets.push("status = ?"); args.push(body.status);
  }
  if (Array.isArray(body.tags)) { sets.push("tags = ?"); args.push(JSON.stringify(body.tags)); }
  if (Array.isArray(body.linked_article_ids)) {
    sets.push("linked_article_ids = ?"); args.push(JSON.stringify(body.linked_article_ids));
  }
  if (Array.isArray(body.chat_thread)) {
    sets.push("chat_thread = ?"); args.push(JSON.stringify(body.chat_thread));
  }
  if (sets.length === 0) return jsonResponse({ error: "nothing to update" }, 400);

  sets.push("updated_at = ?");
  args.push(nowIso());
  args.push(id);

  await env.CONTENT_DB.prepare(
    `UPDATE ideas SET ${sets.join(", ")} WHERE id = ?`,
  ).bind(...args).run();

  const row = await env.CONTENT_DB.prepare(
    `SELECT id, title, body, status, tags, linked_article_ids, chat_thread,
            promoted_to, created_at, updated_at FROM ideas WHERE id = ?`,
  ).bind(id).first<IdeaRow>();
  if (!row) return jsonResponse({ error: "post-update read failed" }, 500);
  return jsonResponse({ idea: ideaRowToDto(row) });
}

async function handleDeleteIdea(id: string, env: Env): Promise<Response> {
  await env.CONTENT_DB.prepare(`DELETE FROM ideas WHERE id = ?`).bind(id).run();
  return jsonResponse({ ok: true });
}

// ── Promote: mode "existing" attaches a task; mode "new" creates project + task ─

interface PromoteBody {
  mode?: "existing" | "new";
  project_id?: string;
  project_name?: string;
  goal?: string;
  priority?: "high" | "medium" | "low";
}

async function handlePromoteIdea(id: string, request: Request, env: Env): Promise<Response> {
  const body = await readJson<PromoteBody>(request);
  const idea = await env.CONTENT_DB.prepare(
    `SELECT id, title, body, status, tags, linked_article_ids, chat_thread,
            promoted_to, created_at, updated_at FROM ideas WHERE id = ?`,
  ).bind(id).first<IdeaRow>();
  if (!idea) return jsonResponse({ error: "idea not found" }, 404);

  const linkedIds = safeParseArray(idea.linked_article_ids) as string[];
  // Pull article titles to attach as task evidence (best-effort).
  let articleLines: string[] = [];
  if (linkedIds.length > 0) {
    const placeholders = linkedIds.map(() => "?").join(", ");
    const rows = await env.CONTENT_DB.prepare(
      `SELECT id, title, url FROM articles WHERE id IN (${placeholders})`,
    ).bind(...linkedIds).all<{ id: string; title: string | null; url: string }>();
    articleLines = (rows.results ?? []).map((r) => `- ${r.title || "(untitled)"} (${r.url})`);
  }

  const taskNotes = [
    idea.body || "",
    articleLines.length > 0 ? "\n\nLinked research:\n" + articleLines.join("\n") : "",
  ].join("");

  let promoted_to: { project_id: string; project_name: string; task_key?: string };

  try {
    if (body.mode === "new") {
      const name = String(body.project_name || idea.title).trim();
      if (!name) return jsonResponse({ error: "project_name is required" }, 400);
      const projectResult = (await cosProposeAndCommit(env, "propose_create_project", {
        name,
        description: body.goal || "",
        status: "active",
        priority: body.priority || "medium",
        healthStatus: "on_track",
        stakeholderIds: [],
      })) as { results?: Array<{ action?: string; details?: { projectId?: string } }> };
      const projectId = projectResult?.results?.find((r) => r.action === "create_project")?.details?.projectId
        || projectResult?.results?.[0]?.details?.projectId;
      if (!projectId) throw new Error("project create did not return a projectId");

      const taskResult = (await cosProposeAndCommit(env, "propose_create_task", {
        title: idea.title,
        notes: taskNotes,
        priority: body.priority || "medium",
        projectId,
        origin: "manual",
        sources: [{ sourceType: "lab_idea", sourceRef: id, excerpt: idea.title }],
      })) as { results?: Array<{ action?: string; details?: { taskKey?: string } }> };
      const taskKey = taskResult?.results?.find((r) => r.action === "create_task")?.details?.taskKey
        || taskResult?.results?.[0]?.details?.taskKey;
      promoted_to = { project_id: projectId, project_name: name, task_key: taskKey };
    } else {
      const projectId = String(body.project_id || "").trim();
      const projectName = String(body.project_name || "").trim();
      if (!projectId) return jsonResponse({ error: "project_id is required" }, 400);
      const taskResult = (await cosProposeAndCommit(env, "propose_create_task", {
        title: idea.title,
        notes: taskNotes,
        priority: body.priority || "medium",
        projectId,
        origin: "manual",
        sources: [{ sourceType: "lab_idea", sourceRef: id, excerpt: idea.title }],
      })) as { results?: Array<{ action?: string; details?: { taskKey?: string } }> };
      const taskKey = taskResult?.results?.find((r) => r.action === "create_task")?.details?.taskKey
        || taskResult?.results?.[0]?.details?.taskKey;
      promoted_to = { project_id: projectId, project_name: projectName, task_key: taskKey };
    }
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 502);
  }

  await env.CONTENT_DB.prepare(
    `UPDATE ideas SET status = 'promoted', promoted_to = ?, updated_at = ? WHERE id = ?`,
  ).bind(JSON.stringify(promoted_to), nowIso(), id).run();

  const row = await env.CONTENT_DB.prepare(
    `SELECT id, title, body, status, tags, linked_article_ids, chat_thread,
            promoted_to, created_at, updated_at FROM ideas WHERE id = ?`,
  ).bind(id).first<IdeaRow>();
  if (!row) return jsonResponse({ error: "post-promote read failed" }, 500);
  return jsonResponse({ idea: ideaRowToDto(row), promoted_to });
}

// ── Articles list ──────────────────────────────────────────────────────────

interface ArticleSlim {
  id: string;
  title: string | null;
  url: string;
  summary: string | null;
  source_id: string | null;
  topics: string[];
  ingested_at: string;
}

async function handleListArticles(url: URL, env: Env): Promise<Response> {
  const window = url.searchParams.get("window") || "7d";
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
  let cutoff: string | null = null;
  if (window === "7d") cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  else if (window === "30d") cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  // window === "all" ⇒ no cutoff

  const sql = cutoff
    ? `SELECT id, title, url, summary, source_id, topics, ingested_at
         FROM articles WHERE status = 'ready' AND datetime(ingested_at) >= datetime(?)
         ORDER BY datetime(ingested_at) DESC LIMIT ?`
    : `SELECT id, title, url, summary, source_id, topics, ingested_at
         FROM articles WHERE status = 'ready'
         ORDER BY datetime(ingested_at) DESC LIMIT ?`;
  const stmt = cutoff
    ? env.CONTENT_DB.prepare(sql).bind(cutoff, limit)
    : env.CONTENT_DB.prepare(sql).bind(limit);
  const result = await stmt.all<{
    id: string; title: string | null; url: string; summary: string | null;
    source_id: string | null; topics: string | null; ingested_at: string;
  }>();
  const articles: ArticleSlim[] = (result.results ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    summary: r.summary,
    source_id: r.source_id,
    topics: safeParseArray(r.topics) as string[],
    ingested_at: r.ingested_at,
  }));
  return jsonResponse({ articles, window, limit });
}

// ── Projects proxy ─────────────────────────────────────────────────────────

async function handleListProjects(env: Env): Promise<Response> {
  try {
    const data = (await callCoSTool(env, "list_projects", { includeClosed: false })) as {
      projects?: Array<{ projectId: string; name: string; status?: string; healthStatus?: string; goalId?: string }>;
      error?: string;
    };
    if (data?.error) return jsonResponse({ error: data.error }, 502);
    return jsonResponse({ projects: data.projects || [] });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}
