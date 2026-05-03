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

import { runCron } from "@agentbuilder/observability";
import type { Env } from "./types";
import { handleRequest } from "./api";
import { runWatcher } from "./scheduler";

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runCron(
        env,
        { agentId: "medium-watcher", trigger: "daily-poll", cron: controller.cron },
        () => runWatcher(env),
      ),
    );
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
