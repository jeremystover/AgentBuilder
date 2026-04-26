/**
 * SMS dispatcher (Phase A). Called by the scheduled() cron tick every
 * 30 minutes. For each opted-in person:
 *
 *   1. Skip if paused for today, or if a session is still awaiting reply.
 *   2. Skip if the current local time isn't within ±15 min of one of the
 *      person's preferred send slots, OR a slot already fired today.
 *   3. Pick the next eligible transaction + suggestion (sms-dispatcher-
 *      shared.ts), open a session, render the SMS.
 *   4. Send via Twilio, persist the outbound message row.
 */

import type { Env } from '../types';
import { getTwilioConfig, sendSms } from './twilio';
import { localNow, parseSlots, matchingSlot, slotKey } from './pacific-time';
import { pickAndOpenSession } from './sms-dispatcher-shared';

export interface DispatchSummary {
  ran_at: string;
  recipients: Array<{
    person: 'jeremy' | 'elyse';
    decision: 'sent' | 'skipped';
    reason?: string;
    transaction_id?: string;
    twilio_sid?: string;
  }>;
}

interface PersonRow {
  user_id: string;
  person: 'jeremy' | 'elyse';
  phone_e164: string;
  timezone: string;
  preferred_send_slots: string;
  paused_until_date: string | null;
  opted_in_at: string | null;
}

export async function runDispatch(env: Env, now = new Date()): Promise<DispatchSummary> {
  const summary: DispatchSummary = { ran_at: now.toISOString(), recipients: [] };

  const cfg = getTwilioConfig(env);
  if (!cfg) {
    summary.recipients.push({ person: 'jeremy', decision: 'skipped', reason: 'TWILIO_* secrets not configured' });
    return summary;
  }

  const persons = await env.DB.prepare(
    `SELECT user_id, person, phone_e164, timezone, preferred_send_slots, paused_until_date, opted_in_at
     FROM sms_persons
     WHERE opted_in_at IS NOT NULL`,
  ).all<PersonRow>();

  for (const person of persons.results) {
    const today = localNow(person.timezone, now);

    if (person.paused_until_date && person.paused_until_date >= today.dateKey) {
      summary.recipients.push({ person: person.person, decision: 'skipped', reason: 'paused' });
      continue;
    }

    const slots = parseSlots(person.preferred_send_slots);
    const slot = matchingSlot(slots, today);
    if (!slot) {
      summary.recipients.push({ person: person.person, decision: 'skipped', reason: 'outside send window' });
      continue;
    }

    // Don't double-fire a single slot. Slot key is "YYYY-MM-DDTHH:MM"
    // in person-local time; compared against any session created within
    // ±30 min of that slot today (covers DST hour wrap + cron jitter).
    const key = slotKey(today.dateKey, slot);
    const recent = await env.DB.prepare(
      `SELECT 1 FROM sms_sessions
       WHERE user_id = ? AND person = ?
         AND sent_at > datetime('now', '-90 minutes')
       LIMIT 1`,
    ).bind(person.user_id, person.person).first();
    if (recent) {
      summary.recipients.push({ person: person.person, decision: 'skipped', reason: `recent send (slot ${key})` });
      continue;
    }

    const picked = await pickAndOpenSession(env, person.user_id, person.person);
    if (!picked) {
      summary.recipients.push({ person: person.person, decision: 'skipped', reason: 'no eligible transactions or open session' });
      continue;
    }

    let twilioSid = '';
    try {
      const sent = await sendSms(cfg, person.phone_e164, picked.message);
      twilioSid = sent.sid;
    } catch (err) {
      // Roll back the open session — leaving it would block the next
      // slot. The transaction-level dedup naturally re-runs next slot.
      await env.DB.prepare(`DELETE FROM sms_sessions WHERE id = ?`).bind(picked.session_id).run();
      summary.recipients.push({
        person: person.person,
        decision: 'skipped',
        reason: `Twilio send failed: ${err instanceof Error ? err.message : String(err)}`,
        transaction_id: picked.transaction_id,
      });
      continue;
    }

    await env.DB.prepare(
      `INSERT INTO sms_messages (id, session_id, user_id, person, direction, body, twilio_sid)
       VALUES (?, ?, ?, ?, 'outbound', ?, ?)`,
    ).bind(
      `smsg_${crypto.randomUUID()}`,
      picked.session_id, person.user_id, person.person, picked.message, twilioSid,
    ).run();

    summary.recipients.push({
      person: person.person,
      decision: 'sent',
      transaction_id: picked.transaction_id,
      twilio_sid: twilioSid,
    });
  }

  return summary;
}
