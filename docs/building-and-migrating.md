# Building and migrating agents

How the two halves of AgentBuilder actually work together.

## The two-plane architecture

AgentBuilder runs on two planes because one plane can't do everything:

- **Claude.ai plane** — the AgentBuilder Worker at `agent-builder.jsstover.workers.dev`. Hosts the Architect, Fleet Manager, and Builder personas. Talks to Claude via the MCP custom-tool integration. This is where you *design* and *plan*. It has no filesystem, no shell, no git.
- **Claude Code plane** — your local machine running the `.claude/skills/*` skills. This is where you *execute*. It has real file system, real git, real wrangler, real GitHub API.

The planes communicate through structured handoffs:

1. You chat with the Architect in claude.ai. It produces a design spec as JSON and emits `HANDOFF: builder`.
2. You send that to the Builder persona. It produces a structured plan as JSON and emits `HANDOFF: claude-code:migrate-agent` (or `scaffold-agent`).
3. You paste the full handoff into Claude Code locally. Claude Code picks up the matching skill and executes the plan.

Everything is intentionally machine-readable at the handoff boundaries so the two planes can't drift.

## Building a new agent (scaffold flow)

### 1. Design in claude.ai

Talk to the Architect persona. It will:

- Call `list_agents` to see what already exists.
- Call `check_overlap` for anything adjacent.
- Push back if an existing agent could be extended instead.
- Eventually emit:

  ```
  HANDOFF: builder
  ```json
  { "id": "...", "name": "...", ..., "cloudflare": {...}, "routing": {...} }
  ```
  ```

At that point the Architect has also called `validate_design` to confirm the JSON matches `AgentEntrySchema`, so you can trust it.

### 2. Add the entry to the registry

Before the Builder can plan anything, the new agent has to exist in `registry/agents.json` as `status: "draft"`. Right now this is a manual step — open a PR that appends the JSON the Architect emitted.

(Phase 4 adds a registry-write tool so the Architect can do this itself.)

### 3. Plan in claude.ai

Switch to the Builder persona and give it the agent id. It will:

- Call `describe_agent` to load the registry entry.
- Call `plan_scaffold` to produce a step-by-step plan.
- Emit:

  ```
  HANDOFF: claude-code:scaffold-agent
  ```json
  { "id": "...", "targetPath": "...", "steps": [...] }
  ```
  ```

### 4. Execute in Claude Code

Open the AgentBuilder repo locally. Start a Claude Code session and paste the handoff. Claude Code runs the `scaffold-agent` skill, which:

- Copies the template from `.agent-builder/templates/<kind>/`
- Fills placeholders
- Installs, typechecks, wrangler dry-runs
- Deploys
- Prompts you for secrets

Commit and push each step as you go.

### 5. Connect to Claude.ai

Once deployed, add a Claude.ai custom tool integration pointing at `https://<worker-name>.<subdomain>.workers.dev/mcp?key=<MCP_HTTP_KEY>`. The new agent is now reachable from your Claude.ai sessions.

## Migrating an existing agent

Same flow, but the Architect's design spec includes a top-level `migration` object:

```json
{
  "id": "cfo",
  ...,
  "migration": {
    "sourceRepo": "jeremystover/tax-prep",
    "sourceWorker": "tax-prep",
    "targetWorker": "cfo",
    "portNotes": "keep transaction ingest, rewrite categorization, drop the standalone UI"
  }
}
```

The Builder recognizes the `migration` object and calls `plan_migration` instead of `plan_scaffold`. The resulting plan has 10 steps including clone → scaffold → port → wire bindings → parallel-run deploy → smoke test → cutover → decommission.

### Migration rules

1. **Always parallel-run.** The source worker stays deployed until you've validated the target against the same routing examples. Never take down the old worker as part of migration.
2. **Re-enter secrets.** Don't copy OAuth tokens from the old worker unless the user explicitly says to reuse them. Use `wrangler secret put` fresh.
3. **Stop before cutover.** The `migrate-agent` skill pauses after the smoke-test step and waits for human sign-off. Cutover is irreversible.
4. **Keep the source 7+ days.** Delete the old worker only after a week of green parallel-run.

### Migration order (current queue)

In priority order, cheapest-first:

1. **CFO** (jeremystover/tax-prep → cfo) — smallest surface, good warm-up.
2. **Guest Booking** (jeremystover/guest-booking → guest-booking, apps kind) — partially built, UI separate.
3. **Chief of Staff** (jeremystover/PersonalProductivityProject → chief-of-staff) — biggest, riskiest, save for last.

Each migration gets its own `docs/migrations/<id>.md` log.

## Personas at a glance

| Persona | Tier | Tools | Writes? |
|---|---|---|---|
| Architect | deep (Opus) | list/describe/check_overlap, validate_design, suggest_worker_name | No |
| Fleet Manager | default (Sonnet) | registry reads + list_shared_package_consumers, find_stale_agents, diff_registry_entry, audit_non_goals | No |
| Builder | default (Sonnet) | registry reads + plan_scaffold, plan_migration | No (planning only) |

All three Worker-side personas are read-only. All writes happen through Claude Code skills running on your machine. This is a deliberate split — it keeps the Worker-side safe to connect to claude.ai and forces every mutation through a tool with real authorization (your local git/wrangler/GitHub creds).

## What's next (phase 4+)

- Registry write tool so the Architect can upsert drafts itself without a manual PR.
- GitHub App credentials so Claude Code can open PRs under a machine account instead of your user.
- Auto-PR from the fleet-audit skill when drift is detected.
- Template versioning so `fleet-audit` can flag agents lagging on template updates.
