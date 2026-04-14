# Chief of Staff

**Purpose.** Manages calendar, stakeholders, projects, tasks, and goals to keep the
user organized and optimize their time. Headless MCP server backed by Google
Drive (markdown status files), Google Sheets (structured data), Gmail (read +
draft), Google Calendar (read/write), and Zoom (cloud recording poll).

## When to call me

- "What's on my calendar today?" / "Give me a morning brief."
- "Add a task to follow up with Acme by Friday."
- "Who haven't I talked to in a while?" (stakeholder touch list)
- "Generate a weekly review for last week."
- "Prep me for my next meeting with <name>."
- "Pull transcripts from yesterday's Zoom meetings."
- "Log a decision to revisit in a month."
- "Draft a reply to this email."
- "Triage my intake queue."
- "What's the state of project X?" (project 360)

## Non-goals

- Financial accounting, bookkeeping, budgeting, or tax work — route to **CFO**.
- Building, scaffolding, or modifying other agents — route to **Agent Builder**.
- Customer-facing apps or external-user conversations.
- Code authoring or software-engineering tasks.
- Property-operations / guest bookings — route to **Guest Booking**.

## Tools

Registry-canonical surface (12 logical tools):

1. `content-tools` — Drive markdown read/write/search (`resolve_uri`, `read_content`, `search_content`, `list/read/write/append/delete_status_file`).
2. `planning-tools` — `hydrate_planning_context`, `get_prioritized_todo`, `get_intake`, `search_vault`, `show_source`.
3. `propose-commit-changeset` — all `propose_*` mutations + `commit_changeset`. ALL writes go through this two-step flow.
4. `goals-projects-tasks` — `list_goals`, `list_projects`, `get_goal_360`, `backfill_projects_from_tasks`, `export_state_markdown`.
5. `stakeholder-360` — `get_stakeholder_360`, `get_project_360`, `list_stakeholders_needing_touch`.
6. `period-reviews` — `generate_period_review`, `log_decision`, `list_decisions_to_revisit`.
7. `zoom-recording-poll` — `poll_zoom_recordings`, `get_meeting_transcript`.
8. `calendar-rw` — `list_calendars`, `list_calendar_events`, `list_work_calendar_events`, `create_calendar_event`, `update_calendar_event`.
9. `gmail-draft` — `create_gmail_draft`.
10. `ingest-cron` — `run_ingest` (Gmail + Calendar + Drive → IntakeQueue).
11. `morning-brief-automation` — `trigger_morning_brief`.
12. `commitment-nudges` — `trigger_commitment_nudges` + `log_agent_run`.

⚠️ **Tool surface exceeds AGENTS.md rule 2 (~10 per agent).** The imported
server exposes ~60 physical MCP tools across the 12 logical categories above.
Consolidation into a smaller surface (e.g. a single `propose` tool with a
`kind` discriminator) is tracked as follow-up in
`docs/migrations/chief-of-staff.md`.

## Shared packages

None yet. This agent was imported as-is from `jeremystover/personal-productivity-mcp`
and does NOT currently depend on `@agentbuilder/core` or `@agentbuilder/llm`.
It is pure Cloudflare Workers ESM with Google / Zoom API clients written
inline. Migration to shared packages is deferred.

## OAuth scopes

- Google Drive (full)
- Google Sheets
- Gmail readonly + compose
- Google Calendar
- Zoom `cloud_recording:read:list_recording_files:admin`

## Operational notes

- **Always call `hydrate_planning_context` before any planning tool.** Planners
  expect a pre-loaded snapshot so per-call Sheets fan-out stays bounded.
- **All mutations go through `propose_*` then `commit_changeset`.** Never write
  directly to Sheets from a tool handler.
- **Auth.** `/mcp` requires `Authorization: Bearer <MCP_HTTP_KEY>` (or the
  legacy `?key=<value>` query param during the deprecation window).
  `/internal/*` endpoints (cron, bootstrap) require `INTERNAL_CRON_KEY` and
  fall back to `MCP_HTTP_KEY` if unset.
- **Model tier.** Not applicable — this agent does not currently invoke an LLM
  directly. The "claude" strings in `tools.js` / `reviews.js` / `automation.js`
  are audit-trail values (`appliedBy = "claude"`), not API calls.
- **Prompt caching.** N/A for the same reason.
