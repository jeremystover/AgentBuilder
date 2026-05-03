# Shopping Price Tracker

**Purpose.** Tracks daily prices for products and airline tickets you're
considering buying. Auto-discovers retailer URLs from a description /
model number on intake (via Claude API `web_search`), then refreshes
prices each day from saved URLs (free), eBay Browse API (free, used /
auction listings), and Claude `web_search` (catches sales at retailers
not in `watch_urls`). Emails a single daily digest so you can decide
when to pull the trigger.

This is an **app-agent**: MCP tools for Claude conversations + a vanilla
web UI at `/app` for browsing tracked items and full price history.

## When to call me
- "Track Sony WH-1000XM5 headphones with a $280 target"
- "Watch flights JFK to LIS, depart May 15-22, return June 1-8, max $700"
- "What's the latest digest?"
- "Show me the price history of my Roborock track"
- Daily 12:00 UTC cron sends the digest automatically.

## Non-goals
- Auto-purchasing items or executing checkout — buy decisions are manual.
  Even if a future adapter speaks OpenAI's Agentic Commerce Protocol,
  this agent calls only ACP's discovery endpoints, never
  `complete_purchase` / Instant Checkout.
- Ingesting *past* purchases for bookkeeping (that's CFO's `amazon-import`).
- General page-content monitoring with regex/contains/hash matchers
  (that's Research Agent's `manage_watches`).
- Calendar, tasks, goals, or stakeholder management (Chief of Staff).
- Building or modifying other agents (Agent Builder).
- Real-time conversational shopping advice — I track listings; you decide.

## Tools (8)
- `add_tracked_item` — start tracking a product or flight. Auto-discovers
  retailer URLs for products via `web_search`.
- `update_tracked_item` — patch fields (target price, priority, status,
  flight constraints, etc.).
- `list_tracked_items` — list with optional `status` / `kind` /
  `priority` filters; includes the latest observation per item.
- `remove_tracked_item` — archive (default) or hard-delete with
  observations.
- `get_item_history` — full price observations over a time window
  (default 30 days).
- `run_search_now` — manual refresh for one item or all active items
  (skips the cron wait).
- `latest_digest` — the most recent daily digest (markdown by default;
  HTML on request).
- `manage_digest_recipients` — add / remove / list email recipients.

## Search strategy
- **Claude API `web_search`** — primary backbone. Used once on intake to
  discover retailer URLs; once per day per active item to find current
  best prices and any active sales. Cost: ~$10 per 1000 searches.
- **URL-watch** — scrapes saved `watch_urls` for `Product.offers.price`
  in JSON-LD or `product:price:amount` in Open Graph. Free, fast, runs
  every refresh.
- **eBay Browse API** — free, requires `EBAY_APP_ID`. Catches used /
  auction listings the web search rarely surfaces.

## Email digest
- One email per day at 12:00 UTC, prefixed `[Shopping]`. Each item has
  a one-line LLM summary, a target/sale/drop chip, the best price found
  today, and a 14-day sparkline.
- Recipients live in `digest_recipients` — manage via the
  `manage_digest_recipients` tool or the Settings page.

## Web UI
- `/app` — dashboard, add-item form (Product / Flight modes), per-item
  detail with full Chart.js history, settings, digest preview.
- Cookie session via `WEB_UI_PASSWORD`.

## REST API (external)
- `/api/v1/items[/<id>][/refresh]`, `/api/v1/digests[/<id>]`,
  `/api/v1/recipients`. Bearer `EXTERNAL_API_KEY`.

## Shared packages
- `@agentbuilder/core`
- `@agentbuilder/llm` (digest summaries)
- `@agentbuilder/web-ui-kit` (auth, SPA shell)
