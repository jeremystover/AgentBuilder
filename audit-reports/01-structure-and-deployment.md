# CFO Agent — Audit Report 01: Structure and Deployment

Audit date: 2026-05-13
Repository: `jeremystover/AgentBuilder`
Branch: `claude/audit-cfo-agent-pBl92`
Target: `apps/cfo` within the AgentBuilder pnpm monorepo

This report describes what is in the repository as of this snapshot. No fixes, suggestions, or value judgements are included.

---

## 1. Directory Structure

### 1a. Top-level directories (monorepo root)

| Path | Apparent purpose |
|---|---|
| `apps/` | One subdirectory per agent. Each agent is a deployable Cloudflare Worker. 12 sibling agents present (agent-builder, cfo, chief-of-staff, graphic-designer, guest-booking, linkedin-watcher, medium-watcher, research-agent, shopping-price-tracker, termination-documentation, wf-check-extension, wired-watcher). |
| `packages/` | Shared TypeScript libraries consumed via `workspace:*`: `auth-github`, `auth-google`, `core`, `credential-vault`, `crypto`, `extract-article`, `llm`, `observability`, `registry`, `web-ui-kit`. |
| `registry/` | `agents.json` — single source of truth for the agent fleet (metadata, tools, secrets, crons, routing). |
| `.agent-builder/` | Scaffold templates used by `pnpm create-agent`. |
| `.github/workflows/` | One reusable workflow (`_deploy-agent.yml`) plus one per-agent caller workflow (`deploy-cfo.yml`, `deploy-chief-of-staff.yml`, etc.). |
| `.claude/` | Claude Code configuration directory (present, not exhaustively read). |
| `docs/` | Repo-wide docs: `building-and-migrating.md`, `paywall-ingestion.md`, `phase-4-secrets-setup.md`, `migrations/`. |
| `tools/` | Repo-wide CLI helpers run with `tsx`: `chat.sh`, `create-agent.ts`, `credentials.ts`, `setup-fleet-secrets.sh`. |
| Root files | `pnpm-workspace.yaml`, `turbo.json`, `biome.json`, `tsconfig.base.json`, `package.json` (root), `pnpm-lock.yaml`, `package-lock.json` (both lockfiles present), `AGENTS.md`, `CLAUDE.md`, `README.md`. |

`pnpm-workspace.yaml` enumerates `apps/*`, `packages/*`, and `tools`. The fleet is a Turborepo + pnpm monorepo.

### 1b. `apps/cfo/` directory layout

```
apps/cfo/
├── package.json
├── wrangler.toml
├── tsconfig.json              (Worker code)
├── tsconfig.web.json          (React SPA code)
├── vite.config.ts             (SPA bundler)
├── vitest.config.ts
├── postcss.config.js
├── tailwind.config.ts
├── pre-migration-backup.sql   (12 KB — leftover from the tax-prep → cfo rename)
├── migrations/                (19 .sql files, numbered 0001…0019; two pairs reuse the same numeric prefix)
├── public/                    (icons, favicons, manifest, legacy.html)
├── scripts/                   (flag-uncategorized.{sh,sql}, gen-icons.py)
└── src/
    ├── index.ts               (Worker entrypoint — fetch + scheduled handlers + regex router, 504 lines)
    ├── types.ts               (Env + domain types + Schedule C/E/Family category tables, 271 lines)
    ├── mcp-tools.ts           (JSON-RPC 2.0 MCP server, 814 lines)
    ├── web-api.ts             (/api/web/* JSON endpoints, 156 lines)
    ├── web-chat.ts            (/api/web/chat SSE handler, 103 lines)
    ├── web-chat-tools.ts      (curated 10-tool subset of MCP for in-app chat, 77 lines)
    ├── lib/                   (30 files — Teller/Plaid/Twilio/Gmail/Amazon/Apple/Etsy/Venmo
    │                           clients, Claude wrappers, SMS dispatcher, nightly sync jobs,
    │                           rule learning, dedup, pacific-time, review interview)
    ├── routes/                (21 REST handler modules — accounts, amazon, bank, bookkeeping,
    │                           budget, check-images, classify, gmail, health, imports, income,
    │                           plaid, pnl, reports, review, rules, setup, sms, tax-categories,
    │                           teller, tiller, transactions)
    └── web/                   (React + Vite SPA: App.tsx, main.tsx, router.ts, api.ts,
                                catalog.ts, types.ts, components/, hooks/, utils/)
```

Source totals: 14,093 lines across `src/*.ts` + `src/lib/*.ts` + `src/routes/*.ts` (web/ excluded). Largest files: `mcp-tools.ts` (814), `claude.ts` (769), `budget.ts` route (720), `classify.ts` route (646), `sms-inbound.ts` (568).

### 1c. Workers in the repository

There is exactly **one** Worker per agent app, with one `wrangler.toml` each. For the CFO:

- Single Worker, `name = "cfo"` (from `apps/cfo/wrangler.toml`).
- Entrypoint: `src/index.ts`.

The fleet has roughly twelve sibling Workers under `apps/*`, each with its own `wrangler.toml`. No multi-environment (`[env.production]`) blocks are used in `apps/cfo/wrangler.toml`.

### 1d. Shared libraries / common code

Per `apps/cfo/package.json`, the CFO app declares dependencies on four workspace packages:

- `@agentbuilder/core` — declared in package.json but **no source import is found** in `apps/cfo/src/**` (grep returns only the package.json line).
- `@agentbuilder/llm` — declared in package.json but **no source import is found** (one comment in `lib/sms-claude.ts` explicitly notes the agent does not use it; SMS Claude calls `fetch('https://api.anthropic.com/v1/messages')` directly).
- `@agentbuilder/observability` — used in `src/index.ts` for `runCron`.
- `@agentbuilder/web-ui-kit` — used in `src/index.ts` (cookie session helpers, `loginHtml`) and `src/web-chat.ts` (`runChatStream`).

The CFO does **not** use `@agentbuilder/auth-google`, `auth-github`, `credential-vault`, `crypto`, `extract-article`, or `registry`. Google OAuth tokens for Gmail are read directly from env vars (`GOOGLE_OAUTH_*`), not via the shared `auth-google` package.

Direct Anthropic API calls (`lib/claude.ts`, `lib/sms-claude.ts`) bypass `@agentbuilder/llm`; the model id `claude-opus-4-6` is hardcoded in at least `lib/claude.ts:28`.

---

## 2. Technology Stack

### 2a. Runtime

- **Cloudflare Workers** with `compatibility_date = "2025-04-01"` and `compatibility_flags = ["nodejs_compat"]`.
- **CPU limit** raised to `cpu_ms = 300000` (5 minutes) under `[limits]`.
- **Cron Triggers** (`[triggers].crons`):
  - `"0 9 * * *"` — nightly Teller + email sync.
  - `"*/30 * * * *"` — SMS dispatcher; comment states 47/48 fires are no-ops because the handler self-checks Pacific local time and per-person preferred slots.
- **Static assets binding** (`[assets]`): serves Vite-built SPA from `./dist`, binding `ASSETS`.
- **mTLS certificate binding** (`[[mtls_certificates]]`): `TELLER_MTLS`, cert id `1c40bf07-6ba7-4e8c-b95f-27df8e7adfda` — required for Teller production.
- **Durable Objects**: none. (`index.ts:23-24` notes: "No Durable Object — the CFO is D1-backed so a DO would just add serialization cost.")
- **Queues**: none.

### 2b. Storage bindings (from `apps/cfo/wrangler.toml`)

| Binding | Type | Resource | ID |
|---|---|---|---|
| `DB` | D1 | `cfo-db` | `7a8081f3-8ae5-4344-8902-5cbd7992670f` |
| `AGENTBUILDER_CORE_DB` | D1 | `agentbuilder-core` (fleet-shared) | `51a422d2-e9ea-46e8-b6c8-233229434eca` |
| `BUCKET` | R2 | `cfo-files` | — |
| `ASSETS` | Static assets | `./dist` | — |
| `TELLER_MTLS` | mTLS cert | — | `1c40bf07-6ba7-4e8c-b95f-27df8e7adfda` |

No KV namespaces. No Queues. No Service Bindings.

D1 migrations: `apps/cfo/migrations/` contains 19 SQL files numbered 0001–0019. Note: two pairs share a numeric prefix — `0015_cut_status.sql` + `0015_gmail_enrollments.sql`, and `0017_apple_email_sync.sql` + `0017_tax_categories.sql`. A `pre-migration-backup.sql` (12 KB) is also present at the app root.

### 2c. Package dependencies (`apps/cfo/package.json`)

**Runtime dependencies:**
- `@agentbuilder/core` — workspace (declared, not imported in src)
- `@agentbuilder/llm` — workspace (declared, not imported in src)
- `@agentbuilder/observability` — workspace
- `@agentbuilder/web-ui-kit` — workspace
- `zod` ^3.23.8

**Dev dependencies:**
- `@cloudflare/workers-types` ^4.20260415.1
- `@types/react` ^18.3.12, `@types/react-dom` ^18.3.1
- `@vitejs/plugin-react` ^4.3.3
- `autoprefixer` ^10.4.20
- `lucide-react` ^0.468.0
- `postcss` ^8.4.49
- `react` ^18.3.1, `react-dom` ^18.3.1
- `sonner` ^1.7.0
- `tailwindcss` ^3.4.15
- `typescript` ^5.6.3
- `vite` ^5.4.11
- `vitest` ^2.1.5
- `wrangler` ^4.83.0

Notable absent dep: there is no `@anthropic-ai/sdk` in `apps/cfo/package.json`; the CFO talks to the Anthropic API via raw `fetch` calls. The Anthropic SDK lives in `@agentbuilder/llm`'s deps but the CFO does not consume it.

**Root `package.json`** scripts: `turbo run dev/build/deploy/typecheck`, `biome lint/format/check`, `pnpm create-agent` (tsx), `pnpm fleet:setup-secrets` (bash), `pnpm cred`. Package manager pinned to `pnpm@9.12.0`; Node `>=20.11.0`; `.nvmrc` present.

### 2d. Language & build tooling

- **Language**: TypeScript throughout (`src/**.ts`, `web/**.tsx`).
- **Worker bundling**: Wrangler 4.x (no separate esbuild config).
- **SPA bundling**: Vite 5 (`vite.config.ts`), output to `./dist`, served via `[assets]`.
- **Two tsconfigs**: `tsconfig.json` (Worker types via `@cloudflare/workers-types`), `tsconfig.web.json` (SPA).
- **Tests**: Vitest. Only one test file in `apps/cfo`: `src/lib/tool-result-truncate.test.ts` (134 lines).
- **Lint/format**: Biome at the monorepo root (`biome.json`). No per-app lint config.
- **Repo orchestration**: Turborepo (`turbo.json`).
- **Both `package-lock.json` and `pnpm-lock.yaml`** exist at the repo root.

---

## 3. Deployment Model

### 3a. Workers deployed

Single Worker `cfo`. No routes are pinned in `wrangler.toml` (no `[[routes]]` or `route =` directive), so the Worker resolves to its default `cfo.<account>.workers.dev` subdomain unless a custom route is configured outside the toml. The wrangler.toml comments reference `https://cfo.<account>.workers.dev/sms/inbound`.

### 3b. Wrangler config count

One `wrangler.toml` for the CFO app. The fleet does not use a single root-level wrangler.toml — each agent owns its own. No `[env.<name>]` blocks in the CFO's wrangler.toml.

### 3c. Deployment scripts / CI

**Per-app CLI** (`apps/cfo/package.json`):
- `dev`: `wrangler dev`
- `web:dev`: `vite`
- `web:build`: `vite build`
- `deploy`: `pnpm web:build && wrangler deploy`
- `build`: `pnpm web:build && wrangler deploy --dry-run --outdir=.wrangler-dist`
- `typecheck`: runs `tsc --noEmit` for both tsconfigs
- `test`: `vitest run`
- `db:migrate`: `wrangler d1 migrations apply cfo-db`

**Root**: `turbo run deploy` fans out to every app.

**GitHub Actions**:
- `.github/workflows/deploy-cfo.yml` — triggered on push to `main` for paths under `apps/cfo/**`, `packages/**`, `pnpm-lock.yaml`, or its own workflow files; also `workflow_dispatch`. Calls reusable workflow with `agent_id: cfo` and `d1_database: cfo-db`.
- `.github/workflows/_deploy-agent.yml` — reusable workflow used by every agent. Steps: checkout → `pnpm/action-setup@v4` (pnpm `9.12.0`) → `actions/setup-node@v4` (Node 20) → `pnpm install --frozen-lockfile` → `pnpm run --if-present web:build` in `apps/{agent_id}` → `cloudflare/wrangler-action@v3` running `d1 migrations apply <db> --remote` (gated on presence of migration files) → `cloudflare/wrangler-action@v3` running `deploy`.
- Required CI secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

### 3d. Secrets / environment variables

**Plaintext vars** in `[vars]`:
- `DEFAULT_BANK_PROVIDER = "teller"`
- `TELLER_ENV = "development"`
- `PLAID_ENV = "sandbox"`

**Secrets listed in wrangler.toml comments** (managed by `wrangler secret put` or Cloudflare Secrets Store):
- `TELLER_APPLICATION_ID`
- `PLAID_CLIENT_ID`, `PLAID_SECRET`
- `ANTHROPIC_API_KEY` (commented as fleet-shared, managed by `pnpm fleet:setup-secrets`)
- `MCP_HTTP_KEY` (gates `/mcp`)
- `WEB_UI_PASSWORD`, `EXTERNAL_API_KEY`, `WEB_UI_USER_ID`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`

**Env interface** (`src/types.ts`) declares all of the above plus the bindings, with all secrets except `ANTHROPIC_API_KEY` marked optional (`?`). `ANTHROPIC_API_KEY` is the only required string secret per the type.

The CFO's **registry entry** (`registry/agents.json`) declares its `secrets[]` as: `ANTHROPIC_API_KEY`, `TELLER_APPLICATION_ID`, `MCP_HTTP_KEY`, `WEB_UI_PASSWORD`, `EXTERNAL_API_KEY`, `WEB_UI_USER_ID`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. The Plaid and Google OAuth secrets that exist in `Env` and the wrangler.toml comment list are **not** in the registry secrets array.

A repo-level helper `tools/setup-fleet-secrets.sh` is wired up under `pnpm fleet:setup-secrets`.

---

## 4. Agent Builder Integration

### 4a. How this app connects to the fleet

- Listed in `registry/agents.json` as `id: "cfo"`, `status: "active"`, `kind: "app"`, `cloudflare.workerName: "cfo"`. The registry entry enumerates the agent's skills, tools, cron schedules, secrets, and routing examples — the fleet dashboard reads from this file.
- Crons are registered both in `wrangler.toml` and in the registry (`crons[]` with `schedule` + `trigger`), and the `scheduled()` handler routes each cron through `runCron(env, { agentId: "cfo", trigger, cron }, ...)` from `@agentbuilder/observability`, which writes one row per invocation to `cron_runs` (and `cron_errors` on failure) in the shared `agentbuilder-core` D1.
- The shared D1 (`AGENTBUILDER_CORE_DB`) is bound but is read-only from the CFO's perspective (writes happen via `runCron` inside the observability package).
- A per-agent CI workflow (`deploy-cfo.yml`) calls the reusable `_deploy-agent.yml` — the fleet's standard delivery path.

### 4b. MCP server

Yes — the CFO embeds an MCP server inside the same Worker.

- **Entry point**: `POST /mcp` in `src/index.ts:393-412`. Auth via `Bearer <MCP_HTTP_KEY>` header (or `?key=` query param). If `MCP_HTTP_KEY` is unset, `/mcp` is open (`requireMcpAuth` early-returns ok) — comment marks this as "dev only".
- **Transport**: JSON-RPC 2.0 over a single HTTP POST. **Not** SSE. `handleMcp` (in `src/mcp-tools.ts`) parses the body, dispatches by `method`, and returns either a JSON response or `204 No Content` for `notifications/initialized`. There is no `/sse` endpoint or stream.
- **Protocol**: identifies as `protocolVersion: "2024-11-05"`, `serverInfo: { name: "cfo", version: "0.1.0" }`. Implements `initialize`, `tools/list`, `tools/call`, and the `notifications/initialized` no-op.
- **Tool registration pattern**: a single `MCP_TOOLS` array literal in `src/mcp-tools.ts` defines each tool's `name`, `description`, and `inputSchema` (JSON Schema). A parallel `dispatchTool(name, args, env)` switch maps every tool name to a synthesized `Request` that is passed to the corresponding REST handler in `src/routes/*` and stringified back to text content. The file header calls this a "thin wrapper over REST" pattern: MCP tools and REST routes share implementations so they cannot drift.

Tools defined in `MCP_TOOLS` (24 in the dispatch switch; the registry lists 18 names): `teller_sync`, `csv_import`, `amazon_import`, `tiller_import`, `classify_transactions`, `set_account_owner`, `reapply_account_rules`, `backfill_budget_categories`, `list_review_queue`, `next_review_item`, `resolve_review`, `schedule_c_report`, `schedule_e_report`, `transactions_summary`, `list_budget_categories`, `create_budget_category`, `set_budget_target`, `budget_status`, `budget_forecast`, `cuts_report`, `pnl_for_entity`, `pnl_all_entities`, `pnl_monthly_trend`, `start_bookkeeping_session`, `get_bookkeeping_batch`, `commit_bookkeeping_decisions`, `get_bookkeeping_notes`, `save_bookkeeping_notes`, `set_transaction_note`. (The agent's tool registry entry omits several of these — `reapply_account_rules`, `backfill_budget_categories`, `budget_forecast`, `cuts_report`, the bookkeeping family, `set_transaction_note`, `set_account_owner`.)

The MCP tool inventory exceeds the fleet's "≤10 tools per agent" rule documented in `AGENTS.md`.

### 4c. How tools are exposed

Three surfaces all wrap the same REST handlers:

1. **REST** — exported handler functions in `src/routes/*.ts`, wired through a regex router (`ROUTES` array in `src/index.ts:155-265`).
2. **MCP JSON-RPC** — `/mcp` invokes `dispatchTool`, which constructs synthetic `Request` objects and calls the REST handlers directly. The dispatch helpers (`jsonRequest`, `withQuery`, `respondText`) live at the bottom of `mcp-tools.ts`. The MCP handler stamps `x-user-id: default` on every synthesized request.
3. **In-app SSE chat** — `/api/web/chat` (`src/web-chat.ts`) streams via `runChatStream` from `@agentbuilder/web-ui-kit`. It exposes a curated 10-tool subset (`TOOL_ALLOWLIST` in `web-chat-tools.ts`) that reuses `MCP_TOOLS` definitions and `dispatchTool` — comment explicitly says this is to keep MCP and web chat "bug-for-bug identical". Tool results are run through `truncateForChat` from `src/lib/tool-result-truncate.ts` before being handed back to the model.

A fourth surface is the React SPA's REST consumption at `/api/web/snapshot` (consolidated dashboard data) and the routes serving the SPA shell.

---

## 5. Code Organization Patterns

### 5a. Route / handler organization

- One file per resource under `src/routes/` (21 files). Each exports named `handleXxx` functions taking `(request: Request, env: Env, ...params: string[]) => Promise<Response>`.
- Routes are registered in a single flat `ROUTES: Route[]` array in `src/index.ts` (~110 entries) with `{ method, pattern: RegExp, handler }`. The router does a sequential `for…of` scan in `fetch`.
- Sub-resource params come from regex capture groups, spread into `handler(req, env, ...params)`.
- Helpers `jsonOk(data, status)` and `jsonError(message, status)` are defined in `src/types.ts`.
- Inside handlers, request bodies are commonly validated with Zod (imported in route files such as `transactions.ts`). Direct SQL on `env.DB` (D1) using prepared statements is the norm.

### 5b. Middleware

There is no formal middleware pipeline. Cross-cutting concerns are inlined in the top-level `fetch` handler in `src/index.ts`:

- **CORS**: `OPTIONS` preflight short-circuit (lines 289-297). Successful REST responses get `Access-Control-Allow-Origin: *` stamped on the way out (line 430-431).
- **Public passthrough**: `PUBLIC_ICON_PATHS` set bypasses auth for favicons/manifest (lines 116-127, 309-311).
- **Path-prefix branches**: `/login`, `/logout`, `/sms/inbound`, `/api/web/*`, `/mcp`, `/legacy*`, then the regex `ROUTES` loop, then unmatched GET → SPA shell.
- **Try/catch wrapping**: each `ROUTES` invocation is wrapped in a try/catch that logs `console.error` and returns `jsonError('Internal server error: …', 500)`.

### 5c. Error handling

- REST handlers return `jsonError(message, status)` or throw, with the router's try/catch translating throws to 500.
- MCP errors return JSON-RPC error objects (`code: -32000` for tool errors, `-32700` parse, `-32600` invalid request, `-32601` method not found).
- Snapshot endpoint (`web-api.ts`) wraps each downstream call in its own try/catch and falls back to `null`/0 on failure rather than failing the whole response.
- `runCron` in `@agentbuilder/observability` is documented to catch handler exceptions and never re-throw, so sibling crons in `scheduled()` keep running.

### 5d. Authentication

Four distinct auth schemes coexist:

1. **Cookie session** (`@agentbuilder/web-ui-kit`) — used for the React SPA at `/` and `/api/web/*`. Backed by a `web_sessions` D1 table via the kit. Login at `POST /login` calls `verifyPassword(env.WEB_UI_PASSWORD, password)` then `createSession`; logout destroys it. `requireWebSession` gates SPA shells; `requireApiAuth` gates `/api/web/*`.
2. **Bearer `EXTERNAL_API_KEY`** — alternative path through `requireApiAuth` for `/api/web/*` programmatic callers.
3. **Bearer `MCP_HTTP_KEY`** — gates `POST /mcp` only. Unset = open.
4. **Header `X-User-Id`** — the legacy tax-prep convention. `getUserId(request)` in `src/types.ts` reads `x-user-id` and defaults to `"default"`. Every REST route uses this as the tenant key. Internal calls from `web-api.ts` and `mcp-tools.ts` stamp `x-user-id: default` (or `env.WEB_UI_USER_ID` for `/api/web/*`). There is no signature check on this header — once a caller is past whichever outer auth applies, it can claim any user id.

A fifth distinct check applies to inbound Twilio SMS at `/sms/inbound` — `handleSmsInbound` verifies `X-Twilio-Signature` against `TWILIO_AUTH_TOKEN`. This sits **before** the cookie gate so Twilio can post without cookies.

### 5e. Shared types and interfaces

- **`src/types.ts`** holds the `Env` interface plus domain types (`Transaction`, `Classification`, `Account`, `Rule`, `AIClassification`, `AmazonOrder`, `BusinessEntity`, `ChartOfAccount`, plus context types for Venmo/Amazon/Apple/Etsy) and the three category tables (`SCHEDULE_C_CATEGORIES`, `AIRBNB_CATEGORIES`, `FAMILY_CATEGORIES`).
- **`src/web/types.ts`** mirrors a subset of the API shapes for the SPA side, alongside chat-stream event types.
- **`MCP_TOOLS`** in `src/mcp-tools.ts` is exported and re-imported by `web-chat-tools.ts` so the in-app chat reuses the same tool definitions.
- **`JsonRpcMessage`** is exported from `mcp-tools.ts` for use in `index.ts`.
- The kit-facing `kitEnv(env)` shim in `src/index.ts:104-110` is the only point that narrows `Env` to the subset `@agentbuilder/web-ui-kit` reads (`DB`, `WEB_UI_PASSWORD`, `EXTERNAL_API_KEY`).

---

## Cross-cutting observations (no recommendations)

These are factual notes that surfaced during the audit and are reported here for completeness, not as suggestions:

- `Env` declares `PLAID_*` bindings and `BankProvider = 'teller' | 'plaid'`, but a comment at `src/types.ts:2-4` states "Dropped Plaid bindings on migration from tax-prep — Teller is the only bank provider now." Plaid code paths still exist under `src/lib/plaid.ts` and `src/routes/plaid.ts`.
- `src/index.ts` does not register `/plaid/*` routes in the `ROUTES` array, so the Plaid route module is imported by the bank-handling code but not directly reachable through the router. (Not exhaustively verified.)
- Two migration files share `0015_` and two share `0017_` as prefixes.
- The package.json's hardcoded model identifier `claude-opus-4-6` in `src/lib/claude.ts:28` contradicts `AGENTS.md` rule 6 ("Model tiers, not model ids"). Reported because rule 6 is repo-stated; not a fix recommendation.
- The agent declares `@agentbuilder/core` and `@agentbuilder/llm` as runtime deps but neither is imported anywhere in `apps/cfo/src/**`.
- `pre-migration-backup.sql` (~12 KB) sits in the app root, outside the `migrations/` directory.
- The MCP `tools/call` surface implements ~24 tools while the registry lists 18; AGENTS.md rule 2 calls for ≤10 tools per agent. The in-app chat allowlist is the only surface that respects the ≤10 rule.
- Both `pnpm-lock.yaml` and `package-lock.json` are present at the repo root.

---

End of report 01.
