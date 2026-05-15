# AGENTS.md

Conventions for Claude (and humans) working in this repo.

## Layout

```
apps/                 One Cloudflare Worker per agent. Deployable unit.
packages/             Shared TypeScript libraries. Consumed via workspace:*.
registry/agents.json  Source of truth for the agent fleet.
.agent-builder/
  templates/          Scaffold templates used by `pnpm create-agent`.
tools/                Repo-wide CLI tooling (run with `tsx`).
```

## Rules

1. **Never create a new agent that duplicates an existing one.** Check `registry/agents.json` first. Prefer extending an existing agent or adding to a shared package.
2. **Keep tool surfaces under ~10 per agent.** Tool-selection accuracy degrades past that.
3. **Every agent needs a SKILL.md.** Purpose + non-goals + routing examples + tool list. Non-goals are mandatory — they prevent drift.
4. **Shared code lives in `packages/*`.** If you see duplicated logic across two agents, extract it. Don't copy-paste.
5. **One OAuth client per provider, reused across the fleet.** Use `@agentbuilder/auth-google` and `@agentbuilder/auth-github` — never import `google-auth-library` or `@octokit/*` directly in an app.
6. **Model tiers, not model ids.** Call `llm.complete({ tier: 'default' })`. Don't hardcode `claude-sonnet-4-6`.
7. **Prompt caching is on by default.** Keep system prompts stable to benefit from it.
8. **D1 is the shared store.** All fleet persistence goes through the `agentbuilder-core` D1 database with per-agent table prefixes.
9. **Web UIs always use `@agentbuilder/web-ui-kit` for auth, sessions, and the `/api/v1/*` external surface.** The SPA visual layer can be either:

    - **Vanilla mode (default)** — no build step, Tailwind via CDN, light/paper theme. Use this for almost every agent. Template: `.agent-builder/templates/web-ui/`. Reference: `apps/chief-of-staff/src/web/`.
    - **React+Vite mode (escape hatch)** — only when the user has explicit design requirements the vanilla shell can't deliver (e.g. dark theme, mind map, drag-and-drop, design tokens unique to the agent). Template: `.agent-builder/templates/web-ui-react/`. Reference: `apps/research-agent/src/lab/` (The Lab).

    Both modes share the same auth surface (cookie `WEB_UI_PASSWORD` + bearer `EXTERNAL_API_KEY`), the `WebSessions` D1 table, and the `/api/<surface>/v1/*` external REST convention. To add a UI, invoke the Claude Code `add-web-ui` skill — it asks which mode and copies the right template.
10. **Runtime agent system prompts prepend `CORE_BEHAVIORAL_PREAMBLE`** from `@agentbuilder/llm`. The full coding/agent guidelines for Claude Code working in this repo live in `/CLAUDE.md`. Three of the AgentBuilder personas (architect, builder, fleet-manager) already do this; new agents pick it up via the scaffold templates.

11. **Every `scheduled()` handler runs through `@agentbuilder/observability`'s `runCron`.** The wrapper writes one row per invocation to `cron_runs` in the shared `agentbuilder-core` D1, plus a `cron_errors` row on failure. The `/dashboard` UI on `agent-builder` reads those tables, so this is what keeps "is this cron running? did it succeed?" answerable. Concretely, every agent with a cron MUST:

    - Add `@agentbuilder/observability` to `dependencies` and bind `agentbuilder-core` as `AGENTBUILDER_CORE_DB` in `wrangler.toml` (alongside the agent's own DB if any).
    - Call `runCron(env, { agentId, trigger, cron }, handler)` from inside `scheduled()` for every cron expression. `agentId` MUST match the registry id; `trigger` is a stable kebab-case name (e.g. `morning-brief`, `daily-poll`) — the dashboard groups by `(agentId, trigger)`.
    - Register every cron in the registry: `agents[].crons[] = { schedule, trigger, description }`. Schedules and triggers must match the wrangler.toml + scheduled() handler exactly, or the dashboard will show an orphan job.
    - Register every secret in `agents[].secrets[]`. Names only — values stay in Cloudflare Secrets Store. The dashboard surfaces this list so the operator knows what to `wrangler secret put` before deploying.

    The `chief-of-staff` and `cfo` agents are reference implementations. New agents pick this up automatically via the scaffold template.

12. **Every `fetch()` handler is wrapped with `@agentbuilder/observability`'s `withObservability`.** This is the request-side analogue of rule 11: uncaught throws are recorded to `fleet_errors` + `bug_tickets` in `agentbuilder-core` D1, where the `/fleet-doctor` scheduled session triages them. Concretely, every agent with a `fetch()` handler MUST:

    - Export `fetch` wrapped: `export default { ...worker, fetch: withObservability(agentId, worker.fetch) }`.
    - Mount `POST /api/v1/client-error` → `handleClientError(req, env, agentId)` (public) so the SPA can report browser errors. Web SPAs add the `sendBeacon` snippet to their entry point.
    - Routes that catch their own errors and return a 5xx SHOULD call `logRequestError(env, agentId, 'request', err, ctx)` so the real stack is preserved.

    `cfo` is the reference implementation.

## Creating a new agent

```bash
pnpm create-agent my-agent --kind headless --name "My Agent" \
  --purpose "One sentence describing what it does" --owner you \
  --d1-database my-agent-db   # optional; omit if the agent has no D1
pnpm install
pnpm --filter @agentbuilder/app-my-agent typecheck
pnpm --filter @agentbuilder/app-my-agent dev
```

Fill in `apps/my-agent/SKILL.md` before merging. The registry entry is
created automatically in draft status; flip to `active` when it's deployed.

`create-agent` also writes `.github/workflows/deploy-my-agent.yml`, which
runs D1 migrations and `wrangler deploy` on push to `main`. See the
"Continuous deployment" section of the README for required secrets.

Before merging, fill in these registry fields on the new entry so the
dashboard renders the agent properly:

- `tools[]` — names; optionally `toolDescriptions: { [name]: "..." }` for one-liners.
- `secrets[]` — every secret the worker reads from `env.X`. Names only; the dashboard shows them so an operator knows what to `wrangler secret put` before deploying.
- `crons[]` — one entry per scheduled trigger, with `{ schedule, trigger, description }`. Schedules MUST match `wrangler.toml`; triggers MUST match the kebab-case name passed to `runCron(env, { trigger }, ...)`. Skip if the agent has no `[triggers]` section.
- `cloudflare.d1[]` — populated automatically; if you add a new D1 binding, also wire it into `apps/agent-builder/wrangler.toml` under `DB_<AGENT>` so the D1 Browser tab can list its tables.

## Adding a scheduled job

If your agent grows a new cron (or a new agent gains its first cron):

1. Add the expression to `wrangler.toml` under `[triggers].crons`.
2. Add `@agentbuilder/observability` to `package.json` dependencies if absent.
3. Bind the shared D1 in `wrangler.toml`:
   ```toml
   [[d1_databases]]
   binding = "AGENTBUILDER_CORE_DB"
   database_name = "agentbuilder-core"
   database_id = "51a422d2-e9ea-46e8-b6c8-233229434eca"
   ```
   And add `AGENTBUILDER_CORE_DB?: D1Database` to the agent's `Env` interface.
4. In `scheduled()`, dispatch each cron expression through `runCron`:
   ```ts
   import { runCron } from "@agentbuilder/observability";

   async scheduled(controller, env, ctx) {
     if (controller.cron === "0 7 * * *") {
       ctx.waitUntil(runCron(
         env,
         { agentId: "my-agent", trigger: "morning-brief", cron: controller.cron },
         () => generateMorningBrief(env),
       ));
     }
   }
   ```
   `runCron` catches the handler's exceptions, writes a `cron_runs` row, and (on failure) a `cron_errors` row — never re-throws, so siblings keep running.
5. Register the cron in the registry (`crons[]` entry on the agent).

After deploying, `/dashboard` → Scheduled jobs will show last/next run, success rate, and full history for the new trigger.

## Modifying shared packages

Changes to `packages/*` affect every dependent. Before merging:
1. Run `turbo run typecheck` to catch type breakage across the fleet.
2. If the change is semantic (not just internal), open issues for each
   dependent agent so the Fleet Manager can evaluate per-agent updates.
