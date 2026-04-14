---
name: migrate-agent
description: Execute an agent migration plan handed off from the Builder persona. Reads the JSON plan following `HANDOFF: claude-code:migrate-agent`, then performs the file copy, port, deploy, and parallel-run steps locally. Use when migrating an existing agent from a sibling repo (e.g. tax-prep → cfo) into the AgentBuilder monorepo.
---

# migrate-agent

You are executing a migration plan produced by the AgentBuilder Builder persona. The plan arrived as a fenced `json` block immediately following a `HANDOFF: claude-code:migrate-agent` line. Parse it first — it contains `id`, `targetPath`, `template`, `sourceRepo`, `sourceWorker`, `targetWorker`, `portNotes`, and a numbered `steps` array.

You have real tools: file system, shell, git, wrangler, GitHub MCP. Use them. The Worker-side Builder did NOT write any code — you are the half that actually does.

## Execution rules

1. **Always parallel-run.** Never take the source worker down as part of migration. Deploy the target worker alongside it and keep both running until cutover is validated.
2. **Never reuse OAuth tokens blindly.** Re-prompt the user for secrets via `wrangler secret put` unless they explicitly say "reuse them".
3. **Never invent fields.** If the plan says a step needs info you don't have, ASK the user instead of guessing.
4. **Every file copy gets a port pass.** Don't paste source code verbatim — rewrite handlers to use `@agentbuilder/llm` and the Worker-safe runtime before committing.
5. **Commit in small chunks.** One commit per migration step when possible. Commit messages: `migrate(<id>): step N — <title>`.
6. **Stop and report** at the end of step 8 (smoke test) and wait for the user's sign-off before executing step 9 (cutover). Migration is irreversible past cutover.

## Step execution

For each step in the plan's `steps` array, in order:

1. Print the step title and detail so the user can see what you're about to do.
2. Execute the step using your real tools.
3. Report success / failure / follow-up.
4. If a step fails: stop, diagnose, fix the underlying cause. Do NOT skip or hack around it.

## Source of truth

- The registry entry at `registry/agents.json` is the canonical design. If the plan disagrees with the registry, TRUST the registry and tell the user about the discrepancy.
- The template at `.agent-builder/templates/<template>/` is the scaffold shape. Copy from there, don't hand-write.
- The source repo (`sourceRepo`) is read-only during migration. Clone shallow, read, and leave it alone.

## When done

Write a short migration log to `docs/migrations/<id>.md` covering: source, target, cutover date (once done), decommission date (once done), anything weird you had to work around.
