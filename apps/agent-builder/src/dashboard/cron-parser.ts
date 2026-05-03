/**
 * Tiny cron parser — just enough to compute the next run time for the
 * dashboard. Supports the 5-field unix cron syntax used in wrangler.toml:
 *
 *   minute hour day-of-month month day-of-week
 *
 * Each field may be: *, N, N,M,..., N-M, * /N, N-M/K
 *
 * Returns null if parsing fails. Cloudflare evaluates cron expressions in
 * UTC, so the dashboard does the same.
 */

type Field = Set<number>;

function parseField(raw: string, lo: number, hi: number): Field | null {
  const all = new Set<number>();
  for (const part of raw.split(',')) {
    let stepStr = '1';
    let rangeStr = part;
    const slashIdx = part.indexOf('/');
    if (slashIdx >= 0) {
      rangeStr = part.slice(0, slashIdx);
      stepStr = part.slice(slashIdx + 1);
    }
    const step = parseInt(stepStr, 10);
    if (!Number.isFinite(step) || step <= 0) return null;

    let start: number;
    let end: number;
    if (rangeStr === '*') {
      start = lo;
      end = hi;
    } else {
      const dashIdx = rangeStr.indexOf('-');
      if (dashIdx >= 0) {
        start = parseInt(rangeStr.slice(0, dashIdx), 10);
        end = parseInt(rangeStr.slice(dashIdx + 1), 10);
      } else {
        const single = parseInt(rangeStr, 10);
        if (!Number.isFinite(single)) return null;
        start = single;
        end = single;
      }
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < lo || end > hi || start > end) return null;
    for (let n = start; n <= end; n += step) all.add(n);
  }
  return all;
}

export function nextRunFromCron(expr: string, from: Date): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0]!, 0, 59);
  const hour = parseField(parts[1]!, 0, 23);
  const dom = parseField(parts[2]!, 1, 31);
  const month = parseField(parts[3]!, 1, 12);
  const dow = parseField(parts[4]!, 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return null;

  const domRestricted = parts[2] !== '*';
  const dowRestricted = parts[4] !== '*';

  // Start at the next minute boundary in UTC, capped at one year out.
  const candidate = new Date(from.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  const horizon = candidate.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() <= horizon) {
    const min = candidate.getUTCMinutes();
    const hr = candidate.getUTCHours();
    const day = candidate.getUTCDate();
    const mon = candidate.getUTCMonth() + 1;
    const wkday = candidate.getUTCDay();

    const monthMatch = month.has(mon);
    const minMatch = minute.has(min);
    const hourMatch = hour.has(hr);

    // Cron's day-of-month and day-of-week have OR semantics when both are
    // restricted, AND semantics when only one is.
    let dayMatch: boolean;
    if (domRestricted && dowRestricted) dayMatch = dom.has(day) || dow.has(wkday);
    else if (domRestricted) dayMatch = dom.has(day);
    else if (dowRestricted) dayMatch = dow.has(wkday);
    else dayMatch = true;

    if (monthMatch && dayMatch && hourMatch && minMatch) {
      return candidate.toISOString();
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return null;
}
