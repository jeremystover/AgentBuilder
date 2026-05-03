import type { Env, WatchedProfile } from "./types";
import { getWatchlist, saveWatchlist } from "./kv";
import { runWatcher } from "./scheduler";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authOk(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization");
  return header === `Bearer ${env.WATCHER_API_KEY}`;
}

function slugFromUrl(linkedinUrl: string): string {
  return linkedinUrl.replace(/\/+$/, "").split("/").pop() ?? "";
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url  = new URL(request.url);
  const path = url.pathname;

  // Unauthenticated liveness probe — safe: returns only a boolean + count.
  if (request.method === "GET" && path === "/health") {
    const list = await getWatchlist(env);
    return json({ ok: true, watching: list.length });
  }

  if (!authOk(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (request.method === "GET" && path === "/watch") {
    return json(await getWatchlist(env));
  }

  if (request.method === "POST" && path === "/watch") {
    let body: { linkedinUrl?: string; name?: string; sourceId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "Request body must be JSON" }, 400);
    }
    if (!body.linkedinUrl || !body.name) {
      return json({ error: "linkedinUrl and name are required" }, 400);
    }

    const slug = slugFromUrl(body.linkedinUrl);
    if (!slug) return json({ error: "Could not derive slug from linkedinUrl" }, 400);

    const list = await getWatchlist(env);
    if (list.some((p) => p.slug === slug)) {
      return json({ error: "Profile already watched" }, 409);
    }

    const profile: WatchedProfile = {
      slug,
      name:        body.name,
      linkedinUrl: body.linkedinUrl,
      sourceId:    body.sourceId,
      addedAt:     new Date().toISOString(),
    };
    list.push(profile);
    await saveWatchlist(env, list);
    return json({ ok: true, profile }, 201);
  }

  if (request.method === "DELETE" && path.startsWith("/watch/")) {
    const slug = path.slice("/watch/".length);
    const list = await getWatchlist(env);
    const filtered = list.filter((p) => p.slug !== slug);
    if (filtered.length === list.length) {
      return json({ error: "Not found" }, 404);
    }
    await saveWatchlist(env, filtered);
    return json({ ok: true });
  }

  // Manual trigger (for testing without waiting for cron).
  if (request.method === "POST" && path === "/run") {
    const result = await runWatcher(env);
    return json(result);
  }

  return json({ error: `Not found: ${request.method} ${path}` }, 404);
}
