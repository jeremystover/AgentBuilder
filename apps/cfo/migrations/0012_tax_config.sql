-- Module 5 (Scenarios) Phase 6 — tax configuration tables.

CREATE TABLE user_profiles (
  id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name                     TEXT NOT NULL,
  role                     TEXT NOT NULL DEFAULT 'self' CHECK (role IN ('self', 'spouse')),
  date_of_birth            DATE NOT NULL,
  expected_retirement_date DATE
);

CREATE TABLE state_residence_timeline (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  state          TEXT NOT NULL,
  effective_date DATE NOT NULL
);

CREATE INDEX idx_state_residence_timeline_date ON state_residence_timeline(effective_date);

CREATE TABLE tax_bracket_schedules (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  year               INTEGER NOT NULL,
  filing_status      TEXT NOT NULL,
  jurisdiction       TEXT NOT NULL,       -- 'federal' | 'CA' | 'VT' | etc.
  brackets_json      JSONB NOT NULL,      -- [{floor, ceiling, rate}]
  standard_deduction NUMERIC(12,2),
  created_by         TEXT NOT NULL DEFAULT 'system',
  UNIQUE (year, filing_status, jurisdiction)
);

CREATE TABLE capital_gains_config (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  year               INTEGER NOT NULL,
  jurisdiction       TEXT NOT NULL,
  ltcg_brackets_json JSONB,
  niit_rate          NUMERIC(6,4) NOT NULL DEFAULT 0.038,
  niit_threshold     NUMERIC(14,2) NOT NULL DEFAULT 250000,
  stcg_as_ordinary   BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (year, jurisdiction)
);

CREATE TABLE tax_deduction_config (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type           TEXT NOT NULL CHECK (type IN ('salt', 'charitable', 'mortgage_interest', 'other')),
  label          TEXT,
  annual_amount  NUMERIC(14,2),
  effective_date DATE NOT NULL,
  source         TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto_mortgage'))
);

CREATE INDEX idx_tax_deduction_config_date ON tax_deduction_config(effective_date);

-- Seed user profiles (DOBs are placeholders — to be set in the UI).
INSERT INTO user_profiles (id, name, role, date_of_birth) VALUES
  ('up_jeremy', 'Jeremy', 'self',   '1976-01-01'),
  ('up_elyse',  'Elyse',  'spouse', '1976-01-01');

-- Seed state residence timeline.
INSERT INTO state_residence_timeline (state, effective_date) VALUES
  ('CA', '2000-01-01'),
  ('VT', '2027-07-01');
