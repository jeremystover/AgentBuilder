# shopping-price-tracker

Tracks daily prices for products and flights and emails you a digest.

## Layout

```
src/
  index.ts            Worker entrypoint (routes + scheduled())
  durable-object.ts   Stub DO (state lives in D1)
  types.ts
  lib/
    db.ts             D1 query helpers (items, observations, digests, recipients)
    ids.ts ids        crypto.randomUUID() wrapper
    money.ts          dollars↔cents, median
    time.ts           ISO helpers
  search/
    index.ts          Adapter orchestrator
    types.ts          Listing interface
    claude_discover.ts  One-shot URL discovery on intake
    claude_web.ts     Daily product price refresh via Claude web_search
    claude_flights.ts Daily flight refresh via Claude web_search
    ebay.ts           eBay Browse API supplement
    url_watch.ts      JSON-LD / Open Graph price scraper
    _json.ts          Robust JSON-array extractor for LLM responses
  mcp/
    server.ts         JSON-RPC dispatcher + tool manifests
    tools/            One file per tool (8 tools)
  digest/
    build.ts          Pull items → run search → tag → LLM summarize
    render.ts         Plain-text + HTML email bodies (inline SVG sparkline)
    email.ts          MIME build + SEND_EMAIL.send per recipient
  cron/
    daily.ts          12:00 UTC: build digest, persist run, send email
    priority.ts       4-hourly: refresh priority='high' items only, no email
  web/
    api.ts            REST handlers for /api/v1 + /app/api
    spa-pages.js      Page handlers concatenated to SPA_CORE_JS
migrations/
  0001_init.sql       tracked_items, flight_constraints, price_observations,
                      digest_runs, digest_recipients
  0002_web_sessions.sql   WebSessions for the web-ui-kit cookie auth
```

## Dev

```bash
pnpm install
pnpm --filter @agentbuilder/app-shopping-price-tracker typecheck
pnpm --filter @agentbuilder/app-shopping-price-tracker dev
```

## D1 setup (one time)

```bash
wrangler d1 create shopping-price-tracker-db
# Copy the database_id into wrangler.toml [[d1_databases]] database_id = "..."

wrangler d1 migrations apply shopping-price-tracker-db --local
wrangler d1 migrations apply shopping-price-tracker-db --remote
```

## Secrets

```bash
wrangler secret put MCP_HTTP_KEY        # bearer token for /mcp
wrangler secret put WEB_UI_PASSWORD     # browser login at /app
wrangler secret put EXTERNAL_API_KEY    # bearer for /api/v1/*
wrangler secret put ANTHROPIC_API_KEY   # web_search + digest summaries
wrangler secret put EBAY_APP_ID         # eBay Browse (optional but recommended)
```

## Deploy

```bash
wrangler deploy
```

Verify the daily cron has a recipient seeded:

```bash
curl -X POST https://shopping-price-tracker.<acct>.workers.dev/api/v1/recipients \
  -H "Authorization: Bearer $EXTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

The destination address must be verified in the Cloudflare dashboard
under Email > Destination addresses for the worker to be able to send
to it.

## Cron schedule

| Cron | Purpose |
|---|---|
| `0 12 * * *` | Daily digest — build + send email |
| `0 */4 * * *` | Priority refresh — `priority='high'` items only, no email |

## MCP wiring

Add `https://shopping-price-tracker.<acct>.workers.dev/mcp` as a custom
tool in Claude.ai with the `MCP_HTTP_KEY` as the bearer token.

```
Track Sony WH-1000XM5 with target $280
→ Claude routes to add_tracked_item with kind: "product"
→ The agent runs claude_discover internally and saves retailer URLs
```

## Cost model

Claude `web_search` bills around $10 per 1000 searches. With ~30 active
items doing one search per day plus a handful of priority refreshes,
expect ~$10–20/month for web_search plus modest token usage.
