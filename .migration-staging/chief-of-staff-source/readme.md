# MCP Worker Backend (Cloudflare)

This directory contains the production MCP backend for Personal Productivity Project.

## What this service is

A **Cloudflare Worker JSON-RPC server** that exposes MCP tools for:

- Drive markdown file operations
- Planning/task/commitment workflow with propose→commit guardrails
- CRM and review workflows
- Gmail/Calendar/Drive ingest
- Zoom recording polling/transcript ingestion
- Automation draft generation (morning brief + commitment nudges)

## Runtime Architecture

- Entry point: `worker.js`
- Deployment/runtime: Cloudflare Workers (`wrangler.toml`)
- Persistent systems:
  - Google Sheets (`sheets.js`): operational database
  - Google Drive API: markdown content storage
  - Gmail + Calendar APIs: automation and ingestion

## Tool Families

`worker.js` composes tools into families:

1. Content + Drive tools (URI resolve/read/search, status file CRUD)
2. **Phase 1** (`tools.js`): planning hydration + propose/commit mutations
3. **Phase 2 CRM** (`crm.js`)
4. **Phase 2 Reviews** (`reviews.js`)
5. **Phase 3 Zoom** (`zoom.js`)
6. Ingest (`ingest.js`)
7. **Phase 4 Automation** (`automation.js`)

## SOP: Deployment

1. Install deps:
   ```bash
   npm install
   ```
2. Configure secrets with Wrangler (`wrangler secret put ...`), including:
   - `GOOGLE_SERVICE_ACCOUNT_JSON`
   - `PPP_SHEETS_SPREADSHEET_ID`
   - `MCP_HTTP_KEY` (recommended)
   - Gmail/Calendar OAuth secrets for user-mode APIs
3. Deploy:
   ```bash
   npm run deploy
   ```

## SOP: Local Development + Tests

```bash
npm run dev
npm test
```

## SOP: Automation/Cron Behavior

Cloudflare cron routes in `worker.js`:

- `*/10 * * * *`: run ingest + Zoom poll
- `0 7 * * *`: generate morning brief draft
- `0 9 * * 1`: generate commitment nudge drafts

Manual/internal trigger endpoints:

- `POST /internal/zoom-poll`
- `POST /internal/morning-brief`
- `POST /internal/commitment-nudges`

If `MCP_HTTP_KEY` is configured, each endpoint requires `?key=<MCP_HTTP_KEY>`.

## SOP: Mutation Safety

- Do not write rows directly from new tools unless there is a clear reason.
- For task/commitment/intake updates, use **propose_* → commit_changeset**.
- Treat changesets as short-lived approvals (10-minute expiry).

## Notes

This folder name is legacy (`MCP-CloudRun-Server`) but the live architecture is Cloudflare Workers.
