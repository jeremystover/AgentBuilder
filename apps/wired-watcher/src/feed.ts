/**
 * Wired section/tag RSS parser. The feeds are public; the article URLs
 * point at paywalled bodies that need cookie replay to fetch in full.
 *
 * Wired's feeds are standard RSS 2.0 with <item> blocks containing
 * <title>, <link>, <guid>, <pubDate>, <dc:creator>. We don't need a full
 * XML parser for this.
 */

import type { RssItem } from "./types";

const FEED_HEADERS: HeadersInit = {
  "User-Agent":      "Mozilla/5.0 (compatible; WiredWatcher/1.0)",
  Accept:            "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export async function fetchFeed(feedUrl: string): Promise<RssItem[]> {
  const response = await fetch(feedUrl, { headers: FEED_HEADERS, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`feed fetch failed ${response.status} for ${feedUrl}`);
  }
  const xml = await response.text();
  return parseItems(xml);
}

const ITEM_RE = /<item\b[\s\S]*?<\/item>/gi;

function parseItems(xml: string): RssItem[] {
  const out: RssItem[] = [];
  for (const match of xml.match(ITEM_RE) ?? []) {
    const title   = pickTag(match, "title")   ?? "";
    const link    = pickTag(match, "link")    ?? "";
    const guidRaw = pickTag(match, "guid")    ?? link;
    const pubDate = pickTag(match, "pubDate");
    const creator = pickTag(match, "dc:creator") ?? pickTag(match, "creator");
    if (!link) continue;
    out.push({
      title:   decodeEntities(title),
      link,
      guid:    guidRaw,
      pubDate: pubDate ?? null,
      creator: creator ? decodeEntities(creator) : null,
    });
  }
  return out;
}

function pickTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${escapeReg(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeReg(tag)}>`, "i");
  const m  = re.exec(xml);
  if (!m) return null;
  let value = m[1] ?? "";
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(value.trim());
  if (cdata?.[1]) value = cdata[1];
  return value.trim();
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&#x27;/g, "'");
}

/** Stable id for dedup. Wired guids are post-stable; fall back to the
 *  link minus query string. */
export function feedItemId(item: RssItem): string {
  if (item.guid) return item.guid;
  return item.link.split("?")[0] ?? item.link;
}
