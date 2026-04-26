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
  position: string | null;
  created_at: string;
  updated_at: string;
}

interface IdeaPosition { x: number; y: number }

interface IdeaDto {
  id: string;
  title: string;
  body: string;
  status: IdeaRow["status"];
  tags: string[];
  linked_article_ids: string[];
  chat_thread: unknown[];
  promoted_to: unknown | null;
  position: IdeaPosition | null;
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
    position: row.position ? (safeParse(row.position) as IdeaPosition | null) : null,
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

  // ── Ingestion (URL or PDF upload from the Research Feed UI) ──────────────
  if (path === "/api/lab/ingest" && method === "POST") {
    return handleIngest(request, env);
  }

  // ── Chat sessions (claude.ai-style sidebar) ──────────────────────────────
  if (path === "/api/lab/sessions" && method === "GET") {
    return handleListSessions(url, env);
  }
  if (path === "/api/lab/sessions" && method === "POST") {
    return handleCreateSession(request, env);
  }
  {
    const m = path.match(/^\/api\/lab\/sessions\/([^/]+)$/);
    if (m && method === "GET") return handleGetSession(m[1] as string, env);
    if (m && method === "PATCH") return handleUpdateSession(m[1] as string, request, env);
    if (m && method === "DELETE") return handleDeleteSession(m[1] as string, env);
  }
  {
    const m = path.match(/^\/api\/lab\/sessions\/([^/]+)\/archive$/);
    if (m && method === "POST") return handleArchiveSession(m[1] as string, env);
  }

  // ── Notes (polymorphic — standalone, idea-attached, or article-attached) ─
  if (path === "/api/lab/notes" && method === "GET") {
    return handleListNotes(url, env);
  }
  if (path === "/api/lab/notes" && method === "POST") {
    return handleCreateNote(request, env);
  }
  {
    const m = path.match(/^\/api\/lab\/notes\/([^/]+)$/);
    if (m && method === "PATCH") return handleUpdateNote(m[1] as string, request, env);
    if (m && method === "DELETE") return handleDeleteNote(m[1] as string, env);
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
            promoted_to, position, created_at, updated_at
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
            promoted_to, position, created_at, updated_at FROM ideas WHERE id = ?`,
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
  /** Mind-map node coordinates. Pass `null` to clear (revert to auto layout). */
  position?: IdeaPosition | null;
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
  if ("position" in body) {
    if (body.position === null) {
      sets.push("position = NULL");
    } else if (body.position && typeof body.position.x === "number" && typeof body.position.y === "number") {
      sets.push("position = ?");
      args.push(JSON.stringify({ x: body.position.x, y: body.position.y }));
    }
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
            promoted_to, position, created_at, updated_at FROM ideas WHERE id = ?`,
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
            promoted_to, position, created_at, updated_at FROM ideas WHERE id = ?`,
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
            promoted_to, position, created_at, updated_at FROM ideas WHERE id = ?`,
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

// ── Chat sessions ──────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  title: string;
  tags: string;
  notes: string;
  scope: "selected" | "digest" | "full_corpus";
  pinned_article_ids: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
}

interface SessionDto {
  id: string;
  title: string;
  tags: string[];
  notes: string;
  scope: SessionRow["scope"];
  pinned_article_ids: string[];
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
}

function sessionRowToDto(row: SessionRow): SessionDto {
  return {
    id: row.id,
    title: row.title,
    tags: safeParseArray(row.tags) as string[],
    notes: row.notes,
    scope: row.scope,
    pinned_article_ids: safeParseArray(row.pinned_article_ids) as string[],
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_message_at: row.last_message_at,
  };
}

interface MessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

async function handleListSessions(url: URL, env: Env): Promise<Response> {
  const includeArchived = url.searchParams.get("include_archived") === "true";
  const where = includeArchived ? "" : "WHERE archived_at IS NULL";
  const rows = await env.CONTENT_DB.prepare(
    `SELECT id, title, tags, notes, scope, pinned_article_ids,
            archived_at, created_at, updated_at, last_message_at
       FROM chat_sessions ${where}
       ORDER BY datetime(COALESCE(last_message_at, updated_at)) DESC
       LIMIT 200`,
  ).all<SessionRow>();
  return jsonResponse({ sessions: (rows.results ?? []).map(sessionRowToDto) });
}

interface CreateSessionBody {
  title?: string;
  scope?: SessionRow["scope"];
  pinned_article_ids?: string[];
}

async function handleCreateSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson<CreateSessionBody>(request);
  const id = generateId("sess");
  const now = nowIso();
  const scope = body.scope && ["selected", "digest", "full_corpus"].includes(body.scope) ? body.scope : "full_corpus";
  await env.CONTENT_DB.prepare(
    `INSERT INTO chat_sessions
       (id, title, tags, notes, scope, pinned_article_ids,
        created_at, updated_at, last_message_at)
       VALUES (?, ?, '[]', '', ?, ?, ?, ?, NULL)`,
  ).bind(
    id,
    String(body.title || "New session"),
    scope,
    JSON.stringify(Array.isArray(body.pinned_article_ids) ? body.pinned_article_ids : []),
    now,
    now,
  ).run();
  const row = await env.CONTENT_DB.prepare(
    `SELECT id, title, tags, notes, scope, pinned_article_ids,
            archived_at, created_at, updated_at, last_message_at
       FROM chat_sessions WHERE id = ?`,
  ).bind(id).first<SessionRow>();
  if (!row) return jsonResponse({ error: "insert failed" }, 500);
  return jsonResponse({ session: sessionRowToDto(row) }, 201);
}

async function handleGetSession(id: string, env: Env): Promise<Response> {
  const row = await env.CONTENT_DB.prepare(
    `SELECT id, title, tags, notes, scope, pinned_article_ids,
            archived_at, created_at, updated_at, last_message_at
       FROM chat_sessions WHERE id = ?`,
  ).bind(id).first<SessionRow>();
  if (!row) return jsonResponse({ error: "session not found" }, 404);
  const msgs = await env.CONTENT_DB.prepare(
    `SELECT id, session_id, role, content, created_at
       FROM chat_messages WHERE session_id = ? ORDER BY datetime(created_at) ASC`,
  ).bind(id).all<MessageRow>();
  // Parse stored JSON content back into the wire shape the client expects.
  const messages = (msgs.results ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    content: safeParse(m.content),
    created_at: m.created_at,
  }));
  return jsonResponse({ session: sessionRowToDto(row), messages });
}

interface PatchSessionBody {
  title?: string;
  tags?: string[];
  notes?: string;
  scope?: SessionRow["scope"];
  pinned_article_ids?: string[];
}

async function handleUpdateSession(id: string, request: Request, env: Env): Promise<Response> {
  const body = await readJson<PatchSessionBody>(request);
  const existing = await env.CONTENT_DB.prepare(`SELECT id FROM chat_sessions WHERE id = ?`).bind(id).first();
  if (!existing) return jsonResponse({ error: "session not found" }, 404);
  const sets: string[] = [];
  const args: unknown[] = [];
  if (typeof body.title === "string") { sets.push("title = ?"); args.push(body.title.slice(0, 200)); }
  if (typeof body.notes === "string") { sets.push("notes = ?"); args.push(body.notes); }
  if (Array.isArray(body.tags)) { sets.push("tags = ?"); args.push(JSON.stringify(body.tags)); }
  if (typeof body.scope === "string" && ["selected", "digest", "full_corpus"].includes(body.scope)) {
    sets.push("scope = ?"); args.push(body.scope);
  }
  if (Array.isArray(body.pinned_article_ids)) {
    sets.push("pinned_article_ids = ?");
    args.push(JSON.stringify(body.pinned_article_ids));
  }
  if (sets.length === 0) return jsonResponse({ error: "nothing to update" }, 400);
  sets.push("updated_at = ?");
  args.push(nowIso());
  args.push(id);
  await env.CONTENT_DB.prepare(
    `UPDATE chat_sessions SET ${sets.join(", ")} WHERE id = ?`,
  ).bind(...args).run();
  const row = await env.CONTENT_DB.prepare(
    `SELECT id, title, tags, notes, scope, pinned_article_ids,
            archived_at, created_at, updated_at, last_message_at
       FROM chat_sessions WHERE id = ?`,
  ).bind(id).first<SessionRow>();
  if (!row) return jsonResponse({ error: "post-update read failed" }, 500);
  return jsonResponse({ session: sessionRowToDto(row) });
}

async function handleArchiveSession(id: string, env: Env): Promise<Response> {
  await env.CONTENT_DB.prepare(
    `UPDATE chat_sessions SET archived_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(nowIso(), nowIso(), id).run();
  return jsonResponse({ ok: true });
}

async function handleDeleteSession(id: string, env: Env): Promise<Response> {
  // Hard delete (CASCADE removes messages too).
  await env.CONTENT_DB.prepare(`DELETE FROM chat_sessions WHERE id = ?`).bind(id).run();
  return jsonResponse({ ok: true });
}

// ── Helpers reused by lab-chat.ts (persistence + auto-title) ──────────────

export async function persistChatTurn(env: Env, sessionId: string, role: "user" | "assistant", content: unknown): Promise<void> {
  await env.CONTENT_DB.prepare(
    `INSERT INTO chat_messages (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
  ).bind(generateId("msg"), sessionId, role, JSON.stringify(content), nowIso()).run();
  await env.CONTENT_DB.prepare(
    `UPDATE chat_sessions SET last_message_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(nowIso(), nowIso(), sessionId).run();
}

export async function ensureSession(env: Env, sessionId: string | null | undefined): Promise<{ id: string; created: boolean }> {
  if (sessionId) {
    const row = await env.CONTENT_DB.prepare(`SELECT id FROM chat_sessions WHERE id = ?`).bind(sessionId).first();
    if (row) return { id: sessionId, created: false };
  }
  const id = generateId("sess");
  const now = nowIso();
  await env.CONTENT_DB.prepare(
    `INSERT INTO chat_sessions (id, title, tags, notes, scope, pinned_article_ids,
                                 created_at, updated_at, last_message_at)
       VALUES (?, 'New session', '[]', '', 'full_corpus', '[]', ?, ?, NULL)`,
  ).bind(id, now, now).run();
  return { id, created: true };
}

export async function setSessionTitle(env: Env, sessionId: string, title: string): Promise<void> {
  await env.CONTENT_DB.prepare(
    `UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?`,
  ).bind(title.slice(0, 200), nowIso(), sessionId).run();
}

export async function getSessionMessageCount(env: Env, sessionId: string): Promise<number> {
  const row = await env.CONTENT_DB.prepare(
    `SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?`,
  ).bind(sessionId).first<{ n: number }>();
  return row ? Number(row.n) : 0;
}

// ── Ingestion (URL or PDF upload) ──────────────────────────────────────────
//
// Accepts EITHER:
//   - JSON: { url: "https://..." }                       → wraps ingest_url
//   - multipart/form-data with `file` field              → wraps upload_file
//
// Both write into the existing research-agent storage so the Research
// Feed sees the new content on the next poll/refresh.

async function handleIngest(request: Request, env: Env): Promise<Response> {
  const ct = request.headers.get("content-type") || "";

  // URL path — JSON body { url }.
  if (ct.includes("application/json")) {
    const body = await readJson<{ url?: string; note?: string }>(request);
    const url = String(body.url || "").trim();
    if (!url) return jsonResponse({ error: "url is required" }, 400);
    try {
      // Local in-process call — same shape as POST /ingest, just routed
      // through the SPA's bearer/cookie-gated namespace.
      const { ingestUrl, IngestUrlInput } = await import("./mcp/tools/ingest_url");
      const parsed = IngestUrlInput.safeParse({ url, note: body.note });
      if (!parsed.success) {
        return jsonResponse({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
      }
      // ingestUrl uses ctx.waitUntil internally to do the heavy lifting
      // off the request path — it returns immediately with a queued
      // status. Pass a stub ExecutionContext shim if needed.
      // The handler accepts a real ExecutionContext; in this REST path
      // we rely on the worker passing it through. Cast to satisfy the
      // signature — the real ctx flows in via the outer fetch() handler.
      const ctxShim = { waitUntil: (p: Promise<unknown>) => { void p; } } as ExecutionContext;
      const result = await ingestUrl(parsed.data, env, ctxShim);
      return jsonResponse(result, 200);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // Multipart upload path — extract `file` field.
  if (ct.includes("multipart/form-data")) {
    let form: FormData;
    try { form = await request.formData(); }
    catch { return jsonResponse({ error: "invalid multipart body" }, 400); }
    const file = form.get("file");
    // Cloudflare Workers types declare FormData.get() as returning string|FormDataEntryValue.
    // Duck-type to a File-shaped object instead of `instanceof File` (which TS resolves to `never` here).
    const isFile = !!file && typeof (file as { arrayBuffer?: unknown }).arrayBuffer === "function" && typeof (file as { name?: unknown }).name === "string";
    if (!isFile) return jsonResponse({ error: "file field is required" }, 400);
    const fileBlob = file as unknown as { arrayBuffer(): Promise<ArrayBuffer>; name: string; type: string };
    const note = (form.get("note") as string | null) ?? undefined;
    try {
      const buf = new Uint8Array(await fileBlob.arrayBuffer());
      // Convert to base64 (chunked to avoid call-stack issues on large files).
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
      }
      const content_base64 = btoa(binary);
      const { uploadFile, UploadFileInput } = await import("./mcp/tools/upload_file");
      const parsed = UploadFileInput.safeParse({
        content_base64,
        filename: fileBlob.name || "upload",
        mime_type: fileBlob.type || undefined,
        note,
      });
      if (!parsed.success) {
        return jsonResponse({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
      }
      const result = await uploadFile(parsed.data, env);
      return jsonResponse(result, 200);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  return jsonResponse({ error: "expected application/json (with url) or multipart/form-data (with file)" }, 415);
}

// ── Notes ──────────────────────────────────────────────────────────────────

interface NoteRow {
  id: string;
  title: string;
  body: string;
  tags: string;
  target_kind: "idea" | "article" | null;
  target_id: string | null;
  source_session_id: string | null;
  linked_article_ids: string;
  created_at: string;
  updated_at: string;
}

interface NoteDto {
  id: string;
  title: string;
  body: string;
  tags: string[];
  target_kind: "idea" | "article" | null;
  target_id: string | null;
  source_session_id: string | null;
  linked_article_ids: string[];
  created_at: string;
  updated_at: string;
}

function noteRowToDto(r: NoteRow): NoteDto {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    tags: safeParseArray(r.tags) as string[],
    target_kind: r.target_kind,
    target_id: r.target_id,
    source_session_id: r.source_session_id,
    linked_article_ids: safeParseArray(r.linked_article_ids) as string[],
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const NOTE_COLUMNS = `id, title, body, tags, target_kind, target_id,
                      source_session_id, linked_article_ids,
                      created_at, updated_at`;

async function handleListNotes(url: URL, env: Env): Promise<Response> {
  const targetKind = url.searchParams.get("target_kind");
  const targetId = url.searchParams.get("target_id");
  const sessionId = url.searchParams.get("session_id");

  let sql = `SELECT ${NOTE_COLUMNS} FROM notes`;
  const args: unknown[] = [];
  const where: string[] = [];
  if (targetKind && targetId) {
    where.push("target_kind = ? AND target_id = ?");
    args.push(targetKind, targetId);
  } else if (targetKind === "null" || targetKind === "") {
    where.push("target_kind IS NULL");
  }
  if (sessionId) {
    where.push("source_session_id = ?");
    args.push(sessionId);
  }
  if (where.length > 0) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY datetime(updated_at) DESC LIMIT 500";

  const result = await env.CONTENT_DB.prepare(sql).bind(...args).all<NoteRow>();
  return jsonResponse({ notes: (result.results ?? []).map(noteRowToDto) });
}

interface CreateNoteBody {
  title?: string;
  body?: string;
  tags?: string[];
  target_kind?: "idea" | "article";
  target_id?: string;
  source_session_id?: string;
  linked_article_ids?: string[];
}

async function handleCreateNote(request: Request, env: Env): Promise<Response> {
  const body = await readJson<CreateNoteBody>(request);
  // Validate the polymorphic target: both fields must be present together.
  if ((body.target_kind && !body.target_id) || (!body.target_kind && body.target_id)) {
    return jsonResponse({ error: "target_kind and target_id must be set together" }, 400);
  }
  const id = generateId("note");
  const now = nowIso();
  await env.CONTENT_DB.prepare(
    `INSERT INTO notes
       (id, title, body, tags, target_kind, target_id, source_session_id,
        linked_article_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    String(body.title || ""),
    String(body.body || ""),
    JSON.stringify(Array.isArray(body.tags) ? body.tags : []),
    body.target_kind ?? null,
    body.target_id ?? null,
    body.source_session_id ?? null,
    JSON.stringify(Array.isArray(body.linked_article_ids) ? body.linked_article_ids : []),
    now,
    now,
  ).run();
  const row = await env.CONTENT_DB.prepare(
    `SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`,
  ).bind(id).first<NoteRow>();
  if (!row) return jsonResponse({ error: "insert failed" }, 500);
  return jsonResponse({ note: noteRowToDto(row) }, 201);
}

interface PatchNoteBody {
  title?: string;
  body?: string;
  tags?: string[];
  linked_article_ids?: string[];
  /** Pass `target` as `null` to detach. To re-attach, send {target_kind, target_id}. */
  target_kind?: "idea" | "article" | null;
  target_id?: string | null;
}

async function handleUpdateNote(id: string, request: Request, env: Env): Promise<Response> {
  const body = await readJson<PatchNoteBody>(request);
  const existing = await env.CONTENT_DB.prepare(`SELECT id FROM notes WHERE id = ?`).bind(id).first();
  if (!existing) return jsonResponse({ error: "note not found" }, 404);
  const sets: string[] = [];
  const args: unknown[] = [];
  if (typeof body.title === "string") { sets.push("title = ?"); args.push(body.title.slice(0, 200)); }
  if (typeof body.body === "string") { sets.push("body = ?"); args.push(body.body); }
  if (Array.isArray(body.tags)) { sets.push("tags = ?"); args.push(JSON.stringify(body.tags)); }
  if (Array.isArray(body.linked_article_ids)) {
    sets.push("linked_article_ids = ?"); args.push(JSON.stringify(body.linked_article_ids));
  }
  // Detach via either explicit nulls or just sending target_kind: null.
  if ("target_kind" in body) {
    if (body.target_kind === null) {
      sets.push("target_kind = NULL", "target_id = NULL");
    } else if (body.target_kind && body.target_id) {
      sets.push("target_kind = ?", "target_id = ?");
      args.push(body.target_kind, body.target_id);
    }
  }
  if (sets.length === 0) return jsonResponse({ error: "nothing to update" }, 400);
  sets.push("updated_at = ?");
  args.push(nowIso());
  args.push(id);
  await env.CONTENT_DB.prepare(
    `UPDATE notes SET ${sets.join(", ")} WHERE id = ?`,
  ).bind(...args).run();
  const row = await env.CONTENT_DB.prepare(
    `SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`,
  ).bind(id).first<NoteRow>();
  if (!row) return jsonResponse({ error: "post-update read failed" }, 500);
  return jsonResponse({ note: noteRowToDto(row) });
}

async function handleDeleteNote(id: string, env: Env): Promise<Response> {
  await env.CONTENT_DB.prepare(`DELETE FROM notes WHERE id = ?`).bind(id).run();
  return jsonResponse({ ok: true });
}
