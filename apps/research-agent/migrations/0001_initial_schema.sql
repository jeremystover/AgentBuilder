-- Research Agent — initial schema
-- Apply via: wrangler d1 migrations apply research-agent-db

-- Sources: ingestion feeds (Bluesky accounts, RSS, email, manual)
CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK(type IN ('rss', 'bluesky', 'email', 'manual')),
  name        TEXT NOT NULL,
  url         TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  poll_cursor TEXT,
  last_polled TEXT,
  created_at  TEXT NOT NULL
);

-- Articles: primary content store
CREATE TABLE IF NOT EXISTS articles (
  id               TEXT PRIMARY KEY,
  source_id        TEXT REFERENCES sources(id),
  url              TEXT NOT NULL UNIQUE,
  canonical_url    TEXT,
  title            TEXT,
  author           TEXT,
  published_at     TEXT,
  ingested_at      TEXT NOT NULL,
  summary          TEXT,
  full_text        TEXT,
  html             TEXT,
  word_count       INTEGER,
  reading_time_min INTEGER,
  language         TEXT,
  topics           TEXT,        -- JSON array of topic strings
  entities         TEXT,        -- JSON array of named entities
  r2_key           TEXT,        -- set when full text/html offloaded to R2
  vector_id        TEXT,        -- Vectorize document ID
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK(status IN ('pending', 'processing', 'ready', 'error')),
  error_message    TEXT
);

-- FTS5 virtual table for full-text search (title + summary + body)
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title,
  summary,
  full_text,
  content=articles,
  content_rowid=rowid
);

-- Triggers to keep articles_fts in sync with articles
CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, summary, full_text)
  VALUES (new.rowid, new.title, new.summary, new.full_text);
END;

CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, summary, full_text)
  VALUES ('delete', old.rowid, old.title, old.summary, old.full_text);
  INSERT INTO articles_fts(rowid, title, summary, full_text)
  VALUES (new.rowid, new.title, new.summary, new.full_text);
END;

CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, summary, full_text)
  VALUES ('delete', old.rowid, old.title, old.summary, old.full_text);
END;

-- Feedback: thumbs-up signals that drive interest profile updates
CREATE TABLE IF NOT EXISTS feedback (
  id         TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  signal     TEXT NOT NULL,
  context    TEXT,        -- JSON context at time of signal
  note       TEXT,
  created_at TEXT NOT NULL
);

-- Interest profile: key-value weights for topics, sources, and settings
-- Key patterns: topic:<name>, source:<id>, setting:<key>, meta:<key>
CREATE TABLE IF NOT EXISTS interest_profile (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,  -- JSON-encoded value
  updated_at TEXT NOT NULL
);
