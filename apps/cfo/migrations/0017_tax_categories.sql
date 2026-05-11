CREATE TABLE tax_categories (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  form_line       TEXT,
  category_group  TEXT NOT NULL CHECK (category_group IN ('schedule_c', 'schedule_e')),
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, slug)
);
