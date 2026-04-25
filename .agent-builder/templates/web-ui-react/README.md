# Web UI (React + Vite) template

Use this when an agent needs a custom-design SPA that the no-build kit
default can't deliver — typically when the user supplies an explicit
visual spec (e.g. "dark theme, mind map view, drag-and-drop kanban") or
needs heavy client-side libraries (React Flow, dnd-kit, etc.).

**Most agents should use the default `web-ui/` template.** Reach for this
one only when the no-build vanilla SPA is genuinely insufficient.

## What stays consistent across modes

Both modes share these conventions (enforced in AGENTS.md rule 9):

- Cookie auth (`WEB_UI_PASSWORD`) + bearer auth (`EXTERNAL_API_KEY`) via `@agentbuilder/web-ui-kit`
- `WebSessions` D1 table from `WEB_SESSIONS_SQL`
- `/api/v1/<noun>` external REST surface for cross-app integrations
- Chat sidebar (when present) calls `runChat` / `chatHandler` from the kit

What this template adds:

- Vite + React + TypeScript build pipeline
- Tailwind CSS with custom theme tokens
- Wrangler `[assets]` binding serving the Vite output
- Tooling: `pnpm lab:dev` (Vite HMR), `pnpm lab:build`, `pnpm deploy` (build then wrangler deploy)

## What you provide

1. **wrangler.toml** — add `[assets] directory = "./dist"` and a `not_found_handling = "single-page-application"` (this template has it)
2. **Custom SPA design** — components, theme, layout
3. **API endpoints** — JSON routes the SPA calls (under `/api/<surface>/*`)
4. **Chat allowlist + system prompt** — if the SPA has a chat surface

## Reference implementation

`apps/research-agent/` (with The Lab at `/lab`) is the worked example:
- Three-panel layout (Research Feed / Chat / Ideas)
- Dark theme with DM Mono headings, IBM Plex Sans body
- Drag-and-drop kanban (dnd-kit) + force-laid-out mind map (React Flow)
- Promote-idea-to-project flow that calls chief-of-staff over MCP

## Required secrets (per agent)

```bash
wrangler secret put WEB_UI_PASSWORD
wrangler secret put ANTHROPIC_API_KEY      # if you have a chat sidebar
wrangler secret put EXTERNAL_API_KEY        # for /api/<surface>/v1/*
wrangler secret put CHIEF_OF_STAFF_MCP_KEY  # if you call chief-of-staff
```

## Files in this template

- `package.json.tmpl`          — adds React + Vite + Tailwind + kit + LLM deps
- `wrangler.toml.tmpl`         — adds `[assets]` block
- `tsconfig.json.tmpl`         — worker tsconfig (excludes `src/lab/**`)
- `tsconfig.lab.json.tmpl`     — separate tsconfig for the React app (DOM lib, JSX)
- `vite.config.ts.tmpl`        — Vite root + base + outDir wiring
- `tailwind.config.ts.tmpl`    — design tokens (replace with your theme)
- `postcss.config.js.tmpl`     — autoprefixer + tailwind
- `migrations/000N_web_ui.sql` — `WebSessions` + optional `Briefs`
- `src/lab/index.html.tmpl`    — SPA entry
- `src/lab/main.tsx.tmpl`      — React root
- `src/lab/App.tsx.tmpl`       — minimal shell (one panel)
- `src/lab/index.css.tmpl`     — Tailwind base + scrollbar styling
- `src/lab/types.ts.tmpl`      — shared types
- `src/lab/api.ts.tmpl`        — fetch wrappers
- `worker-snippet.md`          — wiring for index.ts (auth + `/api/*` + assets fallback)
