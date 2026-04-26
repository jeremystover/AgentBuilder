/**
 * web/chat.js — chief-of-staff chat sidebar + Day/Week Plan + Day/Week
 * Review endpoints. Tool-loop runtime lives in @agentbuilder/web-ui-kit;
 * this file just supplies the chief-of-staff system prompts and the
 * curated tool allowlist.
 */

import { chatHandler, runChat } from "@agentbuilder/web-ui-kit";

const SYSTEM_PROMPT_BASE = `You are the Chief of Staff — a calm, decisive assistant who keeps the user organized and focused.

Operating rules:
- ALWAYS call hydrate_planning_context first before any planning, prioritization, or review work.
- For mutations, call the matching propose_* tool, then call commit_changeset with the returned changesetId. Do not skip the commit step — the user's view will not refresh until you commit.
- Cite sources when creating tasks: every propose_create_task needs at least one source entry.
- Keep replies short. Bullets > paragraphs. Surface what changed (created tasks, completed tasks, scheduled events) in 1-3 lines, not a wall of text.
- If a request is ambiguous (e.g. "schedule the call"), ask one specific clarifying question instead of guessing.
- Today is ${new Date().toISOString().slice(0, 10)}.`;

const DAY_PLAN_SYSTEM = `${SYSTEM_PROMPT_BASE}

You are running the user's DAY PLAN. The user has just typed or dictated free-form notes about their day. Your job:
1. Hydrate planning context.
2. Read the user's notes carefully.
3. Mark any tasks they say are done (propose_complete_task → commit).
4. Add any new tasks they mention (propose_create_task → commit) with priority + dueAt set.
5. Adjust priorities on existing tasks where the notes imply urgency (propose_update_task → commit).
6. Output a 4-8 line plan for the day: top priorities, what to skip, key meetings.
Return ONLY the plan text after all tool calls are done. No preamble.`;

const DAY_REVIEW_SYSTEM = `${SYSTEM_PROMPT_BASE}

You are running the user's DAY REVIEW (end-of-day). The user has just dictated or typed what happened. Your job:
1. Hydrate planning context.
2. Mark completed tasks done.
3. Capture any new tasks or commitments mentioned.
4. Tee up tomorrow: re-prioritize tasks for tomorrow, surface anything overdue.
5. Output a short reflection: what went well, what slipped, top 3 priorities for tomorrow.
Return ONLY the review text after tools are done.`;

const WEEK_PLAN_SYSTEM = `${SYSTEM_PROMPT_BASE}

You are running the user's WEEK PLAN. Hydrate, then:
1. Read the user's notes about the upcoming week.
2. Add/update tasks with dueAt this week.
3. Output the week's themes (3-5 bullets), top tasks, and key meetings.
Return ONLY the plan text.`;

const WEEK_REVIEW_SYSTEM = `${SYSTEM_PROMPT_BASE}

You are running the user's WEEK REVIEW. Hydrate, then:
1. Mark completed tasks/commitments.
2. Capture any new ones mentioned.
3. Highlight stakeholders who need a touch and projects at risk.
4. Output a short retrospective + the next week's top 3-5 priorities.
Return ONLY the review text.`;

// Curated tool surface for the chat sidebar — keep under ~20 for reliable
// tool-selection (AGENTS.md rule 2).
const CHAT_TOOL_ALLOWLIST = [
  "hydrate_planning_context",
  "get_prioritized_todo",
  "get_intake",
  "search_vault",
  "show_source",
  "list_goals",
  "list_projects",
  "get_project_360",
  "get_stakeholder_360",
  "list_stakeholders_needing_touch",
  "list_calendar_events",
  "list_work_calendar_events",
  "create_calendar_event",
  "propose_create_task",
  "propose_update_task",
  "propose_complete_task",
  "propose_resolve_intake",
  "propose_bulk_resolve_intake",
  "propose_create_project",
  "propose_update_project",
  "commit_changeset",
];

export function handleChatRequest(request, ctx) {
  return chatHandler(request, ctx, {
    toolAllowlist: CHAT_TOOL_ALLOWLIST,
    system: SYSTEM_PROMPT_BASE,
    tier: "default",
    maxIterations: 10,
  });
}

export async function handlePlanReviewRequest(request, ctx, kind) {
  const { env } = ctx;
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const input = String(body?.input || "").trim();
  const periodKey = String(body?.periodKey || "").trim();
  if (!periodKey) {
    return new Response(JSON.stringify({ error: "periodKey is required" }), {
      status: 400, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const userMessage = [
    `--- ${kind.replace(/-/g, " ").toUpperCase()} (${periodKey}) ---`,
    body?.brief?.goalsMd ? `\nCurrent goals brief:\n${body.brief.goalsMd}` : "",
    `\nUser notes:\n${input || "(no notes — just plan / review the period from current state)"}`,
  ].join("\n");

  try {
    const result = await runChat({
      ctx,
      body: { message: userMessage, history: [] },
      toolAllowlist: CHAT_TOOL_ALLOWLIST,
      system: pickSystem(kind),
      tier: "default",
      maxIterations: 12,
    });

    const briefKind = kind.startsWith("day") ? "day" : "week";
    const reviewMode = kind.endsWith("review");
    await env.DB.prepare(
      `INSERT INTO Briefs (briefId, kind, periodKey, goalsMd, generatedMd, reviewMd, updatedAt)
         VALUES (?, ?, ?, '', ?, ?, ?)
         ON CONFLICT(kind, periodKey) DO UPDATE SET
           generatedMd = CASE WHEN ? = 0 THEN excluded.generatedMd ELSE Briefs.generatedMd END,
           reviewMd    = CASE WHEN ? = 1 THEN excluded.reviewMd    ELSE Briefs.reviewMd END,
           updatedAt   = excluded.updatedAt`
    ).bind(
      `brief_${briefKind}_${periodKey}_${Date.now().toString(36)}`,
      briefKind,
      periodKey,
      reviewMode ? "" : result.reply,
      reviewMode ? result.reply : "",
      new Date().toISOString(),
      reviewMode ? 1 : 0,
      reviewMode ? 1 : 0,
    ).run();

    return new Response(JSON.stringify({
      output: result.reply,
      periodKey, kind,
      iterations: result.iterations,
      usage: result.usage,
    }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  } catch (err) {
    const msg = String(err?.message || err);
    const status = msg.includes("ANTHROPIC_API_KEY") ? 503 : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}

function pickSystem(kind) {
  switch (kind) {
    case "day-plan":     return DAY_PLAN_SYSTEM;
    case "day-review":   return DAY_REVIEW_SYSTEM;
    case "week-plan":    return WEEK_PLAN_SYSTEM;
    case "week-review":  return WEEK_REVIEW_SYSTEM;
    default:             return SYSTEM_PROMPT_BASE;
  }
}

const PERSON_BRIEF_SYSTEM = `${SYSTEM_PROMPT_BASE}

You are drafting a CONCISE PERSON BRIEF for the given stakeholder.
1. Call get_stakeholder_360 with the personId to load context.
2. Output a brief that covers:
   - Who they are (role / tier).
   - Relationship health, when last touched.
   - Open commitments (mine to them and theirs to me).
   - Active projects they're on.
   - 1-2 things to talk about next time.
Return ONLY the brief — 6-10 lines, no preamble. Markdown is fine.`;

export async function handlePersonBriefRequest(request, ctx, personId) {
  const { env } = ctx;
  if (!personId) {
    return new Response(JSON.stringify({ error: "personId is required" }), {
      status: 400, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  try {
    const result = await runChat({
      ctx,
      body: { message: `Draft a person brief for personId=${personId}.`, history: [] },
      toolAllowlist: CHAT_TOOL_ALLOWLIST,
      system: PERSON_BRIEF_SYSTEM,
      tier: "default",
      maxIterations: 6,
    });
    // Store it on the Briefs table under kind='person', periodKey=personId
    // so the next page load picks it up if the user doesn't edit.
    await env.DB.prepare(
      `INSERT INTO Briefs (briefId, kind, periodKey, goalsMd, generatedMd, reviewMd, updatedAt)
         VALUES (?, 'person', ?, ?, ?, '', ?)
         ON CONFLICT(kind, periodKey) DO UPDATE SET
           goalsMd     = excluded.goalsMd,
           generatedMd = excluded.generatedMd,
           updatedAt   = excluded.updatedAt`
    ).bind(
      `brief_person_${personId}_${Date.now().toString(36)}`,
      personId,
      result.reply,
      result.reply,
      new Date().toISOString(),
    ).run();
    return new Response(JSON.stringify({
      output: result.reply,
      personId,
      iterations: result.iterations,
      usage: result.usage,
    }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  } catch (err) {
    const msg = String(err?.message || err);
    const status = msg.includes("ANTHROPIC_API_KEY") ? 503 : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}
