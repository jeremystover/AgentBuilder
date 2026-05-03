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

## Modifying shared packages

Changes to `packages/*` affect every dependent. Before merging:
1. Run `turbo run typecheck` to catch type breakage across the fleet.
2. If the change is semantic (not just internal), open issues for each
   dependent agent so the Fleet Manager can evaluate per-agent updates.
