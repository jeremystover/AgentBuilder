# Research Agent

**Purpose.** Personal knowledge base — ingests articles from Bluesky, email forwards, and manual bookmarks; retrieves content via semantic and full-text search; synthesizes grounded answers with citations; and curates ranked digests by interest profile.

## When to call me
- "What have I saved about [topic]?"
- "Ingest this URL / add this to my reading list"
- "Search my knowledge base for [topic]"
- "Generate a digest of what I've read recently"
- "What does my research say about [question]?"
- "Add a Bluesky account as a feed source"
- "What articles have I bookmarked from [source]?"

## Non-goals
- Calendar, tasks, goals, or stakeholder management (that's Chief of Staff)
- Sending emails or creating calendar events (that's Chief of Staff)
- Financial accounting, bookkeeping, or tax work (that's CFO)
- Guest booking or property management (that's Guest Booking)
- Building or modifying other agents (that's Agent Builder)
- Real-time web search — this agent searches *ingested* content only
- Ephemeral Drive doc or web page reads for planning context (that's Chief of Staff's `read_content`)

> **Chief of Staff boundary:** Chief of Staff has `read_content` / `resolve_uri` for *ephemeral* fetching of Drive docs and web pages during planning (e.g., reading a meeting agenda). Research Agent is for *permanently indexing* articles so they can be searched later. "Read this doc for context" → Chief of Staff. "Save this article to my reading list" → Research Agent.

## Tools (MCP surface — POST /mcp)

All 10 tools are available via the standard MCP endpoint and via POST /chat.

| Tool | Description |
|---|---|
| `ingest_url` | Fetch a URL, extract content, summarize, embed, and store. Idempotent. |
| `search_semantic` | Vector similarity search using natural language. |
| `search_fulltext` | FTS5 keyword search — supports AND, OR, NOT, "exact phrase". |
| `get_article` | Retrieve full article metadata by UUID; optionally include body or HTML. |
| `synthesize` | RAG: retrieve relevant articles and generate a grounded answer with citations. |
| `generate_digest` | Curate a ranked digest of recent articles by interest profile. |
| `record_feedback` | Thumbs-up a specific article → boosts topic and source weights. |
| `manage_interests` | View or edit interest profile (topic weights, source scores, settings). |
| `list_sources` | List, add, remove, or toggle ingestion sources (Bluesky, RSS, email). |
| `score_content` | Score an article's relevance against the current interest profile. |

## REST endpoints
- `POST /ingest` — quick-ingest from bookmarklet or browser extension
- `POST /api/digest` — generate a digest without going through chat
- `POST /api/sources` — manage sources without going through chat

## Ingestion sources
- **Bluesky** — polled every 30 min via cron; stores liked/timeline posts, extracts linked URLs
- **Email** — forward any email to the agent's Email Workers address; URLs are extracted and ingested
- **Manual** — `ingest_url` tool or `POST /ingest` endpoint; browser bookmarklet

## Shared packages
- None (uses Workers AI directly for `edge`-tier inference; no Anthropic API key required)

## Notes
- Model tier: `edge` (Workers AI — `@cf/baai/bge-base-en-v1.5` for embeddings, `@cf/meta/llama-3.1-8b-instruct` for generation)
- Vectorize index: `research-agent-content` (768 dimensions, cosine metric)
- R2 bucket: `research-agent-content` (full HTML and text for articles exceeding D1 row limits)
- Chat sessions are pinned to a single named Durable Object instance ("jeremy")
- MCP bearer token required for all authenticated endpoints — set via `wrangler secret put MCP_BEARER_TOKEN`
