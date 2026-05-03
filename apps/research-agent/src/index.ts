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

import { runCron }                          from "@agentbuilder/observability";
import type { Env }                        from "./types";
import { checkAuth, authErrorResponse }    from "./auth";
import { handleMcpRequest }                from "./mcp/router";
import { ingestUrl, IngestUrlInput }       from "./mcp/tools/ingest_url";
import { generateDigest, GenerateDigestInput } from "./mcp/tools/generate_digest";
import { listSources, ListSourcesInput }   from "./mcp/tools/list_sources";
import { handleLabApi }                    from "./lab-api";
import { handleLabChat }                   from "./lab-chat";
import {
  requireApiAuth,
  requireWebSession,
  createSession,
  destroySession,
  setSessionCookieHeader,
  clearSessionCookieHeader,
  verifyPassword,
  loginHtml,
} from "@agentbuilder/web-ui-kit";

export { ChatSession } from "./durable/ChatSession";

// The kit's auth helpers expect env.DB. CONTENT_DB is research-agent's
// existing D1 binding; we pass an env-shaped object that aliases it.
function kitEnv(env: Env): Record<string, unknown> {
  return {
    DB: env.CONTENT_DB,
    WEB_UI_PASSWORD: env.WEB_UI_PASSWORD,
    EXTERNAL_API_KEY: env.EXTERNAL_API_KEY,
  };
}

// Public favicon / web-app manifest paths under /lab/. The Vite build
// copies the matching files from src/lab/public/ into dist/ verbatim.
// Listed explicitly (rather than a prefix match) so we never bypass the
// auth gate for the SPA shell or any other /lab/* route.
const PUBLIC_LAB_ICON_PATHS = new Set<string>([
  "/lab/favicon.ico",
  "/lab/favicon.svg",
  "/lab/favicon-16.png",
  "/lab/favicon-32.png",
  "/lab/apple-touch-icon.png",
  "/lab/apple-touch-icon-precomposed.png",
  "/lab/icon-192.png",
  "/lab/icon-512.png",
  "/lab/icon-512-maskable.png",
  "/lab/manifest.webmanifest",
]);

// Icon link tags injected into the kit's loginHtml so the /lab/login
// page (and any tab opened pre-auth) shows the branded mark.
const LAB_ICON_HEAD = [
  '<link rel="icon" type="image/svg+xml" href="/lab/favicon.svg"/>',
  '<link rel="icon" type="image/png" sizes="32x32" href="/lab/favicon-32.png"/>',
  '<link rel="icon" type="image/png" sizes="16x16" href="/lab/favicon-16.png"/>',
  '<link rel="alternate icon" type="image/x-icon" href="/lab/favicon.ico"/>',
  '<link rel="apple-touch-icon" sizes="180x180" href="/lab/apple-touch-icon.png"/>',
  '<link rel="manifest" href="/lab/manifest.webmanifest"/>',
  '<meta name="theme-color" content="#0F1117"/>',
  '<meta name="apple-mobile-web-app-title" content="The Lab"/>',
  '<meta name="application-name" content="The Lab"/>',
  '<meta name="apple-mobile-web-app-capable" content="yes"/>',
  '<meta name="mobile-web-app-capable" content="yes"/>',
].join("\n");

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
    const parsed = IngestUrlInput.safeParse({
      url:          raw["url"],
      source_id:    raw["source_id"],
      note:         raw["note"],
      content:      raw["content"],
      title:        raw["title"],
      author:       raw["author"],
      published_at: raw["published_at"],
    });

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

  // ── /lab — The Lab web UI ─────────────────────────────────────────────
  // Auth flow follows the @agentbuilder/web-ui-kit convention:
  //   GET  /lab/login   shows the password form
  //   POST /lab/login   verifies WEB_UI_PASSWORD + sets session cookie
  //   GET  /lab/logout  destroys the session
  //   /lab + /lab/*     serve the Vite-built SPA from the ASSETS binding
  //                     (gated by cookie session)
  //
  // /api/lab/*          JSON API for the SPA + external apps
  //                     (cookie session OR EXTERNAL_API_KEY bearer)
  // Public favicon / web-app manifest passthrough — must run before any
  // /lab/* auth gate so the login page and MacOS Chrome's "Install as
  // App" can fetch icons unauthenticated. Strip the /lab prefix before
  // calling ASSETS, mirroring the /lab/assets/* handler below (Vite
  // emits files at dist root, not under /lab/).
  if (method === "GET" && PUBLIC_LAB_ICON_PATHS.has(url.pathname)) {
    if (!env.ASSETS) return new Response("ASSETS not configured", { status: 503 });
    const stripped = new URL(request.url);
    stripped.pathname = stripped.pathname.replace(/^\/lab\/?/, "/");
    return env.ASSETS.fetch(new Request(stripped.toString(), request));
  }

  if (url.pathname === "/lab/login" && method === "GET") {
    return new Response(loginHtml({ title: "The Lab", action: "/lab/login", head: LAB_ICON_HEAD }), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/lab/login" && method === "POST") {
    if (!env.WEB_UI_PASSWORD) {
      return new Response(loginHtml({ title: "The Lab", action: "/lab/login", head: LAB_ICON_HEAD, error: "WEB_UI_PASSWORD is not configured." }), {
        status: 500, headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    const form = await request.formData().catch(() => null);
    const password = form?.get?.("password") || "";
    if (!verifyPassword(kitEnv(env), password)) {
      return new Response(loginHtml({ title: "The Lab", action: "/lab/login", head: LAB_ICON_HEAD, error: "Wrong password." }), {
        status: 401, headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    const { sessionId } = await createSession(kitEnv(env));
    const secure = url.protocol === "https:";
    return new Response(null, {
      status: 302,
      headers: {
        location: "/lab",
        "set-cookie": setSessionCookieHeader(sessionId, { secure }),
      },
    });
  }
  if (url.pathname === "/lab/logout") {
    const session = await requireWebSession(request, kitEnv(env), { mode: "page", loginPath: "/lab/login" });
    if (session.ok) await destroySession(kitEnv(env), session.sessionId);
    const secure = url.protocol === "https:";
    return new Response(null, {
      status: 302,
      headers: {
        location: "/lab/login",
        "set-cookie": clearSessionCookieHeader({ secure }),
      },
    });
  }

  // Static asset fallthrough: the SPA itself + any /lab/* asset request.
  // We require a cookie session for ALL /lab routes so the bundle isn't
  // public.
  //
  // Vite is configured with `base: "/lab/"`, so the built index.html
  // references assets under /lab/assets/... — but Cloudflare's ASSETS
  // binding looks them up at their path-from-dist-root, which is just
  // /assets/... (dist/ has no /lab/ subdirectory). Strip the /lab prefix
  // before calling ASSETS so the lookup succeeds; otherwise the binding
  // hits its SPA fallback and returns index.html for every JS/CSS
  // request, breaking the browser's MIME check on module scripts.
  //
  // /lab/assets/* is intentionally PUBLIC (no auth gate). Vite emits
  // <script type="module" crossorigin> tags, which the browser fetches
  // in CORS mode — same-origin or not, those requests do NOT include
  // cookies (crossorigin defaults to "anonymous"). If we gate the
  // assets, the browser gets a 302 redirect to /lab/login when loading
  // the JS module, which fails strict-MIME because the response is HTML.
  // The bundle contains no secrets; the API behind it is what's
  // protected. /lab itself (the SPA shell) stays gated below.
  if (url.pathname.startsWith("/lab/assets/")) {
    if (!env.ASSETS) return new Response("ASSETS not configured", { status: 503 });
    const stripped = new URL(request.url);
    stripped.pathname = stripped.pathname.replace(/^\/lab\/?/, "/");
    return env.ASSETS.fetch(new Request(stripped.toString(), request));
  }

  if (url.pathname === "/lab" || url.pathname.startsWith("/lab/")) {
    const session = await requireWebSession(request, kitEnv(env), { mode: "page", loginPath: "/lab/login" });
    if (!session.ok) return session.response;
    if (!env.ASSETS) {
      return new Response("ASSETS binding not configured (build the Lab with `pnpm lab:build` then redeploy).", { status: 503 });
    }
    const stripped = new URL(request.url);
    stripped.pathname = stripped.pathname.replace(/^\/lab\/?/, "/") || "/";
    return env.ASSETS.fetch(new Request(stripped.toString(), request));
  }

  // ── /api/lab/* — JSON API for the Lab SPA + external apps ─────────────
  if (url.pathname.startsWith("/api/lab/")) {
    const auth = await requireApiAuth(request, kitEnv(env));
    if (!auth.ok) return auth.response;
    if (url.pathname === "/api/lab/chat" && method === "POST") {
      return await handleLabChat(request, env, ctx);
    }
    const labResponse = await handleLabApi(request, env);
    if (labResponse) return labResponse;
    return jsonResponse({ error: `Not found: ${method} ${url.pathname}` }, 404);
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
  if (controller.cron === "*/30 * * * *") {
    ctx.waitUntil(
      runCron(
        env,
        { agentId: "research-agent", trigger: "poll-bluesky", cron: controller.cron },
        async () => {
          const { runPollBluesky } = await import("./cron/poll_bluesky");
          return await runPollBluesky(env, ctx);
        },
      ),
    );
  }
  if (controller.cron === "*/5 * * * *") {
    ctx.waitUntil(
      runCron(
        env,
        { agentId: "research-agent", trigger: "check-watches", cron: controller.cron },
        async () => {
          const { runCheckWatches } = await import("./cron/check_watches");
          return await runCheckWatches(env, ctx);
        },
      ),
    );
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
