/**
 * Thin MCP proxy over the linkedin-watcher worker's REST API.
 *
 * Lets the user manage their LinkedIn-post ingestion pipeline conversationally
 * through Claude:  "Watch Kyle Lagunas", "List the LinkedIn profiles I'm
 * watching", "Stop watching kylelagunas", "Run the LinkedIn poll now".
 *
 * Actually fetching/ingesting posts is owned by linkedin-watcher itself — this
 * tool only manages the watchlist + manual triggers.
 */

import { z } from "zod";
import type { Env } from "../../types";

export const LinkedinWatchInput = z.object({
  action: z.enum(["list", "add", "remove", "run"]),

  // Required for action=add
  linkedin_url: z.string().url().optional(),
  name:         z.string().min(1).max(120).optional(),
  source_id:    z.string().optional(),

  // Required for action=remove
  slug: z.string().min(1).max(120).optional(),
});

export type LinkedinWatchInput = z.infer<typeof LinkedinWatchInput>;

interface WatchedProfile {
  slug:        string;
  name:        string;
  linkedinUrl: string;
  sourceId?:   string;
  addedAt:     string;
}

function ensureConfigured(env: Env): { url: string; key: string } {
  const url = env.LINKEDIN_WATCHER_URL;
  const key = env.LINKEDIN_WATCHER_API_KEY;
  if (!url || !key) {
    throw new Error(
      "linkedin-watcher not configured: set LINKEDIN_WATCHER_URL var and LINKEDIN_WATCHER_API_KEY secret on research-agent",
    );
  }
  return { url, key };
}

async function callWatcher(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const { url, key } = ensureConfigured(env);
  const init: RequestInit = {
    method,
    headers: {
      Authorization:  `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const resp = await fetch(`${url}${path}`, init);
  let data: unknown;
  try { data = await resp.json(); }
  catch { data = await resp.text(); }
  return { status: resp.status, data };
}

export async function linkedinWatch(input: LinkedinWatchInput, env: Env): Promise<unknown> {
  switch (input.action) {
    case "list": {
      const { status, data } = await callWatcher(env, "GET", "/watch");
      if (status !== 200) throw new Error(`linkedin-watcher /watch failed: ${status} ${JSON.stringify(data)}`);
      const profiles = (data as WatchedProfile[]) ?? [];
      return {
        action: "list",
        count:  profiles.length,
        profiles,
      };
    }

    case "add": {
      if (!input.linkedin_url || !input.name) {
        throw new Error("action=add requires linkedin_url and name");
      }
      const { status, data } = await callWatcher(env, "POST", "/watch", {
        linkedinUrl: input.linkedin_url,
        name:        input.name,
        sourceId:    input.source_id,
      });
      if (status === 201) return { action: "add", ...(data as object) };
      if (status === 409) return { action: "add", ok: false, error: "Profile already watched" };
      throw new Error(`linkedin-watcher /watch failed: ${status} ${JSON.stringify(data)}`);
    }

    case "remove": {
      if (!input.slug) throw new Error("action=remove requires slug");
      const { status, data } = await callWatcher(env, "DELETE", `/watch/${encodeURIComponent(input.slug)}`);
      if (status === 200) return { action: "remove", ok: true, slug: input.slug };
      if (status === 404) return { action: "remove", ok: false, error: "Not found", slug: input.slug };
      throw new Error(`linkedin-watcher /watch/${input.slug} failed: ${status} ${JSON.stringify(data)}`);
    }

    case "run": {
      const { status, data } = await callWatcher(env, "POST", "/run");
      if (status !== 200) throw new Error(`linkedin-watcher /run failed: ${status} ${JSON.stringify(data)}`);
      return { action: "run", ...(data as object) };
    }
  }
}
