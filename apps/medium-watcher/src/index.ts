/**
 * Medium Watcher — Worker entrypoint
 *
 * Routes (REST, bearer-authenticated with WATCHER_API_KEY except /health):
 *   GET    /health                              → { ok, watching }
 *   GET    /watch                               → WatchedFeed[]
 *   POST   /watch                               → add { feedUrl, name, sourceId? }
 *   DELETE /watch/:slug                         → remove a feed
 *   POST   /run                                 → trigger a watcher run now
 *   GET    /credentials                         → list vault entries
 *   GET    /credentials/:account/:provider/:kind → fetch one
 *   PUT    /credentials/:account/:provider/:kind → upsert one
 *   DELETE /credentials/:account/:provider/:kind → remove one
 *
 * Events:
 *   scheduled (0 14 * * *) → poll every feed, fetch articles with cookie,
 *                             ingest into research-agent.
 */

import type { Env } from "./types";
import { handleRequest } from "./api";
import { runWatcher } from "./scheduler";

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    console.log(`[cron] trigger: ${controller.cron} at ${new Date(controller.scheduledTime).toISOString()}`);
    ctx.waitUntil(
      (async () => {
        try {
          const result = await runWatcher(env);
          console.log(
            `[cron] complete: processed=${result.processed} paywalled=${result.paywalled} ` +
            `errors=${result.errors.length} cookieMissing=${result.cookieMissing}`,
          );
          if (result.errors.length) console.warn(`[cron] errors: ${result.errors.join("; ")}`);
        } catch (err) {
          console.error("[cron] unhandled:", err);
        }
      })(),
    );
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
