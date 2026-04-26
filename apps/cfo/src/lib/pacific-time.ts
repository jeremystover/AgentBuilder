/**
 * Local-time helpers for SMS scheduling. Uses Intl so DST is handled
 * correctly without us tracking PDT/PST manually.
 *
 * The dispatcher cron fires every 30 min (UTC) and calls localNow() to
 * decide whether the current moment is within ±15 min of one of a
 * person's preferred send slots. We never schedule a Cloudflare cron at a
 * Pacific-local time — that drifts twice a year.
 */

export interface LocalNow {
  hour: number;       // 0-23
  minute: number;     // 0-59
  /** YYYY-MM-DD in the target timezone — used as the dedup key for daily slots. */
  dateKey: string;
}

export function localNow(timezone: string, now = new Date()): LocalNow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  const dateKey = `${get('year')}-${get('month')}-${get('day')}`;
  // Intl returns hour as "24" at midnight in some locales; normalize.
  return { hour: hour === 24 ? 0 : hour, minute, dateKey };
}

export interface SendSlot {
  hour: number;
  minute: number;
}

export function parseSlots(json: string): SendSlot[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is SendSlot =>
        s && typeof s === 'object' &&
        typeof s.hour === 'number' && s.hour >= 0 && s.hour <= 23 &&
        typeof s.minute === 'number' && s.minute >= 0 && s.minute <= 59,
      );
  } catch {
    return [];
  }
}

/** Return the slot whose target time is within ±toleranceMinutes of now. */
export function matchingSlot(
  slots: SendSlot[],
  now: LocalNow,
  toleranceMinutes = 15,
): SendSlot | null {
  const nowMins = now.hour * 60 + now.minute;
  for (const slot of slots) {
    const slotMins = slot.hour * 60 + slot.minute;
    if (Math.abs(nowMins - slotMins) <= toleranceMinutes) return slot;
  }
  return null;
}

/** A canonical key for "this slot, this day" — used to avoid duplicate sends. */
export function slotKey(date: string, slot: SendSlot): string {
  return `${date}T${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')}`;
}
