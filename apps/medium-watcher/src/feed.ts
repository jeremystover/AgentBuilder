/**
 * Medium member-RSS parser. The feed itself is unauthenticated; the items
 * point at member-only article URLs that need cookie replay to fetch the
 * full body.
 *
 * We use a streaming HTMLRewriter pass instead of pulling in an XML parser
 * because Medium's RSS is small, well-formed, and we only need a few
 * fields per item.
 */

import type { RssItem } from "./types";

const FEED_HEADERS: HeadersInit = {
  "User-Agent":      "Mozilla/5.0 (compatible; MediumWatcher/1.0)",
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
  // Strip <![CDATA[ ... ]]>
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

/** Extract a stable id for dedup. Medium guids are stable per-post URLs;
 *  fall back to the article link minus query string if guid is missing. */
export function feedItemId(item: RssItem): string {
  if (item.guid) return item.guid;
  return item.link.split("?")[0] ?? item.link;
}
