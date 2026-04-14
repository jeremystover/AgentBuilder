# chief-of-staff migration

**Source.** `jeremystover/personal-productivity-mcp` (branch `main`, `MCP-CloudRun-Server/`)
→ mirrored into `jeremystover/agentbuilder` on branch `import/chief-of-staff-source`
so the sandbox could read it via git. Orphan branch, safe to delete post-cutover.

**Target.** `apps/chief-of-staff/` in the AgentBuilder monorepo.

**Source worker.** `personal-productivity-mcp` (Cloudflare Workers, v4.0.0).
**Target worker.** `chief-of-staff` (renamed in `apps/chief-of-staff/wrangler.toml`).

**Cutover date.** _not yet cut over — parallel run pending_.
**Decommission date.** _pending cutover + smoke test_.

## Scope decision

User instruction was **"import as-is, flag for follow-up."** No consolidation,
no rewrites, no shared-package ports. The entire `MCP-CloudRun-Server/` tree
was moved verbatim under `apps/chief-of-staff/src/` via `git mv` so history is
preserved. Only new files are the scaffolding manifests (`package.json`,
`wrangler.toml`, `tsconfig.json`, `SKILL.md`).

## AGENTS.md violations carried forward

These are intentional migration carry-overs. They're listed here so the Fleet
Manager can schedule dedicated follow-up passes.

### Rule 2 — tool surface < 10

**Violation.** The live MCP server exposes roughly 60 physical tools. The
registry (and `SKILL.md`) list 12 _logical_ tool categories; the physical
count is an artifact of exposing every `propose_*` mutation and every
Drive/Sheets content operation as a distinct MCP tool.

**Impact.** Tool-selection accuracy degrades past ~10 tools. This is the
biggest latent risk post-import.

**Planned follow-up.**
- Collapse `propose_create_*` / `propose_update_*` / `propose_resolve_*` /
  `propose_complete_*` into a single `propose` tool with `{ kind, payload }`
  arguments. Keep `commit_changeset` as a separate tool.
- Collapse Drive markdown CRUD (`list_status_files`, `read_status_file`,
  `write_status_file`, `append_status_file`, `delete_status_file`) into a
  single `status_file` tool with a `verb` discriminator.
- Target surface: ~12 physical tools matching the 12 logical categories.

### Rule 5 — one OAuth client per provider via `@agentbuilder/auth-google`

**Violation.** `src/auth.js` implements Google service-account JWT signing and
OAuth2 refresh-token flow inline. Does not depend on
`@agentbuilder/auth-google`.

**Planned follow-up.** Port `createGfetch` / `createUserFetch` to a thin
wrapper around `@agentbuilder/auth-google`. Keep retry / backoff behavior
(`withRetry` helper) local until we know the shared package supports it.

### Rule 6 — model tiers not hardcoded model ids

**Non-violation.** This agent does not currently invoke an LLM directly. The
`"claude"` string literals in `tools.js`, `reviews.js`, and `automation.js`
are audit-trail values (`appliedBy = "claude"`), not API calls. Nothing to
port.

### Not-yet-typed JavaScript

`apps/chief-of-staff/tsconfig.json` sets `allowJs: true` + `checkJs: false`
so `turbo run typecheck` participates without forcing a TS port of ~7k lines
of source. A dedicated TS conversion pass is a separate follow-up, not part
of the import.

## Remaining work before cutover

The sandbox cannot deploy for the user. These steps require the user's
Cloudflare / Google / Zoom credentials and must be run from a local shell:

1. **Deploy parallel worker.** `apps/chief-of-staff` deploys to Cloudflare as a
   NEW worker (`name = "chief-of-staff"`) without touching
   `personal-productivity-mcp`.

   ```bash
   cd apps/chief-of-staff
   wrangler deploy
   ```

2. **Copy secrets.** The new worker needs every secret the old one had.
   `wrangler secret put` each of:
   - `GOOGLE_SERVICE_ACCOUNT_JSON`
   - `PPP_SHEETS_SPREADSHEET_ID`
   - `MCP_HTTP_KEY`
   - `INTERNAL_CRON_KEY`
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `GOOGLE_OAUTH_CLIENT_SECRET`
   - `GOOGLE_OAUTH_REFRESH_TOKEN`
   - `ZOOM_ACCOUNT_ID`
   - `ZOOM_CLIENT_ID`
   - `ZOOM_CLIENT_SECRET`

3. **Share the Google Drive folder and spreadsheet** with the service account
   email (same one the old worker uses). No changes required if you're
   reusing the same SA JSON.

4. **Smoke-test via Claude connector.** Point a fresh MCP connector at the new
   worker's `/mcp` endpoint with the same `MCP_HTTP_KEY`. Run:
   - `hydrate_planning_context` → should return non-empty snapshot
   - `list_goals` → should match old worker
   - `poll_zoom_recordings` with `daysBack=1` → should be idempotent
   - `trigger_morning_brief` via `/internal/morning-brief` → should create a
     Gmail draft

5. **Wait a full cron cycle.** Both workers have the same cron schedule. Watch
   the CronRuns sheet to confirm the new worker is logging successful runs
   alongside the old one. A 24-hour parallel run is recommended so every
   schedule fires at least once.

6. **Cutover.** Switch the Claude MCP connector URL from
   `personal-productivity-mcp.<zone>.workers.dev/mcp` to
   `chief-of-staff.<zone>.workers.dev/mcp`. Keep the old worker running for
   another 24 hours as a rollback.

7. **Decommission.** After one clean day on the new worker:
   - `wrangler delete personal-productivity-mcp`
   - Delete `import/chief-of-staff-source` on GitHub:
     `git push origin :import/chief-of-staff-source`
   - Update this doc with the cutover + decommission dates.

## Known oddities

- **Dual secret keys.** `MCP_HTTP_KEY` guards `/mcp`; `INTERNAL_CRON_KEY` guards
  `/internal/*` with a fallback to `MCP_HTTP_KEY`. Unusual but intentional —
  the internal endpoints are privileged (drafting emails, writing to Drive)
  and the plan is to rotate them independently once the fallback is removed.
- **No tests in CI.** `node --test src/test` works locally but isn't wired
  into `turbo run test` yet. Tests carry over so the `checkJs: false` tsconfig
  excludes them from typechecking.
- **Dashboard endpoint.** `/dashboard` renders a read-only HTML view of
  Goals → Projects → Tasks. Gated by `MCP_HTTP_KEY` (header _or_ query string).
  Useful for eyeballing state during migration.
