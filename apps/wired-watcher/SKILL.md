# Wired Watcher

**Purpose.** Polls a watchlist of Wired RSS feeds (sections, tags) daily, fetches each new article with a logged-in subscriber cookie so paywalled bodies come through, and pipes the extracted text into Research Agent's knowledge base. A background feeder — not user-facing.

## When to call me
- "Watch this Wired section / tag"
- "Show me the Wired feeds I'm watching"
- "Stop watching {slug}"
- "Run the Wired poll now"
- "Update my Wired cookie"

## Non-goals
- Searching or synthesizing content — that's Research Agent
- Bypassing other Condé Nast paywalls (use a separate watcher per property)
- Fetching paywalled content for someone else's account
- Discovering Wired feeds (you supply the URL)

> **Research Agent boundary:** This worker fetches and forwards. Research Agent owns ingestion, summarization, embedding, and search.

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

## Pipeline
1. **Cron `30 14 * * *`** — daily, 14:30 UTC. Offset 30 min from medium-watcher.
2. Load the Wired cookie from the vault.
3. For each watched feed:
   - Fetch the RSS (unauthenticated; standard RSS 2.0)
   - Filter to items not present in `seen:{slug}` KV
   - For each new item: GET the article URL with `Cookie: <vault value>` and Safari UA, extract via `@agentbuilder/extract-article`
   - If extracted body < 1200 chars → flag `paywalled` (cookie likely stale or bot challenge served) and mark seen anyway
   - Otherwise POST `{ url, content, title, author, published_at, source_id }` to `research-agent/ingest` with `INTERNAL_SECRET`
4. Append seen ids; cap at 500.

The 1200-char floor is a bit higher than medium-watcher's 800 because Wired tends to serve a longer truncated preview on paywalled fetches, and bot-challenge HTML can have ~600 chars of "verifying you are human" boilerplate.

## Bindings
- **KV**  `WIRED_STATE` — `watchlist` (JSON array) + `seen:{slug}` (string[])
- **D1**  `VAULT_DB`    — `vault_credentials` table from `@agentbuilder/credential-vault`
- **Vars** `RESEARCH_AGENT_URL`

## Secrets
- `WATCHER_API_KEY` — bearer token for this worker's REST API
- `INTERNAL_SECRET` — must match research-agent's `INTERNAL_SECRET`
- `KEK_BASE64`     — base64 of 32 random bytes; AES-256-GCM KEK for the vault. Generate with `openssl rand -base64 32` (or `pnpm --silent cred genkey`).

## First-time setup

```bash
# 1. KV + D1
wrangler kv namespace create WIRED_STATE
wrangler d1 create wired-watcher-vault
# → copy both ids into wrangler.toml

# 2. Schema (the --remote flag is important — without it you migrate the
#    local miniflare D1 instead of the deployed one)
wrangler d1 execute wired-watcher-vault --remote --file=./migrations/0001_init.sql

# 3. Secrets
openssl rand -base64 32 | wrangler secret put KEK_BASE64 --name wired-watcher
wrangler secret put WATCHER_API_KEY --name wired-watcher    # any random string
wrangler secret put INTERNAL_SECRET --name wired-watcher    # must match research-agent

# 4. Deploy
wrangler deploy

# 5. Store your Wired cookie
#    DevTools → Application → Cookies → wired.com
#    Copy the relevant cookies as a single header value:
#       wp_user_token=...; CN_SubID=...; <other Condé cookies>
pnpm cred put wired-watcher default wired cookie

# 6. Add some feeds
curl -X POST https://wired-watcher.<you>.workers.dev/watch \
  -H "Authorization: Bearer $WATCHER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"feedUrl":"https://www.wired.com/feed/category/business/rss","name":"Wired Business"}'

curl -X POST https://wired-watcher.<you>.workers.dev/watch \
  -H "Authorization: Bearer $WATCHER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"feedUrl":"https://www.wired.com/feed/category/science/rss","name":"Wired Science"}'

# 7. Smoke test
curl -X POST https://wired-watcher.<you>.workers.dev/run \
  -H "Authorization: Bearer $WATCHER_API_KEY"
```

## Useful Wired feeds
- `https://www.wired.com/feed/rss` — everything
- `https://www.wired.com/feed/category/business/rss`
- `https://www.wired.com/feed/category/science/rss`
- `https://www.wired.com/feed/category/security/rss`
- `https://www.wired.com/feed/tag/<tag>/rss` — e.g. `tag/artificial-intelligence`

## Notes
- Condé Nast occasionally rotates session cookies and serves Cloudflare/Akamai bot-challenge HTML. Watch for `paywalled` counts climbing in cron logs — that's the signal to refresh the cookie.
- Cookie domain is `.wired.com`; the Safari UA in `article.ts` matters because Wired's bot detection sometimes blocks bare bot UAs.
- Daily cadence is plenty. Scraping more aggressively risks tripping rate limits and is a ToS exposure.
- Personal scope only. The article bodies are stored in Research Agent's private knowledge base; do not republish externally.
