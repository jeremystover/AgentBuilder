import { mountCredentialsApi } from "@agentbuilder/credential-vault";
import { importKey } from "@agentbuilder/crypto";
import type { Env, WatchedFeed } from "./types";
import { D1CredentialVault } from "@agentbuilder/credential-vault";
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

function slugFromFeedUrl(feedUrl: string): string {
  // Examples:
  //   https://medium.com/feed/@danshipper           → "danshipper"
  //   https://medium.com/feed/some-publication      → "some-publication"
  //   https://medium.com/feed/tag/ai                → "tag-ai"
  const path = new URL(feedUrl).pathname.replace(/^\/feed\/?/, "");
  return path
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(/[^a-z0-9._-]/gi, "")
    .toLowerCase();
}

let cachedKey: CryptoKey | null = null;
async function vaultKey(env: Env): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  if (!env.KEK_BASE64) throw new Error("KEK_BASE64 secret is not set");
  const bytes = Uint8Array.from(atob(env.KEK_BASE64), (c) => c.charCodeAt(0));
  cachedKey = await importKey(bytes.buffer);
  return cachedKey;
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url  = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/health") {
    const list = await getWatchlist(env);
    return json({ ok: true, watching: list.length });
  }

  // /credentials/* — vault management, gated by WATCHER_API_KEY
  if (path === "/credentials" || path.startsWith("/credentials/")) {
    const key = await vaultKey(env);
    const vault = new D1CredentialVault({ db: env.VAULT_DB, encryptionKey: key });
    const response = await mountCredentialsApi(request, {
      vault,
      agentId:      "medium-watcher",
      prefix:       "/credentials",
      isAuthorized: (req) => authOk(req, env),
    });
    if (response) return response;
  }

  if (!authOk(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (method === "GET" && path === "/watch") {
    return json(await getWatchlist(env));
  }

  if (method === "POST" && path === "/watch") {
    let body: { feedUrl?: string; name?: string; sourceId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "Body must be JSON" }, 400);
    }
    if (!body.feedUrl || !body.name) {
      return json({ error: "feedUrl and name are required" }, 400);
    }
    let slug: string;
    try {
      slug = slugFromFeedUrl(body.feedUrl);
    } catch {
      return json({ error: "feedUrl must be a valid URL" }, 400);
    }
    if (!slug) return json({ error: "Could not derive slug from feedUrl" }, 400);

    const list = await getWatchlist(env);
    if (list.some((f) => f.slug === slug)) {
      return json({ error: "Feed already watched" }, 409);
    }
    const feed: WatchedFeed = {
      slug,
      name:     body.name,
      feedUrl:  body.feedUrl,
      sourceId: body.sourceId,
      addedAt:  new Date().toISOString(),
    };
    list.push(feed);
    await saveWatchlist(env, list);
    return json({ ok: true, feed }, 201);
  }

  if (method === "DELETE" && path.startsWith("/watch/")) {
    const slug = path.slice("/watch/".length);
    const list = await getWatchlist(env);
    const filtered = list.filter((f) => f.slug !== slug);
    if (filtered.length === list.length) return json({ error: "Not found" }, 404);
    await saveWatchlist(env, filtered);
    return json({ ok: true });
  }

  if (method === "POST" && path === "/run") {
    const result = await runWatcher(env);
    return json(result);
  }

  return json({ error: `Not found: ${method} ${path}` }, 404);
}
