# Guest Booking

**Purpose.** Channel manager for short-term rentals: keeps Airbnb, VRBO,
Booking.com, and the direct-booking site in sync via iCal + platform APIs.
Serves the admin console, the guest-facing booking flow, and an MCP
endpoint so Claude can read inventory and drive syncs conversationally.

This is an **app-agent**. It is a direct import of the legacy
`booking-sync` Hono worker (REST API + admin SPA + guest booking SPA),
with an MCP JSON-RPC layer bolted on top. Guesty is the current source of
truth for listings for the human operator; the worker pulls inbound iCal
feeds on a cron, serves outbound iCal feeds per listing, and handles
direct bookings end-to-end including Stripe/Square payment.

## When to call me
- "What's on the calendar for unit 3 next weekend?" → `check_availability`
- "Refresh the inbound iCal feeds now" → `pull_all_calendars`
- "Has the Airbnb sync errored lately?" → `sync_log`
- "List every listing across platforms" → `list_listings`
- "Show me all bookings for the farm house this month" → `list_bookings`

## Non-goals
- Personal calendar, tasks, stakeholders, or goals — that's **chief-of-staff**.
- Bookkeeping, revenue recognition, quarterly taxes — that's **cfo**.
  Booking revenue flows from this agent *to* CFO as an integration.
- Building or modifying other agents — that's **agent-builder**.
- Dynamic pricing. This agent audits and syncs; it does not set prices.
- Host coaching, review writing, or generic hospitality advice.

## Surface area
This worker exposes three parallel interfaces to the same D1 database:

1. **Admin SPA + REST** (`/` + `/api/*`) — the operator console for
   properties, units, listings, bookings, reviews, photos, sync log.
   Admin routes are gated by `x-admin-token`.
2. **Guest booking flow** (`/book` SSR pages + `/api/public/*` REST) —
   the public-facing direct-booking site, with SEO JSON-LD, Stripe and
   Square checkout, and hold-expiry on a cron.
3. **MCP JSON-RPC** (`POST /mcp`) — Claude custom-connector endpoint.
   Bearer-auth via `MCP_HTTP_KEY`. Tools are thin wrappers over the same
   REST handlers, dispatched through `app.request()` so there's no
   parallel code path.

## MCP tools (8 — under the ~10 cap)
- `list_properties` — GET `/api/properties`
- `list_units` — GET `/api/units` (atomic + composite unit graph)
- `list_listings` — GET `/api/listings`
- `list_platforms` — GET `/api/platforms`
- `list_bookings` — GET `/api/bookings?unit_id=&from=&to=`
- `check_availability` — GET `/api/availability?unit_id=&start=&end=`
  (respects the composite/atomic conflict graph)
- `pull_all_calendars` — POST `/api/sync/pull-all`
- `sync_log` — GET `/api/sync-log`

## Data model
Atomic vs composite units model the nested-inventory graph. A composite
unit (e.g. a 4BR farm house) contains atomic units (individual rooms);
bookings on either propagate blocks to the other via
`availability.ts`'s `blockedRangesForUnit` / `conflictsForUnit`.

## Bindings (see `wrangler.toml`)
- D1: `booking_sync`
- R2: `booking-sync-photos` (listing imagery)
- KV: `CACHE` (iCal fetch cache)
- Assets: `./public` with `run_worker_first = true` so SSR routes
  (`/book`, `/book/unit/:id`) shadow any static file.
- Cron: `*/10 * * * *` — expire stale holds + pull every inbound iCal feed.

## Secrets
Set via `wrangler secret put <NAME>`:
- `ADMIN_TOKEN` — admin REST/UI gate
- `MCP_HTTP_KEY` — bearer for `/mcp`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`

## Shared packages
- `@agentbuilder/core`
- `@agentbuilder/llm`

## Migration status
This replaces the separately-hosted `booking-sync` worker. The legacy
repo is sunset; this app is now the source of truth. Listing-consistency
audit and the Guesty-driven inventory-graph editor are future work — the
scaffolding is here (see non-goals above), but the initial import ports
the existing Hono app as-is.
