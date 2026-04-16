export interface Env {
  ASSETS: Fetcher;
  AGENT_DO: DurableObjectNamespace;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  MCP_HTTP_KEY?: string;

  // Shared inventory graph + audit history + event log.
  DB: D1Database;

  // Platform API response cache (Guesty, iCal polling, rate-limit back-off).
  CACHE: KVNamespace;

  // Booking-event fan-out queue: one event → N platform block writes.
  SYNC_QUEUE: Queue<BookingSyncJob>;

  // Platform credentials (wired via `wrangler secret put`).
  // Note: Guesty Lite does not offer an API. These are reserved for
  // future use if upgrading to Guesty Pro.
  GUESTY_API_KEY?: string;
  GUESTY_WEBHOOK_SECRET?: string;
}

/** A single platform-block/unblock job emitted by the inventory-graph resolver. */
export interface BookingSyncJob {
  listingNodeId: string;
  action: 'block' | 'unblock';
  checkIn: string;
  checkOut: string;
  sourceEventId: string;
}
