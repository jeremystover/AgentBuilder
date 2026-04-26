# worker.js wiring snippet

Paste these blocks into the agent's `src/worker.js`. Adjust the
`buildToolContext(env)` call site to match the agent's existing context
helper (for chief-of-staff that's where tools, sheets, env are bundled).

## 1. Imports (top of file)

```js
import {
  requireWebSession,
  requireApiAuth,
  createSession,
  destroySession,
  setSessionCookieHeader,
  clearSessionCookieHeader,
  verifyPassword,
  SPA_CORE_JS,
} from "@agentbuilder/web-ui-kit";
import { handleApiRequest } from "./web/api.js";
import { handleChatRequest } from "./web/chat.js";
import { loginHtml, appHtml } from "./web/spa-html.js";
import { SPA_PAGES_JS } from "./web/spa-pages.js";
```

## 2. Routes (inside the fetch() handler, BEFORE any /mcp or fallthrough 404)

```js
// /app/login — GET shows form, POST verifies + sets cookie.
if (urlObj.pathname === "/app/login") {
  if (request.method === "GET") {
    return new Response(loginHtml({}), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (request.method === "POST") {
    if (!env.WEB_UI_PASSWORD) {
      return new Response(loginHtml({ error: "WEB_UI_PASSWORD is not configured." }), {
        status: 500, headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    const form = await request.formData().catch(() => null);
    const password = form?.get?.("password") || "";
    if (!verifyPassword(env, password)) {
      return new Response(loginHtml({ error: "Wrong password." }), {
        status: 401, headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (!env.DB) return new Response("D1 binding required.", { status: 500 });
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

// /app/logout
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

// /app/app.js — concatenated SPA bundle.
if (request.method === "GET" && urlObj.pathname === "/app/app.js") {
  const auth = await requireWebSession(request, env, { mode: "page" });
  if (!auth.ok) return auth.response;
  return new Response(SPA_CORE_JS + "\n" + SPA_PAGES_JS, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// /app or /app/* — serve the SPA shell.
if (request.method === "GET" && (urlObj.pathname === "/app" || urlObj.pathname.startsWith("/app/"))) {
  const auth = await requireWebSession(request, env, { mode: "page" });
  if (!auth.ok) return auth.response;
  return new Response(appHtml(), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// /api/* — JSON API for the SPA + external apps.
if (urlObj.pathname.startsWith("/api/")) {
  const auth = await requireApiAuth(request, env);
  if (!auth.ok) return auth.response;
  const ctx = buildToolContext(env);  // your agent's existing helper
  if (urlObj.pathname === "/api/chat" && request.method === "POST") {
    return await handleChatRequest(request, ctx);
  }
  return await handleApiRequest(request, ctx);
}
```

## 3. Required secrets (set before deploy)

```bash
wrangler secret put WEB_UI_PASSWORD     # browser login
wrangler secret put ANTHROPIC_API_KEY   # chat sidebar
wrangler secret put EXTERNAL_API_KEY    # bearer auth for /api/* from other apps
```

## 4. wrangler.toml — D1 binding

Make sure your agent has `[[d1_databases]]` configured. The kit's
`WebSessions` table lives in the same D1 database as your agent's data.
