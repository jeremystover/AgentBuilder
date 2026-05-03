import type { D1Database, KVNamespace } from "@cloudflare/workers-types";

export interface WatchedFeed {
  /** Stable slug derived from the feed URL (e.g. "@danshipper", "publication-foo"). */
  slug:        string;
  /** Display name shown in /watch responses + log lines. */
  name:        string;
  /** Full RSS URL. e.g. "https://medium.com/feed/@danshipper". */
  feedUrl:     string;
  /** Optional research-agent source ID to attribute ingested articles to. */
  sourceId?:   string;
  addedAt:     string;
}

export interface RssItem {
  title:       string;
  link:        string;
  guid:        string;
  pubDate:     string | null;
  creator:     string | null;
}

export interface Env {
  MEDIUM_STATE:           KVNamespace;
  VAULT_DB:               D1Database;
  AGENTBUILDER_CORE_DB?:  D1Database;
  WATCHER_API_KEY:        string;
  INTERNAL_SECRET:        string;
  KEK_BASE64:             string;
  RESEARCH_AGENT_URL:     string;
  ENVIRONMENT:            string;
}
