/**
 * Skill: booking-event-processing
 *
 * Receives webhook / polling payloads from Guesty or platforms,
 * normalises to an internal BookingEvent, writes it to D1, and hands
 * off to `availabilitySync` to fan out platform blocks.
 *
 * Status: stub — platform-specific normalisers land in
 * `platform-api-integration` once Guesty webhooks are wired.
 */
import type { Env } from '../../worker-configuration';

export async function processBookingEvent(_env: Env, _raw: unknown): Promise<void> {
  // TODO: normalise `_raw` → BookingEvent, persist, then call availabilitySync.
}
