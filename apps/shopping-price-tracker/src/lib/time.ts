export function nowIso(): string {
  return new Date().toISOString();
}

export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** YYYY-MM-DD slice of an ISO timestamp. */
export function isoDate(iso: string): string {
  return iso.slice(0, 10);
}
