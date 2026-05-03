export function dollarsToCents(usd: number | string | null | undefined): number | null {
  if (usd === null || usd === undefined || usd === "") return null;
  const n = typeof usd === "string" ? Number.parseFloat(usd) : usd;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function centsToDollars(cents: number | null | undefined): number | null {
  if (cents === null || cents === undefined) return null;
  return Math.round(cents) / 100;
}

export function formatCents(cents: number | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined) return "—";
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency });
  return fmt.format(cents / 100);
}

/** Median of integers; returns null if list is empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}
