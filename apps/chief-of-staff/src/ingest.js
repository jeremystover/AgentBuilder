/**
 * ingest.js — Periodic ingestion loop that replaces workflows_IncrementalMcpSync.gs
 * and workflows_KnowledgeVault.gs.
 *
 * Triggered by Cloudflare Cron (see wrangler.toml [triggers]).
 * Pulls new Gmail threads + Calendar events → writes typed IntakeQueue rows.
 *
 * State (last-processed timestamps) is stored in the Config sheet so it
 * survives across isolate restarts.
 *
 * Factory: createIngest({ ufetch, gfetch, sheets, spreadsheetId }) returns
 *   { runIngest } — call this from the Worker's scheduled() handler.
 */

import { createGmail } from "./gmail.js";
import { createCalendar } from "./calendar.js";

function nowIso() { return new Date().toISOString(); }
function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// ── Config sheet helpers ─────────────────────────────────────────────────────
// We store last-run timestamps in a "Config" sheet (key → value).

async function readConfigValue(sheets, key) {
  try {
    const rows = await sheets.readSheetAsObjects("Config");
    const row = rows.find((r) => String(r.key || r.Key || "") === key);
    return row ? String(row.value || row.Value || "") : null;
  } catch {
    return null;
  }
}

async function writeConfigValue(sheets, key, value) {
  try {
    const rowIdx = await sheets.findRowByKey("Config", "key", key);
    if (rowIdx > 0) {
      await sheets.updateRow("Config", rowIdx, { key, value, updatedAt: nowIso() });
    } else {
      await sheets.appendRows("Config", [[key, value, nowIso()]]);
    }
  } catch {
    // Config sheet may not exist yet — ignore
  }
}

// ── IntakeQueue writer ───────────────────────────────────────────────────────

async function writeIntakeRow(sheets, { kind, summary, payloadJson, sourceRef = "" }) {
  const id = generateId("int");
  await sheets.appendRows("IntakeQueue", [[
    id,
    kind,
    summary.slice(0, 200),
    payloadJson,
    "pending",
    sourceRef,
    nowIso(),
    "",
  ]]);
  return id;
}

// ── Gmail ingestion ──────────────────────────────────────────────────────────

async function ingestGmail({ gmail, sheets, sinceMs }) {
  const threads = await gmail.fetchRecentThreads({
    since: sinceMs,
    query: "in:inbox -category:promotions -category:social",
    maxResults: 50,
  });

  let count = 0;
  for (const thread of threads) {
    const latestMsg = thread.messages[thread.messages.length - 1];

    // Classify intent based on simple heuristics — Claude refines during triage
    const body = latestMsg.body || thread.snippet || "";
    const subject = thread.subject || "";
    const lower = (subject + " " + body).toLowerCase();

    let kind = "email";
    if (/\b(could you|please|can you|would you|requesting|ask)\b/.test(lower)) kind = "ask";
    else if (/\b(committed|will do|i'll|i will|by [a-z]+ \d+)\b/.test(lower)) kind = "commit";
    else if (/\b(decided|decision|going with|we chose|approved)\b/.test(lower)) kind = "decision";

    const payload = {
      kind,
      threadId: thread.threadId,
      subject: thread.subject,
      from: thread.messages[0].from,
      messageCount: thread.messageCount,
      latestDate: latestMsg.date,
      snippet: thread.snippet,
      bodyPreview: body.slice(0, 500),
      messageIds: thread.messages.map((m) => m.messageId),
    };

    await writeIntakeRow(sheets, {
      kind,
      summary: `Email: ${thread.subject} — from ${thread.messages[0].from}`,
      payloadJson: JSON.stringify(payload),
      sourceRef: thread.threadId,
    });
    count++;
  }

  return { ingested: count, source: "gmail" };
}

// ── Calendar ingestion ───────────────────────────────────────────────────────

async function ingestCalendar({ calendar, sheets, sinceMs }) {
  // Look ahead 7 days + back since last run
  const timeMin = new Date(sinceMs).toISOString();
  const timeMax = new Date(Date.now() + 7 * 86400000).toISOString();

  const events = await calendar.listEvents("primary", { timeMin, timeMax, maxResults: 50 });

  // Load existing meetings to avoid duplicates
  let existingMeetings = [];
  try { existingMeetings = await sheets.readSheetAsObjects("Meetings"); } catch { /* empty */ }
  const existingEventIds = new Set(existingMeetings.map((m) => m.eventId).filter(Boolean));

  let newCount = 0;
  let updatedCount = 0;

  for (const evt of events) {
    const norm = calendar.normalizeEvent(evt);
    const isNew = !existingEventIds.has(norm.eventId);

    // Upsert into Meetings sheet
    if (isNew) {
      const meetingId = generateId("mtg");
      await sheets.appendRows("Meetings", [[
        meetingId,
        norm.eventId,
        norm.title,
        norm.startTime,
        norm.endTime,
        norm.description,
        norm.location,
        norm.organizer,
        JSON.stringify(norm.attendees),
        "calendar",
        "google.com",
        `calendar|${norm.eventId}`,
        norm.rawJson,
        "",   // transcriptRef
        "",   // zoomMeetingId
        "",   // zoomRecordingId
        "",   // actionItemsExtracted
        nowIso(),
      ]]);
      newCount++;

      // Write an intake row for upcoming meetings (next 24h) so Claude can prep
      const startMs = new Date(norm.startTime).getTime();
      const hoursUntil = (startMs - Date.now()) / 3600000;
      if (hoursUntil > 0 && hoursUntil <= 24 && norm.attendees.length > 1) {
        const otherAttendees = norm.attendees
          .filter((a) => !a.self)
          .map((a) => a.name || a.email)
          .join(", ");
        await writeIntakeRow(sheets, {
          kind: "calendar",
          summary: `Upcoming meeting: ${norm.title} in ${Math.round(hoursUntil * 10) / 10}h with ${otherAttendees}`,
          payloadJson: JSON.stringify({ ...norm, hoursUntil }),
          sourceRef: norm.eventId,
        });
      }
    } else {
      // Update existing row if title/time changed
      const existing = existingMeetings.find((m) => m.eventId === norm.eventId);
      if (existing && (existing.title !== norm.title || existing.startTime !== norm.startTime)) {
        const rowIdx = await sheets.findRowByKey("Meetings", "eventId", norm.eventId);
        if (rowIdx > 0) {
          await sheets.updateRow("Meetings", rowIdx, {
            ...existing,
            title: norm.title,
            startTime: norm.startTime,
            endTime: norm.endTime,
            description: norm.description,
            attendeesJson: JSON.stringify(norm.attendees),
            rawJson: norm.rawJson,
            updatedAt: nowIso(),
          });
          updatedCount++;
        }
      }
    }
  }

  return { newMeetings: newCount, updatedMeetings: updatedCount, source: "calendar" };
}

// ── Work Calendar ingestion (Apps Script bridge) ─────────────────────────────
// Reads WorkCalendarEvents + WorkCalendarChanges from a separate spreadsheet
// that a Google Apps Script in the work org writes into. Used when the org's
// sharing policy blocks external access to Calendar details (free/busy only).
//
// workCalSheets is a createSheets() instance bound to the work-calendar sheet.
// If it is null (env var unset) we return a no-op result.

function safeParseJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

function parseWorkEventRow(row) {
  return {
    eventId: String(row.eventId || ""),
    title: String(row.title || ""),
    startTime: String(row.startTime || ""),
    endTime: String(row.endTime || ""),
    allDay: String(row.allDay || "").toUpperCase() === "TRUE",
    description: String(row.description || ""),
    location: String(row.location || ""),
    organizer: String(row.organizer || ""),
    attendees: safeParseJson(row.attendeesJson) || [],
    status: String(row.status || ""),
    hangoutLink: String(row.hangoutLink || ""),
    rawJson: String(row.rawJson || "{}"),
  };
}

function isMaterialWorkCalChange(change) {
  if (change.changeType === "created") return true;
  if (change.changeType === "cancelled") return true;
  const diff = safeParseJson(change.diffSummaryJson) || {};
  if (diff.cancelled) return true;
  if (diff.titleChanged) return true;
  if (diff.timeChanged) return true;
  if (diff.locationChanged) return true;
  if (Array.isArray(diff.attendeesAdded) && diff.attendeesAdded.length > 0) return true;
  if (Array.isArray(diff.attendeesRemoved) && diff.attendeesRemoved.length > 0) return true;
  // description-only or response-status-only edits are intentionally skipped
  return false;
}

function buildWorkCalIntakeSummary(change, evt) {
  const title = evt.title || "(untitled)";
  if (change.changeType === "created") return `New work meeting: ${title}`;
  if (change.changeType === "cancelled") return `Cancelled work meeting: ${title}`;
  const human = change.humanSummary || `updated`;
  return `Work mtg changed — ${human}`;
}

async function ingestWorkCalendar({ sheets, workCalSheets, sinceMs }) {
  if (!workCalSheets) {
    return { source: "work-calendar", skipped: "PPP_WORK_CAL_SHEET_ID not set" };
  }

  let changes = [];
  try {
    changes = await workCalSheets.readSheetAsObjects("WorkCalendarChanges");
  } catch (e) {
    return { source: "work-calendar", error: `read changes: ${e.message}` };
  }

  // Only care about changes detected since our last ingest run
  const recent = changes.filter((c) => {
    const t = new Date(c.detectedAt || 0).getTime();
    return Number.isFinite(t) && t > sinceMs;
  });
  if (recent.length === 0) {
    return { source: "work-calendar", newMeetings: 0, updatedMeetings: 0, intakeRows: 0 };
  }

  // Latest change per eventId wins (handles multiple edits within one window)
  const latestByEventId = new Map();
  for (const c of recent) {
    const prev = latestByEventId.get(c.eventId);
    if (!prev || new Date(c.detectedAt) > new Date(prev.detectedAt)) {
      latestByEventId.set(c.eventId, c);
    }
  }

  // Load the current snapshot to resolve each changed eventId to its full state
  let eventsRows = [];
  try {
    eventsRows = await workCalSheets.readSheetAsObjects("WorkCalendarEvents");
  } catch (e) {
    return { source: "work-calendar", error: `read events: ${e.message}` };
  }
  const eventsById = new Map();
  for (const r of eventsRows) {
    if (r.eventId) eventsById.set(String(r.eventId), r);
  }

  // Load existing Meetings rows so we can upsert by eventId
  let existingMeetings = [];
  try { existingMeetings = await sheets.readSheetAsObjects("Meetings"); } catch { /* empty */ }
  const existingEventIds = new Set(existingMeetings.map((m) => m.eventId).filter(Boolean));

  let newMeetings = 0;
  let updatedMeetings = 0;
  let intakeRows = 0;

  for (const [eventId, change] of latestByEventId.entries()) {
    const eventRow = eventsById.get(eventId);
    if (!eventRow) continue; // changelog entry without a matching snapshot row

    const evt = parseWorkEventRow(eventRow);

    if (!existingEventIds.has(evt.eventId)) {
      const meetingId = generateId("mtg");
      await sheets.appendRows("Meetings", [[
        meetingId,
        evt.eventId,
        evt.title,
        evt.startTime,
        evt.endTime,
        evt.description,
        evt.location,
        evt.organizer,
        JSON.stringify(evt.attendees),
        "work-calendar",
        "google.com",
        `work-calendar|${evt.eventId}`,
        evt.rawJson,
        "",   // transcriptRef
        "",   // zoomMeetingId
        "",   // zoomRecordingId
        "",   // actionItemsExtracted
        nowIso(),
      ]]);
      newMeetings++;
    } else {
      const rowIdx = await sheets.findRowByKey("Meetings", "eventId", evt.eventId);
      if (rowIdx > 0) {
        const existing = existingMeetings.find((m) => m.eventId === evt.eventId) || {};
        await sheets.updateRow("Meetings", rowIdx, {
          ...existing,
          title: evt.title,
          startTime: evt.startTime,
          endTime: evt.endTime,
          description: evt.description,
          location: evt.location,
          organizer: evt.organizer,
          attendeesJson: JSON.stringify(evt.attendees),
          rawJson: evt.rawJson,
          updatedAt: nowIso(),
        });
        updatedMeetings++;
      }
    }

    if (isMaterialWorkCalChange(change)) {
      await writeIntakeRow(sheets, {
        kind: change.changeType === "created" ? "calendar" : "calendar-change",
        summary: buildWorkCalIntakeSummary(change, evt),
        payloadJson: JSON.stringify({
          event: evt,
          change: {
            changeType: change.changeType,
            detectedAt: change.detectedAt,
            diff: safeParseJson(change.diffSummaryJson),
            humanSummary: change.humanSummary,
          },
        }),
        sourceRef: evt.eventId,
      });
      intakeRows++;
    }
  }

  return { source: "work-calendar", newMeetings, updatedMeetings, intakeRows };
}

// ── Drive ingestion (already working via gfetch) ─────────────────────────────

async function ingestDrive({ gfetch, sheets, sinceMs }) {
  // Query Drive for files modified since last run that the SA has access to
  const since = new Date(sinceMs).toISOString();
  const query = encodeURIComponent(
    `modifiedTime > "${since}" and trashed = false`
  );

  const res = await gfetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,modifiedTime,webViewLink,owners)&orderBy=modifiedTime desc&pageSize=20`
  );
  const data = await res.json();
  const files = data.files || [];

  let count = 0;
  for (const file of files) {
    // Only surface docs/sheets/slides, not thumbnails/images/etc
    const interestingTypes = [
      "application/vnd.google-apps.document",
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.google-apps.presentation",
    ];
    if (!interestingTypes.includes(file.mimeType)) continue;

    await writeIntakeRow(sheets, {
      kind: "drive",
      summary: `Drive doc updated: ${file.name}`,
      payloadJson: JSON.stringify({
        fileId: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        webViewLink: file.webViewLink,
      }),
      sourceRef: file.id,
    });
    count++;
  }

  return { ingested: count, source: "drive" };
}

// ── Main ingest entry point ───────────────────────────────────────────────────

export function createIngest({ ufetch, gfetch, sheets, workCalSheets = null }) {
  const gmail = createGmail(ufetch);
  const calendar = createCalendar(ufetch);

  async function runIngest() {
    const now = Date.now();
    const INGEST_KEY = "ingest_last_run_ms";

    // Read last-run time (default: 2 hours ago for first run)
    const lastRunStr = await readConfigValue(sheets, INGEST_KEY);
    const sinceMs = lastRunStr ? Number(lastRunStr) : now - 2 * 3600000;

    const results = { startedAt: nowIso(), sinceMs, sources: [] };

    // Gmail
    try {
      const gmailResult = await ingestGmail({ gmail, sheets, sinceMs });
      results.sources.push(gmailResult);
    } catch (e) {
      results.sources.push({ source: "gmail", error: e.message });
    }

    // Calendar
    try {
      const calResult = await ingestCalendar({ calendar, sheets, sinceMs });
      results.sources.push(calResult);
    } catch (e) {
      results.sources.push({ source: "calendar", error: e.message });
    }

    // Work Calendar (Apps Script bridge, optional)
    try {
      const workCalResult = await ingestWorkCalendar({ sheets, workCalSheets, sinceMs });
      results.sources.push(workCalResult);
    } catch (e) {
      results.sources.push({ source: "work-calendar", error: e.message });
    }

    // Drive
    try {
      const driveResult = await ingestDrive({ gfetch, sheets, sinceMs });
      results.sources.push(driveResult);
    } catch (e) {
      results.sources.push({ source: "drive", error: e.message });
    }

    // Update last-run timestamp
    await writeConfigValue(sheets, INGEST_KEY, String(now));

    results.completedAt = nowIso();
    return results;
  }

  return { runIngest, gmail, calendar };
}

// ── MCP tool wrappers ─────────────────────────────────────────────────────────

function formatContent(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

export function createIngestTools({ ufetch, gfetch, sheets, spreadsheetId, workCalSheets = null }) {
  if (!spreadsheetId) return {};

  const { runIngest, gmail, calendar } = createIngest({ ufetch, gfetch, sheets, workCalSheets });

  return {
    run_ingest: {
      description:
        "Manually trigger the ingestion loop: pull new Gmail threads and Calendar events " +
        "since the last run and write them as IntakeQueue rows. " +
        "Normally runs automatically via cron every 10 minutes.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        try {
          const result = await runIngest();
          return formatContent(result);
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    list_calendars: {
      description: "List all Google Calendars accessible to the user.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        try {
          const cals = await calendar.listCalendars();
          return formatContent({ calendars: cals.map((c) => ({ id: c.id, name: c.summary, primary: !!c.primary })) });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    list_calendar_events: {
      description: "List calendar events in a date range.",
      inputSchema: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "Calendar ID. Default: primary." },
          from: { type: "string", description: "ISO start datetime." },
          to: { type: "string", description: "ISO end datetime." },
          maxResults: { type: "number", description: "Max events to return. Default: 20." },
        },
        additionalProperties: false,
      },
      run: async (args = {}) => {
        try {
          const events = await calendar.fetchEventsInRange(args.calendarId || "primary", {
            from: args.from,
            to: args.to || new Date(Date.now() + 7 * 86400000).toISOString(),
          });
          return formatContent({ count: events.length, events: events.slice(0, args.maxResults || 20) });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    list_work_calendar_events: {
      description:
        "List events from the work calendar snapshot populated by the external " +
        "Apps Script bridge (WorkCalendarEvents sheet). Use this when the primary " +
        "OAuth2 calendar cannot return event details because the org restricts " +
        "external sharing to free/busy only.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "ISO start datetime filter (optional)." },
          to: { type: "string", description: "ISO end datetime filter (optional)." },
          maxResults: { type: "number", description: "Max events. Default 50." },
        },
        additionalProperties: false,
      },
      run: async (args = {}) => {
        if (!workCalSheets) {
          return formatContent({ error: "Work calendar sync not configured (PPP_WORK_CAL_SHEET_ID unset)." });
        }
        try {
          const rows = await workCalSheets.readSheetAsObjects("WorkCalendarEvents");
          const fromMs = args.from ? new Date(args.from).getTime() : -Infinity;
          const toMs = args.to ? new Date(args.to).getTime() : Infinity;
          const events = rows
            .map(parseWorkEventRow)
            .filter((e) => {
              const s = new Date(e.startTime).getTime();
              return Number.isFinite(s) && s >= fromMs && s <= toMs;
            })
            .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
            .slice(0, args.maxResults || 50);
          return formatContent({ count: events.length, events });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    create_calendar_event: {
      description: "Create a new Google Calendar event.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          startTime: { type: "string", description: "ISO datetime." },
          endTime: { type: "string", description: "ISO datetime." },
          description: { type: "string" },
          attendeeEmails: { type: "array", items: { type: "string" } },
          location: { type: "string" },
          calendarId: { type: "string", description: "Default: primary." },
        },
        required: ["title", "startTime", "endTime"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        try {
          const evt = await calendar.createSimpleEvent(args.calendarId || "primary", args);
          return formatContent({ ok: true, eventId: evt.id, htmlLink: evt.htmlLink });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    update_calendar_event: {
      description: "Update an existing Google Calendar event.",
      inputSchema: {
        type: "object",
        properties: {
          eventId: { type: "string" },
          calendarId: { type: "string", description: "Default: primary." },
          title: { type: "string" },
          startTime: { type: "string" },
          endTime: { type: "string" },
          description: { type: "string" },
          location: { type: "string" },
        },
        required: ["eventId"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        try {
          const calId = args.calendarId || "primary";
          const existing = await calendar.getEvent(calId, args.eventId);
          const patch = {};
          if (args.title) patch.summary = args.title;
          if (args.startTime) patch.start = { dateTime: args.startTime };
          if (args.endTime) patch.end = { dateTime: args.endTime };
          if (args.description !== undefined) patch.description = args.description;
          if (args.location !== undefined) patch.location = args.location;
          const updated = await calendar.patchEvent(calId, args.eventId, patch);
          return formatContent({ ok: true, eventId: updated.id, title: updated.summary });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    create_gmail_draft: {
      description:
        "Create a Gmail draft. Use for commitment nudges and meeting follow-ups. " +
        "Never auto-sends — draft is held for user review.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string" },
          body: { type: "string", description: "Plain text body." },
          threadId: { type: "string", description: "Optional: reply in an existing thread." },
        },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        try {
          const draft = await gmail.createDraft(args);
          return formatContent({ ok: true, draftId: draft.id });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },
  };
}
