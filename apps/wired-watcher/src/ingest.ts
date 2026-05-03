import type { Env, RssItem, WatchedFeed } from "./types";
import type { ExtractedArticle } from "./article";

export async function forwardToResearchAgent(
  feed:    WatchedFeed,
  item:    RssItem,
  article: ExtractedArticle,
  env:     Env,
): Promise<void> {
  const payload: Record<string, unknown> = {
    url:          article.canonicalUrl ?? item.link,
    content:      article.fullText,
    title:        article.title ?? item.title,
    author:       article.author ?? item.creator ?? null,
    published_at: article.publishedAt ?? (item.pubDate ? new Date(item.pubDate).toISOString() : undefined),
    source_id:    feed.sourceId,
    note:         `Wired article via ${feed.name} (${feed.feedUrl})`,
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
