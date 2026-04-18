-- Graphic Designer initial schema.
--
-- Eight tables:
--   google_tokens     — encrypted OAuth tokens (matches @agentbuilder/auth-google schema)
--   brand_guides      — stored brand style guides (colors, fonts, voice, rules)
--   templates         — registered Google Slides templates
--   template_layouts  — per-layout analysis of a template (slot types, capacities)
--   projects          — design projects (presentations, sites, logos)
--   logo_concepts     — generated logo concepts with R2-hosted image URLs
--   site_deployments  — Cloudflare Pages deployment history
--   compliance_reports — brand-compliance audit results

-- ── Google OAuth token vault (shared schema) ────────────────────────────────
CREATE TABLE IF NOT EXISTS google_tokens (
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  access_token   TEXT NOT NULL,   -- encrypted (AES-256-GCM)
  refresh_token  TEXT,            -- encrypted
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (agent_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_google_tokens_user ON google_tokens(user_id);

-- ── Brand style guides ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brand_guides (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  palette        TEXT NOT NULL,  -- JSON: { primary, secondary, accent, neutral, ... }
  typography     TEXT NOT NULL,  -- JSON: { heading, body, display, scale }
  voice          TEXT,           -- JSON: { tone, adjectives, avoid }
  logo_usage     TEXT,           -- JSON: { clearspace, minSize, placements, reversedAllowed }
  spacing        TEXT,           -- JSON: { grid, unit, breakpoints }
  extras         TEXT,           -- JSON catch-all for custom rules
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

-- ── Registered Google Slides templates ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS templates (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  brand_id            TEXT REFERENCES brand_guides(id) ON DELETE SET NULL,
  google_slides_id    TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  is_default          INTEGER NOT NULL DEFAULT 0,
  analyzed_at         INTEGER,      -- NULL until analyze_template runs
  analysis_summary    TEXT,         -- JSON: { layoutCount, colorCount, fontCount, themes }
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (user_id, google_slides_id)
);

CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id);
CREATE INDEX IF NOT EXISTS idx_templates_default ON templates(user_id, is_default);

-- ── Per-layout analysis of a template ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS template_layouts (
  id                TEXT PRIMARY KEY,
  template_id       TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  layout_object_id  TEXT NOT NULL,   -- Google Slides layout page objectId
  name              TEXT NOT NULL,   -- e.g. "TITLE_AND_BODY", "SECTION_HEADER"
  display_name      TEXT,            -- Human label like "Two-column with image"
  slot_types        TEXT NOT NULL,   -- JSON array: [{type, shape, textCapacity, bounds}, ...]
  text_capacity     INTEGER,         -- Approx total chars the layout can hold comfortably
  image_slots       INTEGER NOT NULL DEFAULT 0,
  best_fit_intents  TEXT,            -- JSON array of suggested intents: ["section-break", "two-ideas"]
  thumbnail_url     TEXT,            -- Optional preview
  created_at        INTEGER NOT NULL,
  UNIQUE (template_id, layout_object_id)
);

CREATE INDEX IF NOT EXISTS idx_layouts_template ON template_layouts(template_id);

-- ── Design projects (decks, sites, logos) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  brand_id       TEXT REFERENCES brand_guides(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('presentation', 'site', 'logo')),
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'planning', 'building', 'completed', 'archived')),
  metadata       TEXT,           -- JSON: kind-specific (outline, plan, selected concepts, etc.)
  output_url     TEXT,           -- Google Drive URL / Pages URL / R2 folder
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_kind ON projects(user_id, kind);

-- ── Logo concepts ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS logo_concepts (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  iteration      INTEGER NOT NULL,       -- 1, 2, 3... rounds of concepts
  style          TEXT NOT NULL,          -- mark | wordmark | combo | lettermark | emblem
  prompt         TEXT NOT NULL,          -- The gpt-image-1 prompt used
  image_r2_key   TEXT NOT NULL,          -- R2 object key for the concept PNG
  preview_url    TEXT,                   -- Signed URL or public URL
  selected       INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_concepts_project ON logo_concepts(project_id, iteration);

-- ── Cloudflare Pages deployments ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_deployments (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pages_project_name     TEXT NOT NULL,
  deployment_id          TEXT,           -- Cloudflare deployment ID
  live_url               TEXT,
  status                 TEXT NOT NULL CHECK (status IN ('pending', 'deployed', 'failed')),
  iteration              INTEGER NOT NULL DEFAULT 1,
  feedback               TEXT,
  created_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deploys_project ON site_deployments(project_id, iteration);

-- ── Brand compliance audit reports ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_reports (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  brand_id        TEXT NOT NULL REFERENCES brand_guides(id) ON DELETE CASCADE,
  file_id         TEXT NOT NULL,          -- Google Drive file ID
  file_type       TEXT NOT NULL CHECK (file_type IN ('doc', 'slides')),
  score           INTEGER,                -- 0-100
  violations      TEXT NOT NULL,          -- JSON array of { rule, location, severity, suggestion }
  summary         TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_brand ON compliance_reports(brand_id, created_at);

-- ── Seed: the default template from the user's Drive ───────────────────────
-- Registered but not yet analyzed. Run `analyze_template` once to populate
-- template_layouts.
INSERT OR IGNORE INTO templates (
  id, user_id, google_slides_id, name, description, is_default, created_at, updated_at
) VALUES (
  'tpl_default_jeremy',
  'default',
  '1QIpHG7Bj_XcYkZer9b5Fydv0OGEUqXHvP_W0iWMVJaY',
  'Default Template',
  'Seed template registered on first migration. Run analyze_template to populate layouts.',
  1,
  unixepoch() * 1000,
  unixepoch() * 1000
);
