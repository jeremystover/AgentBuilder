/**
 * zoom.js — Zoom Server-to-Server OAuth + recording poll + transcript tools.
 *
 * Factory: createZoomTools({ env, gfetch, sheets, spreadsheetId }) returns tools object.
 * Uses Zoom S2S OAuth (account credentials grant, 1h token, cached in memory).
 * Works in Cloudflare Workers (no Node.js dependencies).
 *
 * Required env secrets (set via `wrangler secret put`):
 *   ZOOM_ACCOUNT_ID    — Zoom account ID
 *   ZOOM_CLIENT_ID     — S2S OAuth app client ID
 *   ZOOM_CLIENT_SECRET — S2S OAuth app client secret
 *
 * Required env vars:
 *   PPP_MCP_DRIVE_FOLDER_ID — Google Drive folder for transcript storage
 */

import { withRetry } from "./auth.js";

// ── Module-level token cache (persists across requests in same isolate) ──────

const _zoomTokenCache = { token: null, expiresAt: 0 };

function formatContent(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// ── Zoom S2S OAuth ───────────────────────────────────────────────────────────

async function getZoomAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_zoomTokenCache.token && _zoomTokenCache.expiresAt > now + 60) {
    return _zoomTokenCache.token;
  }

  const accountId = env.ZOOM_ACCOUNT_ID || "";
  const clientId = env.ZOOM_CLIENT_ID || "";
  const clientSecret = env.ZOOM_CLIENT_SECRET || "";

  if (!accountId || !clientId || !clientSecret) {
    throw new Error("Zoom S2S credentials not configured (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET)");
  }

  const credentials = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Zoom OAuth error ${res.status}: ${body}`);
  }

  const data = await res.json();
  _zoomTokenCache.token = data.access_token;
  _zoomTokenCache.expiresAt = now + (data.expires_in || 3600);
  return _zoomTokenCache.token;
}

async function zoomFetch(env, url, options = {}) {
  const token = await getZoomAccessToken(env);
  const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Zoom API ${res.status}: ${body}`);
  }
  return res;
}

// ── Calendar matching ────────────────────────────────────────────────────────

function matchToCalendarEvent(recording, meetings) {
  // Try exact join_url match first
  const joinUrl = recording.join_url || "";
  if (joinUrl) {
    const match = meetings.find((m) => {
      const raw = m.rawJson || "{}";
      return raw.includes(joinUrl) || (m.location || "").includes(joinUrl);
    });
    if (match) return match;
  }

  // Fallback: ±15 min time window match
  const recStart = new Date(recording.start_time);
  const windowMs = 15 * 60 * 1000;

  const timeMatches = meetings.filter((m) => {
    if (!m.startTime) return false;
    const mStart = new Date(m.startTime);
    return Math.abs(mStart.getTime() - recStart.getTime()) <= windowMs;
  });

  return timeMatches.length === 1 ? timeMatches[0] : null;
}

// ── Core Zoom operations ─────────────────────────────────────────────────────

export function createZoomTools({ env, gfetch, sheets, spreadsheetId }) {
  const { readSheetAsObjects, appendRows, updateRow, findRowByKey } = sheets;

  // Poll Zoom for recent recordings and ingest transcripts
  async function runPollZoomRecordings(args = {}) {
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });

    const daysBack = args.daysBack || 1;
    const from = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);

    try {
      // Fetch recent recordings from Zoom
      const listRes = await zoomFetch(env, `https://api.zoom.us/v2/users/me/recordings?from=${from}&page_size=30`);
      const listData = await listRes.json();

      const recordings = (listData.meetings || []).filter((m) =>
        m.recording_files && m.recording_files.length > 0
      );

      if (recordings.length === 0) {
        return formatContent({ polled: true, recordingsFound: 0, message: "No new recordings found." });
      }

      // Load existing meetings for matching
      const meetings = await readSheetAsObjects("Meetings").catch(() => []);
      const results = [];

      for (const rec of recordings) {
        // Find VTT transcript file (or audio transcript)
        const vttFile = rec.recording_files.find((f) =>
          f.file_type === "TRANSCRIPT" || f.recording_type === "audio_transcript"
        );
        const audioFile = rec.recording_files.find((f) =>
          f.file_type === "MP4" || f.file_type === "M4A"
        );

        // Check if already ingested
        const existingByZoom = meetings.find((m) =>
          m.zoomMeetingId === String(rec.id) || m.zoomRecordingId === String(rec.uuid)
        );

        if (existingByZoom && existingByZoom.transcriptRef) {
          results.push({
            zoomMeetingId: rec.id,
            topic: rec.topic,
            status: "already_ingested",
            meetingId: existingByZoom.meetingId,
          });
          continue;
        }

        // Fetch transcript content if available
        let transcriptContent = null;
        let transcriptDriveId = null;

        if (vttFile && vttFile.download_url) {
          const dlRes = await zoomFetch(env, vttFile.download_url);
          transcriptContent = await dlRes.text();

          // Upload transcript to Google Drive
          const folderId = env.PPP_MCP_DRIVE_FOLDER_ID || "";
          if (folderId && transcriptContent) {
            const fileName = `zoom_${rec.id}_${rec.start_time.slice(0, 10)}.vtt`;
            const boundary = "zoom_transcript_boundary";
            const metadata = JSON.stringify({
              name: fileName,
              parents: [folderId],
              mimeType: "text/vtt",
            });

            const body = [
              `--${boundary}`,
              "Content-Type: application/json; charset=UTF-8",
              "",
              metadata,
              `--${boundary}`,
              "Content-Type: text/vtt",
              "",
              transcriptContent,
              `--${boundary}--`,
            ].join("\r\n");

            const uploadRes = await gfetch(
              "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
              {
                method: "POST",
                headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
                body,
              }
            );
            const uploadData = await uploadRes.json();
            transcriptDriveId = uploadData.id;
          }
        }

        // Match to calendar event
        const calendarMatch = matchToCalendarEvent(rec, meetings);
        const meetingId = calendarMatch
          ? calendarMatch.meetingId
          : generateId("mtg");

        // Upsert Meetings row
        const meetingRow = {
          meetingId,
          eventId: calendarMatch ? calendarMatch.eventId || "" : "",
          title: rec.topic || "Zoom Recording",
          startTime: rec.start_time || "",
          endTime: rec.end_time || "",
          description: "",
          location: rec.join_url || "",
          organizer: rec.host_email || "",
          attendeesJson: JSON.stringify(rec.participants_count ? [{ count: rec.participants_count }] : []),
          source: "zoom",
          sourceHost: "zoom.us",
          meetingKey: `zoom|${rec.id}`,
          rawJson: JSON.stringify({ zoom_id: rec.id, uuid: rec.uuid, duration: rec.duration }),
          transcriptRef: transcriptDriveId || "",
          zoomMeetingId: String(rec.id),
          zoomRecordingId: String(rec.uuid || ""),
          actionItemsExtracted: "",
          updatedAt: nowIso(),
        };

        if (calendarMatch) {
          // Update existing row
          const found = await findRowByKey("Meetings", "meetingId", meetingId);
          if (found) {
            await updateRow("Meetings", found.rowNum, meetingRow);
          }
        } else {
          // Append new row
          await appendRows("Meetings", [[
            meetingRow.meetingId,
            meetingRow.eventId,
            meetingRow.title,
            meetingRow.startTime,
            meetingRow.endTime,
            meetingRow.description,
            meetingRow.location,
            meetingRow.organizer,
            meetingRow.attendeesJson,
            meetingRow.source,
            meetingRow.sourceHost,
            meetingRow.meetingKey,
            meetingRow.rawJson,
            meetingRow.transcriptRef,
            meetingRow.zoomMeetingId,
            meetingRow.zoomRecordingId,
            meetingRow.actionItemsExtracted,
            meetingRow.updatedAt,
          ]]);
        }

        results.push({
          zoomMeetingId: rec.id,
          topic: rec.topic,
          status: transcriptDriveId ? "ingested_with_transcript" : "ingested_no_transcript",
          meetingId,
          transcriptDriveId,
          calendarMatched: !!calendarMatch,
        });
      }

      return formatContent({
        polled: true,
        recordingsFound: recordings.length,
        results,
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  // Get transcript content for a meeting
  async function runGetMeetingTranscript(args = {}) {
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });
    if (!args.meetingId) return formatContent({ error: "meetingId is required" });

    try {
      const meetings = await readSheetAsObjects("Meetings").catch(() => []);
      const meeting = meetings.find((m) => m.meetingId === args.meetingId);

      if (!meeting) return formatContent({ error: `Meeting ${args.meetingId} not found` });
      if (!meeting.transcriptRef) {
        return formatContent({ error: `No transcript available for ${args.meetingId}`, meeting: { meetingId: meeting.meetingId, title: meeting.title } });
      }

      // Fetch from Drive
      const res = await gfetch(
        `https://www.googleapis.com/drive/v3/files/${meeting.transcriptRef}?alt=media`
      );
      const text = await res.text();

      return formatContent({
        meetingId: meeting.meetingId,
        title: meeting.title,
        startTime: meeting.startTime,
        endTime: meeting.endTime,
        attendees: meeting.attendeesJson,
        transcriptFormat: "vtt",
        transcript: text,
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  // Propose action items extracted from a meeting transcript
  async function runProposeExtractActionItems(args = {}) {
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });
    if (!args.meetingId) return formatContent({ error: "meetingId is required" });

    try {
      const meetings = await readSheetAsObjects("Meetings").catch(() => []);
      const meeting = meetings.find((m) => m.meetingId === args.meetingId);

      if (!meeting) return formatContent({ error: `Meeting ${args.meetingId} not found` });

      // If no transcript, return what we know
      if (!meeting.transcriptRef) {
        return formatContent({
          meetingId: args.meetingId,
          title: meeting.title,
          hasTranscript: false,
          note: "No transcript available. Add one via poll_zoom_recordings or manual upload.",
        });
      }

      // Fetch transcript
      const res = await gfetch(
        `https://www.googleapis.com/drive/v3/files/${meeting.transcriptRef}?alt=media`
      );
      const transcriptText = await res.text();

      // Load commitments and tasks for context
      const [commitments, tasks] = await Promise.all([
        readSheetAsObjects("Commitments").catch(() => []),
        readSheetAsObjects("Tasks").catch(() => []),
      ]);

      // Parse attendees
      let attendees = [];
      try { attendees = JSON.parse(meeting.attendeesJson || "[]"); } catch { /* ignore */ }

      return formatContent({
        meetingId: args.meetingId,
        title: meeting.title,
        startTime: meeting.startTime,
        attendees,
        transcript: transcriptText,
        existingCommitmentsCount: commitments.length,
        existingTasksCount: tasks.length,
        instructions: [
          "Review the transcript above for action items, commitments, and decisions.",
          "Use propose_create_task for new tasks (cite transcript timestamps as sourceRef).",
          "Use propose_create_commitment for promises made by anyone.",
          "Use log_decision for decisions made during the meeting.",
          "After extraction, the caller should update actionItemsExtracted='yes' on this meeting.",
        ],
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  return {
    poll_zoom_recordings: {
      description:
        "Poll Zoom for recent cloud recordings, fetch VTT transcripts, upload to Drive, " +
        "and upsert Meetings rows. Matches recordings to calendar events by join_url or " +
        "±15 min time window. Idempotent — skips already-ingested recordings.",
      inputSchema: {
        type: "object",
        properties: {
          daysBack: {
            type: "number",
            description: "Number of days to look back for recordings. Default: 1.",
          },
        },
        additionalProperties: false,
      },
      run: runPollZoomRecordings,
    },

    get_meeting_transcript: {
      description:
        "Retrieve the full transcript text for a meeting by meetingId. " +
        "Returns the VTT content stored in Google Drive.",
      inputSchema: {
        type: "object",
        properties: {
          meetingId: { type: "string", description: "The meetingId from the Meetings sheet." },
        },
        required: ["meetingId"],
        additionalProperties: false,
      },
      run: runGetMeetingTranscript,
    },

    propose_extract_action_items: {
      description:
        "Load a meeting transcript plus current tasks/commitments context, and return " +
        "the transcript with instructions for the caller (Claude) to extract action items, " +
        "commitments, and decisions. The caller should then use propose_create_task, " +
        "propose_create_commitment, and log_decision to record findings.",
      inputSchema: {
        type: "object",
        properties: {
          meetingId: { type: "string", description: "The meetingId to extract action items from." },
        },
        required: ["meetingId"],
        additionalProperties: false,
      },
      run: runProposeExtractActionItems,
    },
  };
}
