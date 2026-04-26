import type { KVNamespace, R2Bucket } from "@cloudflare/workers-types";

export interface WatchedProfile {
  slug:        string;   // e.g. "kylelagunas"
  name:        string;   // display name e.g. "Kyle Lagunas"
  linkedinUrl: string;   // full URL e.g. "https://www.linkedin.com/in/kylelagunas"
  sourceId?:   string;   // research agent source ID (optional)
  addedAt:     string;   // ISO 8601
}

export interface ProxycurlPost {
  post_url:      string;
  text:          string;
  actor_name?:   string;
  time?:         string;   // relative e.g. "2d", "1w"
  published_at?: number;   // unix seconds, when available
  num_likes?:    number;
  num_comments?: number;
  urn?:          string;   // stable unique identifier when returned
}

export interface Env {
  LINKEDIN_STATE:     KVNamespace;
  LINKEDIN_CONTENT:   R2Bucket;
  PROXYCURL_API_KEY:  string;
  INTERNAL_SECRET:    string;
  WATCHER_API_KEY:    string;
  RESEARCH_AGENT_URL: string;
  ENVIRONMENT:        string;
}
