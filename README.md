# AgentBuilder

A meta-agent that designs, scaffolds, deploys, and maintains a fleet of
specialized agents running on Cloudflare. AgentBuilder itself lives in
this monorepo — it dogfoods every capability it gives other agents.

## Why

- Building agents one-by-one produces overlap, duplicated code, and inconsistent deploys.
- A single builder-persona handling design + scaffold + fleet hygiene keeps the fleet coherent as it grows.
- Running on Cloudflare Agents SDK + Durable Objects means each agent is stateful, cheap, and globally distributed.

## Architecture

```
┌──────────────────────────────────────────────────┐
│             apps/agent-builder  (meta)           │
│   Architect ⇄ Builder ⇄ Fleet Manager  (subagents)│
└──────────────────────────────────────────────────┘
                       │
    ┌──────────────────┼──────────────────┐
    ▼                  ▼                  ▼
 apps/<a>          apps/<b>           apps/<c>      …one Worker per agent
    │                  │                  │
    └───────── packages/core, llm, ───────┘
               registry, auth-*, …
```

- **`apps/*`** — one Cloudflare Worker per agent. Each has a Durable Object, its own `wrangler.toml`, and a `SKILL.md`.
- **`packages/*`** — shared TypeScript libraries, consumed with `workspace:*`.
- **`registry/agents.json`** — the fleet's source of truth. PR-reviewable.
- **`.agent-builder/templates/`** — templates the scaffolder copies from.
- **`tools/`** — repo-wide CLIs (currently: `create-agent`).

## Stack

- **TypeScript** everywhere (Node.js 20+)
- **pnpm workspaces + Turborepo** for the monorepo
- **Cloudflare**: Workers, Durable Objects, D1, Workers AI, Secrets Store
- **Biome** for lint/format
- **Anthropic SDK** (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`)
- **Prompt caching** on by default for system prompts

## Model tiers

Call sites pick a semantic tier, not a concrete model id:

| Tier | Default model | Use for |
|---|---|---|
| `fast` | `claude-haiku-4-5` | routing, classification, short summarization |
| `default` | `claude-sonnet-4-6` | most agent work |
| `deep` | `claude-opus-4-6` | planning, architecture, hard reasoning |
| `edge` | Workers AI (Llama 3.3) | bulk embeddings, cheap classification |

Edit `packages/llm/src/models.ts` to re-balance fleet-wide.

## Getting started

```bash
# 1. Install deps
pnpm install

# 2. Typecheck everything
pnpm typecheck

# 3. Scaffold a new agent
pnpm create-agent my-agent --kind headless --name "My Agent" \
  --purpose "Does a specific thing" --owner you

# 4. Run an agent locally
pnpm --filter @agentbuilder/app-my-agent dev
```

## Cloudflare setup (one-time)

```bash
# Log in
wrangler login

# Create the shared D1 database used by the fleet
wrangler d1 create agentbuilder-core
# → copy the database_id into apps/agent-builder/wrangler.toml and any agent
#   that declares the DB binding

# Store shared secrets (these flow to Workers via env)
wrangler secret put ANTHROPIC_API_KEY --name agent-builder
wrangler secret put GITHUB_APP_PRIVATE_KEY --name agent-builder
wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET --name agent-builder
```

D1 schema for the shared token vault lives in
`packages/auth-google/src/schema.ts`. Apply it with:

```bash
wrangler d1 execute agentbuilder-core --remote \
  --command "$(node -e 'import(\"./packages/auth-google/src/schema.js\").then(m => console.log(m.GOOGLE_TOKEN_VAULT_SCHEMA))')"
```

## Testing the Architect persona (phase 2)

The Architect is the first persona implemented with a real tool loop.
It has read-only access to the registry via three tools: `list_agents`,
`describe_agent`, and `check_overlap`. You can test it end-to-end once
`ANTHROPIC_API_KEY` is configured:

```bash
# 1. Put your Anthropic key in a local .dev.vars file (wrangler reads it for dev)
echo 'ANTHROPIC_API_KEY = "sk-ant-..."' > apps/agent-builder/.dev.vars

# 2. Start the Worker locally
pnpm --filter @agentbuilder/app-agent-builder dev
# → wrangler prints a URL like http://localhost:8787

# 3. In another terminal, drive a conversation with the chat harness
./tools/chat.sh "I want an agent that drafts sales follow-up emails."
# → prints the Architect's reply + a session id

# 4. Continue the same session (pass the session id back)
./tools/chat.sh "Yes, I want it to handle LinkedIn too." <session-id>

# 5. Or hit the /chat endpoint directly
curl -X POST http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -d '{"message": "List everything in the fleet", "persona": "architect"}'
```

Expected behavior: the Architect will call `list_agents` on most turns
and `check_overlap` when you propose something new. Watch the `iterations`
field in the response — > 1 means it made at least one tool call.

The Builder and Fleet Manager personas are still phase-2 stubs
(single-turn, no tools). They'll get real tool loops in phase 3.

## Phase status

- ✅ **Phase 1** — monorepo skeleton, shared packages, persona stubs, templates, CLI, registry seed.
- ✅ **Phase 2 (this commit)** — Architect persona with a real tool loop, structured-content support in the LLM client, DO-backed conversation sessions, registry tools (list/describe/check_overlap), `/chat` endpoint, chat test harness.
- ⏳ **Phase 3** — Builder persona with fs/git/wrangler/github-app tools (opens real PRs), Fleet Manager persona with registry write + overlap propagation, shared eval harness, first dogfood agent scaffolded end-to-end.
- ⏳ **Phase 4** — Google OAuth dance + token vault encryption, GitHub App JWT signing, production secrets wiring.

See `AGENTS.md` for working-in-repo conventions.
