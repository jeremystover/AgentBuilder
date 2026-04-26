import type { Env, WatchedProfile } from "./types";

const WATCHLIST_KEY = "watchlist";
const seenKey = (slug: string) => `seen:${slug}`;

// Cap seen-ids at 500 most-recent to bound KV value size while still covering
// weeks of history for a normal posting cadence.
const SEEN_CAP = 500;

export async function getWatchlist(env: Env): Promise<WatchedProfile[]> {
  const raw = await env.LINKEDIN_STATE.get(WATCHLIST_KEY);
  return raw ? (JSON.parse(raw) as WatchedProfile[]) : [];
}

export async function saveWatchlist(env: Env, list: WatchedProfile[]): Promise<void> {
  await env.LINKEDIN_STATE.put(WATCHLIST_KEY, JSON.stringify(list));
}

export async function getSeenIds(env: Env, slug: string): Promise<Set<string>> {
  const raw = await env.LINKEDIN_STATE.get(seenKey(slug));
  return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
}

export async function addSeenIds(env: Env, slug: string, newIds: string[]): Promise<void> {
  if (newIds.length === 0) return;
  const existing = await getSeenIds(env, slug);
  for (const id of newIds) existing.add(id);
  const capped = Array.from(existing).slice(-SEEN_CAP);
  await env.LINKEDIN_STATE.put(seenKey(slug), JSON.stringify(capped));
}
