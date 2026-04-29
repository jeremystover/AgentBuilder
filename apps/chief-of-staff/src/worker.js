/**
 * worker.js — Cloudflare Workers entry point for the chief-of-staff MCP server.
 *
 * Replaces server.js (Cloud Run / Node.js HTTP server).
 * No Node.js APIs used — runs on Cloudflare's V8 edge runtime.
 *
 * Endpoints:
 *   GET  /health
 *   POST /mcp                (JSON-RPC 2.0)
 *   POST /internal/zoom-poll (cron — polls Zoom for recordings)
 *
 * Auth:
 *   If MCP_HTTP_KEY secret is set, require /mcp?key=<MCP_HTTP_KEY>
 *
 * Required secrets (set via `wrangler secret put`):
 *   GOOGLE_SERVICE_ACCOUNT_JSON  — full SA JSON with drive + sheets scope
 *   PPP_SHEETS_SPREADSHEET_ID    — spreadsheet ID for Tasks/Commitments/etc.
 *   MCP_HTTP_KEY                 — optional bearer key for Claude auth
 *
 * Optional vars (wrangler.toml [vars]):
 *   PPP_MCP_DRIVE_FOLDER_ID, PPP_MCP_APPS_SHEET_ID, PPP_MCP_APP_ID,
 *   PPP_MCP_APPS_SHEET_NAME, PPP_MCP_MAX_CHARS,
 *   PPP_MCP_WEB_TIMEOUT_MS, PPP_MCP_WEB_MAX_REDIRECTS, PPP_MCP_WEB_MAX_BYTES,
 *   PPP_MCP_WEB_RATE_LIMIT_PER_MIN, PPP_MCP_WEB_ALLOWLIST, PPP_MCP_WEB_DENYLIST
 */

import { createGfetch, createUserFetch, createUserFetches } from "./auth.js";
import { createSheets } from "./sheets.js";
import { createD1Sheets } from "./d1-sheets.js";
import { createTools } from "./tools.js";
import { createCrmTools } from "./crm.js";
import { createReviewTools } from "./reviews.js";
import { createZoomTools } from "./zoom.js";
import { createIngest, createIngestTools } from "./ingest.js";
import { generateMorningBrief, generateCommitmentNudges, createAutomationTools } from "./automation.js";
import { createContentTools } from "./content-tools.js";
import { readContent } from "./content.js";
import { runCron, logError } from "./observability.js";
import { bootstrapSheets } from "./bootstrap.js";
import { createGoalsTools } from "./goals.js";
import { createStateExportTools, generateStateExport, renderStateMarkdown } from "./state-export.js";
import { createEmailFilterMCPTools } from "./email-filters.js";
import {
  requireWebSession,
  requireApiAuth,
  createSession,
  destroySession,
  setSessionCookieHeader,
  clearSessionCookieHeader,
  verifyPassword,
} from "./web/auth.js";
import { handleApiRequest } from "./web/api.js";
import { handleChatRequest, handlePlanReviewRequest, handlePersonBriefRequest } from "./web/chat.js";
import { loginHtml, appHtml } from "./web/spa-html.js";
import { SPA_PAGES_JS } from "./web/spa-pages.js";
import { SPA_PAGES2_JS } from "./web/spa-pages2.js";
import { SPA_CORE_JS } from "@agentbuilder/web-ui-kit";
import {
  FAVICON_ICO_B64,
  FAVICON_16_PNG_B64,
  FAVICON_32_PNG_B64,
  APPLE_TOUCH_ICON_B64,
  ICON_192_PNG_B64,
  ICON_512_PNG_B64,
  ICON_512_MASKABLE_B64,
  FAVICON_SVG,
  MANIFEST_JSON,
  bytesFromB64,
} from "./web/icons.js";

// ── Data store resolution ────────────────────────────────────────────────────
// When env.DB (Cloudflare D1) is bound, use it as the primary data store.
// Otherwise fall back to Google Sheets via gfetch + spreadsheetId. The D1
// adapter implements the same interface (readSheetAsObjects, findRowByKey,
// appendRows, updateRow, etc.) so all consumers work unchanged.
//
// workCalSheets always uses Google Sheets — it's a separate spreadsheet
// maintained by an external Apps Script bridge in the work org.

function resolveDataStore(env, gfetch) {
  if (env.DB) {
    // D1 is available — use it. Pass a truthy sentinel for spreadsheetId so
    // guard checks like `if (!spreadsheetId)` still pass in tool factories.
    return { sheets: createD1Sheets(env.DB), spreadsheetId: "d1" };
  }
  const spreadsheetId = env.PPP_SHEETS_SPREADSHEET_ID || "";
  return { sheets: createSheets(gfetch, spreadsheetId), spreadsheetId };
}

// Builds the merged TOOLS registry shared by /mcp and the web UI's /api/*.
// Mirrors the construction inside fetch() for /mcp — keep them in sync.
function buildToolContext(env) {
  const config = {
    DEFAULT_FOLDER_ID: env.PPP_MCP_DRIVE_FOLDER_ID || "",
    APPS_SHEET_ID: env.PPP_MCP_APPS_SHEET_ID || "",
    DEFAULT_SHEET_NAME: env.PPP_MCP_APPS_SHEET_NAME || "Apps",
    APP_ID: env.PPP_MCP_APP_ID || "",
    MAX_CHARS: Number(env.PPP_MCP_MAX_CHARS || 12_000),
    WEB_TIMEOUT_MS: Number(env.PPP_MCP_WEB_TIMEOUT_MS || 8_000),
    WEB_MAX_REDIRECTS: Number(env.PPP_MCP_WEB_MAX_REDIRECTS || 3),
    WEB_MAX_BYTES: Number(env.PPP_MCP_WEB_MAX_BYTES || 1_000_000),
    WEB_RATE_LIMIT_PER_MIN: Number(env.PPP_MCP_WEB_RATE_LIMIT_PER_MIN || 30),
    WEB_ALLOWLIST: String(env.PPP_MCP_WEB_ALLOWLIST || "")
      .split(",").map((v) => v.trim().toLowerCase()).filter(Boolean),
    WEB_DENYLIST: String(env.PPP_MCP_WEB_DENYLIST || "")
      .split(",").map((v) => v.trim().toLowerCase()).filter(Boolean),
  };

  const { gfetch } = createGfetch(env);
  const { sheets, spreadsheetId } = resolveDataStore(env, gfetch);
  const workCalSheetId = env.PPP_WORK_CAL_SHEET_ID || "";
  const workCalSheets = workCalSheetId ? createSheets(gfetch, workCalSheetId) : null;

  const phase1ToolsRaw = createTools({ spreadsheetId, sheets });
  const storeChangeset = phase1ToolsRaw.__storeChangeset;
  const { __storeChangeset: _ignored, ...phase1Tools } = phase1ToolsRaw;
  const phase2CrmTools = createCrmTools({ spreadsheetId, sheets });
  const phase2ReviewTools = createReviewTools({ spreadsheetId, sheets });
  const phase3ZoomTools = createZoomTools({ env, gfetch, sheets, spreadsheetId });
  const userFetches = createUserFetches(env);
  const ufetch = userFetches.personal?.ufetch;
  const ingestTools = createIngestTools({ ufetch, userFetches, gfetch, sheets, spreadsheetId, workCalSheets, env });
  const phase4AutomationTools = createAutomationTools({ ufetch, sheets, spreadsheetId });
  const { tools: contentTools, loaders, drive } = createContentTools({ gfetch, config });
  const goalsTools = createGoalsTools({ spreadsheetId, sheets, storeChangeset });
  const stateExportTools = createStateExportTools({ spreadsheetId, sheets, drive });
  const emailFilterToolDefs = createEmailFilterMCPTools({ sheets });
  const emailFilterTools = emailFilterToolDefs.reduce((acc, def) => {
    acc[def.name] = { description: def.description, inputSchema: def.inputSchema, run: def.handler };
    return acc;
  }, {});

  const tools = {
    ...contentTools,
    ...phase1Tools,
    ...goalsTools,
    ...stateExportTools,
    ...phase2CrmTools,
    ...phase2ReviewTools,
    ...phase3ZoomTools,
    ...ingestTools,
    ...emailFilterTools,
    ...phase4AutomationTools,
    bootstrap_sheets: {
      description:
        "Verify and initialize the Google Sheets schema. Creates missing tabs " +
        "and appends missing columns (non-destructive — existing data and extra " +
        "columns are preserved). Returns a report of what was created/fixed/ok. " +
        "Safe to run repeatedly — idempotent.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        if (!spreadsheetId) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "PPP_SHEETS_SPREADSHEET_ID not set" }) }] };
        }
        try {
          const report = await bootstrapSheets(sheets);
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, report }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
        }
      },
    },
  };

  return { tools, sheets, spreadsheetId, loaders, env };
}

// ── Pure utilities ───────────────────────────────────────────────────────────

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function asError(code, message, data) {
  return { code, message, data };
}

// ── Auth helper ──────────────────────────────────────────────────────────────
// Single entry point for key-based auth across /mcp and /internal/*.
//
// Scopes:
//   "mcp"      — requires env.MCP_HTTP_KEY (agentic surface used by Claude)
//   "internal" — requires env.INTERNAL_CRON_KEY (privileged /internal/* endpoints
//                used by cron / ops). Falls back to MCP_HTTP_KEY during the
//                deprecation window so existing deployments keep working until
//                the operator sets INTERNAL_CRON_KEY.
//
// Token source (in order):
//   1. Authorization: Bearer <token>  (preferred — never appears in URL logs)
//   2. ?key=<token>                   (deprecated fallback, still accepted)
//
// Returns { ok: true } on success, { ok: false, response: Response } on failure.
function requireAuth(request, env, { scope }) {
  let expected = "";
  if (scope === "mcp") {
    expected = env.MCP_HTTP_KEY || "";
  } else if (scope === "internal") {
    expected = env.INTERNAL_CRON_KEY || env.MCP_HTTP_KEY || "";
  }

  // If no secret is configured at all, allow (dev / local) — same behavior
  // as the previous per-endpoint check.
  if (!expected) return { ok: true };

  const header = request.headers.get("authorization") || "";
  let token = "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) token = m[1].trim();

  if (!token) {
    const urlObj = new URL(request.url);
    token = urlObj.searchParams.get("key") || "";
  }

  if (token && token === expected) return { ok: true };
  return { ok: false, response: jsonResponse({ error: "Unauthorized" }, 401) };
}

// ── Tool category registry ───────────────────────────────────────────────────
// Categories group tools in tools/list output so planners can scan related
// capabilities together. Every tool MUST be listed here; anything unlisted is
// surfaced under "uncategorized" and should be treated as a registration bug.

const TOOL_CATEGORIES = {
  content: [
    "resolve_uri",
    "read_content",
    "search_content",
    "list_status_files",
    "read_status_file",
    "write_status_file",
    "append_status_file",
    "delete_status_file",
  ],
  planning: [
    "hydrate_planning_context",
    "get_prioritized_todo",
    "get_intake",
    "search_vault",
    "show_source",
  ],
  mutations: [
    "propose_create_task",
    "propose_update_task",
    "propose_complete_task",
    "propose_create_commitment",
    "propose_resolve_commitment",
    "propose_create_goal",
    "propose_update_goal",
    "propose_delete_goal",
    "propose_create_project",
    "propose_update_project",
    "propose_delete_project",
    "propose_resolve_intake",
    "propose_bulk_resolve_intake",
    "propose_extract_action_items",
    "propose_draft_reply",
    "commit_changeset",
  ],
  goals: [
    "list_goals",
    "list_projects",
    "get_goal_360",
    "backfill_projects_from_tasks",
    "export_state_markdown",
  ],
  crm: [
    "get_stakeholder_360",
    "get_project_360",
    "list_stakeholders_needing_touch",
  ],
  reviews: [
    "generate_period_review",
    "log_decision",
    "list_decisions_to_revisit",
  ],
  meetings: [
    "poll_zoom_recordings",
    "get_meeting_transcript",
  ],
  calendar: [
    "list_calendars",
    "list_calendar_events",
    "list_work_calendar_events",
    "create_calendar_event",
    "update_calendar_event",
  ],
  gmail: [
    "create_gmail_draft",
  ],
  email_filtering: [
    "create_email_filter",
    "list_email_filters",
    "update_email_filter",
    "delete_email_filter",
    "get_flagged_emails",
    "mark_flagged_email",
  ],
  automation: [
    "run_ingest",
    "trigger_morning_brief",
    "trigger_commitment_nudges",
    "log_agent_run",
  ],
  bluesky: [
    "run_bluesky_sync",
    "list_bluesky_likes",
  ],
  admin: [
    "bootstrap_sheets",
  ],
};

// Flat lookup: toolName -> category
const CATEGORY_BY_TOOL = (() => {
  const m = new Map();
  for (const [cat, names] of Object.entries(TOOL_CATEGORIES)) {
    for (const n of names) m.set(n, cat);
  }
  return m;
})();

// Category display order for tools/list
const CATEGORY_ORDER = Object.keys(TOOL_CATEGORIES);

function categoryFor(name) {
  return CATEGORY_BY_TOOL.get(name) || "uncategorized";
}

function compareByCategory(aName, bName) {
  const aCat = categoryFor(aName);
  const bCat = categoryFor(bName);
  const aIdx = CATEGORY_ORDER.indexOf(aCat);
  const bIdx = CATEGORY_ORDER.indexOf(bCat);
  const aRank = aIdx === -1 ? CATEGORY_ORDER.length : aIdx;
  const bRank = bIdx === -1 ? CATEGORY_ORDER.length : bIdx;
  if (aRank !== bRank) return aRank - bRank;
  // Within a category, keep the per-category order from TOOL_CATEGORIES so
  // related tools stay adjacent (e.g. propose_* next to commit_changeset).
  if (aCat === bCat && TOOL_CATEGORIES[aCat]) {
    const order = TOOL_CATEGORIES[aCat];
    const ai = order.indexOf(aName);
    const bi = order.indexOf(bName);
    if (ai !== -1 && bi !== -1) return ai - bi;
  }
  return aName.localeCompare(bName);
}

// ── JSON-RPC handler ─────────────────────────────────────────────────────────

async function handleJsonRpc(message, tools, loaders) {
  const { id, method, params } = message || {};

  if (!method) {
    return { jsonrpc: "2.0", id: id ?? null, error: asError(-32600, "Invalid Request: missing method") };
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "ppp-mcp-worker", version: "4.0.0" },
        instructions:
          "Chief-of-staff MCP server (Cloudflare Workers). " +
          "Phase 1: Drive files + task/commitment/intake tools (hydrate → plan → propose → commit). " +
          "Phase 2: CRM (get_stakeholder_360, get_project_360, list_stakeholders_needing_touch) + " +
          "reviews (generate_period_review, log_decision, list_decisions_to_revisit). " +
          "Phase 3: Zoom recording poll (poll_zoom_recordings, get_meeting_transcript). " +
          "Phase 4: Automated drafts (trigger_morning_brief, trigger_commitment_nudges, " +
          "propose_draft_reply) + session logging (log_agent_run). " +
          "Required secrets: GOOGLE_SERVICE_ACCOUNT_JSON, PPP_SHEETS_SPREADSHEET_ID. " +
          "Auth: /mcp?key=... if MCP_HTTP_KEY set. " +
          "ALWAYS call hydrate_planning_context before any planning tool. " +
          "All mutations go through propose_* then commit_changeset.",
      },
    };
  }

  if (method === "resources/list") {
    // Resource index from file system is not supported in Workers.
    // Use Drive tools (list_status_files, read_status_file) directly instead.
    return { jsonrpc: "2.0", id, result: { resources: [] } };
  }

  if (method === "resources/read") {
    const uri = String(params?.uri || "");
    if (!uri) return { jsonrpc: "2.0", id, error: asError(-32602, "uri is required") };
    try {
      const out = await readContent({
        uri,
        mode: "full",
        include_metadata: false,
        maxChars: Number.MAX_SAFE_INTEGER,
        loaders,
      });
      return {
        jsonrpc: "2.0",
        id,
        result: { contents: [{ uri, mimeType: "text/markdown", text: out.text }] },
      };
    } catch (e) {
      return { jsonrpc: "2.0", id, error: asError(-32000, e.message) };
    }
  }

  if (method === "tools/list") {
    const toolList = Object.entries(tools)
      .sort(([a], [b]) => compareByCategory(a, b))
      .map(([name, def]) => ({
        name,
        description: def.description,
        inputSchema: def.inputSchema,
        category: categoryFor(name),
      }));
    return { jsonrpc: "2.0", id, result: { tools: toolList } };
  }

  if (method === "tools/call") {
    const name = params?.name;
    const tool = tools[name];
    if (!tool) return { jsonrpc: "2.0", id, error: asError(-32601, `Unknown tool: ${name}`) };
    const t0 = Date.now();
    try {
      const result = await tool.run(params?.arguments || {});
      console.log(`[tool] ${name} ok ${Date.now() - t0}ms`);
      return { jsonrpc: "2.0", id, result };
    } catch (e) {
      console.error(`[tool] ${name} error ${Date.now() - t0}ms: ${e.message}`);
      return { jsonrpc: "2.0", id, error: asError(-32000, e.message) };
    }
  }

  if (method === "notifications/initialized") return null;

  return { jsonrpc: "2.0", id, error: asError(-32601, `Method not found: ${method}`) };
}

// ── Cloudflare Workers export ────────────────────────────────────────────────

// ── Cron dispatch table ──────────────────────────────────────────────────────
// Each entry is a distinct schedule handler. Adding a new cron = add a row
// here (and a matching cron trigger in wrangler.toml). Each handler runs
// inside runCron() for a per-trigger CronRuns row and isolated try/catch, so
// one schedule failing cannot break the others.
function buildCronDispatch({ gfetch, ufetch, userFetches, sheets, workCalSheets, spreadsheetId, env }) {
  return {
    "0 6 * * *": {
      // 6am daily — regenerate Current_State.md on Drive so the user has a
      // fresh browsable document of the Goals → Projects → Tasks tree.
      trigger: "state-export",
      handler: async () => {
        const { drive } = createContentTools({
          gfetch,
          config: {
            DEFAULT_FOLDER_ID: env.PPP_MCP_DRIVE_FOLDER_ID || "",
            APPS_SHEET_ID: env.PPP_MCP_APPS_SHEET_ID || "",
            DEFAULT_SHEET_NAME: env.PPP_MCP_APPS_SHEET_NAME || "Apps",
            APP_ID: env.PPP_MCP_APP_ID || "",
            MAX_CHARS: Number(env.PPP_MCP_MAX_CHARS || 12_000),
            WEB_TIMEOUT_MS: Number(env.PPP_MCP_WEB_TIMEOUT_MS || 8_000),
            WEB_MAX_REDIRECTS: Number(env.PPP_MCP_WEB_MAX_REDIRECTS || 3),
            WEB_MAX_BYTES: Number(env.PPP_MCP_WEB_MAX_BYTES || 1_000_000),
            WEB_RATE_LIMIT_PER_MIN: Number(env.PPP_MCP_WEB_RATE_LIMIT_PER_MIN || 30),
            WEB_ALLOWLIST: [],
            WEB_DENYLIST: [],
          },
        });
        return await generateStateExport({ sheets, drive });
      },
    },
    "0 7 * * *": {
      trigger: "morning-brief",
      handler: () => generateMorningBrief({ sheets, ufetch, spreadsheetId }),
    },
    "0 9 * * 1": {
      trigger: "commitment-nudges",
      handler: () => generateCommitmentNudges({ sheets, ufetch, spreadsheetId }),
    },
    "*/10 * * * *": {
      trigger: "ingest-and-zoom",
      handler: async () => {
        const { runIngest } = createIngest({ ufetch, userFetches, gfetch, sheets, workCalSheets, env });
        const ingest = await runIngest();
        // Zoom is best-effort on the same trigger; isolate its error so a Zoom
        // outage cannot mask ingest results in CronRuns.
        let zoomResult = null;
        try {
          const zoom = createZoomTools({ env, gfetch, sheets, spreadsheetId });
          zoomResult = await zoom.poll_zoom_recordings.run({ daysBack: 1 });
        } catch (err) {
          await logError({
            sheets,
            spreadsheetId,
            scope: "cron:ingest-and-zoom:zoom",
            err,
            context: { note: "Zoom poll failed; ingest still succeeded." },
          });
        }
        return { ingest, zoom: zoomResult };
      },
    },
  };
}

export default {
  // ── Cron handler — replaces GAS time-based triggers ───────────────────────
  //
  //  Cron patterns (see buildCronDispatch above for authoritative list):
  //    "*/10 * * * *"  — every 10 min: Gmail/Calendar/Drive ingest + Zoom poll
  //    "0 7 * * *"     — 7am daily: morning brief draft
  //    "0 9 * * 1"     — 9am Monday: commitment nudge drafts
  async scheduled(event, env, ctx) {
    const { gfetch } = createGfetch(env);
    const userFetches = createUserFetches(env);
    // Personal account remains the default for automation drafts / legacy
    // single-account callers. Multi-account consumers use `userFetches`.
    const ufetch = userFetches.personal?.ufetch;
    const { sheets, spreadsheetId } = resolveDataStore(env, gfetch);
    const workCalSheetId = env.PPP_WORK_CAL_SHEET_ID || "";
    const workCalSheets = workCalSheetId ? createSheets(gfetch, workCalSheetId) : null;

    const dispatch = buildCronDispatch({ gfetch, ufetch, userFetches, sheets, workCalSheets, spreadsheetId, env });
    const entry = dispatch[event.cron];

    if (!entry) {
      await logError({
        sheets,
        spreadsheetId,
        scope: "cron:unknown",
        err: new Error(`No handler for cron pattern: ${event.cron}`),
        context: { cron: event.cron },
      });
      return;
    }

    ctx.waitUntil(
      runCron(
        { sheets, spreadsheetId, trigger: entry.trigger, cron: event.cron },
        entry.handler
      )
    );
  },

  async fetch(request, env, ctx) {
    const urlObj = new URL(request.url);

    // Health check
    if (request.method === "GET" && urlObj.pathname === "/health") {
      return jsonResponse({ ok: true });
    }

    // ── Branded icons ────────────────────────────────────────────────────
    // Public assets — served before any auth gate so the browser tab and
    // MacOS Chrome "Install as App" can fetch them on the login page.
    // Bytes live in src/web/icons.js (regenerate via scripts/gen-icons.py).
    if (request.method === "GET") {
      const iconRoutes = {
        "/favicon.ico":             { b64: FAVICON_ICO_B64,       type: "image/x-icon" },
        "/favicon-16.png":          { b64: FAVICON_16_PNG_B64,    type: "image/png" },
        "/favicon-32.png":          { b64: FAVICON_32_PNG_B64,    type: "image/png" },
        "/apple-touch-icon.png":    { b64: APPLE_TOUCH_ICON_B64,  type: "image/png" },
        // iOS sometimes asks for the precomposed variant — serve the same bytes.
        "/apple-touch-icon-precomposed.png": { b64: APPLE_TOUCH_ICON_B64, type: "image/png" },
        "/icon-192.png":            { b64: ICON_192_PNG_B64,      type: "image/png" },
        "/icon-512.png":            { b64: ICON_512_PNG_B64,      type: "image/png" },
        "/icon-512-maskable.png":   { b64: ICON_512_MASKABLE_B64, type: "image/png" },
      };
      const iconHit = iconRoutes[urlObj.pathname];
      if (iconHit) {
        return new Response(bytesFromB64(iconHit.b64), {
          status: 200,
          headers: {
            "content-type": iconHit.type,
            "cache-control": "public, max-age=86400",
          },
        });
      }
      if (urlObj.pathname === "/favicon.svg") {
        return new Response(FAVICON_SVG, {
          status: 200,
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "cache-control": "public, max-age=86400",
          },
        });
      }
      if (urlObj.pathname === "/manifest.webmanifest") {
        return new Response(MANIFEST_JSON, {
          status: 200,
          headers: {
            "content-type": "application/manifest+json; charset=utf-8",
            "cache-control": "public, max-age=86400",
          },
        });
      }
    }

    // Dashboard — read-only HTML view of Goals → Projects → Tasks.
    // Reuses the same markdown renderer as the nightly export so the layout
    // stays in one place. Guarded by the MCP key so the URL is private.
    if (request.method === "GET" && urlObj.pathname === "/dashboard") {
      const auth = requireAuth(request, env, { scope: "mcp" });
      if (!auth.ok) return auth.response;
      const { gfetch: gf } = createGfetch(env);
      const { sheets: sh, spreadsheetId: sid } = resolveDataStore(env, gf);
      if (!sid) {
        return new Response("No data store configured (need DB or PPP_SHEETS_SPREADSHEET_ID)", { status: 400 });
      }
      try {
        const [goals, projects, tasks, stakeholders] = await Promise.all([
          sh.readSheetAsObjects("Goals").catch(() => []),
          sh.readSheetAsObjects("Projects").catch(() => []),
          sh.readSheetAsObjects("Tasks").catch(() => []),
          sh.readSheetAsObjects("Stakeholders").catch(() => []),
        ]);
        const quarter = urlObj.searchParams.get("quarter") || "";
        const md = renderStateMarkdown({
          goals, projects, tasks, stakeholders,
          filter: quarter ? { quarter } : {},
        });
        const escaped = md
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        const html = `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>PPP Dashboard</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 900px; margin: 2em auto; padding: 0 1em; line-height: 1.5; color: #222; }
  pre { white-space: pre-wrap; word-wrap: break-word; }
  .hint { color: #888; font-size: 0.85em; margin-bottom: 1em; }
</style>
</head><body>
<p class="hint">Add <code>?quarter=2026Q2</code> to filter.</p>
<pre>${escaped}</pre>
</body></html>`;
        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch (e) {
        return new Response(`Error: ${e.message}`, { status: 500 });
      }
    }

    // Internal: on-demand state export (cron fallback + manual trigger).
    if (request.method === "POST" && urlObj.pathname === "/internal/state-export") {
      const auth = requireAuth(request, env, { scope: "internal" });
      if (!auth.ok) return auth.response;
      const { gfetch: gf } = createGfetch(env);
      const { sheets: sh, spreadsheetId: sid } = resolveDataStore(env, gf);
      if (!sid) return jsonResponse({ error: "No data store configured" }, 400);
      try {
        const { drive: d } = createContentTools({ gfetch: gf, config: {
          DEFAULT_FOLDER_ID: env.PPP_MCP_DRIVE_FOLDER_ID || "",
          APPS_SHEET_ID: env.PPP_MCP_APPS_SHEET_ID || "",
          DEFAULT_SHEET_NAME: env.PPP_MCP_APPS_SHEET_NAME || "Apps",
          APP_ID: env.PPP_MCP_APP_ID || "",
          MAX_CHARS: Number(env.PPP_MCP_MAX_CHARS || 12_000),
          WEB_TIMEOUT_MS: Number(env.PPP_MCP_WEB_TIMEOUT_MS || 8_000),
          WEB_MAX_REDIRECTS: Number(env.PPP_MCP_WEB_MAX_REDIRECTS || 3),
          WEB_MAX_BYTES: Number(env.PPP_MCP_WEB_MAX_BYTES || 1_000_000),
          WEB_RATE_LIMIT_PER_MIN: Number(env.PPP_MCP_WEB_RATE_LIMIT_PER_MIN || 30),
          WEB_ALLOWLIST: [],
          WEB_DENYLIST: [],
        }});
        const result = await generateStateExport({ sheets: sh, drive: d });
        return jsonResponse({ ok: true, path: result.path, bytesWritten: result.bytesWritten, counts: result.counts });
      } catch (e) {
        await logError({ sheets: sh, spreadsheetId: sid, scope: "internal:state-export", err: e });
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // Internal: zoom recording poll (triggered by Cloud Scheduler / cron)
    if (request.method === "POST" && urlObj.pathname === "/internal/zoom-poll") {
      const auth = requireAuth(request, env, { scope: "internal" });
      if (!auth.ok) return auth.response;
      const { gfetch: gf } = createGfetch(env);
      const { sheets: sh, spreadsheetId: sid } = resolveDataStore(env, gf);
      try {
        const zoom = createZoomTools({ env, gfetch: gf, sheets: sh, spreadsheetId: sid });
        const result = await zoom.poll_zoom_recordings.run({});
        return jsonResponse(result);
      } catch (e) {
        await logError({ sheets: sh, spreadsheetId: sid, scope: "internal:zoom-poll", err: e });
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // Internal: morning brief (triggered by cron at 7am or manually)
    if (request.method === "POST" && urlObj.pathname === "/internal/morning-brief") {
      const auth = requireAuth(request, env, { scope: "internal" });
      if (!auth.ok) return auth.response;
      const { ufetch: uf } = createUserFetch(env);
      const { gfetch: gf } = createGfetch(env);
      const { sheets: sh, spreadsheetId: sid } = resolveDataStore(env, gf);
      try {
        const result = await generateMorningBrief({ sheets: sh, ufetch: uf, spreadsheetId: sid });
        return jsonResponse(result);
      } catch (e) {
        await logError({ sheets: sh, spreadsheetId: sid, scope: "internal:morning-brief", err: e });
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // Internal: commitment nudges (triggered by cron on Mondays or manually)
    if (request.method === "POST" && urlObj.pathname === "/internal/commitment-nudges") {
      const auth = requireAuth(request, env, { scope: "internal" });
      if (!auth.ok) return auth.response;
      const { ufetch: uf } = createUserFetch(env);
      const { gfetch: gf } = createGfetch(env);
      const { sheets: sh, spreadsheetId: sid } = resolveDataStore(env, gf);
      try {
        const result = await generateCommitmentNudges({ sheets: sh, ufetch: uf, spreadsheetId: sid });
        return jsonResponse(result);
      } catch (e) {
        await logError({ sheets: sh, spreadsheetId: sid, scope: "internal:commitment-nudges", err: e });
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // Internal: bootstrap/verify Google Sheets schema.
    //
    // Creates missing tabs and appends missing columns to existing tabs,
    // based on SHEET_SCHEMAS in bootstrap.js. Non-destructive: existing data
    // and extra columns are preserved. Run after provisioning a new
    // spreadsheet, or after pulling a schema update.
    if (request.method === "POST" && urlObj.pathname === "/internal/bootstrap-sheets") {
      const auth = requireAuth(request, env, { scope: "internal" });
      if (!auth.ok) return auth.response;
      const { gfetch: gf } = createGfetch(env);
      const { sheets: sh, spreadsheetId: sid } = resolveDataStore(env, gf);
      if (!sid) {
        return jsonResponse({ error: "No data store configured" }, 400);
      }
      try {
        const report = await bootstrapSheets(sh);
        return jsonResponse({ ok: true, report });
      } catch (e) {
        await logError({ sheets: sh, spreadsheetId: sid, scope: "internal:bootstrap-sheets", err: e });
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // Internal: auth diagnostic — tests SA JSON parse, JWT sign, token exchange,
    // and a live Sheets API call. Each step is reported independently so the
    // exact failure point is visible without needing Cloudflare log tail.
    //   curl -s "https://<worker>/internal/auth-check?key=<INTERNAL_CRON_KEY>" | jq
    if (request.method === "GET" && urlObj.pathname === "/internal/auth-check") {
      const auth = requireAuth(request, env, { scope: "internal" });
      if (!auth.ok) return auth.response;

      const steps = [];

      // Step 1: parse GOOGLE_SERVICE_ACCOUNT_JSON
      let saJson = null;
      try {
        const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
        saJson = JSON.parse(raw);
        const pk = saJson.private_key || "";
        steps.push({
          step: "1_json_parse",
          ok: !!(saJson.client_email && pk),
          client_email: saJson.client_email || null,
          private_key_length: pk.length,
          private_key_starts_with: pk.slice(0, 27),
          has_real_newlines: pk.includes("\n"),
          type: saJson.type || null,
        });
      } catch (e) {
        steps.push({ step: "1_json_parse", ok: false, error: e.message });
        return jsonResponse({ ok: false, steps });
      }

      if (!saJson.client_email || !saJson.private_key) {
        steps.push({ step: "2_get_access_token", ok: false, error: "Skipped — missing client_email or private_key" });
        return jsonResponse({ ok: false, steps });
      }

      // Step 2: JWT sign + token exchange (getAccessToken does both)
      let gfetch2;
      try {
        const { gfetch: gf, getAccessToken } = createGfetch(env);
        gfetch2 = gf;
        const token = await getAccessToken();
        steps.push({ step: "2_get_access_token", ok: true, token_prefix: token.slice(0, 10) + "…" });
      } catch (e) {
        steps.push({ step: "2_get_access_token", ok: false, error: e.message });
        return jsonResponse({ ok: false, steps });
      }

      // Step 3: Sheets API — fetch spreadsheet metadata (lightweight, no data read)
      const spreadsheetId = env.PPP_SHEETS_SPREADSHEET_ID || "";
      if (!spreadsheetId || spreadsheetId === "d1") {
        steps.push({ step: "3_sheets_api", ok: null, skipped: "PPP_SHEETS_SPREADSHEET_ID not set or using D1" });
      } else {
        try {
          const res = await gfetch2(
            `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,properties.title`
          );
          const meta = await res.json();
          steps.push({
            step: "3_sheets_api",
            ok: true,
            spreadsheet_id: meta.spreadsheetId,
            spreadsheet_title: meta.properties?.title,
          });
        } catch (e) {
          steps.push({ step: "3_sheets_api", ok: false, error: e.message });
        }
      }

      const allOk = steps.every((s) => s.ok === true || s.ok === null);
      return jsonResponse({ ok: allOk, steps });
    }

    // ── Web UI routes ─────────────────────────────────────────────────────
    // /app/login — GET shows form, POST verifies password + sets cookie.
    if (urlObj.pathname === "/app/login") {
      if (request.method === "GET") {
        return new Response(loginHtml({}), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (request.method === "POST") {
        if (!env.WEB_UI_PASSWORD) {
          return new Response(loginHtml({ error: "WEB_UI_PASSWORD is not configured on this Worker." }), {
            status: 500,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        const form = await request.formData().catch(() => null);
        const password = form?.get?.("password") || "";
        if (!verifyPassword(env, password)) {
          return new Response(loginHtml({ error: "Wrong password." }), {
            status: 401,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (!env.DB) {
          return new Response("D1 binding required for web UI sessions.", { status: 500 });
        }
        const { sessionId } = await createSession(env);
        const secure = urlObj.protocol === "https:";
        return new Response(null, {
          status: 302,
          headers: {
            location: "/app",
            "set-cookie": setSessionCookieHeader(sessionId, { secure }),
          },
        });
      }
    }

    if (urlObj.pathname === "/app/logout") {
      const session = await requireWebSession(request, env, { mode: "page" });
      if (session.ok) await destroySession(env, session.sessionId);
      const secure = urlObj.protocol === "https:";
      return new Response(null, {
        status: 302,
        headers: {
          location: "/app/login",
          "set-cookie": clearSessionCookieHeader({ secure }),
        },
      });
    }

    // /app/app.js — concatenated SPA bundle (auth-gated).
    if (request.method === "GET" && urlObj.pathname === "/app/app.js") {
      const auth = await requireWebSession(request, env, { mode: "page" });
      if (!auth.ok) return auth.response;
      const body = SPA_CORE_JS + "\n" + SPA_PAGES_JS + "\n" + SPA_PAGES2_JS;
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    // /app or /app/* — serve the SPA shell. Hash routing inside.
    if (request.method === "GET" && (urlObj.pathname === "/app" || urlObj.pathname.startsWith("/app/"))) {
      const auth = await requireWebSession(request, env, { mode: "page" });
      if (!auth.ok) return auth.response;
      return new Response(appHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // ── /api/* — JSON API for the SPA + external apps ────────────────────
    if (urlObj.pathname.startsWith("/api/")) {
      const auth = await requireApiAuth(request, env);
      if (!auth.ok) return auth.response;

      const ctx = buildToolContext(env);
      if (urlObj.pathname === "/api/chat" && request.method === "POST") {
        return await handleChatRequest(request, ctx);
      }
      const planMatch = urlObj.pathname.match(/^\/api\/(day-plan|day-review|week-plan|week-review)$/);
      if (planMatch && request.method === "POST") {
        return await handlePlanReviewRequest(request, ctx, planMatch[1]);
      }
      const personBriefMatch = urlObj.pathname.match(/^\/api\/people\/([^/]+)\/brief\/generate$/);
      if (personBriefMatch && request.method === "POST") {
        return await handlePersonBriefRequest(request, ctx, decodeURIComponent(personBriefMatch[1]));
      }
      return await handleApiRequest(request, ctx);
    }

    if (request.method !== "POST" || urlObj.pathname !== "/mcp") {
      return jsonResponse({ error: "Not found" }, 404);
    }

    // Key auth for /mcp (Claude agent surface)
    {
      const auth = requireAuth(request, env, { scope: "mcp" });
      if (!auth.ok) return auth.response;
    }

    // Per-request tool context — same registry the /api/* routes use.
    const { tools: TOOLS, loaders } = buildToolContext(env);

    // Parse body
    let raw, msg;
    try {
      raw = await request.text();
      msg = JSON.parse(raw);
    } catch {
      return jsonResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }

    // Dispatch
    try {
      const out = await handleJsonRpc(msg, TOOLS, loaders);
      if (out === null) return new Response(null, { status: 204 });
      return jsonResponse(out);
    } catch (err) {
      let parsedId = null;
      try { parsedId = JSON.parse(raw)?.id ?? null; } catch { /* ignore */ }
      console.error(`[error] ${err?.message || err}`);
      return jsonResponse({
        jsonrpc: "2.0",
        id: parsedId,
        error: { code: -32000, message: String(err?.message || "Server error") },
      });
    }
  },
};
