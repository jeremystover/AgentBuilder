# LinkedIn Watcher

**Purpose.** Polls a watchlist of LinkedIn profiles daily via the Proxycurl API and pipes any new posts into Research Agent's knowledge base for ingestion, summarization, and search. A background feeder — not user-facing.

## When to call me
- "Watch this LinkedIn profile for new posts"
- "Show me the LinkedIn profiles I'm watching"
- "Stop watching {slug}"
- "Run the LinkedIn poll now"

## Non-goals
- Searching or synthesizing content — that's Research Agent
- Posting to LinkedIn or any social network
- Pulling connections, messages, or non-post activity
- Ephemeral reads of a LinkedIn profile for planning — this agent is for persistent ingestion
- Building or modifying other agents (that's Agent Builder)

> **Research Agent boundary:** This worker fetches and forwards; Research Agent owns the knowledge base (summarize, embed, store, search). New feed type → add a poller here; new search or digest behavior → belongs in Research Agent.

## REST API (bearer-authenticated with `WATCHER_API_KEY`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe (unauth): `{ ok, watching }` |
| `GET` | `/watch` | List watched profiles |
| `POST` | `/watch` | Add `{ linkedinUrl, name, sourceId? }` |
| `DELETE` | `/watch/:slug` | Remove a profile by slug |
| `POST` | `/run` | Trigger a watcher run now (for testing) |

## Pipeline
1. **Cron `0 14 * * *`** — runs daily at 14:00 UTC (~7am PT).
2. For each watched profile, call **Proxycurl** `/linkedin/person/posts?type=posts`.
3. Filter to posts within a 48h window and not already in `seen:{slug}` KV state.
4. Render each new post to HTML and archive to R2 (`posts/{slug}/{postId}.html`).
5. `POST /ingest` to **research-agent** with pre-fetched content + `INTERNAL_SECRET` bearer.
6. Append the post id to `seen:{slug}` (capped at 500 entries).

## Bindings
- **KV** `LINKEDIN_STATE` — `watchlist` (JSON array) + `seen:{slug}` (string[])
- **R2** `LINKEDIN_CONTENT` (bucket `linkedin-watcher-content`) — archived post HTML
- **Vars** `RESEARCH_AGENT_URL`

## Secrets
- `PROXYCURL_API_KEY` — app.proxycurl.com API key
- `INTERNAL_SECRET` — must match research-agent's `INTERNAL_SECRET`
- `WATCHER_API_KEY` — bearer token protecting this worker's mgmt API

## Notes
- 48h lookback with daily cron = one missed run is still recovered without re-ingestion (dedup handles the overlap).
- `seen:{slug}` cap at 500 keeps KV values bounded while covering weeks of typical posting cadence.
- Proxycurl billing: ~1–2 credits per profile poll (~$0.01). Watch the watchlist size.
- No Anthropic API key required — this worker is pure transport, no LLM calls.
