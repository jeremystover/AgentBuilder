import type { Env, WatchedFeed } from "./types";

const WATCHLIST_KEY = "watchlist";
const seenKey = (slug: string) => `seen:${slug}`;

const SEEN_CAP = 500;

export async function getWatchlist(env: Env): Promise<WatchedFeed[]> {
  const raw = await env.MEDIUM_STATE.get(WATCHLIST_KEY);
  return raw ? (JSON.parse(raw) as WatchedFeed[]) : [];
}

export async function saveWatchlist(env: Env, list: WatchedFeed[]): Promise<void> {
  await env.MEDIUM_STATE.put(WATCHLIST_KEY, JSON.stringify(list));
}

export async function getSeenIds(env: Env, slug: string): Promise<Set<string>> {
  const raw = await env.MEDIUM_STATE.get(seenKey(slug));
  return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
}

export async function addSeenIds(env: Env, slug: string, newIds: string[]): Promise<void> {
  if (newIds.length === 0) return;
  const existing = await getSeenIds(env, slug);
  for (const id of newIds) existing.add(id);
  const capped = Array.from(existing).slice(-SEEN_CAP);
  await env.MEDIUM_STATE.put(seenKey(slug), JSON.stringify(capped));
}
