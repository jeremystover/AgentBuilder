/**
 * Skill: availability-sync
 *
 * Given a booking event, walks the inventory graph via
 * `inventory-graph-resolver` and enqueues one `BookingSyncJob` per
 * affected listing into `SYNC_QUEUE`.
 *
 * Status: stub — real implementation runs the graph walk against D1.
 */
import type { BookingSyncJob, Env } from '../../worker-configuration';

export interface AvailabilitySyncInput {
  listingNodeId: string;
  checkIn: string; // ISO YYYY-MM-DD
  checkOut: string; // ISO YYYY-MM-DD
  eventType: 'booked' | 'cancelled' | 'modified';
}

export async function availabilitySync(env: Env, input: AvailabilitySyncInput): Promise<void> {
  // TODO: resolve affected nodes via the inventory graph.
  const affected: string[] = [input.listingNodeId];

  const action: BookingSyncJob['action'] = input.eventType === 'cancelled' ? 'unblock' : 'block';
  const jobs: BookingSyncJob[] = affected.map((listingNodeId) => ({
    listingNodeId,
    action,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    sourceEventId: crypto.randomUUID(),
  }));

  for (const job of jobs) {
    await env.SYNC_QUEUE.send(job);
  }
}
