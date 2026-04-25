# Web UI template

Scaffold a `/app` web surface for an existing agent. Copies these files into
`apps/<agent>/src/web/`, adds a D1 migration for `WebSessions` (and
optionally `Briefs`), and wires routes into the agent's `worker.js`.

**This is a template — customize the agent-specific parts after copying.**
The kit (`@agentbuilder/web-ui-kit`) provides everything that's truly
shared: auth, HTML shell, SPA core, chat tool-loop runtime. Per-agent
files only describe *what* this agent does, not *how* the UI scaffolds.

## What you get

- `web/auth.js`        — re-export shim for the kit's auth helpers
- `web/spa-html.js`    — agent-branded login + app shell
- `web/api.js`         — JSON endpoints (`/api/...`) for the SPA
- `web/spa-pages.js`   — page renderers (one example page included)
- `web/chat.js`        — chat sidebar wiring (curated tool allowlist + system prompt)
- `migration.sql`      — D1 schema fragment to append to your next migration
- `worker-snippet.md`  — code to paste into `worker.js` for routing

## What you provide

1. **Agent-specific NAV** — top-level pages (e.g. Today, Projects, People).
2. **Page renderers** — what each page shows, calling `/api/*`.
3. **Tool allowlist** — which agent tools the chat sidebar can call.
4. **System prompt** — how the chat persona should think + behave.

## Required secrets

Set on the agent's Worker before deploy:

```bash
wrangler secret put WEB_UI_PASSWORD     # browser login
wrangler secret put ANTHROPIC_API_KEY   # chat sidebar (only)
wrangler secret put EXTERNAL_API_KEY    # bearer auth for /api/* from other apps
```

## Reference implementation

`apps/chief-of-staff/src/web/` is the canonical worked example. Copy
patterns from there — task row component, propose/commit pattern,
day/week brief editor, voice-input wiring.
