---
name: add-web-ui
description: Add a /app or /lab web UI to an existing agent using @agentbuilder/web-ui-kit. Use when the user asks "add a web UI to <agent>", "build a dashboard for <agent>", or any request to give an agent a browser-facing surface. Picks between the vanilla and React+Vite modes, wires auth, SPA shell, /api/<surface>/* + /api/<surface>/v1/* routes, and the chat sidebar runtime in one consistent shape across the fleet.
---

# add-web-ui

You are adding a web UI to an existing agent under `apps/<agent>/`. The
fleet has a shared kit at `packages/web-ui-kit/` and two scaffold
templates: `.agent-builder/templates/web-ui/` (vanilla, default) and
`.agent-builder/templates/web-ui-react/` (React + Vite, escape hatch).
**Never re-implement auth, sessions, or the chat tool-loop.** Always use
the kit.

## Before you start

Confirm with the user:

1. **Which agent?** Locate `apps/<agent>/` and read `apps/<agent>/SKILL.md`
   to understand its tools and data model.
2. **Which mode?** Default to **vanilla** (no build step, light/paper theme,
   Tailwind CDN — chief-of-staff style). Switch to **React+Vite** ONLY if:
   - The user supplies an explicit visual design (dark theme, custom tokens, etc.)
   - The UI needs heavy client-side libs (React Flow mind map, drag-and-drop kanban, etc.)
   - The user explicitly asks for React/Vite/TypeScript SPA
   When in doubt, ask the user. The escape hatch is heavier — Vite build,
   more deps, more config.
3. **Which surface path?** Default `/app` for vanilla, `/lab` for React+Vite
   (matches the references). Confirm before committing.
4. **Which pages?** Get a short list (e.g. "Today, Projects, People").
5. **Mutations?** Does this agent use the `propose_* + commit_changeset`
   pattern, or direct writes? Determines whether the API uses
   `proposeAndCommit` or `callTool` for mutations.
6. **Chat tool surface?** Pick a curated allowlist of ≤20 tool names
   from the agent's existing registry (AGENTS.md rule 2).

If anything's ambiguous, ask one specific question instead of guessing.
The chief-of-staff implementation at `apps/chief-of-staff/src/web/` is
the canonical reference — read it first when in doubt.

## Steps

### 1. Add the dependency

Edit `apps/<agent>/package.json`:

```json
"dependencies": {
  "@agentbuilder/web-ui-kit": "workspace:*"
}
```

Run `pnpm install` from the repo root.

### 2. Copy the template

```bash
mkdir -p apps/<agent>/src/web
cp .agent-builder/templates/web-ui/web/auth.js.tmpl     apps/<agent>/src/web/auth.js
cp .agent-builder/templates/web-ui/web/spa-html.js.tmpl apps/<agent>/src/web/spa-html.js
cp .agent-builder/templates/web-ui/web/api.js.tmpl      apps/<agent>/src/web/api.js
cp .agent-builder/templates/web-ui/web/spa-pages.js.tmpl apps/<agent>/src/web/spa-pages.js
cp .agent-builder/templates/web-ui/web/chat.js.tmpl     apps/<agent>/src/web/chat.js
```

Replace placeholders in every copied file:

- `{{AGENT_NAME}}` → human-readable name (e.g. "Chief of Staff")
- `{{AGENT_ID}}` → directory name (e.g. "chief-of-staff")

Verify with `grep -r "{{" apps/<agent>/src/web/` — must return nothing.

### 3. Add D1 schema

Append the contents of `.agent-builder/templates/web-ui/migration.sql`
to a new migration file: `apps/<agent>/migrations/000N_web_ui.sql`
(numbered after the agent's existing migrations).

If the agent doesn't use day/week briefs, drop the `Briefs` block.

### 4. Wire `worker.js`

Read `.agent-builder/templates/web-ui/worker-snippet.md` and paste the
imports + routing blocks into the agent's `worker.js`. The routing
block must run BEFORE any `/mcp` route or final 404 fallback.

If the agent doesn't have a `buildToolContext(env)` helper, extract one
from its existing inline tool construction so `/mcp` and `/api/*` share
the same registry — chief-of-staff's `worker.js` shows the pattern.

### 5. Customize the agent-specific pieces

- **`web/api.js`** — replace the example `/api/items` route with real
  routes for the agent's data model. Use `proposeAndCommit` for
  mutations if the agent uses changesets.
- **`web/spa-pages.js`** — replace `pageHome` with one renderer per
  page in the user's NAV list. Update `window.NAV` and `window.ROUTES`.
- **`web/chat.js`** — set `CHAT_TOOL_ALLOWLIST` to ≤20 of the agent's
  tool names. Tune the `SYSTEM_PROMPT` to the agent's persona.

### 6. Document secrets

Add to the agent's `wrangler.toml` comments (matching chief-of-staff's
style):

```
#   wrangler secret put WEB_UI_PASSWORD     — browser login
#   wrangler secret put ANTHROPIC_API_KEY   — chat sidebar
#   wrangler secret put EXTERNAL_API_KEY    — bearer auth for /api/* from other apps
```

### 7. Verify

```bash
pnpm --filter @agentbuilder/app-<agent> typecheck
pnpm --filter @agentbuilder/app-<agent> build       # wrangler dry-run
pnpm --filter @agentbuilder/app-<agent> test        # if tests exist
```

All three must pass before commit.

### 8. Apply migration + deploy

```bash
wrangler d1 execute <agent>-db --remote --file=apps/<agent>/migrations/000N_web_ui.sql
wrangler secret put WEB_UI_PASSWORD --name <agent>
wrangler secret put ANTHROPIC_API_KEY --name <agent>
wrangler secret put EXTERNAL_API_KEY --name <agent>
pnpm --filter @agentbuilder/app-<agent> run deploy
```

### 9. Smoke test

```bash
curl https://<worker>.workers.dev/app/login              # 200, login form HTML
curl -X POST https://<worker>.workers.dev/api/v1/items \
  -H "Authorization: Bearer $EXTERNAL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"title":"smoke test"}'                            # 201, { ok: true }
```

Then open `https://<worker>.workers.dev/app/login` in a browser, sign in,
verify the SPA loads + the chat sidebar responds.

## React + Vite mode (escape hatch)

When the user picked the React mode, swap the steps above for these:

### React 1. Add the dependency

Edit `apps/<agent>/package.json` from the React template (`.tmpl` files
in `.agent-builder/templates/web-ui-react/`). Adds React, Vite, Tailwind,
plus the kit + LLM workspace deps. Run `pnpm install` from the repo root.

### React 2. Copy the template

```bash
mkdir -p apps/<agent>/src/lab/{components,hooks}
cp .agent-builder/templates/web-ui-react/vite.config.ts.tmpl     apps/<agent>/vite.config.ts
cp .agent-builder/templates/web-ui-react/tailwind.config.ts.tmpl apps/<agent>/tailwind.config.ts
cp .agent-builder/templates/web-ui-react/postcss.config.js.tmpl  apps/<agent>/postcss.config.js
cp .agent-builder/templates/web-ui-react/tsconfig.lab.json.tmpl  apps/<agent>/tsconfig.lab.json
cp .agent-builder/templates/web-ui-react/src/lab/index.html.tmpl apps/<agent>/src/lab/index.html
cp .agent-builder/templates/web-ui-react/src/lab/main.tsx.tmpl   apps/<agent>/src/lab/main.tsx
cp .agent-builder/templates/web-ui-react/src/lab/App.tsx.tmpl    apps/<agent>/src/lab/App.tsx
cp .agent-builder/templates/web-ui-react/src/lab/index.css.tmpl  apps/<agent>/src/lab/index.css
cp .agent-builder/templates/web-ui-react/src/lab/api.ts.tmpl     apps/<agent>/src/lab/api.ts
```

Replace placeholders: `{{AGENT_ID}}`, `{{AGENT_NAME}}`, `{{SURFACE}}`
(e.g. "lab", "console", "studio").

### React 3. Adjust the existing tsconfig.json

The agent's existing `tsconfig.json` must exclude the React folder so the
worker typecheck doesn't see DOM/JSX types:

```json
"exclude": ["src/lab/**", "dist", ".wrangler-dist"]
```

Update `package.json`'s typecheck script:

```json
"typecheck": "tsc --noEmit && tsc -p tsconfig.lab.json --noEmit"
```

### React 4. Add D1 schema + wire wrangler.toml

- Append `migrations/000N_web_ui.sql` (kit's `WebSessions` table)
- Add the `[assets]` block to `wrangler.toml` (see worker-snippet.md)
- Add a `binding = "ASSETS"` so the worker can call `env.ASSETS.fetch(request)`

### React 5. Wire the worker

Read `.agent-builder/templates/web-ui-react/worker-snippet.md`. The
shape is the same as the vanilla mode but with one extra bit: after auth
gating, the SPA falls through to `env.ASSETS.fetch(request)` instead of
returning an inline HTML string.

### React 6. Build the SPA + verify

```bash
pnpm --filter @agentbuilder/app-<agent> lab:build         # vite build → dist/
pnpm --filter @agentbuilder/app-<agent> typecheck         # both tsconfigs
pnpm --filter @agentbuilder/app-<agent> exec wrangler deploy --dry-run --outdir=.wrangler-dist
```

All three must pass.

### React 7. Iterate on the SPA

Live reload during development:

```bash
# Terminal 1 — Worker (handles /api/* and auth):
pnpm --filter @agentbuilder/app-<agent> dev

# Terminal 2 — Vite HMR for the SPA:
pnpm --filter @agentbuilder/app-<agent> lab:dev
# Open http://localhost:5173/<surface>/
```

The Vite dev server proxies `/api/<surface>/*` and the login routes to
the Worker on port 8787 so the cookie session works in HMR.

### React 8. Deploy

```bash
pnpm --filter @agentbuilder/app-<agent> run deploy   # builds Vite, then wrangler deploy
```

The CI deploy workflow at `.github/workflows/deploy-<agent>.yml` should
also run `pnpm lab:build` before `wrangler deploy` — verify before
merging.

## Rules of thumb

- **Don't** add a build step. The SPA bundle is concatenated strings; no
  esbuild/JSX. Vanilla JS, Tailwind via CDN.
- **Don't** customize colors, fonts, or layout structure. Visual
  consistency across the fleet is the whole point of the kit.
- **Don't** expose more than ~20 tools to the chat. Past that,
  tool-selection accuracy degrades.
- **Do** mirror the chief-of-staff patterns when uncertain — task row,
  modal editor, propose/commit flow, voice input, brief autosave.
- **Do** add `/api/v1/<noun>` routes for any record type other apps
  might want to create (tasks, items, projects, people). The bearer-key
  auth is already wired by `requireApiAuth`.
