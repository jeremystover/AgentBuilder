# CLAUDE.md
Behavioral guidelines for Claude Code sessions working in this repo. Fleet conventions (rules about agents, packages, scaffolding) live in `AGENTS.md` — read both.

**Tradeoff:** these guidelines bias toward caution over speed. For trivial tasks, use judgment.

---

## 1. Think Before Coding
**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

---

## 2. Simplicity First
**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

---

## 3. Surgical Changes
**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

---

## 4. Goal-Driven Execution
**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## 5. Deploy Workflow
**Fix → commit → PR → merge → confirm. No human gate.**

Merging to `main` triggers the per-agent GitHub Actions workflow, which applies
D1 + Neon migrations and deploys the Worker. There are two execution contexts —
use the one that matches where you are running.

### Claude Code web sessions (the default)
Outbound HTTP is blocked here: `wrangler` and `curl` to `*.workers.dev` do not
work. Drive the whole deploy through the **GitHub MCP** and confirm through the
**Cloudflare MCP** — never ask the user to open a PR for you.

```
1. git add -A && git commit -m "fix: <description>" && git push   (feature branch)
2. mcp__github__create_pull_request   (base: main)
3. mcp__github__merge_pull_request    (squash)  → this triggers the deploy
4. Confirm: query the `deployments` table in agentbuilder-core D1 via the
   Cloudflare MCP d1_database_query for a row matching the merge commit SHA
   with status='success' AND smoke_status='ok'.
   Secondary check: workers_get_worker shows a fresh version / modified_on.
```

If no `success` row appears, or `status='failed'`, read the failure and loop —
do **not** report "it's deployed" until the `deployments` row confirms it.

### Local developer terminal
`wrangler`, `gh`, and `curl` all work. Use `make fix-and-ship` (see §7).

**Do not stop and ask for merge approval.** The workflow is intentionally
no-gate.

---

## 6. Cloudflare Auth & Debugging

### Auth setup (one-time, in the developer's local terminal — not Claude Code's job)
Wrangler and GitHub CLI credentials are stored outside the repo:
- `~/.wrangler/` — Wrangler OAuth token (set via `wrangler login`)
- `~/.config/gh/` — GitHub CLI token (set via `gh auth login`)

**Never put API tokens in repo files.** GitHub will block them. Cloudflare API tokens for CI/CD live in GitHub repo Settings → Secrets → Actions as `CLOUDFLARE_API_TOKEN`.

### Verifying auth before starting work
```bash
npx wrangler whoami      # should show your Cloudflare account
gh auth status           # should show authenticated to GitHub
```

If either fails, stop and tell the developer — do not attempt to set up credentials yourself.

### Reading logs / errors

**Claude Code web sessions:** `wrangler tail` and `curl` are blocked. Read
errors from the `agentbuilder-core` D1 instead — query `fleet_errors` (every
request/cron/queue/frontend error), `bug_tickets` (deduped, with triage
state), and `cron_runs`/`cron_errors` via the Cloudflare MCP `d1_database_query`.

**Local developer terminal:** stream live logs while triggering a request:
```bash
npx wrangler tail <worker-name> --format pretty
npx wrangler tail <worker-name> --format json | head -50   # recent only
```

### Smoke test
CI runs a post-deploy smoke test automatically (see `_deploy-agent.yml`) and
records the result in the `deployments` table. Locally you can also run:
```bash
make test
```

### Debug loop
When something is broken:
1. Read the error: `fleet_errors` in D1 (web) or `wrangler tail` (local).
2. Fix the code. Deploy via the §5 workflow.
3. Confirm the `deployments` row shows `status='success'` and
   `smoke_status='ok'` — re-loop if not.
4. Don't report "it's deployed" — report what the `deployments` row says.

---

## 7. Makefile Targets
The Makefile is for the **local developer terminal only** — every target shells
out to `wrangler`, `gh`, or `curl`, which are blocked in Claude Code web
sessions (use the §5 MCP workflow there instead).

```bash
make deploy          # wrangler deploy only (no git)
make logs            # wrangler tail, live stream
make test            # smoke test the MCP endpoint
make fix-and-ship    # commit + PR + merge + deploy + test (pass msg="..." for commit message)
```

If a Makefile target is missing for a repeated task, add it and commit it.

---

## 8. Bug Monitoring (autonomous)

Errors from every agent are captured into the shared `agentbuilder-core` D1:

- `fleet_errors` — one row per occurrence (request / cron / queue / frontend).
- `bug_tickets` — deduped by fingerprint, with triage + fix state.
- `bug_fixes` — append-only audit of what got fixed or flagged.

Capture is wired through `@agentbuilder/observability`: `withObservability`
wraps each `fetch` handler, `runCron` covers crons, and `handleClientError`
(mounted at `POST /api/v1/client-error`) takes browser errors. See `AGENTS.md`
rules 11–12.

The **`/fleet-doctor`** slash command (`.claude/commands/fleet-doctor.md`) is
the autonomous triage loop: it reads open `bug_tickets`, fixes what it's
confident about (PR → merge → confirm via `deployments`), and opens a
`needs-human` GitHub issue for the rest. It is **anti-spin**: at most 2 fix
attempts per fingerprint, then it flags and stops.

Run it on a recurring **scheduled trigger** (Claude Code on the web →
environment settings; recommend hourly). To review what it has done, query
`bug_tickets` / `bug_fixes`.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

**Origin:** distilled from Andrej Karpathy's January 2026 observations on LLM coding pitfalls, via the [`andrej-karpathy-skills`](https://github.com/forrestchang/andrej-karpathy-skills) CLAUDE.md.

---

## Runtime agents
The four bolded one-liners above are also exported from `@agentbuilder/llm` as `CORE_BEHAVIORAL_PREAMBLE`. Runtime agents (the AgentBuilder personas and any agent under `apps/*`) should prepend that constant to their system prompt. See `AGENTS.md` rule 10.
