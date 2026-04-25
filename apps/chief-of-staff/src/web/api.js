/**
 * web/api.js — JSON endpoints that back the /app SPA.
 *
 * Every handler here runs *after* requireWebSession has succeeded, so we
 * trust the caller and skip per-handler auth. Mutations go through the
 * existing propose_* + commit_changeset tools so the audit trail stays
 * intact and the same code paths the MCP surface uses are exercised.
 *
 * The SPA hits these routes:
 *
 *   GET    /api/today                     tasks + meetings + brief for today
 *   GET    /api/week                      tasks + meetings + brief for this week
 *   GET    /api/projects                  list of projects (with stakeholder ids)
 *   GET    /api/projects/:id              project 360 (stakeholders, tasks, meetings)
 *   GET    /api/people                    stakeholder list
 *   GET    /api/people/:id                stakeholder 360
 *   GET    /api/intake                    pending IntakeQueue rows
 *   GET    /api/calendar?from=&to=        raw calendar events (used by Projects → Add Meeting)
 *
 *   POST   /api/tasks                     create task          (propose+commit)
 *   PATCH  /api/tasks/:id                 update task          (propose+commit)
 *   POST   /api/tasks/:id/complete        mark task done       (propose+commit)
 *   POST   /api/tasks/:id/uncomplete      mark task open
 *
 *   POST   /api/projects                  create project       (propose+commit)
 *   PATCH  /api/projects/:id              update project       (propose+commit)
 *
 *   POST   /api/people                    create stakeholder
 *   PATCH  /api/people/:id                update stakeholder
 *
 *   POST   /api/intake/:id/resolve        resolve intake item  (propose+commit)
 *   POST   /api/intake/:id/dismiss        dismiss intake item  (propose+commit, action=dropped)
 *
 *   POST   /api/calendar                  create calendar event (delegates to create_calendar_event)
 *
 *   GET    /api/briefs/:kind/:periodKey   read or empty brief
 *   PUT    /api/briefs/:kind/:periodKey   update brief goalsMd
 */

import { jsonResponse, callTool, proposeAndCommit } from "@agentbuilder/web-ui-kit";

function nowIso() {
  return new Date().toISOString();
}

function isOpenStatus(s) {
  const v = String(s || "").toLowerCase();
  return !v || v === "open" || v === "in_progress" || v === "pending" || v === "todo" || v === "active";
}

function startOfDay(d) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d) {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

function startOfWeek(d) {
  const out = startOfDay(d);
  const day = out.getDay(); // 0=Sun .. 6=Sat — use Mon-anchored week
  const diff = (day + 6) % 7;
  out.setDate(out.getDate() - diff);
  return out;
}

function endOfWeek(d) {
  const start = startOfWeek(d);
  const out = new Date(start);
  out.setDate(out.getDate() + 6);
  return endOfDay(out);
}

function isoWeekKey(d) {
  // ISO week: yyyy-Www. Computes per ISO 8601 (Mon-anchored).
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function dayKey(d) {
  return startOfDay(d).toISOString().slice(0, 10);
}

// callTool / proposeAndCommit / jsonResponse imported from
// @agentbuilder/web-ui-kit at the top of this file.

// ── Direct sheets reads for "shape the UI" queries ──────────────────────────
// These reads happen often and the tool layer isn't optimized for them
// (e.g. there is no `list_stakeholders` tool — only get_stakeholder_360).
// Per AGENTS.md we should prefer the tool layer for writes; reads of named
// tables for UI rendering are fine.

async function readAll(sheets, name) {
  try {
    return await sheets.readSheetAsObjects(name);
  } catch {
    return [];
  }
}

function safeParseJsonArray(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function compareDueAt(a, b) {
  const av = a?.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
  const bv = b?.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
  return av - bv;
}

// ── Calendar helpers ────────────────────────────────────────────────────────
// Returns an array of { eventId, title, start, end, attendees: [{email,name}], description, location }

async function listMeetings(sheets, fromIso, toIso) {
  const rows = await readAll(sheets, "Meetings");
  return rows
    .filter((r) => {
      if (!r.startTime) return false;
      const t = Date.parse(r.startTime);
      if (!Number.isFinite(t)) return false;
      return t >= Date.parse(fromIso) && t <= Date.parse(toIso);
    })
    .map((r) => ({
      meetingId: r.meetingId,
      eventId: r.eventId,
      title: r.title,
      startTime: r.startTime,
      endTime: r.endTime,
      description: r.description,
      location: r.location,
      organizer: r.organizer,
      attendees: safeParseJsonArray(r.attendeesJson),
    }))
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

// ── Prep notes for a meeting attendee ───────────────────────────────────────
// We keep this dumb on purpose. The chat sidebar can expand to a richer prep
// brief on demand; the rendered notes here are the cheap version.

function prepNotesForMeeting(meeting, { stakeholders, projects, tasks, commitments }) {
  const matchedStakeholders = [];
  const matchedProjects = new Set();
  for (const a of meeting.attendees || []) {
    const email = String(a.email || "").toLowerCase();
    if (!email) continue;
    const sh = stakeholders.find((s) => String(s.email || "").toLowerCase() === email);
    if (sh) {
      matchedStakeholders.push({
        stakeholderId: sh.stakeholderId,
        name: sh.name || sh.email,
        tier: sh.tierTag || "",
        lastInteractionAt: sh.lastInteractionAt || "",
      });
      for (const p of projects) {
        const ids = safeParseJsonArray(p.stakeholdersJson);
        if (ids.includes(sh.stakeholderId)) matchedProjects.add(p.projectId);
      }
    }
  }
  const projectList = [...matchedProjects]
    .map((id) => projects.find((p) => p.projectId === id))
    .filter(Boolean)
    .map((p) => ({ projectId: p.projectId, name: p.name, status: p.status, healthStatus: p.healthStatus }));
  const openTasks = tasks
    .filter((t) => isOpenStatus(t.status))
    .filter((t) => projectList.find((p) => p.projectId === t.projectId))
    .slice(0, 6)
    .map((t) => ({ taskKey: t.taskKey, title: t.title, dueAt: t.dueAt, priority: t.priority }));
  const openCommitments = commitments
    .filter((c) => String(c.status || "").toLowerCase() !== "done"
                  && String(c.status || "").toLowerCase() !== "dropped")
    .filter((c) => matchedStakeholders.find((s) => s.stakeholderId === c.stakeholderId))
    .slice(0, 6)
    .map((c) => ({ commitmentId: c.commitmentId, description: c.description, dueAt: c.dueAt, ownerType: c.ownerType }));
  return { stakeholders: matchedStakeholders, projects: projectList, openTasks, openCommitments };
}

// ── Route registration ──────────────────────────────────────────────────────

/**
 * Build the API routes. All deps come from the worker's per-request
 * factories so we share auth/data-store wiring.
 *
 * @param {object} ctx
 * @param {object} ctx.tools          merged TOOLS registry (same one /mcp uses)
 * @param {object} ctx.sheets         createD1Sheets(env.DB) or createSheets(...)
 * @param {string} ctx.spreadsheetId  truthy sentinel
 * @param {object} ctx.env            Cloudflare env (for DB)
 */
export async function handleApiRequest(request, ctx) {
  const { tools, sheets, env } = ctx;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Helper to read JSON body safely.
  async function readJson() {
    try { return await request.json(); } catch { return {}; }
  }

  // ── Today ────────────────────────────────────────────────────────────────
  if (method === "GET" && path === "/api/today") {
    return await handleToday();
  }
  if (method === "GET" && path === "/api/week") {
    return await handleWeek();
  }

  // ── Projects ─────────────────────────────────────────────────────────────
  if (method === "GET" && path === "/api/projects") {
    const projects = await readAll(sheets, "Projects");
    return jsonResponse({
      projects: projects.map((p) => ({
        projectId: p.projectId,
        name: p.name,
        status: p.status,
        priority: p.priority,
        healthStatus: p.healthStatus,
        nextMilestoneAt: p.nextMilestoneAt,
        goalId: p.goalId,
        stakeholderIds: safeParseJsonArray(p.stakeholdersJson),
      })),
    });
  }
  {
    const m = path.match(/^\/api\/projects\/([^/]+)$/);
    if (m && method === "GET") {
      const data = await callTool(tools, "get_project_360", { projectId: m[1] });
      return jsonResponse(data);
    }
    if (m && method === "PATCH") {
      const body = await readJson();
      const result = await proposeAndCommit(tools, "propose_update_project", {
        projectId: m[1],
        patch: body.patch || {},
        stakeholderIds: body.stakeholderIds,
        reason: body.reason || "edited via web UI",
      });
      return jsonResponse({ ok: true, result });
    }
  }
  if (method === "POST" && path === "/api/projects") {
    const body = await readJson();
    const result = await proposeAndCommit(tools, "propose_create_project", {
      name: body.name,
      goalId: body.goalId,
      description: body.description,
      status: body.status || "active",
      priority: body.priority,
      healthStatus: body.healthStatus || "on_track",
      stakeholderIds: body.stakeholderIds || [],
    });
    return jsonResponse({ ok: true, result });
  }

  // ── People (stakeholders) ────────────────────────────────────────────────
  if (method === "GET" && path === "/api/people") {
    const rows = await readAll(sheets, "Stakeholders");
    return jsonResponse({
      people: rows
        .map((r) => ({
          stakeholderId: r.stakeholderId,
          name: r.name,
          email: r.email,
          tierTag: r.tierTag,
          cadenceDays: r.cadenceDays,
          lastInteractionAt: r.lastInteractionAt,
        }))
        .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email))),
    });
  }
  {
    const m = path.match(/^\/api\/people\/([^/]+)$/);
    if (m && method === "GET") {
      const data = await callTool(tools, "get_stakeholder_360", { personId: m[1] });
      return jsonResponse(data);
    }
    if (m && method === "PATCH") {
      const body = await readJson();
      await updateStakeholderRow(sheets, m[1], body.patch || {});
      return jsonResponse({ ok: true });
    }
  }
  if (method === "POST" && path === "/api/people") {
    const body = await readJson();
    const id = await createStakeholderRow(sheets, body);
    return jsonResponse({ ok: true, stakeholderId: id });
  }

  // ── Tasks ────────────────────────────────────────────────────────────────
  if (method === "POST" && path === "/api/tasks") {
    const body = await readJson();
    const result = await proposeAndCommit(tools, "propose_create_task", {
      title: body.title,
      dueAt: body.dueAt,
      priority: body.priority,
      projectId: body.projectId,
      notes: body.notes,
      origin: body.origin || "web_ui",
      sources: body.sources || [{ sourceType: "manual", sourceRef: "web-ui", excerpt: "Created from web UI" }],
    });
    return jsonResponse({ ok: true, result });
  }
  {
    const m = path.match(/^\/api\/tasks\/([^/]+)(\/(complete|uncomplete))?$/);
    if (m && method === "PATCH") {
      const body = await readJson();
      const result = await proposeAndCommit(tools, "propose_update_task", {
        taskKey: m[1],
        patch: body.patch || {},
        sources: body.sources,
        reason: body.reason || "edited via web UI",
      });
      return jsonResponse({ ok: true, result });
    }
    if (m && m[3] === "complete" && method === "POST") {
      const body = await readJson();
      const result = await proposeAndCommit(tools, "propose_complete_task", {
        taskKey: m[1],
        completionNote: body.completionNote || "",
      });
      return jsonResponse({ ok: true, result });
    }
    if (m && m[3] === "uncomplete" && method === "POST") {
      const result = await proposeAndCommit(tools, "propose_update_task", {
        taskKey: m[1],
        patch: { status: "open" },
        reason: "uncompleted via web UI",
      });
      return jsonResponse({ ok: true, result });
    }
  }

  // ── Intake ───────────────────────────────────────────────────────────────
  if (method === "GET" && path === "/api/intake") {
    const data = await callTool(tools, "get_intake", { limit: 100 });
    return jsonResponse(data);
  }
  {
    const m = path.match(/^\/api\/intake\/([^/]+)\/(resolve|dismiss)$/);
    if (m && method === "POST") {
      const body = await readJson();
      const action = m[2] === "dismiss" ? "dropped" : "resolved";
      const proposeArgs = { intakeId: m[1], action };
      if (body.linkedTaskKey) proposeArgs.linkedTaskKey = body.linkedTaskKey;
      if (body.linkedCommitmentId) proposeArgs.linkedCommitmentId = body.linkedCommitmentId;
      const result = await proposeAndCommit(tools, "propose_resolve_intake", proposeArgs);
      return jsonResponse({ ok: true, result });
    }
  }

  // ── Calendar ─────────────────────────────────────────────────────────────
  if (method === "GET" && path === "/api/calendar") {
    const from = url.searchParams.get("from") || nowIso();
    const to = url.searchParams.get("to") || new Date(Date.now() + 7 * 86400000).toISOString();
    const meetings = await listMeetings(sheets, from, to);
    return jsonResponse({ meetings });
  }
  if (method === "POST" && path === "/api/calendar") {
    const body = await readJson();
    const data = await callTool(tools, "create_calendar_event", {
      account: body.account || { name: "personal" },
      title: body.title,
      startTime: body.startTime,
      endTime: body.endTime,
      description: body.description,
      location: body.location,
      attendeeEmails: body.attendeeEmails || [],
    });
    return jsonResponse({ ok: true, event: data });
  }

  // ── Briefs ───────────────────────────────────────────────────────────────
  {
    const m = path.match(/^\/api\/briefs\/(day|week)\/([^/]+)$/);
    if (m) {
      const kind = m[1];
      const periodKey = m[2];
      if (method === "GET") {
        const row = await env.DB.prepare(
          `SELECT briefId, kind, periodKey, goalsMd, generatedMd, reviewMd, updatedAt
             FROM Briefs WHERE kind = ? AND periodKey = ?`
        ).bind(kind, periodKey).first();
        return jsonResponse({ brief: row || { kind, periodKey, goalsMd: "", generatedMd: "", reviewMd: "" } });
      }
      if (method === "PUT") {
        const body = await readJson();
        await upsertBrief(env, { kind, periodKey, goalsMd: body.goalsMd ?? "" });
        return jsonResponse({ ok: true });
      }
    }
  }

  // ── Goals (read-only for now, used by Projects → "linked goal" picker) ───
  if (method === "GET" && path === "/api/goals") {
    const data = await callTool(tools, "list_goals", { includeClosed: false });
    return jsonResponse(data);
  }

  // ── External REST API (/api/v1/*) ────────────────────────────────────────
  // Stable, narrow surface for other applications to create tasks, projects,
  // and people. Auth-equivalent to /api/* (session cookie OR bearer key) —
  // the routing for that lives in worker.js. These routes accept the same
  // body shapes as their /api/* siblings but return a slimmer envelope.

  if (method === "POST" && path === "/api/v1/tasks") {
    const body = await readJson();
    if (!body?.title) return jsonResponse({ error: "title is required" }, 400);
    const result = await proposeAndCommit(tools, "propose_create_task", {
      title: body.title,
      dueAt: body.dueAt,
      priority: body.priority,
      projectId: body.projectId,
      ownerId: body.ownerId,
      ownerType: body.ownerType,
      notes: body.notes,
      origin: body.origin || "manual",
      sources: body.sources && body.sources.length
        ? body.sources
        : [{
            sourceType: body.sourceType || "external_api",
            sourceRef: body.sourceRef || "external",
            excerpt: body.excerpt || `Created via /api/v1/tasks`,
          }],
    });
    const taskKey = result?.results?.find((r) => r.action === "create_task")?.details?.taskKey
      || result?.results?.[0]?.details?.taskKey
      || null;
    return jsonResponse({ ok: true, taskKey }, 201);
  }

  if (method === "POST" && path === "/api/v1/projects") {
    const body = await readJson();
    if (!body?.name) return jsonResponse({ error: "name is required" }, 400);
    const result = await proposeAndCommit(tools, "propose_create_project", {
      name: body.name,
      goalId: body.goalId,
      description: body.description,
      status: body.status || "active",
      priority: body.priority,
      healthStatus: body.healthStatus || "on_track",
      stakeholderIds: body.stakeholderIds || [],
    });
    const projectId = result?.results?.find((r) => r.action === "create_project")?.details?.projectId
      || result?.results?.[0]?.details?.projectId
      || null;
    return jsonResponse({ ok: true, projectId }, 201);
  }

  if (method === "POST" && path === "/api/v1/people") {
    const body = await readJson();
    if (!body?.name && !body?.email) {
      return jsonResponse({ error: "name or email is required" }, 400);
    }
    const stakeholderId = await createStakeholderRow(sheets, body);
    return jsonResponse({ ok: true, stakeholderId }, 201);
  }

  return jsonResponse({ error: "not found" }, 404);

  // ── Inner handlers ───────────────────────────────────────────────────────

  async function handleToday() {
    const now = new Date();
    const dStart = startOfDay(now).toISOString();
    const dEnd = endOfDay(now).toISOString();
    const [tasks, meetings, stakeholders, projects, commitments, brief] = await Promise.all([
      readAll(sheets, "Tasks"),
      listMeetings(sheets, dStart, dEnd),
      readAll(sheets, "Stakeholders"),
      readAll(sheets, "Projects"),
      readAll(sheets, "Commitments"),
      env.DB.prepare(
        `SELECT briefId, kind, periodKey, goalsMd, generatedMd, reviewMd, updatedAt
           FROM Briefs WHERE kind='day' AND periodKey=?`
      ).bind(dayKey(now)).first(),
    ]);
    const todayTasks = tasks
      .filter((t) => isOpenStatus(t.status))
      .filter((t) => {
        if (!t.dueAt) return false;
        const d = Date.parse(t.dueAt);
        return Number.isFinite(d) && d <= Date.parse(dEnd);
      })
      .map(toTaskDto)
      .sort(compareDueAt);
    const meetingsWithPrep = meetings.map((m) => ({
      ...m,
      prep: prepNotesForMeeting(m, { stakeholders, projects, tasks, commitments }),
    }));
    return jsonResponse({
      date: dayKey(now),
      tasks: todayTasks,
      meetings: meetingsWithPrep,
      brief: brief || { kind: "day", periodKey: dayKey(now), goalsMd: "", generatedMd: "", reviewMd: "" },
    });
  }

  async function handleWeek() {
    const now = new Date();
    const wStart = startOfWeek(now).toISOString();
    const wEnd = endOfWeek(now).toISOString();
    const periodKey = isoWeekKey(now);
    const [tasks, meetings, stakeholders, projects, commitments, brief] = await Promise.all([
      readAll(sheets, "Tasks"),
      listMeetings(sheets, wStart, wEnd),
      readAll(sheets, "Stakeholders"),
      readAll(sheets, "Projects"),
      readAll(sheets, "Commitments"),
      env.DB.prepare(
        `SELECT briefId, kind, periodKey, goalsMd, generatedMd, reviewMd, updatedAt
           FROM Briefs WHERE kind='week' AND periodKey=?`
      ).bind(periodKey).first(),
    ]);
    const weekTasks = tasks
      .filter((t) => isOpenStatus(t.status))
      .filter((t) => {
        if (!t.dueAt) return false;
        const d = Date.parse(t.dueAt);
        return Number.isFinite(d) && d <= Date.parse(wEnd);
      })
      .map(toTaskDto)
      .sort(compareDueAt);
    const meetingsWithPrep = meetings.map((m) => ({
      ...m,
      prep: prepNotesForMeeting(m, { stakeholders, projects, tasks, commitments }),
    }));
    return jsonResponse({
      periodKey,
      from: wStart,
      to: wEnd,
      tasks: weekTasks,
      meetings: meetingsWithPrep,
      brief: brief || { kind: "week", periodKey, goalsMd: "", generatedMd: "", reviewMd: "" },
    });
  }
}

function toTaskDto(t) {
  return {
    taskKey: t.taskKey,
    title: t.title || t.subject || "(untitled)",
    status: t.status || "open",
    priority: t.priority || "",
    dueAt: t.dueAt || "",
    projectId: t.projectId || "",
    notes: t.notes || "",
  };
}

// ── Stakeholder helpers (no propose tool exists for stakeholders) ───────────
// Stakeholders aren't part of the changeset flow today — they're written
// directly. Kept in api.js so the discrepancy with tasks/projects is obvious.

async function createStakeholderRow(sheets, body) {
  const stakeholderId = body.stakeholderId || `sh_${Date.now().toString(36)}`;
  const row = {
    stakeholderId,
    name: body.name || "",
    email: body.email || "",
    tierTag: body.tierTag || "",
    cadenceDays: body.cadenceDays != null ? String(body.cadenceDays) : "",
    lastInteractionAt: body.lastInteractionAt || "",
    relationshipHealth: body.relationshipHealth || "",
  };
  await sheets.appendRows("Stakeholders", [
    [row.stakeholderId, row.name, row.email, row.tierTag, row.cadenceDays, row.lastInteractionAt, row.relationshipHealth],
  ]);
  return stakeholderId;
}

async function updateStakeholderRow(sheets, stakeholderId, patch) {
  const found = await sheets.findRowByKey("Stakeholders", "stakeholderId", stakeholderId);
  if (!found) throw new Error(`Stakeholder not found: ${stakeholderId}`);
  const merged = { ...found.data, ...patch };
  await sheets.updateRow("Stakeholders", found.rowNum, [
    merged.stakeholderId,
    merged.name || "",
    merged.email || "",
    merged.tierTag || "",
    merged.cadenceDays != null ? String(merged.cadenceDays) : "",
    merged.lastInteractionAt || "",
    merged.relationshipHealth || "",
  ]);
}

// ── Brief upsert ────────────────────────────────────────────────────────────

async function upsertBrief(env, { kind, periodKey, goalsMd, generatedMd, reviewMd }) {
  const existing = await env.DB.prepare(
    `SELECT _row_id, briefId, goalsMd, generatedMd, reviewMd FROM Briefs
      WHERE kind = ? AND periodKey = ?`
  ).bind(kind, periodKey).first();
  if (existing) {
    await env.DB.prepare(
      `UPDATE Briefs SET
         goalsMd = COALESCE(?, goalsMd),
         generatedMd = COALESCE(?, generatedMd),
         reviewMd = COALESCE(?, reviewMd),
         updatedAt = ?
       WHERE _row_id = ?`
    ).bind(
      goalsMd ?? null,
      generatedMd ?? null,
      reviewMd ?? null,
      nowIso(),
      existing._row_id,
    ).run();
    return existing.briefId;
  }
  const briefId = `brief_${kind}_${periodKey}_${Date.now().toString(36)}`;
  await env.DB.prepare(
    `INSERT INTO Briefs (briefId, kind, periodKey, goalsMd, generatedMd, reviewMd, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    briefId,
    kind,
    periodKey,
    goalsMd ?? "",
    generatedMd ?? "",
    reviewMd ?? "",
    nowIso(),
  ).run();
  return briefId;
}

export const _internals = { upsertBrief, dayKey, isoWeekKey, prepNotesForMeeting };
