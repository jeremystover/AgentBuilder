/**
 * Pro-ration helpers for the Spending module.
 *
 * - `prorateAmount` converts a plan's monthly or annual amount into the
 *   expected amount for a (possibly partial) period.
 * - `generatePeriods` slices a date range into monthly or annual buckets.
 *
 * All dates are interpreted in UTC; the date-only inputs returned by
 * Postgres (`date` columns) round-trip cleanly through `new Date(iso)`.
 */

export type PeriodType = 'monthly' | 'annual';

const MS_PER_DAY = 86_400_000;

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

function startOfDay(d: Date): Date {
  return utcDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function daysBetweenInclusive(start: Date, end: Date): number {
  const ms = startOfDay(end).getTime() - startOfDay(start).getTime();
  return Math.round(ms / MS_PER_DAY) + 1;
}

/**
 * Compute the planned amount for a (possibly partial) period.
 *
 * @param baseAmount    Plan's category amount as stored.
 * @param periodType    Whether `baseAmount` represents monthly or annual.
 * @param periodStart   Period bucket start (inclusive).
 * @param periodEnd     Period bucket end (inclusive).
 * @param reportingPeriod Whether the report bucket itself is monthly or annual
 *                       — only used to short-circuit full-period cases.
 */
export function prorateAmount(
  baseAmount: number,
  periodType: PeriodType,
  periodStart: Date,
  periodEnd: Date,
  reportingPeriod: PeriodType,
): number {
  if (!Number.isFinite(baseAmount) || baseAmount === 0) return 0;
  const days = daysBetweenInclusive(periodStart, periodEnd);

  if (periodType === 'monthly') {
    // Full-month bucket → return base amount as-is.
    const y = periodStart.getUTCFullYear();
    const m = periodStart.getUTCMonth();
    const monthDays = daysInMonth(y, m);
    if (
      reportingPeriod === 'monthly' &&
      periodStart.getUTCDate() === 1 &&
      days === monthDays
    ) {
      return baseAmount;
    }
    if (reportingPeriod === 'annual') {
      // Annual bucket fed by monthly plan: 12 months over a full year.
      // For partial year buckets fall back to per-day pro-ration.
      const fullYear = days >= 365;
      if (fullYear) return baseAmount * 12;
    }
    // Partial period: pro-rate by days, using the bucket's first month
    // as the day-count basis (close enough for daily-accuracy).
    return (baseAmount / monthDays) * days;
  }

  // Annual plan: pro-rate by days / 365.
  return (baseAmount / 365) * days;
}

/**
 * Slice [from, to] into period buckets. Partial first/last buckets are
 * clipped to the requested range. `isFuture` is true when the bucket
 * starts strictly after today.
 */
export function generatePeriods(
  from: Date,
  to: Date,
  periodType: PeriodType,
  today: Date = new Date(),
): Array<{ start: Date; end: Date; label: string; isFuture: boolean }> {
  const fromUtc = startOfDay(from);
  const toUtc = startOfDay(to);
  const todayUtc = startOfDay(today);
  if (toUtc.getTime() < fromUtc.getTime()) return [];

  const out: Array<{ start: Date; end: Date; label: string; isFuture: boolean }> = [];

  if (periodType === 'monthly') {
    let cursor = utcDate(fromUtc.getUTCFullYear(), fromUtc.getUTCMonth(), 1);
    while (cursor.getTime() <= toUtc.getTime()) {
      const y = cursor.getUTCFullYear();
      const m = cursor.getUTCMonth();
      const monthEnd = utcDate(y, m, daysInMonth(y, m));
      const bucketStart = cursor.getTime() < fromUtc.getTime() ? fromUtc : cursor;
      const bucketEnd   = monthEnd.getTime() > toUtc.getTime() ? toUtc : monthEnd;
      out.push({
        start: bucketStart,
        end:   bucketEnd,
        label: formatMonth(y, m),
        isFuture: bucketStart.getTime() > todayUtc.getTime(),
      });
      cursor = utcDate(y, m + 1, 1);
    }
    return out;
  }

  // Annual buckets, calendar-year aligned.
  let cursor = utcDate(fromUtc.getUTCFullYear(), 0, 1);
  while (cursor.getTime() <= toUtc.getTime()) {
    const y = cursor.getUTCFullYear();
    const yearEnd = utcDate(y, 11, 31);
    const bucketStart = cursor.getTime() < fromUtc.getTime() ? fromUtc : cursor;
    const bucketEnd   = yearEnd.getTime() > toUtc.getTime() ? toUtc : yearEnd;
    out.push({
      start: bucketStart,
      end:   bucketEnd,
      label: String(y),
      isFuture: bucketStart.getTime() > todayUtc.getTime(),
    });
    cursor = utcDate(y + 1, 0, 1);
  }
  return out;
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function formatMonth(year: number, month: number): string {
  return `${MONTH_NAMES[month]} ${year}`;
}
