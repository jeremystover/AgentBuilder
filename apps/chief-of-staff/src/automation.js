/**
 * automation.js — Phase 4 automated drafts.
 *
 * Morning brief: assembles today's calendar + overdue tasks + my overdue commitments
 *   + pending intake + decisions-to-revisit, then creates a Gmail draft titled
 *   "Daily brief YYYY-MM-DD". Never auto-sends — lands in Drafts for user review.
 *
 * Commitment nudges: for each overdue "other" commitment, creates a Gmail draft
 *   follow-up email addressed to the commitment owner. Never auto-sends.
 *
 * MCP tools exposed:
 *   trigger_morning_brief        — manually run the morning brief
 *   trigger_commitment_nudges    — manually run commitment nudge drafts
 *   propose_draft_reply          — create a Gmail draft reply for an intake item
 *   log_agent_run                — write a session record to AgentRuns sheet
 *
 * Factory: createAutomationTools({ ufetch, sheets, spreadsheetId, calendar })
 *
 * Works in Cloudflare Workers (no Node.js dependencies).
 */

import { createGmail } from "./gmail.js";
import { createCalendar } from "./calendar.js";

function nowIso() { return new Date().toISOString(); }
function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function isOpen(status) {
  const s = String(status || "").toLowerCase();
  return !s || s === "open" || s === "in_progress" || s === "pending" || s === "todo" || s === "waiting";
}

function formatDate(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function formatTime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function daysOverdue(dueDateIso) {
  return Math.round((Date.now() - new Date(dueDateIso).getTime()) / 86400000);
}

// Render a short " on <whom>" / " on blocker" suffix for a waiting task so
// the brief reads naturally (e.g. "Follow up with finance (waiting on Sara)").
// Returns "" when there's no specific subject to surface.
export function formatWaitContext(t) {
  const reason = String(t.waitReason || "").toLowerCase();
  if (reason === "person" || reason === "assigned") {
    const who = t.waitOnName || t.waitOnStakeholderId;
    return who ? ` on ${who}` : "";
  }
  if (reason === "dependency" && t.blockedByTaskKey) return ` on ${t.blockedByTaskKey}`;
  if (reason === "external-event") return " on external event";
  if (reason === "time-block") return " for a time block";
  if (reason === "date" && t.expectedBy) return ` until ${formatDate(t.expectedBy)}`;
  return "";
}

// Filter the Tasks list to those whose waiting-resurface trigger has fired
// by `now`: expectedBy passed, snooze elapsed (nextCheckAt), or a fresh
// inbound signal (lastSignalAt newer than the row's last update). Exported
// so the same filter the morning brief uses can be reused by other surfaces
// (web UI tab, tests) without duplicating the trigger semantics.
export function filterWaitingReady(tasks, now = new Date()) {
  const cutoff = now;
  return (tasks || []).filter((t) => {
    if (String(t.status || "").toLowerCase() !== "waiting") return false;
    const exp = t.expectedBy && new Date(t.expectedBy) <= cutoff;
    const chk = t.nextCheckAt && new Date(t.nextCheckAt) <= cutoff;
    const sig = t.lastSignalAt
      && (!t.updatedAt || new Date(t.lastSignalAt) >= new Date(t.updatedAt));
    return exp || chk || sig;
  });
}

// Explain *why* a waiting task is being resurfaced today. Picks the most
// specific trigger that fired so the user can act fast without opening the
// task: a fresh inbound signal beats a passed expected-by date.
export function waitingTrigger(t, now) {
  if (t.lastSignalAt && (!t.updatedAt || new Date(t.lastSignalAt) >= new Date(t.updatedAt))) {
    const days = Math.round((now.getTime() - new Date(t.lastSignalAt).getTime()) / 86400000);
    if (days <= 0) return "new signal today";
    return `new signal ${days} day${days !== 1 ? "s" : ""} ago`;
  }
  if (t.expectedBy && new Date(t.expectedBy) <= now) {
    const overdue = Math.round((now.getTime() - new Date(t.expectedBy).getTime()) / 86400000);
    if (overdue <= 0) return `expected by ${formatDate(t.expectedBy)}`;
    return `expected ${overdue} day${overdue !== 1 ? "s" : ""} ago`;
  }
  if (t.nextCheckAt && new Date(t.nextCheckAt) <= now) return "snooze elapsed";
  return "ready to revisit";
}

// ── Morning brief ─────────────────────────────────────────────────────────────

export async function generateMorningBrief({ sheets, ufetch, spreadsheetId }) {
  const gmail = createGmail(ufetch);
  const calendar = createCalendar(ufetch);

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  // Parallel data fetch
  const [tasks, commitments, intake, decisions, calEvents] = await Promise.all([
    sheets.readSheetAsObjects("Tasks").catch(() => []),
    sheets.readSheetAsObjects("Commitments").catch(() => []),
    sheets.readSheetAsObjects("IntakeQueue").catch(() => []),
    sheets.readSheetAsObjects("Decisions").catch(() => []),
    calendar.fetchEventsInRange("primary", { from: startOfDay, to: endOfDay }).catch(() => []),
  ]);

  // Today's calendar
  const todayEvents = calEvents
    .filter((e) => e.startTime)
    .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));

  // Tasks due today or overdue (open only)
  const urgentTasks = tasks
    .filter((t) => isOpen(t.status) && t.dueAt && new Date(t.dueAt) <= new Date(endOfDay))
    .sort((a, b) => {
      const priOrder = { high: 0, med: 1, low: 2, "": 3 };
      const pa = priOrder[String(a.priority || "").toLowerCase()] ?? 3;
      const pb = priOrder[String(b.priority || "").toLowerCase()] ?? 3;
      if (pa !== pb) return pa - pb;
      return String(a.dueAt).localeCompare(String(b.dueAt));
    })
    .slice(0, 15);

  // Waiting tasks whose resurface trigger has fired by end-of-day. Keeps
  // waiting tasks visible in the user's main flow without spamming them
  // every day. Trigger semantics live in filterWaitingReady so the web UI
  // and tests can reuse them without duplicating logic.
  const waitingReady = filterWaitingReady(tasks, new Date(endOfDay))
    .sort((a, b) => {
      const ax = a.expectedBy || a.nextCheckAt || "";
      const bx = b.expectedBy || b.nextCheckAt || "";
      return String(ax).localeCompare(String(bx));
    })
    .slice(0, 15);

  // My overdue commitments
  const myOverdueCommitments = commitments.filter(
    (c) => String(c.ownerType) === "me" && isOpen(c.status) && c.dueAt && new Date(c.dueAt) < now
  );

  // Pending intake (newest first, capped at 10)
  const pendingIntake = intake
    .filter((i) => String(i.status || "").toLowerCase() === "pending")
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 10);

  // Decisions to revisit today
  const decisionsToRevisit = decisions.filter(
    (d) => String(d.status) === "open" && d.revisitDate && new Date(d.revisitDate) <= now
  );

  // ── Compose brief ──────────────────────────────────────────────────────────

  const dayLabel = now.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const lines = [`Daily brief — ${dayLabel}`, ""];

  // Calendar section
  if (todayEvents.length > 0) {
    lines.push(`## Today's calendar (${todayEvents.length} event${todayEvents.length !== 1 ? "s" : ""})`);
    for (const e of todayEvents) {
      const start = formatTime(e.startTime);
      const end = formatTime(e.endTime);
      const attendees = (e.attendees || []).filter((a) => !a.self).map((a) => a.name || a.email);
      const with_ = attendees.length > 0 ? ` with ${attendees.slice(0, 3).join(", ")}` : "";
      lines.push(`• ${start}–${end}  ${e.title}${with_}`);
    }
    lines.push("");
  } else {
    lines.push("## Today's calendar");
    lines.push("• No events today.");
    lines.push("");
  }

  // Tasks section
  if (urgentTasks.length > 0) {
    lines.push(`## Tasks due today or overdue (${urgentTasks.length})`);
    for (const t of urgentTasks) {
      const pri = t.priority ? `[${String(t.priority).toUpperCase()}] ` : "";
      const isToday = t.dueAt.slice(0, 10) === todayStr;
      const overdue = daysOverdue(t.dueAt);
      const dueLabel = isToday ? "due today" : `${overdue} day${overdue !== 1 ? "s" : ""} overdue`;
      const waitTag = String(t.status || "").toLowerCase() === "waiting"
        ? ` (waiting${formatWaitContext(t)})`
        : "";
      lines.push(`• ${pri}${t.title || t.subject} — ${dueLabel}${waitTag}  [${t.taskKey}]`);
    }
    lines.push("");
  }

  // Waiting — ready to revisit section. Listed separately from urgentTasks
  // so the user immediately sees which waits the system thinks are ripe,
  // and why ("Sara replied", "expected by Mar 12 — overdue", etc).
  if (waitingReady.length > 0) {
    lines.push(`## Waiting — ready to revisit (${waitingReady.length})`);
    for (const t of waitingReady) {
      const why = waitingTrigger(t, now);
      lines.push(`• ${t.title || t.subject}${formatWaitContext(t)} — ${why}  [${t.taskKey}]`);
    }
    lines.push("");
  }

  // My commitments section
  if (myOverdueCommitments.length > 0) {
    lines.push(`## My overdue commitments (${myOverdueCommitments.length})`);
    for (const c of myOverdueCommitments) {
      const overdue = daysOverdue(c.dueAt);
      const toWhom = c.ownerId ? ` — owed to ${c.ownerId}` : "";
      lines.push(`• ${c.description}${toWhom} (${overdue} day${overdue !== 1 ? "s" : ""} overdue)`);
    }
    lines.push("");
  }

  // Intake section
  if (pendingIntake.length > 0) {
    lines.push(`## Pending intake (${pendingIntake.length} new item${pendingIntake.length !== 1 ? "s" : ""})`);
    for (const i of pendingIntake) {
      lines.push(`• ${i.summary || `${i.kind}: ${i.intakeId}`}`);
    }
    lines.push("");
  }

  // Decisions to revisit
  if (decisionsToRevisit.length > 0) {
    lines.push(`## Decisions to revisit (${decisionsToRevisit.length})`);
    for (const d of decisionsToRevisit) {
      lines.push(`• ${d.title} (decided ${formatDate(d.decisionDate)}, revisit due ${formatDate(d.revisitDate)})`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`Generated by Chief-of-Staff · ${now.toUTCString()}`);

  const body = lines.join("\n");
  const subject = `Daily brief ${todayStr}`;

  // Create draft
  const profile = await gmail.getProfile().catch(() => ({}));
  const myEmail = profile.emailAddress || "";

  const draft = await gmail.createDraft({ to: myEmail, subject, body });

  return {
    ok: true,
    draftId: draft.id,
    subject,
    stats: {
      calendarEvents: todayEvents.length,
      urgentTasks: urgentTasks.length,
      myOverdueCommitments: myOverdueCommitments.length,
      pendingIntake: pendingIntake.length,
      decisionsToRevisit: decisionsToRevisit.length,
    },
  };
}

// ── Commitment nudges ─────────────────────────────────────────────────────────

export async function generateCommitmentNudges({ sheets, ufetch, spreadsheetId }) {
  const gmail = createGmail(ufetch);

  const commitments = await sheets.readSheetAsObjects("Commitments").catch(() => []);

  const overdue = commitments.filter(
    (c) => String(c.ownerType) === "other" && isOpen(c.status) && c.dueAt && new Date(c.dueAt) < new Date()
  );

  if (overdue.length === 0) {
    return { ok: true, draftsCreated: 0, note: "No overdue other-commitments. Nothing to nudge." };
  }

  // Load stakeholders for email lookup
  const stakeholders = await sheets.readSheetAsObjects("Stakeholders").catch(() => []);
  const stakeholdersByName = new Map(stakeholders.map((s) => [String(s.name || "").toLowerCase(), s]));
  const stakeholdersByEmail = new Map(stakeholders.map((s) => [String(s.email || "").toLowerCase(), s]));

  const created = [];
  const skipped = [];

  for (const c of overdue) {
    // Resolve email address for the owner
    const ownerRaw = String(c.ownerId || "");
    let toEmail = "";
    let toName = ownerRaw;

    if (ownerRaw.includes("@")) {
      toEmail = ownerRaw;
      const sh = stakeholdersByEmail.get(ownerRaw.toLowerCase());
      if (sh?.name) toName = sh.name;
    } else {
      const sh = stakeholdersByName.get(ownerRaw.toLowerCase());
      if (sh?.email) {
        toEmail = sh.email;
        toName = sh.name || ownerRaw;
      }
    }

    if (!toEmail) {
      skipped.push({ commitmentId: c.commitmentId, reason: `No email found for owner: ${ownerRaw}` });
      continue;
    }

    const overdueDays = daysOverdue(c.dueAt);
    const dueDateLabel = formatDate(c.dueAt);
    const firstName = toName.split(/\s+/)[0] || toName;

    const subject = `Following up: ${c.description.slice(0, 60)}`;
    const body = [
      `Hi ${firstName},`,
      "",
      `I wanted to follow up on: "${c.description}"`,
      "",
      `This was due ${dueDateLabel} (${overdueDays} day${overdueDays !== 1 ? "s" : ""} ago).`,
      "",
      "Could you share a quick update on where things stand?",
      "",
      "Thanks,",
    ].join("\n");

    try {
      const draft = await gmail.createDraft({ to: toEmail, subject, body });
      created.push({
        commitmentId: c.commitmentId,
        draftId: draft.id,
        to: toEmail,
        subject,
        overdueDays,
      });
    } catch (e) {
      skipped.push({ commitmentId: c.commitmentId, reason: e.message });
    }
  }

  return {
    ok: true,
    draftsCreated: created.length,
    skipped: skipped.length,
    created,
    skipped: skipped.length > 0 ? skipped : undefined,
    note: `${created.length} nudge draft${created.length !== 1 ? "s" : ""} created in Gmail Drafts. Review before sending.`,
  };
}

// ── MCP tool factory ─────────────────────────────────────────────────────────

function formatContent(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

export function createAutomationTools({ ufetch, sheets, spreadsheetId }) {
  return {

    // ── trigger_morning_brief ───────────────────────────────────────────────
    trigger_morning_brief: {
      description:
        "Generate and save the morning daily brief as a Gmail draft. " +
        "Includes today's calendar, overdue tasks, my overdue commitments, " +
        "pending intake items, and decisions to revisit. " +
        "The draft is addressed to yourself and held in Gmail Drafts — never auto-sent. " +
        "Normally runs automatically at 7am via cron.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        try {
          const result = await generateMorningBrief({ sheets, ufetch, spreadsheetId });
          return formatContent(result);
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    // ── trigger_commitment_nudges ───────────────────────────────────────────
    trigger_commitment_nudges: {
      description:
        "For each overdue commitment where someone else owes you something, create a " +
        "Gmail draft follow-up email. Drafts are never auto-sent — review before sending. " +
        "Normally runs automatically on Mondays at 9am via cron.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        try {
          const result = await generateCommitmentNudges({ sheets, ufetch, spreadsheetId });
          return formatContent(result);
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    // ── propose_draft_reply ─────────────────────────────────────────────────
    propose_draft_reply: {
      description:
        "Create a Gmail draft reply for an intake item flagged as an ask/request. " +
        "Looks up the intake row to get the sender and thread, then stages a draft. " +
        "Draft is never sent automatically — user must review and send from Gmail.",
      inputSchema: {
        type: "object",
        properties: {
          intakeId: {
            type: "string",
            description: "IntakeQueue row ID to reply to.",
          },
          body: {
            type: "string",
            description: "Plain-text reply body.",
          },
          subject: {
            type: "string",
            description: "Optional subject override. Defaults to Re: <original subject>.",
          },
        },
        required: ["intakeId", "body"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });
        if (!args.intakeId || !args.body) {
          return formatContent({ error: "intakeId and body are required" });
        }

        try {
          const rows = await sheets.readSheetAsObjects("IntakeQueue").catch(() => []);
          const row = rows.find((r) => r.intakeId === args.intakeId);
          if (!row) return formatContent({ error: `Intake item not found: ${args.intakeId}` });

          let payload = {};
          try { payload = JSON.parse(row.payloadJson || "{}"); } catch { /* ignore */ }

          const threadId = payload.threadId || "";
          const from = payload.from || "";
          const originalSubject = payload.subject || row.summary || "";

          if (!from) return formatContent({ error: "No sender email found in intake payload. Cannot create draft." });

          const subject = args.subject || (originalSubject ? `Re: ${originalSubject}` : "Re: your message");
          const gmail = createGmail(ufetch);
          const draft = await gmail.createDraft({
            to: from,
            subject,
            body: args.body,
            threadId: threadId || undefined,
          });

          return formatContent({
            ok: true,
            draftId: draft.id,
            to: from,
            subject,
            intakeId: args.intakeId,
            note: "Draft created in Gmail Drafts. Open Gmail to review and send.",
          });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    // ── log_agent_run ───────────────────────────────────────────────────────
    log_agent_run: {
      description:
        "Log a session record to the AgentRuns sheet for audit and debugging. " +
        "Call at the end of a significant planning session with a summary of what was done.",
      inputSchema: {
        type: "object",
        properties: {
          sessionType: {
            type: "string",
            description: "E.g. plan-now, eod-dump, inbox-triage, morning-brief, weekly-review.",
          },
          summary: {
            type: "string",
            description: "Short description of what was accomplished in this session.",
          },
          toolsCalled: {
            type: "array",
            items: { type: "string" },
            description: "List of MCP tool names called during the session.",
          },
          changesetsApplied: {
            type: "array",
            items: { type: "string" },
            description: "Changeset IDs that were committed.",
          },
          startedAt: {
            type: "string",
            description: "ISO datetime when the session started (optional).",
          },
        },
        required: ["sessionType", "summary"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });

        try {
          const id = generateId("run");
          const now = nowIso();
          await sheets.appendRows("AgentRuns", [[
            id,
            args.sessionType || "",
            args.summary || "",
            JSON.stringify(args.toolsCalled || []),
            JSON.stringify(args.changesetsApplied || []),
            args.startedAt || now,
            now,
            "claude",
          ]]);
          return formatContent({ ok: true, runId: id, completedAt: now });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },
  };
}
