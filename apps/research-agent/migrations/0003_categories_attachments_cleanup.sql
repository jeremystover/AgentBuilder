-- Research Agent — categories, attachments, and cleanup support
-- Apply via: wrangler d1 migrations apply research-agent-db

-- Categories for organizing research into interest areas
CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT,
  color       TEXT,
  parent_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_categories_slug   ON categories(slug);

-- Many-to-many: articles <-> categories
CREATE TABLE IF NOT EXISTS article_categories (
  article_id  TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL,
  assigned_by TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (article_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_article_categories_category ON article_categories(category_id);

-- File attachments with OCR support
CREATE TABLE IF NOT EXISTS attachments (
  id             TEXT PRIMARY KEY,
  article_id     TEXT REFERENCES articles(id) ON DELETE SET NULL,
  filename       TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  file_size      INTEGER NOT NULL,
  r2_key         TEXT NOT NULL,
  ocr_text       TEXT,
  ocr_confidence REAL,
  is_text_image  INTEGER NOT NULL DEFAULT 0,
  vector_id      TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_article ON attachments(article_id);

-- Many-to-many: attachments <-> categories
CREATE TABLE IF NOT EXISTS attachment_categories (
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  category_id   TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (attachment_id, category_id)
);

-- Cleanup audit log
CREATE TABLE IF NOT EXISTS cleanup_log (
  id          TEXT PRIMARY KEY,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  reason      TEXT,
  details     TEXT,
  status      TEXT NOT NULL DEFAULT 'proposed',
  batch_id    TEXT,
  proposed_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cleanup_log_status ON cleanup_log(status);
CREATE INDEX IF NOT EXISTS idx_cleanup_log_batch  ON cleanup_log(batch_id);
