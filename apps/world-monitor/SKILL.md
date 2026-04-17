# World Monitor

**Purpose.** Situational-awareness agent for the fleet. Wraps the upstream
[worldmonitor-mcp](https://github.com/mahimn01/worldmonitor-mcp) server
(which itself wraps [koala73/worldmonitor](https://github.com/koala73/worldmonitor))
to surface live markets, geopolitics, conflict, climate, supply chain, cyber,
and infrastructure signals to other agents via MCP.

## When to call me
- "What's happening in the markets right now?"
- "Any recent earthquakes / wildfires / severe weather near [place]?"
- "Latest FRED print for [series]" / "What did the treasury auction today?"
- "Summarize conflict activity in [region] over the last 24h"
- "Any new SEC EDGAR filings for [ticker]?"
- "What do prediction markets say about [event]?"
- "Pull a news brief on [topic]"
- "Supply-chain or maritime disruptions today?"
- "Recent cyber incidents affecting [sector]?"

## Non-goals
- Calendar, tasks, goals, or stakeholder management (that's Chief of Staff)
- Bookkeeping, budgeting, tax work, or personal financial planning (that's CFO) —
  World Monitor reports market data, it doesn't act on your portfolio
- Guest booking or property management (that's Guest Booking)
- Building or modifying other agents (that's Agent Builder)
- Indexing articles into a personal knowledge base (that's Research Agent) —
  World Monitor returns live feeds, not a saved-article store
- Executing trades, moving money, or any write-side action against external systems
- Giving investment, legal, medical, or geopolitical advice — data only

## Tools (MCP surface — POST /mcp)

Surface is kept coarse. Each tool proxies to the matching category in the
upstream worldmonitor-mcp server (which exposes ~140 underlying tools across
32 services). The upstream server is launched as a stdio child process or
reached via a configured `WORLDMONITOR_MCP_URL`.

| Tool | Description |
|---|---|
| `markets` | Equities, treasury, CFTC, congress-trading, onchain, and sentiment queries. |
| `geopolitics` | Intelligence, conflict events, military movement, unrest, displacement. |
| `news` | Headline feeds, research briefs, and article extraction (direct + Google Cache + Archive.org fallbacks). |
| `climate` | Weather, agriculture, wildfire, and seismology queries. |
| `supply_chain` | Supply-chain signals, maritime traffic, and trade-flow data. |
| `cyber_infra` | Cyber incidents, critical-infrastructure alerts, aviation events. |
| `government` | Government releases, SEC EDGAR filings, economic-calendar entries. |
| `predictions` | Prediction-market odds and forecasting signals. |

Kept under the 10-tool cap (AGENTS.md §2). Each tool takes a free-form
`query` plus optional structured params (`symbols`, `region`, `since`, etc.)
that are forwarded to the underlying worldmonitor-mcp call.

## Upstream MCP server

```json
{
  "mcpServers": {
    "worldmonitor": {
      "command": "npx",
      "args": ["github:mahimn01/worldmonitor-mcp"]
    }
  }
}
```

Installed from the git repo because `worldmonitor-mcp` is not yet published
to npm. Swap to `"args": ["worldmonitor-mcp"]` once it's on the registry.

## Env / secrets

None are required. All are optional and unlock rate-limited endpoints:

| Secret | Purpose |
|---|---|
| `WORLDMONITOR_BASE_URL` | Upstream worldmonitor.app URL (default `https://worldmonitor.app`) |
| `WORLDMONITOR_API_KEY` | Upstream API key if you have one |
| `FINNHUB_API_KEY` | Earnings/IPO calendar, market quotes |
| `FRED_API_KEY` | FRED economic data |
| `USDA_API_KEY` | Crop and drought reports |
| `OPENSANCTIONS_API_KEY` | Sanctions search enhancement |

Set any of these via `wrangler secret put <NAME> --name world-monitor`.

## Shared packages
- `@agentbuilder/core`
- `@agentbuilder/llm`

## Notes
- Model tier: `default` (Sonnet). Drop to `fast` (Haiku) for pure
  classification (e.g., "which category does this question belong to").
- Prompt caching: on by default via `@agentbuilder/llm`.
- Upstream is AGPL-3.0 (koala73/worldmonitor). The `mahimn01/worldmonitor-mcp`
  wrapper licensing should be reviewed before production deploy.
