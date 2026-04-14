---
name: fleet-audit
description: Run a read-only audit of the AgentBuilder fleet — check for stale agents, shared-package blast radius, registry drift, and non-goal overlap. Produces a report with concrete recommendations. No writes. Use for periodic health checks or before a risky refactor.
---

# fleet-audit

You are performing a read-only audit of the agent fleet. The Fleet Manager persona running in the Worker already has these same tools, but this skill exists so you can run the audit locally where you also have filesystem and git — useful when the audit needs to cross-check registry entries against actual source code in `apps/*`.

## What to check

Ask the user what kind of audit they want, or default to a full sweep:

1. **Staleness** — agents whose `lastDeployed` is older than 30 days. Read `registry/agents.json` directly.
2. **Shared package consumers** — for each `@agentbuilder/*` package, list every agent declaring it in `sharedPackages`. Cross-check against actual imports in `apps/<id>/src/` to catch drift between declared and actual dependencies.
3. **Registry-vs-code drift** — for each agent in the registry, verify `apps/<id>/` exists and its `wrangler.toml` name matches `cloudflare.workerName`. Flag any mismatch.
4. **Non-goal drift** — find pairs of agents where one agent's trigger phrases or purpose overlap another's non-goals. Report both sides of each overlap.
5. **Template drift** — compare each `apps/<id>/src/index.ts` head against the current template to see if any agents have fallen behind on template updates (e.g. the MCP handler shape).

## How to report

Write a markdown report to `docs/audits/YYYY-MM-DD-fleet-audit.md` with sections for each check and a final "Recommended actions" bullet list. Each recommendation names either:

- a Claude Code skill to run (e.g. `run migrate-agent for cfo`), or
- a specific field + file to change (e.g. `bump chief-of-staff.lastDeployed in registry/agents.json`), or
- a shared package to refactor (e.g. `@agentbuilder/auth-github — 2 consumers`).

## Constraints

- READ ONLY. This skill does not commit, push, or mutate anything. Producing the audit file is the only write.
- Never delete or archive an agent. That's a human decision with rollback implications.
- If you find a critical issue (e.g. an agent's worker doesn't exist on Cloudflare anymore), surface it with **[CRITICAL]** at the top of the report but still don't take action.
