# worker.js / index.ts wiring snippet

Paste these blocks into the agent's worker entry. Replace `{{SURFACE}}`
(e.g. `lab`, `console`, `studio`) and `{{AGENT_NAME}}` with the agent's
public name.

## 1. wrangler.toml — add the assets binding

```toml
[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
```

## 2. Imports

```ts
import {
  requireApiAuth, requireWebSession,
  createSession, destroySession,
  setSessionCookieHeader, clearSessionCookieHeader,
  verifyPassword, loginHtml,
} from "@agentbuilder/web-ui-kit";

// If your agent's D1 binding isn't named `DB`, alias it for the kit.
function kitEnv(env: Env): Record<string, unknown> {
  return {
    DB: env.YOUR_D1_BINDING,
    WEB_UI_PASSWORD: env.WEB_UI_PASSWORD,
    EXTERNAL_API_KEY: env.EXTERNAL_API_KEY,
  };
}
```

## 3. Routes (BEFORE any final 404 fallthrough)

```ts
// Login + logout
if (url.pathname === "/{{SURFACE}}/login" && method === "GET") {
  return new Response(loginHtml({ title: "{{AGENT_NAME}}" }), {
    status: 200, headers: { "content-type": "text/html; charset=utf-8" },
  });
}
if (url.pathname === "/{{SURFACE}}/login" && method === "POST") {
  if (!env.WEB_UI_PASSWORD) {
    return new Response(loginHtml({ title: "{{AGENT_NAME}}", error: "WEB_UI_PASSWORD not configured" }), {
      status: 500, headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const form = await request.formData().catch(() => null);
  const password = form?.get?.("password") || "";
  if (!verifyPassword(kitEnv(env), password)) {
    return new Response(loginHtml({ title: "{{AGENT_NAME}}", error: "Wrong password." }), {
      status: 401, headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const { sessionId } = await createSession(kitEnv(env));
  const secure = url.protocol === "https:";
  return new Response(null, {
    status: 302,
    headers: {
      location: "/{{SURFACE}}",
      "set-cookie": setSessionCookieHeader(sessionId, { secure }),
    },
  });
}
if (url.pathname === "/{{SURFACE}}/logout") {
  const session = await requireWebSession(request, kitEnv(env), { mode: "page" });
  if (session.ok) await destroySession(kitEnv(env), session.sessionId);
  const secure = url.protocol === "https:";
  return new Response(null, {
    status: 302,
    headers: {
      location: "/{{SURFACE}}/login",
      "set-cookie": clearSessionCookieHeader({ secure }),
    },
  });
}

// SPA shell + assets — auth-gated so the bundle isn't public.
if (url.pathname === "/{{SURFACE}}" || url.pathname.startsWith("/{{SURFACE}}/")) {
  const session = await requireWebSession(request, kitEnv(env), { mode: "page" });
  if (!session.ok) return session.response;
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response("ASSETS binding not configured (build the SPA first).", { status: 503 });
}

// JSON API — cookie session OR bearer key.
if (url.pathname.startsWith("/api/{{SURFACE}}/")) {
  const auth = await requireApiAuth(request, kitEnv(env));
  if (!auth.ok) return auth.response;
  // dispatch to your agent's /api/{{SURFACE}}/* handlers...
}
```

## 4. Required secrets

```bash
wrangler secret put WEB_UI_PASSWORD
wrangler secret put ANTHROPIC_API_KEY     # if you have a chat sidebar
wrangler secret put EXTERNAL_API_KEY      # bearer for /api/{{SURFACE}}/v1/*
```
