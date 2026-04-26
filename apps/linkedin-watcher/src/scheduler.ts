import type { Env } from "./types";
import { addSeenIds, getSeenIds, getWatchlist } from "./kv";
import { fetchRecentPosts, getPostId, isRecent } from "./proxycurl";
import { uploadAndIngest } from "./ingest";

export interface RunResult {
  processed: number;
  errors:    string[];
}

const DELAY_BETWEEN_INGESTS_MS  = 500;
const DELAY_BETWEEN_PROFILES_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runWatcher(env: Env): Promise<RunResult> {
  const watchlist = await getWatchlist(env);
  const errors: string[] = [];
  let processed = 0;

  for (const profile of watchlist) {
    try {
      console.log(`[watcher] checking ${profile.name} (${profile.slug})`);
      const posts = await fetchRecentPosts(profile.linkedinUrl, env);
      const recent = posts.filter(isRecent);
      const seen   = await getSeenIds(env, profile.slug);
      const fresh  = recent.filter((p) => !seen.has(getPostId(p)));

      console.log(
        `[watcher]   ${fresh.length} new (of ${recent.length} recent, ${seen.size} previously seen)`,
      );

      const newIds: string[] = [];
      for (const post of fresh) {
        try {
          await uploadAndIngest(profile, post, env);
          newIds.push(getPostId(post));
          processed++;
          await sleep(DELAY_BETWEEN_INGESTS_MS);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${profile.slug}/${getPostId(post)}: ${msg}`);
          console.error(`[watcher]   ingest error for ${profile.slug}:`, err);
        }
      }

      await addSeenIds(env, profile.slug, newIds);
      await sleep(DELAY_BETWEEN_PROFILES_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${profile.slug}: ${msg}`);
      console.error(`[watcher] error processing ${profile.slug}:`, err);
    }
  }

  return { processed, errors };
}
