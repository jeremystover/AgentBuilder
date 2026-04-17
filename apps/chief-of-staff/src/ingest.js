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
import { DEFAULT_ACCOUNT, getUserFetch } from "./auth.js";
import { createBluesky } from "./bluesky.js";
import { createEmailFilterTools } from "./email-filters.js";

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
    const found = await sheets.findRowByKey("Config", "key", key);
    if (found) {
      await sheets.updateRow("Config", found.rowNum, [key, value, nowIso()]);
    } else {
      await sheets.appendRows("Config", [[key, value, nowIso()]]);
    }
  } catch {
    // Config sheet may not exist yet — ignore
  }
}

// ── IntakeQueue writer ───────────────────────────────────────────────────────

async function writeIntakeRow(sheets, { kind, summary, payloadJson, sourceRef = "", existingRefs = null }) {
  // Deduplication: skip if sourceRef already exists in IntakeQueue
  if (sourceRef && existingRefs && existingRefs.has(sourceRef)) {
    return null; // Already ingested, skip
  }

  const id = generateId("int");
  // Column order must match SHEET_SCHEMAS.IntakeQueue:
  // intakeId, kind, summary, sourceRef, payloadJson, status, createdAt, updatedAt
  await sheets.appendRows("IntakeQueue", [[
    id,
    kind,
    summary.slice(0, 200),
    sourceRef,
    payloadJson,
    "pending",
    nowIso(),
    "",
  ]]);
  return id;
}

// ── Gmail ingestion ──────────────────────────────────────────────────────────

async function ingestGmail({ gmail, sheets, sinceMs, account = DEFAULT_ACCOUNT }) {
  const threads = await gmail.fetchRecentThreads({
    since: sinceMs,
    query: "in:inbox -category:promotions -category:social",
    maxResults: 50,
  });

  // Load existing IntakeQueue sourceRefs to avoid duplicates
  let existingRows = [];
  try {
    existingRows = await sheets.readSheetAsObjects("IntakeQueue");
  } catch {
    // Table may not exist on first run
  }
  const existingRefs = new Set(existingRows.map((r) => r.sourceRef).filter(Boolean));

  let count = 0;
  const emails = []; // Collect emails for filter scanning

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
      account,
      threadId: thread.threadId,
      subject: thread.subject,
      from: thread.messages[0].from,
      messageCount: thread.messageCount,
      latestDate: latestMsg.date,
      snippet: thread.snippet,
      bodyPreview: body.slice(0, 500),
      messageIds: thread.messages.map((m) => m.messageId),
    };

    // Tag non-personal accounts in the summary so triage can see at a glance
    // which inbox a thread came from. Tag the sourceRef too to keep intake
    // rows from different accounts from colliding on a shared threadId.
    const acctTag = account === DEFAULT_ACCOUNT ? "" : `[${account}] `;
    const sourceRef = account === DEFAULT_ACCOUNT ? thread.threadId : `${account}:${thread.threadId}`;

    const intakeId = await writeIntakeRow(sheets, {
      kind,
      summary: `${acctTag}Email: ${thread.subject} — from ${thread.messages[0].from}`,
      payloadJson: JSON.stringify(payload),
      sourceRef,
      existingRefs,
    });

    // Collect email data for filter scanning
    emails.push({
      messageId: thread.messages[0].messageId,
      threadId: thread.threadId,
      subject: thread.subject,
      from: thread.messages[0].from,
      date: latestMsg.date,
      snippet: thread.snippet,
      body: body,
    });

    count++;
    if (intakeId) count++;
  }

  // Scan emails for filter matches
  let flagged = 0;
  try {
    const { scanEmailsForFilters } = createEmailFilterTools({ sheets });
    const flaggedEmails = await scanEmailsForFilters(emails);
    flagged = flaggedEmails.length;
  } catch {
    // Email filtering failure should not block ingest
  }

  return { ingested: count, flagged, source: "gmail", account };
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

  // Load existing intake sourceRefs to avoid duplicate intake rows
  let existingIntakeRows = [];
  try {
    existingIntakeRows = await sheets.readSheetAsObjects("IntakeQueue");
  } catch { /* empty */ }
  const existingIntakeRefs = new Set(existingIntakeRows.map((r) => r.sourceRef).filter(Boolean));

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
          existingRefs: existingIntakeRefs,
        });
      }
    } else {
      // Update existing row if title/time changed
      const existing = existingMeetings.find((m) => m.eventId === norm.eventId);
      if (existing && (existing.title !== norm.title || existing.startTime !== norm.startTime)) {
        const found = await sheets.findRowByKey("Meetings", "eventId", norm.eventId);
        if (found) {
          await sheets.updateRow("Meetings", found.rowNum, {
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

  // Load existing intake sourceRefs to avoid duplicate intake rows
  let existingIntakeRows = [];
  try {
    existingIntakeRows = await sheets.readSheetAsObjects("IntakeQueue");
  } catch { /* empty */ }
  const existingIntakeRefs = new Set(existingIntakeRows.map((r) => r.sourceRef).filter(Boolean));

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
      const found = await sheets.findRowByKey("Meetings", "eventId", evt.eventId);
      if (found) {
        const existing = existingMeetings.find((m) => m.eventId === evt.eventId) || {};
        await sheets.updateRow("Meetings", found.rowNum, {
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
      const intakeId = await writeIntakeRow(sheets, {
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
        existingRefs: existingIntakeRefs,
      });
      if (intakeId) intakeRows++;
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

  // Load existing intake sourceRefs to avoid duplicates
  let existingRows = [];
  try {
    existingRows = await sheets.readSheetAsObjects("IntakeQueue");
  } catch {
    // Table may not exist on first run
  }
  const existingRefs = new Set(existingRows.map((r) => r.sourceRef).filter(Boolean));

  let count = 0;
  for (const file of files) {
    // Only surface docs/sheets/slides, not thumbnails/images/etc
    const interestingTypes = [
      "application/vnd.google-apps.document",
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.google-apps.presentation",
    ];
    if (!interestingTypes.includes(file.mimeType)) continue;

    const intakeId = await writeIntakeRow(sheets, {
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
      existingRefs,
    });
    if (intakeId) count++;
  }

  return { ingested: count, source: "drive" };
}

// ── Bluesky likes ingestion ──────────────────────────────────────────────────
// Fetches the authenticated user's most-recent liked posts from the Bluesky
// ATProto API and writes new ones to BlueskyLikes + IntakeQueue.
//
// Strategy: listRecords returns likes newest-first. We stop fetching pages the
// moment we see a likeUri that is already in our BlueskyLikes table — since
// all subsequent records are even older and therefore already imported.
// This keeps the cost of each incremental sync to just one or two API pages.

async function ingestBlueskyLikes({ bluesky, sheets }) {
  // Load existing likeUris so we can detect when we've caught up.
  let existingRows = [];
  try {
    existingRows = await sheets.readSheetAsObjects("BlueskyLikes");
  } catch {
    // Table may not exist on the first run — treat as empty.
  }
  const existingUris = new Set(existingRows.map((r) => r.likeUri).filter(Boolean));

  // Load existing intake sourceRefs to avoid duplicate intake rows
  let existingIntakeRows = [];
  try {
    existingIntakeRows = await sheets.readSheetAsObjects("IntakeQueue");
  } catch { /* empty */ }
  const existingIntakeRefs = new Set(existingIntakeRows.map((r) => r.sourceRef).filter(Boolean));

  const toInsert = []; // { row: [...], intake: {...} }
  let cursor;
  const MAX_PAGES = 5; // 5 × 100 = 500 likes max per ingest run

  outer: for (let page = 0; page < MAX_PAGES; page++) {
    let data;
    try {
      data = await bluesky.listLikes({ limit: 100, cursor });
    } catch (e) {
      // Surface partial results if we already have some new rows; otherwise error.
      if (toInsert.length === 0) {
        return { source: "bluesky-likes", error: e.message };
      }
      break;
    }

    const records = data.records || [];
    if (!records.length) break;

    // Collect fresh records. Stop at the first one we already know — all
    // subsequent records are older and therefore also already imported.
    const freshRecords = [];
    for (const rec of records) {
      if (existingUris.has(rec.uri)) break outer;
      freshRecords.push(rec);
    }

    // Resolve post content in batches of 25 (API limit).
    const postUriList = freshRecords
      .map((r) => r.value?.subject?.uri)
      .filter(Boolean);
    const postsByUri = new Map();
    for (let i = 0; i < postUriList.length; i += 25) {
      try {
        const { posts = [] } = await bluesky.getPosts(postUriList.slice(i, i + 25));
        for (const p of posts) postsByUri.set(p.uri, p);
      } catch {
        // Best-effort — continue without post content if resolution fails.
      }
    }

    for (const rec of freshRecords) {
      const postUri = rec.value?.subject?.uri || "";
      const post = postsByUri.get(postUri);
      const author = post?.author || {};
      const postRecord = post?.record || {};
      const text = String(postRecord.text || "").slice(0, 1000);
      const likedAt = rec.value?.createdAt || nowIso();

      const likeId = generateId("bsky");
      toInsert.push({
        row: [
          likeId,
          rec.uri,                          // likeUri
          postUri,                          // postUri
          rec.value?.subject?.cid || "",    // postCid
          author.did || "",                 // postAuthorDid
          author.handle || "",              // postAuthorHandle
          author.displayName || "",         // postAuthorName
          text,                             // postText
          postRecord.createdAt || "",       // postCreatedAt
          likedAt,                          // likedAt
          JSON.stringify({ likeRecord: rec, post: post || null }), // payloadJson
          nowIso(),                         // importedAt
        ],
        intake: {
          kind: "bluesky-like",
          summary: `Liked on Bluesky: @${author.handle || "unknown"} — ${text.slice(0, 120)}`,
          payloadJson: JSON.stringify({
            likeId,
            likeUri: rec.uri,
            postUri,
            author: {
              did: author.did || "",
              handle: author.handle || "",
              displayName: author.displayName || "",
            },
            text,
            likedAt,
          }),
          sourceRef: rec.uri,
        },
      });
    }

    cursor = data.cursor;
    if (!cursor) break;
  }

  if (toInsert.length > 0) {
    try {
      await sheets.appendRows("BlueskyLikes", toInsert.map((t) => t.row));
    } catch (e) {
      return {
        source: "bluesky-likes",
        error: `write failed: ${e.message}`,
        attempted: toInsert.length,
      };
    }
    for (const { intake } of toInsert) {
      try {
        await writeIntakeRow(sheets, {
          ...intake,
          existingRefs: existingIntakeRefs,
        });
      } catch {
        // Best-effort — intake failure should not block the main sync result.
      }
    }
  }

  return { source: "bluesky-likes", newLikes: toInsert.length };
}

// ── Main ingest entry point ───────────────────────────────────────────────────

export function createIngest({ ufetch, userFetches = null, gfetch, sheets, workCalSheets = null, env = null }) {
  // Personal account clients stay as the default for backwards-compatible
  // callers. Multi-account ingest builds per-account clients on the fly
  // below so each account gets its own token/auth context.
  const gmail = ufetch ? createGmail(ufetch) : null;
  const calendar = ufetch ? createCalendar(ufetch) : null;
  const bluesky = env ? createBluesky(env) : null;

  // Resolve the set of accounts to ingest Gmail from. If the caller passed a
  // userFetches map we use every entry in it; otherwise we fall back to the
  // single legacy ufetch keyed as "personal".
  function listAccounts() {
    if (userFetches && Object.keys(userFetches).length > 0) {
      return Object.entries(userFetches).map(([name, entry]) => ({
        name,
        gmail: createGmail(entry.ufetch),
        calendar: createCalendar(entry.ufetch),
      }));
    }
    if (gmail && calendar) {
      return [{ name: DEFAULT_ACCOUNT, gmail, calendar }];
    }
    return [];
  }

  async function runIngest() {
    const now = Date.now();
    const DEFAULT_LAST_RUN = "ingest_last_run_ms";

    const results = { startedAt: nowIso(), sources: [] };
    const accounts = listAccounts();

    // Gmail — one pass per configured account. Per-account last-run keys so
    // an outage on one account can't skip mail on another when it recovers.
    for (const acct of accounts) {
      const key = acct.name === DEFAULT_ACCOUNT
        ? DEFAULT_LAST_RUN
        : `ingest_last_run_ms_${acct.name}`;
      const lastRunStr = await readConfigValue(sheets, key);
      const sinceMs = lastRunStr ? Number(lastRunStr) : now - 2 * 3600000;
      try {
        const gmailResult = await ingestGmail({
          gmail: acct.gmail,
          sheets,
          sinceMs,
          account: acct.name,
        });
        results.sources.push(gmailResult);
      } catch (e) {
        results.sources.push({ source: "gmail", account: acct.name, error: e.message });
      }
      await writeConfigValue(sheets, key, String(now));
    }

    // Calendar — still personal-only. The Meetings sheet keys off eventId and
    // was not designed to multiplex across accounts; adding work calendar
    // ingest here would require scoping eventIds and a schema migration.
    // Direct tool calls with `account: "work"` on list_/create_/update_
    // calendar_event still work against the live work calendar.
    const personal = accounts.find((a) => a.name === DEFAULT_ACCOUNT);
    if (personal) {
      const lastRunStr = await readConfigValue(sheets, DEFAULT_LAST_RUN);
      const sinceMs = lastRunStr ? Number(lastRunStr) : now - 2 * 3600000;
      try {
        const calResult = await ingestCalendar({ calendar: personal.calendar, sheets, sinceMs });
        results.sources.push(calResult);
      } catch (e) {
        results.sources.push({ source: "calendar", error: e.message });
      }
    }

    // Work Calendar (Apps Script bridge, optional)
    try {
      const sinceMs = now - 2 * 3600000;
      const workCalResult = await ingestWorkCalendar({ sheets, workCalSheets, sinceMs });
      results.sources.push(workCalResult);
    } catch (e) {
      results.sources.push({ source: "work-calendar", error: e.message });
    }

    // Drive — service account, account-agnostic
    try {
      const lastRunStr = await readConfigValue(sheets, DEFAULT_LAST_RUN);
      const sinceMs = lastRunStr ? Number(lastRunStr) : now - 2 * 3600000;
      const driveResult = await ingestDrive({ gfetch, sheets, sinceMs });
      results.sources.push(driveResult);
    } catch (e) {
      results.sources.push({ source: "drive", error: e.message });
    }

    // Bluesky likes — optional, requires BLUESKY_HANDLE + BLUESKY_APP_PASSWORD.
    // Isolated so a Bluesky outage cannot mask results from the other sources.
    if (bluesky) {
      try {
        const bskyResult = await ingestBlueskyLikes({ bluesky, sheets });
        results.sources.push(bskyResult);
      } catch (e) {
        results.sources.push({ source: "bluesky-likes", error: e.message });
      }
    } else {
      results.sources.push({
        source: "bluesky-likes",
        skipped: "BLUESKY_HANDLE or BLUESKY_APP_PASSWORD not set",
      });
    }

    // Keep the legacy single-account last-run key fresh so older tooling
    // that still reads it (and the personal-only calendar/drive paths above)
    // advances in lockstep with the main ingest cycle.
    await writeConfigValue(sheets, DEFAULT_LAST_RUN, String(now));

    results.completedAt = nowIso();
    return results;
  }

  return { runIngest, gmail, calendar, bluesky };
}

// ── MCP tool wrappers ─────────────────────────────────────────────────────────

function formatContent(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

export function createIngestTools({ ufetch, userFetches = null, gfetch, sheets, spreadsheetId, workCalSheets = null, env = null }) {
  if (!spreadsheetId) return {};

  const { runIngest, bluesky } = createIngest({ ufetch, userFetches, gfetch, sheets, workCalSheets, env });

  // Resolve { gmail, calendar } clients for a named account. If userFetches
  // was not provided (legacy single-account callers) we fall back to the
  // personal ufetch for any account name, so existing behavior is preserved.
  function clientsFor(accountArg) {
    const account = accountArg || DEFAULT_ACCOUNT;
    if (userFetches) {
      const uf = getUserFetch(userFetches, account);
      return { gmail: createGmail(uf), calendar: createCalendar(uf), account };
    }
    if (!ufetch) {
      throw new Error("No Google OAuth credentials configured.");
    }
    return { gmail: createGmail(ufetch), calendar: createCalendar(ufetch), account: DEFAULT_ACCOUNT };
  }

  // Shared enum of account names for tool input schemas. Populated from the
  // userFetches map so planners see exactly which accounts are configured.
  const accountNames = userFetches ? Object.keys(userFetches) : [DEFAULT_ACCOUNT];
  const accountSchema = {
    type: "string",
    description:
      `Which Google OAuth account to use. Defaults to "${DEFAULT_ACCOUNT}". ` +
      `Configured: ${accountNames.join(", ") || "(none)"}.`,
    enum: accountNames.length > 0 ? accountNames : undefined,
  };

  return {
    run_ingest: {
      description:
        "Manually trigger the ingestion loop: pull new Gmail threads and Calendar events " +
        "since the last run and write them as IntakeQueue rows. " +
        "Normally runs automatically via cron every 10 minutes. " +
        "Gmail is ingested from every configured OAuth account; Calendar ingest " +
        "remains personal-only (use list_calendar_events with account:<name> for " +
        "ad-hoc reads from other accounts).",
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
      description: "List all Google Calendars accessible to the user for the given account.",
      inputSchema: {
        type: "object",
        properties: { account: accountSchema },
        additionalProperties: false,
      },
      run: async (args = {}) => {
        try {
          const { calendar } = clientsFor(args.account);
          const cals = await calendar.listCalendars();
          return formatContent({ calendars: cals.map((c) => ({ id: c.id, name: c.summary, primary: !!c.primary })) });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    list_calendar_events: {
      description: "List calendar events in a date range for the given account.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountSchema,
          calendarId: { type: "string", description: "Calendar ID. Default: primary." },
          from: { type: "string", description: "ISO start datetime." },
          to: { type: "string", description: "ISO end datetime." },
          maxResults: { type: "number", description: "Max events to return. Default: 20." },
        },
        additionalProperties: false,
      },
      run: async (args = {}) => {
        try {
          const { calendar } = clientsFor(args.account);
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
      description: "Create a new Google Calendar event on the given account.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountSchema,
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
          const { calendar } = clientsFor(args.account);
          const evt = await calendar.createSimpleEvent(args.calendarId || "primary", args);
          return formatContent({ ok: true, eventId: evt.id, htmlLink: evt.htmlLink });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    update_calendar_event: {
      description: "Update an existing Google Calendar event on the given account.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountSchema,
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
          const { calendar } = clientsFor(args.account);
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
        "Create a Gmail draft on the given account. Use for commitment nudges and " +
        "meeting follow-ups. Never auto-sends — draft is held for user review.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountSchema,
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
          const { gmail } = clientsFor(args.account);
          const draft = await gmail.createDraft(args);
          return formatContent({ ok: true, draftId: draft.id });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    // ── Bluesky tools ───────────────────────────────────────────────────────

    run_bluesky_sync: {
      description:
        "Manually trigger the Bluesky likes sync. Fetches recently liked posts from " +
        "the Bluesky API and writes any new ones to BlueskyLikes + IntakeQueue. " +
        "Normally runs automatically as part of the 10-minute ingest cron. " +
        "Requires BLUESKY_HANDLE and BLUESKY_APP_PASSWORD secrets.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        if (!bluesky) {
          return formatContent({
            error:
              "Bluesky not configured. Set the BLUESKY_HANDLE and " +
              "BLUESKY_APP_PASSWORD secrets via `wrangler secret put`.",
          });
        }
        try {
          const result = await ingestBlueskyLikes({ bluesky, sheets });
          return formatContent(result);
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    list_bluesky_likes: {
      description:
        "List recently liked Bluesky posts stored in BlueskyLikes. " +
        "Returns likes sorted newest-first, useful for content curation and inspiration. " +
        "Call run_bluesky_sync first if results seem stale.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max results to return. Default 20, max 100.",
          },
        },
        additionalProperties: false,
      },
      run: async (args = {}) => {
        try {
          const rows = await sheets.readSheetAsObjects("BlueskyLikes");
          const limit = Math.min(args.limit || 20, 100);
          const sorted = rows
            .filter((r) => r.likedAt)
            .sort((a, b) => (a.likedAt < b.likedAt ? 1 : -1))
            .slice(0, limit)
            .map((r) => ({
              likeId: r.likeId,
              postUri: r.postUri,
              author: r.postAuthorHandle ? `@${r.postAuthorHandle}` : r.postAuthorDid,
              displayName: r.postAuthorName,
              text: r.postText,
              postCreatedAt: r.postCreatedAt,
              likedAt: r.likedAt,
            }));
          return formatContent({ count: sorted.length, likes: sorted });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    // ── Intake queue management ────────────────────────────────────────

    purge_intake_before: {
      description:
        "Mark all pending intake items created before a specified date as 'archived' without screening. " +
        "Useful for bulk cleanup of stale queue items (e.g., archive everything before 30 days ago). " +
        "Does NOT apply screening — purely date-based archival. Returns count archived.",
      inputSchema: {
        type: "object",
        properties: {
          beforeDate: {
            type: "string",
            description: "ISO 8601 datetime (e.g., 2026-04-16T00:00:00Z or 2026-04-16). Archive all pending items created before this.",
          },
        },
        required: ["beforeDate"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        if (!args.beforeDate) {
          return formatContent({ error: "beforeDate is required (ISO 8601 format)" });
        }
        try {
          let dateStr = String(args.beforeDate).trim();

          // Handle date-only format (YYYY-MM-DD) by appending T00:00:00Z
          if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
            dateStr = dateStr + "T00:00:00Z";
          }

          // Ensure it ends with Z for UTC if it has time but no timezone
          if (dateStr.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/) && !dateStr.endsWith("Z")) {
            dateStr = dateStr + "Z";
          }

          const cutoffMs = new Date(dateStr).getTime();
          if (!Number.isFinite(cutoffMs)) {
            return formatContent({ error: `Invalid date format: "${args.beforeDate}". Expected ISO 8601 (e.g., 2026-04-16 or 2026-04-16T12:00:00Z).` });
          }

          const rows = await sheets.readSheetAsObjects("IntakeQueue");
          const toArchive = rows.filter((r) => {
            const createdMs = new Date(r.createdAt || 0).getTime();
            return Number.isFinite(createdMs) && createdMs < cutoffMs && String(r.status || "").toLowerCase() === "pending";
          });

          if (toArchive.length === 0) {
            return formatContent({ archived: 0, note: "No pending items found before cutoff date." });
          }

          let archivedCount = 0;
          for (const row of toArchive) {
            try {
              const found = await sheets.findRowByKey("IntakeQueue", "intakeId", row.intakeId);
              if (found) {
                await sheets.updateRow("IntakeQueue", found.rowNum, {
                  ...row,
                  status: "archived",
                  updatedAt: nowIso(),
                });
                archivedCount++;
              }
            } catch {
              // Best-effort: continue archiving others if one fails
            }
          }

          return formatContent({
            archived: archivedCount,
            beforeDate: args.beforeDate,
            note: `Archived ${archivedCount} pending intake items created before ${args.beforeDate}.`,
          });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    intake_queue_stats: {
      description:
        "Show statistics about the IntakeQueue: total items, pending count, items by kind, " +
        "oldest/newest items. Useful for monitoring queue size and health.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        try {
          const rows = await sheets.readSheetAsObjects("IntakeQueue");
          const total = rows.length;
          const pending = rows.filter((r) => String(r.status || "").toLowerCase() === "pending").length;

          const byKind = {};
          for (const row of rows) {
            const kind = String(row.kind || "unknown");
            byKind[kind] = (byKind[kind] || 0) + 1;
          }

          const createdDates = rows
            .map((r) => new Date(r.createdAt || 0).getTime())
            .filter(Number.isFinite);
          const oldest = createdDates.length > 0 ? new Date(Math.min(...createdDates)).toISOString() : null;
          const newest = createdDates.length > 0 ? new Date(Math.max(...createdDates)).toISOString() : null;

          return formatContent({
            total,
            pending,
            byKind,
            oldest,
            newest,
            note: pending > 0 && pending > 100 ? `⚠️  Queue is large (${pending} pending). Consider purging old items.` : undefined,
          });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },
  };
}
