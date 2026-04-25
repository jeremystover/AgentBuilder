/**
 * web/chat.js — Claude-driven chat sidebar + Day Plan / Week Plan / Day Review
 * / Week Review buttons.
 *
 * The chat endpoint takes a message + history and runs Claude Sonnet through
 * a tool-use loop with the chief-of-staff tool registry. Tools that mutate
 * the world go through propose_* + commit_changeset like everywhere else.
 *
 * Day-Plan / Week-Plan / Day-Review / Week-Review are thin wrappers around
 * the same loop with a canned system prompt + a structured input bundle.
 */

// Dynamic import of @agentbuilder/llm — keeps the worker test suite
// (which imports worker.js under raw Node ESM) from failing when Node tries
// to resolve the package's TypeScript entry. esbuild handles the dynamic
// import the same as a static one when bundling for the Worker runtime.
async function loadLlm() {
  return await import("@agentbuilder/llm");
}

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

// ── Tool surface for the chat sidebar ───────────────────────────────────────
// We don't expose every MCP tool to the chat — that's too many for tool-
// selection accuracy (AGENTS.md rule 2). The list below is the curated set
// the sidebar needs.

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

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function normalizeInputSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  // Anthropic's tool input schema must be a JSON Schema object with type:"object".
  if (schema.type !== "object") return { type: "object", properties: {}, additionalProperties: false };
  return schema;
}

function buildToolDefs(tools) {
  const defs = [];
  const handlers = {};
  for (const name of CHAT_TOOL_ALLOWLIST) {
    const tool = tools[name];
    if (!tool) continue;
    defs.push({
      name,
      description: String(tool.description || "").slice(0, 1024),
      inputSchema: normalizeInputSchema(tool.inputSchema),
    });
    handlers[name] = async (input) => {
      const result = await tool.run(input || {});
      // The LLM expects a string. The MCP envelope wraps text already; just
      // pass it through.
      const text = result?.content?.[0]?.text;
      return typeof text === "string" ? text : JSON.stringify(result);
    };
  }
  return { defs, handlers };
}

/**
 * POST /api/chat
 * body: { message: string, history?: ChatMessage[], pageContext?: { kind, periodKey } }
 * returns: { reply, messages, iterations, usage }
 */
export async function handleChatRequest(request, ctx) {
  const { tools, env } = ctx;
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY not configured" }, 503);
  }
  const body = await readJson(request);
  const message = String(body?.message || "").trim();
  if (!message) return jsonResponse({ error: "message is required" }, 400);
  const history = Array.isArray(body?.history) ? body.history : [];

  const { LLMClient, runToolLoop } = await loadLlm();
  const llm = new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY });
  const { defs, handlers } = buildToolDefs(tools);
  const pageHint = body?.pageContext?.kind
    ? `\n\nUser is currently viewing the "${body.pageContext.kind}" page${body.pageContext.periodKey ? ` for ${body.pageContext.periodKey}` : ""}.`
    : "";
  try {
    const result = await runToolLoop({
      llm,
      tier: "default",
      system: SYSTEM_PROMPT_BASE + pageHint,
      initialMessages: [...history, { role: "user", content: message }],
      tools: defs,
      handlers,
      maxIterations: 10,
    });
    return jsonResponse({
      reply: result.text,
      messages: result.messages,
      iterations: result.iterations,
      usage: result.usage,
      stopReason: result.stopReason,
    });
  } catch (err) {
    return jsonResponse({ error: String(err?.message || err) }, 500);
  }
}

/**
 * POST /api/day-plan, /api/day-review, /api/week-plan, /api/week-review
 * body: { input: string, periodKey: string, brief?: { goalsMd } }
 *
 * Returns: { output, periodKey } and persists to Briefs.generatedMd /
 * Briefs.reviewMd respectively so the SPA can render the latest output
 * inline next to the brief.
 */
export async function handlePlanReviewRequest(request, ctx, kind) {
  const { tools, env } = ctx;
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY not configured" }, 503);
  }
  const body = await readJson(request);
  const input = String(body?.input || "").trim();
  const periodKey = String(body?.periodKey || "").trim();
  if (!periodKey) return jsonResponse({ error: "periodKey is required" }, 400);

  const system = pickSystem(kind);
  const { LLMClient, runToolLoop } = await loadLlm();
  const llm = new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY });
  const { defs, handlers } = buildToolDefs(tools);

  const userMessage = [
    `--- ${kind.replace(/-/g, " ").toUpperCase()} (${periodKey}) ---`,
    body?.brief?.goalsMd
      ? `\nCurrent goals brief:\n${body.brief.goalsMd}`
      : "",
    `\nUser notes:\n${input || "(no notes — just plan / review the period from current state)"}`,
  ].join("\n");

  try {
    const result = await runToolLoop({
      llm,
      tier: "default",
      system,
      initialMessages: [{ role: "user", content: userMessage }],
      tools: defs,
      handlers,
      maxIterations: 12,
    });
    // Persist to Briefs (web/api.js owns the upsert; we re-export it for here).
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
      reviewMode ? "" : result.text,
      reviewMode ? result.text : "",
      new Date().toISOString(),
      reviewMode ? 1 : 0,
      reviewMode ? 1 : 0,
    ).run();

    return jsonResponse({
      output: result.text,
      periodKey,
      kind,
      iterations: result.iterations,
      usage: result.usage,
    });
  } catch (err) {
    return jsonResponse({ error: String(err?.message || err) }, 500);
  }
}

function pickSystem(kind) {
  switch (kind) {
    case "day-plan": return DAY_PLAN_SYSTEM;
    case "day-review": return DAY_REVIEW_SYSTEM;
    case "week-plan": return WEEK_PLAN_SYSTEM;
    case "week-review": return WEEK_REVIEW_SYSTEM;
    default: return SYSTEM_PROMPT_BASE;
  }
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}
