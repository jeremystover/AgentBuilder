import { DurableObject } from "cloudflare:workers";
import type { Env } from "../worker-configuration";

/**
 * Minimal stub. The agent's state lives in D1, not the DO; we keep the
 * binding wired for compatibility with the app-agent scaffold and as a
 * future home for per-item locking or rate-limited refresh queues.
 */
export class ShoppingPriceTrackerDO extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    return new Response("Not used", { status: 404 });
  }
}
