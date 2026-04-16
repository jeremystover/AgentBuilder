/**
 * GuestBookingDO — one instance per property.
 *
 * Holds live availability state and processes booking events in strict
 * order to prevent double-booking races when two platforms fire webhooks
 * at nearly the same moment.
 *
 * This file is deliberately a thin router into ./skills/*. Skills hold
 * the real logic; the DO exists to serialize writes and provide the
 * REST surface the operator UI calls.
 */
import { DurableObject } from 'cloudflare:workers';
import { createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { BookingSyncJob, Env } from '../worker-configuration';
import { availabilitySync } from './skills/availability-sync.js';
import { processBookingEvent } from './skills/booking-event-processing.js';
import {
  type ListingEdge,
  type ListingNode,
  upsertEdge,
  upsertListingNode,
} from './skills/inventory-graph-management.js';
import { listingConsistencyAudit } from './skills/listing-consistency-audit.js';
import {
  type ImportListingsInput,
  type LinkListingsInput,
  importListings,
  linkListings,
} from './skills/listing-import.js';

const SYSTEM_PROMPT = `You are Guest Booking.

Purpose: Manages guest bookings across Airbnb, VRBO, and Booking.com —
audits listing consistency across platforms and manages overlapping-
inventory availability using a graph-based containment/conflict model.

See SKILL.md for your non-goals and tool surface.`;

export class GuestBookingDO extends DurableObject<Env> {
  private readonly llm: LLMClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.llm = new LLMClient({
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      workersAi: env.AI,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const logger = createLogger({ base: { agent: 'guest-booking' } });
    const url = new URL(request.url);
    const method = request.method;

    // ── MCP tool dispatch (proxied from the outer worker) ──────────────────
    if (url.pathname === '/api/mcp/import_listings' && method === 'POST') {
      const body = (await request.json()) as ImportListingsInput;
      logger.info('mcp.import_listings', { platform: body.platform });
      const result = await importListings(this.env, body);
      return Response.json(result);
    }

    if (url.pathname === '/api/mcp/link_listings' && method === 'POST') {
      const body = (await request.json()) as LinkListingsInput;
      logger.info('mcp.link_listings', { count: body.listingNodeIds?.length });
      const result = await linkListings(this.env, body);
      return Response.json(result);
    }

    if (url.pathname === '/api/mcp/audit_listings' && method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { propertyId?: string };
      logger.info('mcp.audit_listings');
      const report = await listingConsistencyAudit(this.env, { propertyId: body.propertyId });
      return Response.json(report);
    }

    if (url.pathname === '/api/mcp/sync_availability' && method === 'POST') {
      const body = (await request.json()) as Parameters<typeof availabilitySync>[1];
      logger.info('mcp.sync_availability');
      await availabilitySync(this.env, body);
      return Response.json({ ok: true });
    }

    // ── REST routes for the operator UI ────────────────────────────────────
    if (url.pathname === '/api/chat' && method === 'POST') {
      const { message } = (await request.json()) as { message: string };
      logger.info('chat.turn');
      const res = await this.llm.complete({
        tier: 'default',
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: message }],
      });
      return Response.json({ reply: res.text, usage: res.usage });
    }

    if (url.pathname === '/api/inventory/nodes' && method === 'POST') {
      const node = (await request.json()) as ListingNode;
      await upsertListingNode(this.env, node);
      return Response.json({ ok: true });
    }

    if (url.pathname === '/api/inventory/edges' && method === 'POST') {
      const edge = (await request.json()) as ListingEdge;
      await upsertEdge(this.env, edge);
      return Response.json({ ok: true });
    }

    if (url.pathname === '/api/events' && method === 'POST') {
      const raw = await request.json();
      await processBookingEvent(this.env, raw);
      return Response.json({ ok: true });
    }

    if (url.pathname === '/api/sync/apply' && method === 'POST') {
      // Drained from the queue consumer — apply a single block/unblock write.
      const job = (await request.json()) as BookingSyncJob;
      logger.info('sync.apply', { listingNodeId: job.listingNodeId, action: job.action });
      // Implementation lives in availability-block-writer (TODO).
      return Response.json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }
}
