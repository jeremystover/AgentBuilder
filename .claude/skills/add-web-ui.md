---
name: add-web-ui
description: Add a /app web UI to an existing agent using @agentbuilder/web-ui-kit. Use when the user asks "add a web UI to <agent>", "build a dashboard for <agent>", or any request to give an agent a browser-facing surface. Wires auth, SPA shell, /api/* + /api/v1/* routes, and the chat sidebar runtime in one consistent shape across the fleet.
---

# add-web-ui

You are adding a web UI to an existing agent under `apps/<agent>/`. The
fleet has a shared kit at `packages/web-ui-kit/` and a scaffold template
at `.agent-builder/templates/web-ui/`. **Never re-implement auth, the
SPA shell, or the chat tool-loop.** Always use the kit.

## Before you start

Confirm with the user:

1. **Which agent?** Locate `apps/<agent>/` and read `apps/<agent>/SKILL.md`
   to understand its tools and data model.
2. **Which pages?** Get a short list (e.g. "Today, Projects, People").
3. **Mutations?** Does this agent use the `propose_* + commit_changeset`
   pattern, or direct writes? Determines whether the API uses
   `proposeAndCommit` or `callTool` for mutations.
4. **Chat tool surface?** Pick a curated allowlist of ≤20 tool names
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
pnpm --filter @agentbuilder/app-<agent> deploy
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
