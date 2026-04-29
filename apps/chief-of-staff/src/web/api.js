/**
 * web/api.js — JSON endpoints that back the /app SPA.
 *
 * Every handler here runs *after* requireWebSession has succeeded, so we
 * trust the caller and skip per-handler auth. Mutations go through the
 * existing propose_* + commit_changeset tools so the audit trail stays
 * intact and the same code paths the MCP surface uses are exercised.
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

function priorityRank(p) {
  const v = String(p || "").toLowerCase();
  return v === "high" ? 3 : v === "medium" ? 2 : v === "low" ? 1 : 0;
}

function compareDueAt(a, b) {
  const av = a?.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
  const bv = b?.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
  return av - bv;
}

// ── Calendar helpers ────────────────────────────────────────────────────────
// Returns an array of { eventId, title, start, end, attendees: [{email,name}], description, location }

function extractZoomUrl(text) {
  if (!text) return "";
  const m = String(text).match(/https?:\/\/[^\s<>"]*zoom\.us\/[^\s<>"]+/i);
  return m ? m[0] : "";
}

function extractMeetUrl(text) {
  if (!text) return "";
  const m = String(text).match(/https?:\/\/meet\.google\.com\/[^\s<>"]+/i);
  return m ? m[0] : "";
}

function meetingLinks(r) {
  // Pull calendar invite + conference URLs from whatever fields they happen
  // to live in. rawJson is the canonical place; location/description are the
  // fallbacks for older imports.
  let raw = {};
  try { raw = r.rawJson ? JSON.parse(r.rawJson) : {}; } catch { raw = {}; }
  const conf = raw?.conferenceData;
  const entry = Array.isArray(conf?.entryPoints) ? conf.entryPoints : [];
  const video = entry.find((e) => e.entryPointType === "video") || entry[0];
  const conferenceUrl = video?.uri || "";
  const htmlLink = raw?.htmlLink || "";
  const zoomUrl = extractZoomUrl(r.location) || extractZoomUrl(r.description) || extractZoomUrl(conferenceUrl);
  const meetUrl = extractMeetUrl(r.location) || extractMeetUrl(r.description) || extractMeetUrl(conferenceUrl);
  return {
    htmlLink,
    zoomUrl: zoomUrl || (conferenceUrl && /zoom/i.test(conferenceUrl) ? conferenceUrl : ""),
    meetUrl: meetUrl || (conferenceUrl && /meet\.google/i.test(conferenceUrl) ? conferenceUrl : ""),
    conferenceUrl,
  };
}

function projectMeeting(r) {
  const links = meetingLinks(r);
  let raw = {};
  try { raw = r.rawJson ? JSON.parse(r.rawJson) : {}; } catch { raw = {}; }
  const status = String(raw?.status || "").toLowerCase();
  const iCalUID = String(raw?.iCalUID || "");
  const attendees = safeParseJsonArray(r.attendeesJson);
  const selfAttendee = attendees.find((a) => a && a.self);
  const selfStatus = String(selfAttendee?.status || "").toLowerCase();
  const declinedAttendees = attendees
    .filter((a) => a && !a.self && String(a.status || "").toLowerCase() === "declined")
    .map((a) => a.name || a.email)
    .filter(Boolean);
  return {
    meetingId: r.meetingId,
    eventId: r.eventId,
    iCalUID,
    title: r.title,
    startTime: r.startTime,
    endTime: r.endTime,
    description: r.description,
    location: r.location,
    organizer: r.organizer,
    attendees,
    sourceType: r.sourceType || "",
    status,
    selfStatus,
    declinedAttendees,
    anyDeclined: declinedAttendees.length > 0,
    htmlLink: links.htmlLink,
    zoomUrl: links.zoomUrl,
    meetUrl: links.meetUrl,
    conferenceUrl: links.conferenceUrl,
  };
}

// Score a projected meeting so dedupe can keep the richest source row.
// Personal-calendar rows usually have htmlLink + zoom + full attendees;
// work-cal rows are often free/busy-only and lighter.
function meetingRichnessScore(m) {
  return (m.attendees?.length || 0)
    + (m.htmlLink ? 5 : 0)
    + (m.zoomUrl || m.meetUrl ? 3 : 0)
    + (m.description ? 1 : 0)
    + (m.sourceType === "calendar" ? 2 : 0);
}

// Filter out cancelled meetings and meetings the user declined, then dedupe
// the same logical event arriving from multiple calendar sources (personal +
// work) where the eventIds differ but iCalUID / start+end+title match.
function dedupAndFilterMeetings(meetings) {
  const live = meetings.filter((m) => m.status !== "cancelled" && m.selfStatus !== "declined");
  const byKey = new Map();
  for (const m of live) {
    const key = m.iCalUID
      || `${m.startTime}|${m.endTime}|${String(m.title || "").trim().toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, m);
      continue;
    }
    if (meetingRichnessScore(m) > meetingRichnessScore(existing)) {
      // Carry forward any decline signal from the dropped row so a work-cal
      // row that knows about a decline isn't lost when the personal row wins.
      const merged = {
        ...m,
        anyDeclined: m.anyDeclined || existing.anyDeclined,
        declinedAttendees: [...new Set([...(m.declinedAttendees || []), ...(existing.declinedAttendees || [])])],
      };
      byKey.set(key, merged);
    } else {
      existing.anyDeclined = existing.anyDeclined || m.anyDeclined;
      existing.declinedAttendees = [...new Set([...(existing.declinedAttendees || []), ...(m.declinedAttendees || [])])];
    }
  }
  return [...byKey.values()].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

async function listMeetings(sheets, fromIso, toIso) {
  const rows = await readAll(sheets, "Meetings");
  const projected = rows
    .filter((r) => {
      if (!r.startTime) return false;
      const t = Date.parse(r.startTime);
      if (!Number.isFinite(t)) return false;
      return t >= Date.parse(fromIso) && t <= Date.parse(toIso);
    })
    .map(projectMeeting);
  return dedupAndFilterMeetings(projected);
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

  // ── Config (non-secret runtime values for the SPA) ───────────────────────
  if (method === "GET" && path === "/api/config") {
    return jsonResponse({
      ideasUrl: env.IDEAS_URL || "",
    });
  }

  // ── Now ──────────────────────────────────────────────────────────────────
  if (method === "GET" && path === "/api/now") {
    return await handleNow();
  }

  // ── Focus list (the "Focus now" tray on /now) ────────────────────────────
  if (method === "GET" && path === "/api/focus-now") {
    return jsonResponse({ tasks: await readFocusList() });
  }
  if (method === "POST" && path === "/api/focus-now") {
    const body = await readJson();
    if (!body.taskKey) return jsonResponse({ error: "taskKey required" }, 400);
    await addToFocusList(body.taskKey);
    return jsonResponse({ ok: true });
  }
  if (method === "DELETE" && path === "/api/focus-now") {
    await env.DB.prepare(`DELETE FROM FocusNow`).run();
    return jsonResponse({ ok: true });
  }
  {
    const m = path.match(/^\/api\/focus-now\/([^/]+)$/);
    if (m && method === "DELETE") {
      await env.DB.prepare(`DELETE FROM FocusNow WHERE taskKey=?`).bind(m[1]).run();
      return jsonResponse({ ok: true });
    }
  }

  // ── Today tasks (user-curated "do this today" list) ──────────────────────
  // Designation auto-expires when the calendar day rolls over (queries are
  // filtered by today's dayKey). Completing a task drops it from the view
  // via the open-status filter; the user can also explicitly unmark.
  if (method === "GET" && path === "/api/today-tasks") {
    const keys = await readTodayTaskKeys();
    return jsonResponse({ taskKeys: Array.from(keys) });
  }
  if (method === "POST" && path === "/api/today-tasks") {
    const body = await readJson();
    if (!body.taskKey) return jsonResponse({ error: "taskKey required" }, 400);
    await addTodayTask(body.taskKey);
    return jsonResponse({ ok: true });
  }
  {
    const m = path.match(/^\/api\/today-tasks\/([^/]+)$/);
    if (m && method === "DELETE") {
      await env.DB.prepare(
        `DELETE FROM TodayTasks WHERE taskKey=? AND dayKey=?`
      ).bind(m[1], dayKey(new Date())).run();
      return jsonResponse({ ok: true });
    }
  }

  // ── Meeting transcript / summary ─────────────────────────────────────────
  {
    const m = path.match(/^\/api\/meetings\/([^/]+)\/transcript$/);
    if (m && method === "GET") {
      try {
        const data = await callTool(tools, "get_meeting_transcript", { meetingId: m[1] });
        return jsonResponse({ transcript: data.transcript || "", meetingId: m[1] });
      } catch (err) {
        return jsonResponse({ transcript: "", error: err.message }, 200);
      }
    }
    if (m && method === "POST") {
      // Pull from Zoom (poll recent recordings). Then re-fetch the transcript.
      const days = (await readJson()).daysBack || 1;
      try {
        await callTool(tools, "poll_zoom_recordings", { daysBack: days });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 200);
      }
      try {
        const data = await callTool(tools, "get_meeting_transcript", { meetingId: m[1] });
        return jsonResponse({ ok: true, transcript: data.transcript || "" });
      } catch (err) {
        return jsonResponse({ ok: true, transcript: "", note: err.message });
      }
    }
  }
  {
    const m = path.match(/^\/api\/meetings\/([^/]+)\/summary$/);
    if (m && method === "GET") {
      const row = await env.DB.prepare(
        `SELECT noteId, body, updatedAt FROM Notes
           WHERE entityType='meeting' AND entityId=?
           ORDER BY updatedAt DESC LIMIT 1`
      ).bind(m[1]).first();
      return jsonResponse({ summary: row || null });
    }
    if (m && method === "PUT") {
      const body = await readJson();
      const existing = await env.DB.prepare(
        `SELECT noteId FROM Notes WHERE entityType='meeting' AND entityId=? LIMIT 1`
      ).bind(m[1]).first();
      const now = nowIso();
      if (existing) {
        await env.DB.prepare(`UPDATE Notes SET body=?, updatedAt=? WHERE noteId=?`)
          .bind(body.body || "", now, existing.noteId).run();
        return jsonResponse({ ok: true, noteId: existing.noteId });
      }
      const noteId = `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      await env.DB.prepare(
        `INSERT INTO Notes (noteId, entityType, entityId, body, createdAt, updatedAt)
           VALUES (?, 'meeting', ?, ?, ?, ?)`
      ).bind(noteId, m[1], body.body || "", now, now).run();
      return jsonResponse({ ok: true, noteId });
    }
  }

  // ── Today ────────────────────────────────────────────────────────────────
  if (method === "GET" && path === "/api/today") {
    return await handleToday(url.searchParams.get("includeCompleted") === "1");
  }
  if (method === "GET" && path === "/api/week") {
    return await handleWeek(url.searchParams.get("includeCompleted") === "1");
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
      // Augment project_360 with hydrated stakeholders (the tool returns
      // bare ids/objects; the UI needs name+email to render pills) and
      // upcoming + recent meetings linked via attendee email overlap.
      const data = await callTool(tools, "get_project_360", { projectId: m[1] });
      const [stakeholderRows, allMeetings] = await Promise.all([
        readAll(sheets, "Stakeholders"),
        readAll(sheets, "Meetings"),
      ]);
      const byId = Object.fromEntries(stakeholderRows.map((s) => [s.stakeholderId, s]));
      const byEmail = Object.fromEntries(stakeholderRows
        .filter((s) => s.email)
        .map((s) => [String(s.email).toLowerCase(), s]));
      const projectStakeholderIds = (data.stakeholders || []).map((s) =>
        typeof s === "string" ? s : (s.stakeholderId || s.id || ""),
      ).filter(Boolean);
      const hydratedStakeholders = projectStakeholderIds.map((id) => {
        const s = byId[id] || {};
        return {
          stakeholderId: id,
          name: s.name || "",
          email: s.email || "",
          tierTag: s.tierTag || "",
        };
      });
      const stakeholderEmails = new Set(hydratedStakeholders
        .map((s) => String(s.email || "").toLowerCase())
        .filter(Boolean));
      const nowMs = Date.now();
      const projectId = m[1];
      const projectMeetings = dedupAndFilterMeetings(allMeetings
        .filter((m2) => {
          if (!m2.startTime) return false;
          // Explicit links — set by POST /api/meetings/:id/link-project.
          let raw = {};
          try { raw = m2.rawJson ? JSON.parse(m2.rawJson) : {}; } catch { raw = {}; }
          if (Array.isArray(raw.linkedProjectIds) && raw.linkedProjectIds.includes(projectId)) return true;
          // Fallback: stakeholder-email overlap.
          const attendeesText = String(m2.attendeesJson || "").toLowerCase();
          for (const e of stakeholderEmails) if (attendeesText.includes(e)) return true;
          return false;
        })
        .map(projectMeeting));
      const upcomingMeetings = projectMeetings
        .filter((m2) => Date.parse(m2.startTime) >= nowMs)
        .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
        .slice(0, 10);
      // recentMeetings already on `data` but use ours so the same shape
      // (with htmlLink/zoomUrl) is available everywhere.
      const recentMeetings = projectMeetings
        .filter((m2) => Date.parse(m2.startTime) < nowMs)
        .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
        .slice(0, 5);
      return jsonResponse({
        ...data,
        stakeholders: hydratedStakeholders,
        upcomingMeetings,
        recentMeetings,
      });
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
      // get_stakeholder_360's recentMeetings only carries title + startTime.
      // Re-project from the Meetings table directly so the UI gets the same
      // rich shape (htmlLink, zoomUrl, attendees) as everywhere else.
      const stakeholderRows = await readAll(sheets, "Stakeholders");
      const sh = stakeholderRows.find((s) =>
        s.stakeholderId === m[1] || String(s.email || "").toLowerCase() === m[1].toLowerCase(),
      );
      const email = String(sh?.email || data.email || "").toLowerCase();
      let upcomingMeetings = [];
      let recentMeetings = data.recentMeetings || [];
      if (email) {
        const allMeetings = await readAll(sheets, "Meetings");
        const nowMs = Date.now();
        const matching = dedupAndFilterMeetings(allMeetings
          .filter((mm) => mm.startTime && String(mm.attendeesJson || "").toLowerCase().includes(email))
          .map(projectMeeting));
        upcomingMeetings = matching
          .filter((mm) => Date.parse(mm.startTime) >= nowMs)
          .slice(0, 10);
        recentMeetings = matching
          .filter((mm) => Date.parse(mm.startTime) < nowMs)
          .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
          .slice(0, 10);
      }
      return jsonResponse({ ...data, upcomingMeetings, recentMeetings });
    }
    if (m && method === "PATCH") {
      const body = await readJson();
      await updateStakeholderRow(sheets, m[1], body.patch || {});
      return jsonResponse({ ok: true });
    }
  }
  {
    // Link a project to a person (additive — does not replace existing links).
    const m = path.match(/^\/api\/people\/([^/]+)\/projects$/);
    if (m && method === "POST") {
      const body = await readJson();
      if (!body.projectId) return jsonResponse({ error: "projectId required" }, 400);
      const cur = await callTool(tools, "get_project_360", { projectId: body.projectId });
      const existingIds = (cur.stakeholders || []).map((s) =>
        typeof s === "string" ? s : (s.stakeholderId || s.id || ""),
      ).filter(Boolean);
      const ids = Array.from(new Set([...existingIds, m[1]]));
      const result = await proposeAndCommit(tools, "propose_update_project", {
        projectId: body.projectId,
        patch: {},
        stakeholderIds: ids,
        reason: "linked from person page",
      });
      return jsonResponse({ ok: true, result });
    }
  }
  {
    // Person brief (kind='person', periodKey=stakeholderId). Reuses Briefs.
    const m = path.match(/^\/api\/people\/([^/]+)\/brief$/);
    if (m && method === "GET") {
      const row = await env.DB.prepare(
        `SELECT briefId, kind, periodKey, goalsMd, generatedMd, reviewMd, updatedAt
           FROM Briefs WHERE kind='person' AND periodKey=?`
      ).bind(m[1]).first();
      return jsonResponse({ brief: row || { kind: "person", periodKey: m[1], goalsMd: "", generatedMd: "" } });
    }
    if (m && method === "PUT") {
      const body = await readJson();
      await upsertBrief(env, { kind: "person", periodKey: m[1], goalsMd: body.goalsMd ?? "" });
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
    const rows = await readAll(sheets, "IntakeQueue");
    const items = rows
      .filter((r) => String(r.status || "").toLowerCase() === "pending" || !r.status)
      .map((r) => {
        let payload = {};
        try { payload = r.payloadJson ? JSON.parse(r.payloadJson) : {}; } catch { payload = {}; }
        const body = payload.body || payload.bodyText || payload.snippet
          || payload.description || payload.content || "";
        const fromAddr = payload.from || payload.sender || payload.organizer || "";
        const replyTo = payload.replyTo || payload.from || "";
        const subject = payload.subject || r.summary || "";
        const threadId = payload.threadId || payload.gmailThreadId || "";
        const urgency = scoreIntakeUrgency(r, payload);
        return {
          intakeId: r.intakeId,
          kind: r.kind,
          summary: r.summary,
          sourceRef: r.sourceRef,
          createdAt: r.createdAt || "",
          updatedAt: r.updatedAt || "",
          body,
          subject,
          fromAddr,
          replyTo,
          threadId,
          urgency,
        };
      })
      .sort((a, b) => (b.urgency - a.urgency) || String(b.createdAt).localeCompare(String(a.createdAt)));
    return jsonResponse({ count: items.length, items });
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
  {
    const m = path.match(/^\/api\/intake\/([^/]+)\/reply$/);
    if (m && method === "POST") {
      const body = await readJson();
      if (!body.to || !body.body) return jsonResponse({ error: "to and body required" }, 400);
      const data = await callTool(tools, "create_gmail_draft", {
        account: body.account || { name: "personal" },
        to: body.to,
        subject: body.subject || "",
        body: body.body,
        threadId: body.threadId || "",
      });
      return jsonResponse({ ok: true, draft: data });
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
  {
    // Update an existing calendar event by eventId. Used by the meeting
    // editor (date/time/description/attendees). Mirrors update_calendar_event.
    const m = path.match(/^\/api\/calendar\/([^/]+)$/);
    if (m && method === "PATCH") {
      const body = await readJson();
      const data = await callTool(tools, "update_calendar_event", {
        account: body.account || { name: "personal" },
        eventId: m[1],
        calendarId: body.calendarId,
        title: body.title,
        startTime: body.startTime,
        endTime: body.endTime,
        description: body.description,
        location: body.location,
        addAttendeeEmails: body.addAttendeeEmails,
      });
      return jsonResponse({ ok: true, event: data });
    }
  }
  {
    // Link a meeting to a project. Stored on the Meetings row in
    // rawJson.linkedProjectIds so it doesn't pollute the calendar invite
    // visible to attendees. Project pages match meetings via attendee
    // email overlap *or* this list.
    const m = path.match(/^\/api\/meetings\/([^/]+)\/link-project$/);
    if (m && method === "POST") {
      const body = await readJson();
      if (!body.projectId) return jsonResponse({ error: "projectId required" }, 400);
      const found = await sheets.findRowByKey("Meetings", "meetingId", m[1]);
      if (!found) return jsonResponse({ error: "Meeting not found" }, 404);
      let raw = {};
      try { raw = found.data.rawJson ? JSON.parse(found.data.rawJson) : {}; } catch { raw = {}; }
      const linked = new Set(Array.isArray(raw.linkedProjectIds) ? raw.linkedProjectIds : []);
      linked.add(body.projectId);
      raw.linkedProjectIds = [...linked];
      await sheets.updateRow("Meetings", found.rowNum, { rawJson: JSON.stringify(raw) });
      return jsonResponse({ ok: true });
    }
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

  // ── Notes (free-form text linked to a person/project/task) ───────────────
  if (method === "GET" && path === "/api/notes") {
    const entityType = url.searchParams.get("entityType") || "";
    const entityId = url.searchParams.get("entityId") || "";
    if (!entityType || !entityId) return jsonResponse({ notes: [] });
    const rows = await env.DB.prepare(
      `SELECT noteId, entityType, entityId, body, createdAt, updatedAt
         FROM Notes WHERE entityType=? AND entityId=?
         ORDER BY updatedAt DESC`
    ).bind(entityType, entityId).all();
    return jsonResponse({ notes: rows.results || [] });
  }
  if (method === "POST" && path === "/api/notes") {
    const body = await readJson();
    if (!body.entityType || !body.entityId) {
      return jsonResponse({ error: "entityType and entityId required" }, 400);
    }
    const noteId = `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO Notes (noteId, entityType, entityId, body, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(noteId, body.entityType, body.entityId, body.body || "", now, now).run();
    return jsonResponse({ ok: true, noteId });
  }
  {
    const m = path.match(/^\/api\/notes\/([^/]+)$/);
    if (m && method === "PATCH") {
      const body = await readJson();
      await env.DB.prepare(
        `UPDATE Notes SET body=?, updatedAt=? WHERE noteId=?`
      ).bind(body.body || "", nowIso(), m[1]).run();
      return jsonResponse({ ok: true });
    }
    if (m && method === "DELETE") {
      await env.DB.prepare(`DELETE FROM Notes WHERE noteId=?`).bind(m[1]).run();
      return jsonResponse({ ok: true });
    }
  }

  // ── Completed tasks (used by the per-page "show completed" toggle) ───────
  if (method === "GET" && path === "/api/tasks/completed") {
    const scope = url.searchParams.get("scope") || "today"; // today | week | all
    const projectId = url.searchParams.get("projectId") || "";
    const ownerId = url.searchParams.get("ownerId") || "";
    const tasks = await readAll(sheets, "Tasks");
    const now = new Date();
    let from = null;
    if (scope === "today") from = startOfDay(now);
    else if (scope === "week") from = startOfWeek(now);
    const fromMs = from ? from.getTime() : 0;
    const completed = tasks
      .filter((t) => String(t.status || "").toLowerCase() === "done")
      .filter((t) => !projectId || String(t.projectId || "") === projectId)
      .filter((t) => !ownerId || String(t.ownerId || "").toLowerCase() === ownerId.toLowerCase())
      .filter((t) => {
        if (!from) return true;
        const ts = Date.parse(t.completedAt || t.updatedAt || t.dueAt || "");
        return Number.isFinite(ts) ? ts >= fromMs : false;
      })
      .map(toTaskDto)
      .sort((a, b) => String(b.dueAt).localeCompare(String(a.dueAt)));
    return jsonResponse({ tasks: completed });
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

  async function readFocusList() {
    const res = await env.DB.prepare(
      `SELECT taskKey, position, addedAt FROM FocusNow ORDER BY position ASC, _row_id ASC`
    ).all();
    const rows = res.results || [];
    if (!rows.length) return [];
    const [tasks, todayKeys] = await Promise.all([
      readAll(sheets, "Tasks"),
      readTodayTaskKeys(),
    ]);
    const byKey = Object.fromEntries(tasks.map((t) => [t.taskKey, t]));
    return rows
      .map((r) => byKey[r.taskKey]
        ? { ...toTaskDto(byKey[r.taskKey]), addedAt: r.addedAt, today: todayKeys.has(r.taskKey) }
        : null)
      .filter(Boolean);
  }

  async function addToFocusList(taskKey) {
    const existing = await env.DB.prepare(
      `SELECT _row_id FROM FocusNow WHERE taskKey=?`
    ).bind(taskKey).first();
    if (existing) return;
    const next = await env.DB.prepare(
      `SELECT COALESCE(MAX(position), 0) + 1 AS p FROM FocusNow`
    ).first();
    await env.DB.prepare(
      `INSERT INTO FocusNow (taskKey, position, addedAt) VALUES (?, ?, ?)`
    ).bind(taskKey, next?.p || 1, nowIso()).run();
  }

  async function readTodayTaskKeys() {
    const today = dayKey(new Date());
    const res = await env.DB.prepare(
      `SELECT taskKey FROM TodayTasks WHERE dayKey=?`
    ).bind(today).all();
    return new Set((res.results || []).map((r) => r.taskKey));
  }

  async function addTodayTask(taskKey) {
    const today = dayKey(new Date());
    await env.DB.prepare(
      `INSERT OR IGNORE INTO TodayTasks (taskKey, dayKey, addedAt) VALUES (?, ?, ?)`
    ).bind(taskKey, today, nowIso()).run();
  }

  async function handleNow() {
    const now = new Date();
    const nowMs = now.getTime();
    const fromIso = new Date(nowMs - 4 * 3_600_000).toISOString();
    const toIso = new Date(nowMs + 24 * 3_600_000).toISOString();
    const [tasks, meetings, stakeholders, projects, commitments] = await Promise.all([
      readAll(sheets, "Tasks"),
      listMeetings(sheets, fromIso, toIso),
      readAll(sheets, "Stakeholders"),
      readAll(sheets, "Projects"),
      readAll(sheets, "Commitments"),
    ]);
    const allMeetingRows = await readAll(sheets, "Meetings");
    const meetingRowById = Object.fromEntries(allMeetingRows.map((r) => [r.meetingId, r]));

    // Next meeting: first one whose start is in the future. Fall back to the
    // current in-progress meeting (started but not yet ended) so the prep
    // panel is still useful when you're already in the call.
    const future = meetings.filter((m) => Date.parse(m.startTime) > nowMs);
    const inProgress = meetings.filter((m) => {
      const s = Date.parse(m.startTime), e = Date.parse(m.endTime);
      return Number.isFinite(s) && Number.isFinite(e) && s <= nowMs && nowMs <= e;
    });
    const pickNext = inProgress[0] || future[0] || null;
    const nextMeeting = pickNext ? {
      ...pickNext,
      prep: prepNotesForMeeting(pickNext, { stakeholders, projects, tasks, commitments }),
      secondsUntil: Math.max(0, Math.round((Date.parse(pickNext.startTime) - nowMs) / 1000)),
      inProgress: !!inProgress[0],
    } : null;

    // Recent meeting: most-recently-ended meeting within the last 2 hours.
    const recent = meetings
      .filter((m) => {
        const e = Date.parse(m.endTime);
        return Number.isFinite(e) && e <= nowMs && e >= nowMs - 2 * 3_600_000;
      })
      .sort((a, b) => Date.parse(b.endTime) - Date.parse(a.endTime))[0] || null;
    let recentMeeting = null;
    if (recent) {
      const row = meetingRowById[recent.meetingId];
      const summaryRow = await env.DB.prepare(
        `SELECT noteId, body, updatedAt FROM Notes
           WHERE entityType='meeting' AND entityId=?
           ORDER BY updatedAt DESC LIMIT 1`
      ).bind(recent.meetingId || recent.eventId || "").first();
      recentMeeting = {
        ...recent,
        hasTranscript: !!(row?.transcriptRef),
        summary: summaryRow || null,
      };
    }

    // Quick wins: small, prioritized, due-soon open tasks. The user wants a
    // *short* list of things they can knock out right now, so we cap at 5
    // and exclude anything already in the focus list. User-marked "today"
    // tasks always make the list (and sort to the top) — they're the user's
    // explicit "do this today" picks, so we don't want a heuristic to drop them.
    const focusKeys = new Set(((await env.DB.prepare(
      `SELECT taskKey FROM FocusNow`
    ).all()).results || []).map((r) => r.taskKey));
    const todayKeys = await readTodayTaskKeys();
    const quickWins = tasks
      .filter((t) => isOpenStatus(t.status))
      .filter((t) => !focusKeys.has(t.taskKey))
      .map((t) => {
        const due = Date.parse(t.dueAt || "");
        const overdue = Number.isFinite(due) && due < nowMs;
        const dueToday = Number.isFinite(due) && due <= nowMs + 24 * 3_600_000;
        const pri = priorityRank(t.priority);
        const today = todayKeys.has(t.taskKey);
        const score = (today ? 100 : 0) + (overdue ? 5 : 0) + (dueToday ? 2 : 0) + pri;
        return { task: t, score, today };
      })
      .filter((x) => x.today || x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => ({ ...toTaskDto(x.task), today: x.today }));

    const focusTasks = await readFocusList();

    return jsonResponse({
      now: now.toISOString(),
      nextMeeting,
      recentMeeting,
      quickWins,
      focusTasks,
    });
  }

  async function handleToday(includeCompleted) {
    const now = new Date();
    const dStart = startOfDay(now).toISOString();
    const dEnd = endOfDay(now).toISOString();
    const [tasks, meetings, stakeholders, projects, commitments, brief, todayKeys] = await Promise.all([
      readAll(sheets, "Tasks"),
      listMeetings(sheets, dStart, dEnd),
      readAll(sheets, "Stakeholders"),
      readAll(sheets, "Projects"),
      readAll(sheets, "Commitments"),
      env.DB.prepare(
        `SELECT briefId, kind, periodKey, goalsMd, generatedMd, reviewMd, updatedAt
           FROM Briefs WHERE kind='day' AND periodKey=?`
      ).bind(dayKey(now)).first(),
      readTodayTaskKeys(),
    ]);
    // Show a task on Today if either (a) it's due on/before today, or
    // (b) the user marked it as a today task. Today-marked tasks always
    // sort to the top regardless of due date.
    const todayTasks = tasks
      .filter((t) => includeCompleted ? true : isOpenStatus(t.status))
      .filter((t) => {
        if (todayKeys.has(t.taskKey)) return true;
        if (!t.dueAt) return false;
        const d = Date.parse(t.dueAt);
        return Number.isFinite(d) && d <= Date.parse(dEnd);
      })
      .map((t) => ({ ...toTaskDto(t), today: todayKeys.has(t.taskKey) }))
      .sort((a, b) => {
        if (a.today !== b.today) return a.today ? -1 : 1;
        return compareDueAt(a, b);
      });
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

  async function handleWeek(includeCompleted) {
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
      .filter((t) => includeCompleted ? true : isOpenStatus(t.status))
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
    completedAt: t.completedAt || "",
  };
}

// Heuristic urgency score for triage prioritization. We don't burn an LLM
// call here — counts of urgency keywords + "person needs to reply" signals
// give a useful sort. The chat sidebar can do a smarter pass on demand.
function scoreIntakeUrgency(row, payload) {
  const text = [
    row.summary,
    payload.subject,
    payload.snippet,
    payload.body,
  ].filter(Boolean).join(" ").toLowerCase();
  let score = 0;
  if (/\b(urgent|asap|today|immediately|need by|by eod|by tomorrow)\b/.test(text)) score += 3;
  if (/\b(deadline|due|expires|expiring)\b/.test(text)) score += 2;
  if (/\?(\s|$)/.test(text)) score += 1; // there's a question
  if (/\b(reply|respond|let me know|get back to me|circling back|following up)\b/.test(text)) score += 2;
  if (/\b(meeting|invite|calendar)\b/.test(text)) score += 1;
  if (/\b(paid|payment|invoice|contract|signing|sign)\b/.test(text)) score += 1;
  // Recency bumps urgency.
  const created = Date.parse(row.createdAt || "");
  if (Number.isFinite(created)) {
    const ageHours = (Date.now() - created) / 3_600_000;
    if (ageHours < 6) score += 2;
    else if (ageHours < 24) score += 1;
  }
  return score;
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
