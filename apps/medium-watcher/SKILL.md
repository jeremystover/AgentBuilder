# Medium Watcher

**Purpose.** Polls a watchlist of Medium RSS feeds daily, fetches each new article with a logged-in subscriber cookie so member-only bodies come through, and pipes the extracted text into Research Agent's knowledge base. A background feeder — not user-facing.

## When to call me
- "Watch this Medium author / publication / tag"
- "Show me the Medium feeds I'm watching"
- "Stop watching {slug}"
- "Run the Medium poll now"
- "Update my Medium cookie"

## Non-goals
- Searching or synthesizing content — that's Research Agent
- Posting to Medium
- Fetching member-only content for someone else's account
- Discovering Medium feeds (you supply the URL)

> **Research Agent boundary:** This worker fetches and forwards. Research Agent owns ingestion, summarization, embedding, and search. New paywalled source → add a poller here or its own watcher; new search/digest behavior → belongs in Research Agent.

## REST API (bearer-authenticated with `WATCHER_API_KEY`)

| Method | Path | Description |
|---|---|---|
| `GET`    | `/health`                                    | Liveness probe (unauth): `{ ok, watching }` |
| `GET`    | `/watch`                                     | List watched feeds |
| `POST`   | `/watch`                                     | Add `{ feedUrl, name, sourceId? }` |
| `DELETE` | `/watch/:slug`                               | Remove a feed |
| `POST`   | `/run`                                       | Trigger a poll now |
| `GET`    | `/credentials`                               | List vault entries (`?provider=`, `?account=`) |
| `GET`    | `/credentials/:account/:provider/:kind`      | Read one credential |
| `PUT`    | `/credentials/:account/:provider/:kind`      | Upsert `{ value, metadata?, expiresAt? }` |
| `DELETE` | `/credentials/:account/:provider/:kind`      | Remove one credential |

The `/credentials` surface is shared via `mountCredentialsApi` from `@agentbuilder/credential-vault`. Use the `pnpm cred …` CLI to drive it from a developer machine.

## Pipeline
1. **Cron `0 14 * * *`** — daily, 14:00 UTC.
2. Load the Medium cookie once from the vault.
3. For each watched feed:
   - Fetch the RSS (unauthenticated; `application/rss+xml`)
   - Filter to items not present in `seen:{slug}` KV
   - For each new item: GET the article URL with `Cookie: <vault value>` and Safari UA, run an HTMLRewriter pass to extract `<article>` body, JSON-LD metadata, og: title, canonical link
   - If extracted body < 800 chars → flag as `paywalled` and mark seen anyway (we'll re-ingest after a cookie refresh)
   - Otherwise POST `{ url, content, title, author, published_at, source_id }` to `research-agent/ingest` with `INTERNAL_SECRET` bearer
4. Append seen ids; cap at 500 to bound KV value size.

## Bindings
- **KV**  `MEDIUM_STATE` — `watchlist` (JSON array) + `seen:{slug}` (string[])
- **D1**  `VAULT_DB`     — `vault_credentials` table from `@agentbuilder/credential-vault`
- **Vars** `RESEARCH_AGENT_URL`

## Secrets
- `WATCHER_API_KEY` — bearer token for this worker's REST API
- `INTERNAL_SECRET` — must match research-agent's `INTERNAL_SECRET`
- `KEK_BASE64`     — base64 of 32 random bytes; used as the AES-256-GCM KEK for the vault. Generate with `openssl rand -base64 32` (or `pnpm --silent cred genkey`).

## First-time setup

```bash
# 1. KV + D1
wrangler kv namespace create MEDIUM_STATE
wrangler d1 create medium-watcher-vault
# → copy both ids into wrangler.toml

# 2. Schema (the --remote flag is important — without it you migrate the
#    local miniflare D1 instead of the deployed one)
wrangler d1 execute medium-watcher-vault --remote --file=./migrations/0001_init.sql

# 3. Secrets
openssl rand -base64 32 | wrangler secret put KEK_BASE64 --name medium-watcher
wrangler secret put WATCHER_API_KEY --name medium-watcher    # any random string
wrangler secret put INTERNAL_SECRET --name medium-watcher    # must match research-agent

# 4. Deploy
wrangler deploy

# 5. Store your Medium cookie
#    (DevTools → Application → Cookies → copy `sid`, `uid`, etc. as
#     `name1=value1; name2=value2`)
pnpm cred put medium-watcher default medium cookie

# 6. Add a feed
curl -X POST https://medium-watcher.<you>.workers.dev/watch \
  -H "Authorization: Bearer $WATCHER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"feedUrl":"https://medium.com/feed/@danshipper","name":"Dan Shipper"}'

# 7. Smoke test
curl -X POST https://medium-watcher.<you>.workers.dev/run \
  -H "Authorization: Bearer $WATCHER_API_KEY"
```

## Notes
- Medium's `sid` cookie typically rotates every ~30 days. Set `expiresAt` when you store the cookie so future tooling can warn before expiry.
- The 800-char paywall heuristic is loose. If you see legitimate short articles consistently flagged, lower it — the dedup state means re-ingestion is harmless.
- No LLM calls in this worker; pure transport.
- Respect the Medium ToS: this worker pulls *your own* paid session into *your own* private knowledge base. Do not republish externally.
