import type { Env } from "./types";
import { addSeenIds, getSeenIds, getWatchlist } from "./kv";
import { feedItemId, fetchFeed } from "./feed";
import { fetchArticle, loadCookie } from "./article";
import { forwardToResearchAgent } from "./ingest";

export interface RunResult {
  processed:     number;
  paywalled:     number;
  errors:        string[];
  cookieMissing: boolean;
}

const DELAY_BETWEEN_FETCHES_MS = 1500;
const DELAY_BETWEEN_FEEDS_MS   = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runWatcher(env: Env): Promise<RunResult> {
  const watchlist = await getWatchlist(env);
  const errors: string[] = [];
  let processed = 0;
  let paywalled = 0;

  const cookie = await loadCookie(env);
  const cookieMissing = !cookie;
  if (cookieMissing) {
    console.warn("[medium-watcher] no cookie in vault — fetches will only get paywall previews");
  }

  for (const feed of watchlist) {
    try {
      console.log(`[medium-watcher] checking ${feed.name} (${feed.slug})`);
      const items = await fetchFeed(feed.feedUrl);
      const seen  = await getSeenIds(env, feed.slug);
      const fresh = items.filter((it) => !seen.has(feedItemId(it)));
      console.log(`[medium-watcher]   ${fresh.length} new (of ${items.length}, ${seen.size} seen)`);

      const newIds: string[] = [];
      for (const item of fresh) {
        try {
          const article = await fetchArticle(item.link, cookie);
          if (article.looksPaywalled) {
            paywalled++;
            console.warn(`[medium-watcher]   paywalled (cookie may be stale): ${item.link}`);
            // We still mark as seen so we don't retry every day. Operator
            // can force a re-ingest after refreshing the cookie.
            newIds.push(feedItemId(item));
            await sleep(DELAY_BETWEEN_FETCHES_MS);
            continue;
          }
          await forwardToResearchAgent(feed, item, article, env);
          newIds.push(feedItemId(item));
          processed++;
          await sleep(DELAY_BETWEEN_FETCHES_MS);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${feed.slug}/${feedItemId(item)}: ${msg}`);
          console.error(`[medium-watcher]   ingest error for ${item.link}:`, err);
        }
      }

      await addSeenIds(env, feed.slug, newIds);
      await sleep(DELAY_BETWEEN_FEEDS_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${feed.slug}: ${msg}`);
      console.error(`[medium-watcher] error processing ${feed.slug}:`, err);
    }
  }

  return { processed, paywalled, errors, cookieMissing };
}
