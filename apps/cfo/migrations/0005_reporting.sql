-- Module 6 (Reporting) — saved configurations and run history.

CREATE TABLE report_configs (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name                 TEXT NOT NULL,
  entity_ids           TEXT[] NOT NULL DEFAULT '{}',
  category_ids         TEXT[] NOT NULL DEFAULT '{}',
  category_mode        TEXT NOT NULL DEFAULT 'all'
                       CHECK (category_mode IN ('tax', 'budget', 'all')),
  include_transactions BOOLEAN NOT NULL DEFAULT true,
  drive_folder_id      TEXT,
  notes                TEXT,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO report_configs (id, name, entity_ids, category_mode, notes) VALUES
  ('rc_schedule_c_elyse',    'Elyse Coaching — Schedule C',   ARRAY['ent_elyse_coaching'],  'tax',    'Schedule C for Elyse coaching business.'),
  ('rc_schedule_c_jeremy',   'Jeremy Coaching — Schedule C',  ARRAY['ent_jeremy_coaching'], 'tax',    'Schedule C for Jeremy coaching business.'),
  ('rc_schedule_e_whitford', 'Whitford House — Schedule E',   ARRAY['ent_whitford'],        'tax',    'Schedule E for Whitford House rental property.'),
  ('rc_family_annual',       'Family Annual Summary',          ARRAY[]::text[],              'budget', 'All entities, budget categories.');

CREATE TABLE report_runs (
  id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  config_id                TEXT NOT NULL REFERENCES report_configs(id),
  date_from                DATE NOT NULL,
  date_to                  DATE NOT NULL,
  generated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  drive_link               TEXT,
  file_name                TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  error_message            TEXT,
  transaction_count        INTEGER,
  unreviewed_warning_count INTEGER DEFAULT 0
);

CREATE INDEX idx_report_runs_config ON report_runs(config_id, generated_at DESC);
