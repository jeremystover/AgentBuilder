/**
 * Research Agent — Worker entrypoint
 *
 * Routes:
 *   POST /mcp          → MCP JSON-RPC server (bearer auth required)
 *   POST /ingest       → Quick-ingest from bookmarklet/extension (bearer auth required)
 *   POST /chat         → Chat with the knowledge base via Durable Object (bearer auth required)
 *   GET  /chat/history → Retrieve conversation history (bearer auth required)
 *   DELETE /chat/history → Clear conversation (bearer auth required)
 *   POST /api/digest   → Generate on-demand digest (bearer auth required)
 *   POST /api/sources  → Manage sources (bearer auth required)
 *   GET  /health       → Liveness probe (no auth)
 *
 * Events:
 *   scheduled   → poll_bluesky cron (every 30 min)
 *   email       → ingest URLs from forwarded emails
 */

import type { Env }                        from "./types";
import { checkAuth, authErrorResponse }    from "./auth";
import { handleMcpRequest }                from "./mcp/router";
import { ingestUrl, IngestUrlInput }       from "./mcp/tools/ingest_url";
import { generateDigest, GenerateDigestInput } from "./mcp/tools/generate_digest";
import { listSources, ListSourcesInput }   from "./mcp/tools/list_sources";

export { ChatSession } from "./durable/ChatSession";

// Open CORS for the MCP endpoint — MCP clients (Claude, Cowork, etc.)
// connect from various origins and need unrestricted access.
// Auth is enforced via bearer token, not origin.
function mcpCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
    "Access-Control-Max-Age":       "86400",
  };
}

// Restricted CORS for browser-originated endpoints (ingest, chat)
function corsHeaders(origin: string | null): HeadersInit {
  const allowed = ["chrome-extension://", "moz-extension://", "https://research-agent."];
  const allowOrigin = origin && allowed.some((p) => origin.startsWith(p)) ? origin : "null";
  return {
    "Access-Control-Allow-Origin":  allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age":       "86400",
  };
}

function jsonResponse(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", ...extra },
  });
}

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url    = new URL(request.url);
  const method = request.method.toUpperCase();
  const origin = request.headers.get("Origin");

  if (method === "OPTIONS") {
    // MCP preflight gets open CORS; all other endpoints get restricted CORS
    const headers = url.pathname === "/mcp" ? mcpCorsHeaders() : corsHeaders(origin);
    return new Response(null, { status: 204, headers });
  }

  if (url.pathname === "/health" && method === "GET") {
    return jsonResponse({ status: "ok", environment: env.ENVIRONMENT ?? "unknown", ts: new Date().toISOString() });
  }

  if (url.pathname === "/mcp" && method === "POST") {
    const auth = await checkAuth(request, env);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { "Content-Type": "application/json", ...mcpCorsHeaders() },
      });
    }
    const response = await handleMcpRequest(request, env, ctx);
    // Attach open CORS headers to every MCP response
    const newHeaders = new Headers(response.headers);
    for (const [k, v] of Object.entries(mcpCorsHeaders())) newHeaders.set(k, v);
    return new Response(response.body, { status: response.status, headers: newHeaders });
  }

  if (url.pathname === "/ingest" && method === "POST") {
    const auth = await checkAuth(request, env);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    let body: unknown;
    try { body = await request.json(); }
    catch { return jsonResponse({ error: "Request body must be JSON" }, 400, corsHeaders(origin)); }

    if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>)["url"] !== "string") {
      return jsonResponse({ error: 'Body must be { "url": "https://..." }' }, 400, corsHeaders(origin));
    }

    const raw = body as Record<string, unknown>;
    const parsed = IngestUrlInput.safeParse({ url: raw["url"], source_id: raw["source_id"], note: raw["note"] });

    if (!parsed.success) {
      return jsonResponse({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400, corsHeaders(origin));
    }

    try {
      const result = await ingestUrl(parsed.data, env, ctx);
      return jsonResponse(result, 200, corsHeaders(origin));
    } catch (e) {
      console.error("[/ingest] error:", e);
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500, corsHeaders(origin));
    }
  }

  // ── POST /chat — chat with knowledge base ──────────────────
  if (url.pathname === "/chat" && method === "POST") {
    const auth = await checkAuth(request, env);
    if (!auth.ok) return authErrorResponse(auth);
    return proxyToDO(env, request, "/message");
  }

  // ── GET /chat/history ───────────────────────────────────────
  if (url.pathname === "/chat/history" && method === "GET") {
    const auth = await checkAuth(request, env);
    if (!auth.ok) return authErrorResponse(auth);
    return proxyToDO(env, request, "/history");
  }

  // ── DELETE /chat/history ────────────────────────────────────
  if (url.pathname === "/chat/history" && method === "DELETE") {
    const auth = await checkAuth(request, env);
    if (!auth.ok) return authErrorResponse(auth);
    return proxyToDO(env, request, "/history");
  }

  // ── POST /api/digest ────────────────────────────────────────
  if (url.pathname === "/api/digest" && method === "POST") {
    const auth = await checkAuth(request, env);
    if (!auth.ok) return authErrorResponse(auth);
    let body: unknown = {};
    try { body = await request.json(); } catch { /* empty body = use defaults */ }
    const parsed = GenerateDigestInput.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
    }
    try {
      return jsonResponse(await generateDigest(parsed.data, env));
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ── POST /api/sources ───────────────────────────────────────
  if (url.pathname === "/api/sources" && method === "POST") {
    const auth = await checkAuth(request, env);
    if (!auth.ok) return authErrorResponse(auth);
    let body: unknown;
    try { body = await request.json(); }
    catch { return jsonResponse({ error: "Request body must be JSON" }, 400); }
    const parsed = ListSourcesInput.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
    }
    try {
      return jsonResponse(await listSources(parsed.data, env));
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  return jsonResponse({ error: `Not found: ${method} ${url.pathname}` }, 404);
}

/** Proxy a request to the single-user ChatSession Durable Object */
function proxyToDO(env: Env, request: Request, pathname: string): Promise<Response> {
  // Single user — always use the same named instance "jeremy"
  const id = env.CHAT_SESSION.idFromName("jeremy");
  const stub = env.CHAT_SESSION.get(id);
  const doUrl = new URL(request.url);
  doUrl.pathname = pathname;
  return stub.fetch(new Request(doUrl.toString(), {
    method:  request.method,
    headers: request.headers,
    body:    request.method !== "GET" && request.method !== "DELETE" ? request.body : null,
  }));
}

async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  console.log(`[cron] trigger: ${controller.cron} at ${new Date(controller.scheduledTime).toISOString()}`);
  if (controller.cron === "*/30 * * * *") {
    ctx.waitUntil((async () => {
      try {
        const { runPollBluesky } = await import("./cron/poll_bluesky");
        await runPollBluesky(env);
      } catch (e) {
        console.error("[cron/poll_bluesky] failed:", e);
      }
    })());
  }
}

async function handleEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  const from    = message.from;
  const subject = message.headers.get("subject") ?? "(no subject)";
  console.log(`[email] received from=${from} subject="${subject}"`);
  try {
    const { handleInboundEmail } = await import("./email/handler");
    ctx.waitUntil(handleInboundEmail(message, env, ctx));
  } catch (e) {
    console.error("[email] handler import failed:", e);
    message.setReject("Internal processing error — please try again later.");
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(handleScheduled(controller, env, ctx));
  },
  email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(handleEmail(message, env, ctx));
  },
} satisfies ExportedHandler<Env>;
