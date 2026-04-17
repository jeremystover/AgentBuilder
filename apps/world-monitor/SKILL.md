# World Monitor

**Purpose.** Situational-awareness agent for the fleet. Surfaces live markets,
geopolitics, conflict, climate, supply-chain, cyber, and infrastructure signals
via 8 coarse MCP tools. Internally ports the upstream
[worldmonitor-mcp](https://github.com/mahimn01/worldmonitor-mcp) registry
(which itself wraps [koala73/worldmonitor](https://github.com/koala73/worldmonitor)),
implemented as a native Cloudflare Worker — no stdio subprocess, no DOM parser.

## When to call me
- "What's happening in the markets right now?"
- "Any recent earthquakes M5+ in the last 24h?"
- "Give me a news brief on [variant=full|tech|finance]"
- "Any new SEC EDGAR filings for NVDA?"
- "Show insider transactions for CIK 0000320193"
- "What are the latest 13F filings from Berkshire (CIK 1067983)?"

## Non-goals
- Calendar, tasks, goals, or stakeholder management (that's Chief of Staff)
- Bookkeeping, budgeting, taxes, or personal financial planning (that's CFO) —
  World Monitor reports market data, it doesn't act on your portfolio
- Guest booking or property management (that's Guest Booking)
- Building or modifying other agents (that's Agent Builder)
- Indexing articles into a personal knowledge base (that's Research Agent) —
  World Monitor returns live feeds, not a saved-article store
- Article extraction / body fetching — explicitly out of scope (HTML parsing on
  Workers is costly; the upstream's DOM-based extractor was not ported)
- Executing trades, moving money, or any write-side action against external systems
- Investment, legal, medical, or geopolitical advice — data only

## MCP surface

Exposed at `POST /mcp` as 8 coarse tools. Each takes `{ operation, params }`
where `operation` is an enum of the specific endpoint to hit.

| Coarse tool | v1 status | v1 operations |
|---|---|---|
| `markets` | wired (proxy) | `list_market_quotes`, `list_crypto_quotes`, `list_commodity_quotes`, `get_sector_summary`, `list_stablecoin_markets`, `list_etf_flows`, `get_country_stock_index`, `list_gulf_quotes` |
| `news` | wired (proxy) | `list_feed_digest` |
| `climate` | wired (proxy) | `list_earthquakes` |
| `government` | wired (**direct** to SEC EDGAR) | `search_sec_filings`, `get_insider_transactions`, `get_institutional_holdings`, `get_company_filings`, `get_company_facts` |
| `geopolitics` | stubbed (returns 501) | — |
| `supply_chain` | stubbed | — |
| `cyber_infra` | stubbed | — |
| `predictions` | stubbed | — |

Adding operations to a wired category = drop a `ServiceDef` under
`src/registry/services/` and register it in `src/registry/index.ts`.
Adding a direct handler = add a file under `src/handlers/` and mirror
`directHandlers` in `src/handlers/index.ts`. The dispatcher and cache are
category-generic; no other code changes needed.

## Architecture

```
POST /mcp  ─►  handleMcp  ─►  dispatch(category, operation, params)
                                │
                                ├─ withCache (KV, per-category TTL)
                                │       │
                                │       ▼
                                ├─ direct  → src/handlers/<service>.ts
                                │           (e.g. SEC EDGAR → data.sec.gov)
                                │
                                └─ proxy   → client.callUrl
                                            (WORLDMONITOR_BASE_URL + basePath + endpoint)
```

- **HTTP client** (`src/client.ts`): native `fetch`, AbortController timeout,
  2× exponential backoff on 429/5xx, HTML-response detection, response-size
  truncation (largest-array halving, ported from upstream).
- **Cache** (`src/cache.ts`): KV-backed, per-category TTL. Degrades to no-op
  when the `WM_CACHE` binding is absent.
- **Registry** (`src/registry/`): declarative `ServiceDef` objects — same shape
  as upstream; porting more services is mechanical.

## Cache TTLs

Tuned by data volatility:

| Category | TTL |
|---|---|
| `markets` | 60s |
| `news`, `climate`, `cyber_infra`, `predictions`, `geopolitics` | 5m |
| `supply_chain` | 10m |
| `government` | 15m |

`markets` sits at KV's minimum (60s); lowering further requires a different
cache substrate (Durable Object storage or in-memory).

## Env / secrets

None are required; defaults work. All are optional:

| Variable | Purpose | Default |
|---|---|---|
| `WM_CACHE` (KV binding) | Response cache | disabled (no-op) |
| `MCP_HTTP_KEY` | Bearer token for `POST /mcp` | no auth |
| `WORLDMONITOR_BASE_URL` | Upstream base URL | `https://worldmonitor.app` |
| `WORLDMONITOR_API_KEY` | Upstream bearer token | none |
| `WORLDMONITOR_TIMEOUT` | HTTP timeout in ms | `15000` |
| `WORLDMONITOR_MAX_RESPONSE_SIZE` | Response truncation threshold in bytes | `100000` |

Secrets flow via `wrangler secret put <NAME> --name world-monitor`.

## One-time setup: KV cache

```bash
wrangler kv namespace create WM_CACHE
# → returns an id; paste it into wrangler.toml where noted
```

The worker is functional without KV — the cache layer silently no-ops when
the binding is missing. Skipping this step is fine for local dev.

## Shared packages
- `@agentbuilder/core`
- `@agentbuilder/llm`

## Notes
- Model tier: `default` (Sonnet). The MCP surface is pure data — the LLM only
  engages when a user calls `POST /chat` for a conversational turn.
- Prompt caching: on by default via `@agentbuilder/llm`.
- Upstream koala73/worldmonitor is AGPL-3.0; mahimn01/worldmonitor-mcp is MIT.
  This Worker port uses only the service definitions and the
  direct-handler shapes — verify license compatibility before production deploy.
