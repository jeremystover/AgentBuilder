/**
 * LinkedIn Watcher — Worker entrypoint
 *
 * Routes (REST, bearer-authenticated with WATCHER_API_KEY except /health):
 *   GET    /health       → { ok, watching }
 *   GET    /watch        → WatchedProfile[]
 *   POST   /watch        → add a profile
 *   DELETE /watch/:slug  → remove a profile
 *   POST   /run          → trigger a watcher run now (for testing)
 *
 * Events:
 *   scheduled (0 14 * * *) → poll every profile, ingest new posts into research-agent
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
        { agentId: "linkedin-watcher", trigger: "daily-poll", cron: controller.cron },
        () => runWatcher(env),
      ),
    );
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
