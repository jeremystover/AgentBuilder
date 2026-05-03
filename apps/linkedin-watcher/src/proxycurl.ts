import type { Env, ProxycurlPost } from "./types";

// Proxycurl Person Posts API
// Docs: https://nubela.co/proxycurl/docs#linkedin-person-profile-api
const POSTS_URL = "https://nubela.co/proxycurl/api/v2/linkedin/person/posts";

// 48h lookback — the cron runs daily, but a doubled window protects against
// a single missed run without re-ingesting (dedup handles the overlap).
const RECENT_WINDOW_HOURS = 48;

export async function fetchRecentPosts(
  linkedinUrl: string,
  env: Env,
): Promise<ProxycurlPost[]> {
  const params = new URLSearchParams({
    linkedin_profile_url: linkedinUrl,
    type: "posts",
  });

  const resp = await fetch(`${POSTS_URL}?${params}`, {
    headers: { Authorization: `Bearer ${env.PROXYCURL_API_KEY}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Proxycurl error ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as { posts?: ProxycurlPost[] };
  return data.posts ?? [];
}

export function isRecent(post: ProxycurlPost): boolean {
  if (post.published_at) {
    const ageHours = (Date.now() / 1000 - post.published_at) / 3600;
    return ageHours < RECENT_WINDOW_HOURS;
  }
  if (post.time) {
    const match = /^(\d+)([hdwm])$/.exec(post.time);
    if (match?.[1] && match[2]) {
      const n = parseInt(match[1], 10);
      const unit = match[2];
      const hours =
        unit === "h" ? n :
        unit === "d" ? n * 24 :
        unit === "w" ? n * 168 :
        /* "m" = months, way past window */ 9999;
      return hours <= RECENT_WINDOW_HOURS;
    }
  }
  // Unknown age — include and let dedup handle repeats.
  return true;
}

export function getPostId(post: ProxycurlPost): string {
  if (post.urn) return post.urn;
  return post.post_url.replace(/[^a-z0-9]/gi, "-").slice(-60);
}
