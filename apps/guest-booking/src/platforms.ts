// Platform adapters.  Today all three supported public platforms expose
// iCal feeds (pull) and consume iCal feeds (push), which is how every
// open-source channel manager reliably handles availability sync.  A
// proper API integration (Booking.com XML, Airbnb partner API) can be
// added later by implementing the same interface.

import type { Env, Listing, Platform } from "./types";
import { parseICal, type ICalEvent } from "./ical";

export interface PulledBooking {
  external_uid: string;
  start_date: string;
  end_date: string;
  summary?: string;
  description?: string;
  status?: string;
}

export interface PlatformAdapter {
  slug: string;
  /** Pull bookings from the platform for a given listing. */
  pull(env: Env, listing: Listing, platform: Platform): Promise<PulledBooking[]>;
}

async function fetchICal(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "BookingSyncManager/0.1 (+cloudflare-workers)",
      "Accept": "text/calendar, text/plain;q=0.9, */*;q=0.8",
    },
    // iCal feeds are small; disable CF cache to respect platform TTLs.
    cf: { cacheTtl: 0, cacheEverything: false } as unknown as RequestInitCfProperties,
  });
  if (!res.ok) throw new Error(`iCal fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

function eventsToBookings(events: ICalEvent[]): PulledBooking[] {
  return events
    .filter(e => e.start && e.end)
    .map(e => ({
      external_uid: e.uid,
      start_date: e.start,
      end_date: e.end,
      summary: e.summary,
      description: e.description,
      status: e.status?.toLowerCase() === "cancelled" ? "cancelled" : "confirmed",
    }));
}

/** Generic iCal puller used by any platform whose adapter is 'ical'. */
const icalAdapter: PlatformAdapter = {
  slug: "ical",
  async pull(_env, listing) {
    if (!listing.ical_import_url) return [];
    const text = await fetchICal(listing.ical_import_url);
    return eventsToBookings(parseICal(text));
  },
};

// Per-platform adapters are currently identical to the generic iCal
// adapter, but having explicit entries lets us override behavior later
// without touching the sync engine.  Notes on each platform:
//
//   airbnb         - per-listing iCal under Host → Availability → Sync calendars.
//   vrbo           - per-listing iCal under Calendar → Import calendar.
//                    Also transparently distributes to Expedia.com /
//                    Hotels.com / Travelocity / Orbitz for eligible pro
//                    listings, so there's no separate Expedia adapter.
//   booking        - per-property iCal under Rates & Availability → Sync
//                    calendars.  Direct XML requires a Connectivity
//                    Partner relationship, which individual owners don't
//                    usually qualify for - iCal is the path forward.
//   hostaway       - itself a channel manager.  For now we pull via its
//                    per-listing iCal export.  Hostaway also has a REST
//                    API (OAuth2) that can be wired in later to get
//                    real-time push instead of polling.
//   furnishedfinder- iCal feed from Property Dashboard → Calendar.
//                    Mid-term rental audience (nurses, travelers, 30+
//                    night stays).
//   tripadvisor    - TripAdvisor Rentals / Holiday Lettings / FlipKey
//                    all support iCal import-export under the same
//                    Calendar Sync settings.
export const adapters: Record<string, PlatformAdapter> = {
  airbnb:          { ...icalAdapter, slug: "airbnb" },
  vrbo:            { ...icalAdapter, slug: "vrbo" },
  booking:         { ...icalAdapter, slug: "booking" },
  hostaway:        { ...icalAdapter, slug: "hostaway" },
  furnishedfinder: { ...icalAdapter, slug: "furnishedfinder" },
  tripadvisor:     { ...icalAdapter, slug: "tripadvisor" },
  // 'direct' does not pull - its bookings are created inside this app.
  direct: {
    slug: "direct",
    async pull() { return []; },
  },
};

export function adapterFor(slug: string): PlatformAdapter {
  return adapters[slug] ?? icalAdapter;
}
