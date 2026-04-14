---
name: scaffold-agent
description: Execute a scaffolding plan handed off from the Builder persona. Reads the JSON plan following `HANDOFF: claude-code:scaffold-agent`, copies the template, fills placeholders, installs, typechecks, dry-runs wrangler, then deploys. Use when the Architect has designed a brand-new agent and the user is ready to build it.
---

# scaffold-agent

You are executing a scaffold plan produced by the AgentBuilder Builder persona. The plan arrived as a fenced `json` block immediately following a `HANDOFF: claude-code:scaffold-agent` line. Parse it first — it contains `id`, `targetPath`, `template`, and a numbered `steps` array.

## Execution rules

1. **Read the registry entry first.** Open `registry/agents.json` and find the entry for `id`. That entry is the single source of truth for bindings, skills, tools, and worker name. The plan is derived from it; the registry wins if they disagree.
2. **Copy the template verbatim.** Don't improvise. The template at `.agent-builder/templates/<template>/` is the shape every agent starts from. If the template is missing something the registry needs, stop and fix the TEMPLATE (a separate commit), then retry.
3. **Fill placeholders carefully.** Every file in the copied tree needs `{{AGENT_ID}}`, `{{AGENT_NAME}}`, `{{WORKER_NAME}}`, `{{PURPOSE}}` replaced. Use a grep to verify no placeholders remain before moving on.
4. **Typecheck before deploying.** `pnpm -F @agentbuilder/app-<id> exec tsc --noEmit` must pass clean. No `any`, no ts-ignore.
5. **Dry-run wrangler before real deploy.** `wrangler deploy --dry-run` catches binding mistakes without spending deploy budget.
6. **Commit each step.** Commit messages: `scaffold(<id>): step N — <title>`.
7. **Prompt for secrets.** After the first real deploy, the new worker needs secrets. Read `oauthScopes` from the registry entry and prompt the user for each. Use `wrangler secret put`.

## Step execution

For each step in the plan's `steps` array, in order:

1. Print the step title and detail.
2. Execute it.
3. Report success / failure / follow-up.
4. If a step fails: stop, diagnose, fix the underlying cause. Do NOT skip.

## When done

- Verify `curl https://<worker-name>.<subdomain>.workers.dev/health` returns ok.
- Verify the MCP handshake: `POST /mcp` with an `initialize` JSON-RPC call.
- Update the registry entry's `lastDeployed` and bump `version` if this is a material shape change.
- Report to the user with the deployed URL and the Claude.ai custom tool connection info (`/mcp?key=<MCP_HTTP_KEY>`).
