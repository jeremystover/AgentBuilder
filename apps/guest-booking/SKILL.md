# Guest Booking

**Purpose.** Manages guest bookings across Airbnb, VRBO, and Booking.com — audits listing consistency across platforms and manages overlapping-inventory availability using a graph-based containment/conflict model so that nested listing configurations (whole-house, partial-house, individual rooms) block each other correctly.

This is an **app-agent**: it serves a UI at `/` and an API at `/api/*`,
backed by a Durable Object (`GuestBookingDO`). Guesty is the current
source of truth for listings and reservations; the agent reads from
Guesty and writes blocks back through platform APIs (or iCal where that
is all the platform exposes).

## When to call me
- "Audit my listings for divergence" → run `listing-consistency-audit`
- "A new booking just came in on Airbnb for the 4BR farm house" → run `availability-sync` and fan out blocks across the conflicting room listings
- "Add a new room listing to the farm house topology" → run `inventory-graph-management`
- "Show me what's blocked and why for next weekend" → read from the DO + D1

## Non-goals
- Personal calendar, tasks, stakeholders, or goals — that's **chief-of-staff**.
- Bookkeeping, revenue recognition, quarterly taxes — that's **cfo**. Booking revenue flows from this agent *to* CFO as an integration, not a capability here.
- Building or modifying other agents — that's **agent-builder**.
- Dynamic pricing. This agent *audits* price consistency across platforms; it does not *set* prices.
- Host coaching, review writing, or generic hospitality advice.

## Tools (7 — under the ~10 cap)
- `guesty-api-client` — read current state from Guesty (source of truth today).
- `listing-diff-engine` — compare listing fields (price, terms, photos, description, title) across platforms; produce a structured divergence report.
- `inventory-graph-resolver` — given a booking event + the conflict graph, return the full set of listings that need blocking/unblocking.
- `availability-block-writer` — push calendar blocks back to Guesty and platform APIs.
- `booking-event-listener` — webhook / polling receiver for new bookings across platforms.
- `platform-calendar-sync` — iCal import/export for platforms that don't expose a rich API (VRBO).
- `audit-report-generator` — render consistency reports as human-readable output.

## Data model: the inventory graph

The differentiator. We store a directed graph in D1, not a hardcoded
farm-house layout:

- `listing_node` — one row per `(platform, external_listing_id)` pair.
  The farm house ends up with ~18 nodes (4BR + 3BR-with-host + 4 rooms,
  each replicated across Airbnb/VRBO/Booking.com).
- `listing_edge` — edges of type `contains` or `conflicts_with`. Booking
  any node walks the edges to find every other node that must be blocked.

Reconfiguring the property (or adding a second property) means editing
graph rows, not source code.

## UI
- Static assets live in `public/`. Replace `index.html` with the real
  operator UI (divergence dashboard, booking log, inventory-graph editor).
- Vite + React works well — build to `public/` in your `build` script.

## Shared packages
- `@agentbuilder/core`
- `@agentbuilder/llm`

## Migration plan
The legacy **booking-sync** worker stays running as-is until this agent
reaches parity. Do **not** port `booking-sync`'s architecture — cherry-pick
only its iCal parsing, platform-auth patterns, and calendar UI components.
Sunset `booking-sync` once `guest-booking` can do everything it does.
