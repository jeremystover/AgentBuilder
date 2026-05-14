/**
 * Account analytics — rate of return math used by the Net Worth view.
 *
 * `calculateActualRate` annualizes the return between two balance
 * snapshots. `getConfiguredRateAtDate` looks up the most recent rate
 * schedule entry on or before a target date.
 */

export interface RateScheduleEntry {
  effective_date: string; // YYYY-MM-DD
  base_rate: number;      // 0.07 = 7%
}

export function calculateActualRate(
  startBalance: number,
  endBalance: number,
  startDate: Date,
  endDate: Date,
): number | null {
  if (startBalance <= 0 || endBalance <= 0) return null;
  const years = (endDate.getTime() - startDate.getTime()) / (365.25 * 86_400_000);
  if (years <= 0) return null;
  return Math.pow(endBalance / startBalance, 1 / years) - 1;
}

export function getConfiguredRateAtDate(
  schedule: RateScheduleEntry[],
  date: Date,
): number | null {
  if (schedule.length === 0) return null;
  const target = date.getTime();
  let best: RateScheduleEntry | null = null;
  for (const entry of schedule) {
    const t = new Date(`${entry.effective_date}T00:00:00Z`).getTime();
    if (t <= target && (best == null || t > new Date(`${best.effective_date}T00:00:00Z`).getTime())) {
      best = entry;
    }
  }
  return best?.base_rate ?? null;
}
