import type { Env, ProxycurlPost, WatchedProfile } from "./types";
import { getPostId } from "./proxycurl";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPostHtml(profile: WatchedProfile, post: ProxycurlPost): string {
  const date = post.published_at
    ? new Date(post.published_at * 1000).toISOString()
    : new Date().toISOString();
  const excerpt = escapeHtml(post.text.slice(0, 80));
  const paragraphs = post.text
    .split(/\n+/)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(profile.name)} on LinkedIn: ${excerpt}</title>
  <meta name="author" content="${escapeHtml(profile.name)}">
  <meta name="published_time" content="${date}">
  <meta property="og:url" content="${escapeHtml(post.post_url)}">
</head>
<body>
  <article>
    <header>
      <h1>${escapeHtml(profile.name)} on LinkedIn</h1>
      <p>Posted: ${date}</p>
      <p>Original: <a href="${escapeHtml(post.post_url)}">${escapeHtml(post.post_url)}</a></p>
    </header>
    <main>${paragraphs}</main>
    <footer>
      <p>Likes: ${post.num_likes ?? 0} | Comments: ${post.num_comments ?? 0}</p>
    </footer>
  </article>
</body>
</html>`;
}

export async function uploadAndIngest(
  profile: WatchedProfile,
  post: ProxycurlPost,
  env: Env,
): Promise<void> {
  const postId = getPostId(post);
  const r2Key = `posts/${profile.slug}/${postId}.html`;

  // 1) Archive to R2 for the audit trail.
  const html = renderPostHtml(profile, post);
  await env.LINKEDIN_CONTENT.put(r2Key, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });

  // 2) Push pre-fetched content into the research agent.
  const payload: Record<string, unknown> = {
    url:     post.post_url,
    content: post.text,
    title:   `${profile.name} on LinkedIn: ${post.text.slice(0, 80)}`,
    author:  profile.name,
    published_at: post.published_at
      ? new Date(post.published_at * 1000).toISOString()
      : undefined,
    source_id: profile.sourceId,
    note:      `LinkedIn post by ${profile.name}`,
  };

  const resp = await fetch(`${env.RESEARCH_AGENT_URL}/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${env.INTERNAL_SECRET}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`research-agent /ingest failed: ${resp.status} ${body}`);
  }
}
