/**
 * Shopping Price Tracker — Worker entrypoint.
 *
 * Routes
 *   GET  /health                Liveness probe
 *   POST /mcp                   MCP JSON-RPC server (Bearer MCP_HTTP_KEY)
 *   GET/POST/PATCH/DELETE /api/v1/*   External REST (Bearer EXTERNAL_API_KEY)
 *   GET  /app/login             Password form
 *   POST /app/login             Verify + set session cookie
 *   GET  /app/logout            Destroy session
 *   GET  /app/app.js            SPA bundle (cookie-gated)
 *   GET  /app, /app/*           SPA shell (cookie-gated)
 *   GET/POST/PATCH/DELETE /app/api/*  SPA REST (cookie-gated)
 *   *                            Static assets via env.ASSETS
 *
 * Crons
 *   0 12 * * *     daily digest
 *   0 *\/4 * * *   priority refresh (high-priority items only)
 */

import {
  appHtml,
  clearSessionCookieHeader,
  createSession,
  destroySession,
  loginHtml,
  requireApiAuth,
  requireWebSession,
  setSessionCookieHeader,
  SPA_CORE_JS,
  verifyPassword,
} from "@agentbuilder/web-ui-kit";
import { runCron } from "@agentbuilder/observability";
import { runDailyDigest } from "./cron/daily";
import { runPriorityRefresh } from "./cron/priority";
import { handleMcpRequest } from "./mcp/server";
import type { Env } from "./types";
import { routeApi } from "./web/api";
// @ts-expect-error — JS module concatenated into the SPA bundle.
import { SPA_PAGES_JS } from "./web/spa-pages.js";

export { ShoppingPriceTrackerDO } from "./durable-object";

const APP_TITLE = "Shopping Price Tracker";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
  });
}

function checkMcpAuth(
  request: Request,
  env: Env,
): { ok: true } | { ok: false; response: Response } {
  const expected = env.MCP_HTTP_KEY ?? "";
  if (!expected) return { ok: true }; // unset = open (matches scaffolder behavior)
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? new URL(request.url).searchParams.get("key") ?? "";
  if (token === expected) return { ok: true };
  return { ok: false, response: jsonResponse({ error: "Unauthorized" }, 401) };
}

function mcpCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
  };
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: mcpCorsHeaders() });
  }

  // ── /health ─────────────────────────────────────────────────────────────────
  if (method === "GET" && url.pathname === "/health") {
    return jsonResponse({
      status: "ok",
      agent: "shopping-price-tracker",
      environment: env.ENVIRONMENT ?? "unknown",
      ts: new Date().toISOString(),
    });
  }

  // ── /mcp — JSON-RPC ─────────────────────────────────────────────────────────
  if (url.pathname === "/mcp" && method === "POST") {
    const auth = checkMcpAuth(request, env);
    if (!auth.ok) return auth.response;
    const response = await handleMcpRequest(request, env);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(mcpCorsHeaders())) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  }

  // ── /api/v1/* — external REST (bearer) ──────────────────────────────────────
  if (url.pathname.startsWith("/api/v1/") || url.pathname === "/api/v1") {
    const auth = await requireApiAuth(request, env);
    if (!auth.ok) return auth.response;
    return await routeApi(request, env, "/api/v1");
  }

  // ── /app/login — GET form, POST verify ──────────────────────────────────────
  if (url.pathname === "/app/login") {
    if (method === "GET") {
      return new Response(loginHtml({ title: APP_TITLE, action: "/app/login" }), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (method === "POST") {
      if (!env.WEB_UI_PASSWORD) {
        return new Response(
          loginHtml({
            title: APP_TITLE,
            action: "/app/login",
            error: "WEB_UI_PASSWORD is not configured.",
          }),
          { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      const form = await request.formData().catch(() => null);
      const password = form?.get?.("password") || "";
      if (!verifyPassword(env, password)) {
        return new Response(
          loginHtml({ title: APP_TITLE, action: "/app/login", error: "Wrong password." }),
          { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      const { sessionId } = await createSession(env);
      const secure = url.protocol === "https:";
      return new Response(null, {
        status: 302,
        headers: {
          location: "/app",
          "set-cookie": setSessionCookieHeader(sessionId, { secure }),
        },
      });
    }
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // ── /app/logout ─────────────────────────────────────────────────────────────
  if (url.pathname === "/app/logout") {
    const session = await requireWebSession(request, env, { mode: "page" });
    if (session.ok && session.sessionId) await destroySession(env, session.sessionId);
    const secure = url.protocol === "https:";
    return new Response(null, {
      status: 302,
      headers: { location: "/app/login", "set-cookie": clearSessionCookieHeader({ secure }) },
    });
  }

  // ── /app/app.js — SPA bundle ────────────────────────────────────────────────
  if (method === "GET" && url.pathname === "/app/app.js") {
    const auth = await requireWebSession(request, env, { mode: "page" });
    if (!auth.ok) return auth.response;
    return new Response(`${SPA_CORE_JS}\n${SPA_PAGES_JS}`, {
      status: 200,
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  // ── /app/api/* — SPA REST (cookie) ──────────────────────────────────────────
  if (url.pathname.startsWith("/app/api/")) {
    const auth = await requireWebSession(request, env, { mode: "api" });
    if (!auth.ok) return auth.response;
    return await routeApi(request, env, "/app/api");
  }

  // ── /app, /app/* — SPA shell ────────────────────────────────────────────────
  if (method === "GET" && (url.pathname === "/app" || url.pathname.startsWith("/app/"))) {
    const auth = await requireWebSession(request, env, { mode: "page" });
    if (!auth.ok) return auth.response;
    return new Response(appHtml({ title: APP_TITLE }), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // ── Fall through to static assets ───────────────────────────────────────────
  return env.ASSETS.fetch(request);
}

async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron === "0 12 * * *") {
    await runCron(
      env,
      { agentId: "shopping-price-tracker", trigger: "daily-digest", cron: controller.cron },
      () => runDailyDigest(env),
    );
    return;
  }
  if (controller.cron === "0 */4 * * *") {
    await runCron(
      env,
      { agentId: "shopping-price-tracker", trigger: "priority-refresh", cron: controller.cron },
      () => runPriorityRefresh(env),
    );
    return;
  }
}

export default {
  fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env);
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(handleScheduled(controller, env));
  },
} satisfies ExportedHandler<Env>;
