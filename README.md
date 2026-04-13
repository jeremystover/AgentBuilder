# Booking Sync Manager

A self-hosted channel manager for short-term rentals, running on
Cloudflare Workers + D1 + R2. It replaces the bits of
[Guesty](https://www.guesty.com/) we actually use: availability sync
across Airbnb, VRBO, Booking.com and our own direct channel (the
direct booking page for [www.thewhitfordhouse.com](https://www.thewhitfordhouse.com)),
central content management, and a simple booking calendar. Guests on
the direct channel pay via **Stripe** or **Square**.

This app lives inside the `PDF-Combiner` monorepo under `apps/booking-sync/`
but is **completely independent** of the PDF/Slide Builder Apps Script
code at the repo root.

## Why a new app?

Guesty is powerful but expensive and heavy for a single property owner
with a handful of listings. The problem we actually need to solve is:

1. A booking on **any** channel must block the dates everywhere else.
2. One place to push content / price / rule changes out to every channel.
3. One place to see photos, availability, and revenue across channels.
4. Room-level bookings on the main house must block the 3BR / 4BR
   composite listings automatically (and vice-versa).
5. Easy to extend to additional platforms later.

## Architecture

```
┌────────────┐      pull iCal       ┌────────────────────────┐
│  Airbnb    │ ───────────────────▶ │                        │
│  VRBO      │                      │   Cloudflare Worker    │
│  Booking   │ ◀───── push iCal ─── │   (Hono + D1 + R2)     │
└────────────┘                      │                        │
                                    │  • availability engine │
   Admin UI ─── HTTPS ─────────────▶│  • REST API            │
   (public/)                        │  • /ical/:token.ics    │
                                    └────────────────────────┘
```

### Key ideas

* **Units vs. listings.** A `unit` is the physical thing you rent (a
  room or the whole house). A `listing` is `(unit × platform)`. Each
  platform gets its own listing row, its own inbound iCal URL, and its
  own outbound iCal export token. Changing unit content once updates
  the data every listing reads from.
* **Atomic vs. composite units.** `atomic` units are the smallest
  rentable thing (a single room, the guest house). `composite` units
  are collections of atomic units (4BR = all four rooms). A booking on
  a composite expands into occupancy on each atomic member. A booking
  on an atomic automatically blocks every composite that contains it.
  Result: the 4BR listing goes unavailable the moment any single room
  is booked.
* **iCal as the lowest common denominator.** Every supported platform
  (Airbnb, VRBO, Booking.com) lets you import and export an iCalendar
  feed. We pull theirs on a 10-minute cron and we serve ours at
  `/ical/<token>.ics`. API integrations (Airbnb Partner API,
  Booking.com XML, …) can be added later as per-platform adapters in
  `src/platforms.ts` without touching the sync engine.

## Directory layout

```
apps/booking-sync/
├─ package.json
├─ wrangler.toml          ← Cloudflare Worker config
├─ tsconfig.json
├─ schema.sql             ← D1 schema (fresh install)
├─ seed.sql               ← the guest house + main house described above
├─ migrations/
│   ├─ 0001_payments.sql         ← hold/payment columns on bookings
│   ├─ 0002_add_platforms.sql    ← Hostaway / Furnished Finder / TripAdvisor
│   └─ 0003_location_reviews.sql ← lat/lng on properties + reviews table
├─ public/                ← static assets served by the Assets binding
│   ├─ index.html         ← admin SPA
│   ├─ app.js
│   ├─ styles.css
│   ├─ book.html          ← 301 redirect to /book
│   ├─ book.css
│   └─ book.js            ← hydrates SSR booking pages
└─ src/
    ├─ index.ts           ← Worker entry, Hono router, cron handler
    ├─ types.ts
    ├─ ical.ts            ← RFC 5545 parser + generator
    ├─ availability.ts    ← unit conflict engine (respects holds)
    ├─ platforms.ts       ← channel-sync adapter registry
    ├─ sync.ts            ← pull / push + direct booking creation
    ├─ pricing.ts         ← nightly price / cleaning fee / min-nights
    ├─ hmac.ts            ← Web Crypto HMAC helpers
    ├─ seo.ts             ← Schema.org JSON-LD builders
    ├─ ssr.ts             ← SSR HTML for /book, /book/unit/:id, etc.
    └─ payments/
        ├─ stripe.ts      ← Checkout Session + webhook
        └─ square.ts      ← Payment Link + webhook
```

## Getting started

```bash
cd apps/booking-sync

# 1. install
npm install

# 2. create Cloudflare resources
npx wrangler d1 create booking_sync
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create booking-sync-photos
# paste the returned IDs into wrangler.toml

# 3. apply schema (pick local or remote)
npm run db:init:local
npm run db:seed:local
# If you already have an earlier version of the DB, apply the migration
# that adds payment/hold columns instead of re-initing:
#   wrangler d1 execute booking_sync --local --file=./migrations/0001_payments.sql

# 4. run locally
npm run dev
```

Then open `http://localhost:8787`. Paste an admin token into the field
at the top right if you've set `ADMIN_TOKEN`; leave blank in dev.

## Wiring up the channels

For each listing row in the **Listings** tab:

1. In the other platform's calendar settings (Airbnb / VRBO /
   Booking.com), **copy the iCal export URL** and paste it into the
   listing's **Import URL** field. Click **Save**, then **Pull**.
2. In the other platform, **add an imported calendar** and paste in the
   **Export URL** from this app (`/ical/<token>.ics`). That feed is the
   union of every blocking booking across all our units, so the other
   platform will automatically reflect bookings that came in from
   anywhere else — including direct bookings we made inside this app.

The scheduled handler in `src/index.ts` runs every 10 minutes and pulls
every active listing whose `ical_import_url` is set.

## API

All endpoints are JSON except the photo upload (raw bytes) and the
outbound iCal feed (`text/calendar`). Admin endpoints require the
`x-admin-token` header when `ADMIN_TOKEN` is set as a secret.

```
GET  /api/health
GET  /api/properties              POST/PUT/DELETE
GET  /api/units                   POST/PUT/DELETE
GET  /api/listings                POST/PUT/DELETE
POST /api/listings/:id/pull
POST /api/sync/pull-all
GET  /api/bookings?unit_id&from&to
POST /api/bookings                (auto-rejects on conflict unless force=true)
DELETE /api/bookings/:id          (soft-cancel)
GET  /api/availability?unit_id&start&end
GET  /api/units/:id/photos
POST /api/units/:id/photos        (raw image body)
DELETE /api/photos/:id
GET  /photos/:id                  (binary, public)
GET  /api/platforms               POST
GET  /api/sync-log

GET  /ical/:token.ics             (public, per-listing)
```

## SEO / Google rich results

The public booking pages are **server-rendered** by the Worker at:

- **`/book`** — canonical list of bookable units with a
  `LodgingBusiness` JSON-LD that contains a `VacationRental` entry per
  bookable unit (plus one full standalone `VacationRental` block per
  unit).
- **`/book/unit/:id`** — detail page with a full `VacationRental`
  JSON-LD (offer, occupancy, address, amenities, photos) and a
  `BreadcrumbList`.
- **`/sitemap.xml`** — auto-generated from the bookable units.
- **`/robots.txt`** — allows `/book/*`, disallows `/api/`, `/ical/`,
  `/photos/`, and links to the sitemap.

Every page emits:

- Canonical `<link rel="canonical">`
- Open Graph + Twitter card tags for link previews
- `max-image-preview:large` so Google can use full photos in search
- `GeoCoordinates` (`geo`) with latitude/longitude when the property has
  them set — powers Google Maps integration and local search ranking
- `AggregateRating` + up to 10 `Review` objects on each unit when the
  property has published guest reviews in the `reviews` table
- `hasMap` link to Google Maps for the unit's coordinates

Because the HTML is rendered server-side (not built by JavaScript on
the client), Google's crawler sees the full listing content and
structured data without needing to execute `/book.js`. That script
only *hydrates* the SSR pages with interactive behavior (date picker,
live price quote, Stripe/Square checkout).

To verify the markup once it's deployed:

1. Paste a URL like `https://www.thewhitfordhouse.com/book/unit/1`
   into the [Rich Results Test](https://search.google.com/test/rich-results).
2. Confirm the `VacationRental` block validates.
3. Submit `/sitemap.xml` in Google Search Console under Sitemaps.

Google's vacation-rental rich results program requires a partner
agreement for the dedicated VR surface, but the `VacationRental`
structured data still powers brand sitelinks, knowledge panels,
and image thumbnails in regular search immediately — no partnership
needed.

## Direct booking page + payments

The public booking page lives at **`/book.html`** and is branded for
[thewhitfordhouse.com](https://www.thewhitfordhouse.com). Guests:

1. Browse bookable units (populated from the admin, filtered to units
   with a `base_price` set).
2. Pick a unit, dates, and enter their info.
3. Click **Pay with Card (Stripe)** or **Pay with Square**.
4. The server re-checks availability, computes the price, creates a
   30-minute *hold* booking, and redirects to the hosted checkout.
5. A webhook (`/api/webhooks/stripe` or `/api/webhooks/square`) verifies
   the HMAC signature and flips the hold to `confirmed`. Holds that
   aren't paid within 30 minutes are auto-expired by the cron handler,
   so abandoned checkouts don't block the calendar.

Because the hold is a real row in the `bookings` table, the unit's
atomic members become unavailable immediately — which means the
outbound iCal feeds to Airbnb, VRBO, and Booking.com will include the
dates as blocked on the very next feed pull. No double-booking.

### Configuring Stripe

1. Create a restricted key: Dashboard → Developers → API keys →
   "Create restricted key" with `write` access on *Checkout Sessions*
   and *Payment Intents*. Or use a secret key for testing.
2. `wrangler secret put STRIPE_SECRET_KEY`
3. Add a webhook endpoint in Stripe pointing to
   `https://<your-worker-host>/api/webhooks/stripe` subscribed to:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `checkout.session.async_payment_failed`
4. Copy the signing secret and `wrangler secret put STRIPE_WEBHOOK_SECRET`.

### Configuring Square

1. Create an application in the Square Developer Dashboard and grab
   the access token + location ID.
2. `wrangler secret put SQUARE_ACCESS_TOKEN`
3. `wrangler secret put SQUARE_LOCATION_ID`
4. Add a webhook subscription for `payment.updated` pointing to
   `https://<your-worker-host>/api/webhooks/square`.
5. `wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY`
6. Set `SQUARE_ENV = "production"` in `wrangler.toml` when going live;
   keep it `"sandbox"` while testing.

### Public API (no auth)

```
GET  /api/public/units                 -> bookable units with photos
GET  /api/public/units/:id             -> single unit + photos
POST /api/public/quote                 -> { amount_cents, nights, available }
POST /api/public/checkout              -> { booking_id, url }   (Stripe/Square)
GET  /api/public/booking-by-session/:sid
POST /api/webhooks/stripe
POST /api/webhooks/square
```

## Supported platforms

Pre-wired out of the box, all via iCal sync (see `src/platforms.ts`):

| Platform           | Slug              | Notes                                                                                                |
|--------------------|-------------------|------------------------------------------------------------------------------------------------------|
| Airbnb             | `airbnb`          | Per-listing iCal under Host → Availability → Sync calendars.                                         |
| VRBO               | `vrbo`            | Also distributes to Expedia / Hotels.com / Travelocity / Orbitz for eligible pro listings.           |
| Booking.com        | `booking`         | Per-property iCal. Requires disconnecting any certified Connectivity Provider first.                 |
| Hostaway           | `hostaway`        | Per-listing iCal export; REST API upgrade path available.                                            |
| Furnished Finder   | `furnishedfinder` | Mid-term (30+ night) audience — traveling nurses, relocations.                                       |
| TripAdvisor        | `tripadvisor`     | Covers TripAdvisor Rentals / Holiday Lettings / FlipKey under one Calendar Sync setting.             |
| Direct             | `direct`          | This app's own booking page at `/book.html` with Stripe + Square checkout.                           |

## Adding more platforms

1. Insert a row into `platforms` (slug, display name, adapter kind).
2. If it's iCal-based, nothing else is needed - the generic adapter
   handles it. If it's a proper API, add a new entry in
   `src/platforms.ts` implementing the `PlatformAdapter` interface.
3. Create listings against existing units on the new platform from the
   **Listings** tab.

## Security notes

* `ADMIN_TOKEN` is a shared secret used to gate the API. Set it via
  `wrangler secret put ADMIN_TOKEN`. For real production use, replace
  with per-user auth.
* Outbound iCal feeds include only date ranges, not guest PII.
* Platform API credentials live in `platforms.api_credentials` as JSON.
  Consider encrypting with a key stored in `wrangler secret`.
