-- SMS-based gamified categorization (Phase A — plumbing).
--
-- Outbound: a cron worker picks the oldest unclassified transaction owned
-- by a person, predicts a category via the existing rules+AI pipeline,
-- and sends a Twilio SMS asking them to confirm.
--
-- Inbound: Twilio POSTs replies to /sms/inbound. Reply parsing is
-- numeric-only in Phase A (1=confirm, 2=reroute to Jeremy, 3/PAUSE=pause
-- for today, MORE=send next, STOP=Twilio-mandated unsubscribe).
-- Free-text intent parsing via Claude lands in Phase B.
--
-- Routing: account ownership is already supported via accounts.owner_tag
-- (added in 0001). We standardize on lower-case 'jeremy' / 'elyse'.

-- One row per (user_id, person). person is 'jeremy' or 'elyse'.
-- paused_until_date implements "PAUSE for today" cleanly without
-- collapsing into Twilio's permanent STOP keyword.
-- preferred_send_slots is JSON: [{"hour":8,"minute":0}, ...] in the
-- person's local timezone. Defaults to 8:00 / 12:30 / 18:30 PT.
CREATE TABLE IF NOT EXISTS sms_persons (
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person                   TEXT NOT NULL CHECK (person IN ('jeremy', 'elyse')),
  phone_e164               TEXT NOT NULL,
  timezone                 TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  preferred_send_slots     TEXT NOT NULL DEFAULT '[{"hour":8,"minute":0},{"hour":12,"minute":30},{"hour":18,"minute":30}]',
  preferred_batch_size     INTEGER NOT NULL DEFAULT 1,
  opted_in_at              TEXT,
  paused_until_date        TEXT,           -- YYYY-MM-DD in person's timezone; NULL = not paused
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, person)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_persons_phone ON sms_persons(phone_e164);

-- Per-conversation tracking. A session = one outbound + the user's reply.
-- Phase A: one transaction per session. Phase B will allow batch sessions
-- by extending sms_session_transactions (introduced then).
CREATE TABLE IF NOT EXISTS sms_sessions (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  person                   TEXT NOT NULL,
  transaction_id           TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  suggested_entity         TEXT,
  suggested_category_tax   TEXT,
  suggested_category_budget TEXT,
  suggested_confidence     REAL,
  suggested_method         TEXT,           -- 'rule' | 'ai' | 'historical'
  status                   TEXT NOT NULL DEFAULT 'awaiting_reply'
                             CHECK (status IN ('awaiting_reply','confirmed','rerouted','paused','unsubscribed','timed_out')),
  variant_id               TEXT,           -- A/B copy variant; NULL in Phase A
  sent_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at             TEXT,
  closed_at                TEXT
);

CREATE INDEX IF NOT EXISTS idx_sms_sessions_open ON sms_sessions(user_id, person, status);
CREATE INDEX IF NOT EXISTS idx_sms_sessions_tx   ON sms_sessions(transaction_id);

-- Every inbound + outbound, indexed by Twilio's MessageSid for dedup
-- (Twilio retries inbound webhooks on 5xx; same MessageSid arrives twice).
CREATE TABLE IF NOT EXISTS sms_messages (
  id                       TEXT PRIMARY KEY,
  session_id               TEXT REFERENCES sms_sessions(id) ON DELETE CASCADE,
  user_id                  TEXT NOT NULL,
  person                   TEXT NOT NULL,
  direction                TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  body                     TEXT NOT NULL,
  twilio_sid               TEXT,
  twilio_payload           TEXT,           -- raw form body, JSON-encoded; useful for debugging
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_messages_sid ON sms_messages(twilio_sid)
  WHERE twilio_sid IS NOT NULL;

-- Per-transaction outcome of an SMS interaction. Drives the "praise
-- reflects actual progress" goal AND feeds the learned-rules engine
-- (a 'confirmed' outcome with method='ai' is a high-quality positive
-- signal for that merchant→category pairing).
CREATE TABLE IF NOT EXISTS sms_outcomes (
  id                       TEXT PRIMARY KEY,
  session_id               TEXT NOT NULL REFERENCES sms_sessions(id) ON DELETE CASCADE,
  transaction_id           TEXT NOT NULL,
  user_id                  TEXT NOT NULL,
  person                   TEXT NOT NULL,
  action                   TEXT NOT NULL
                             CHECK (action IN ('confirmed','rerouted','free_text','timed_out')),
  category_tax             TEXT,
  category_budget          TEXT,
  entity                   TEXT,
  source                   TEXT NOT NULL CHECK (source IN ('preset','free_text')),
  confidence               REAL,
  latency_seconds          INTEGER,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sms_outcomes_person ON sms_outcomes(user_id, person, created_at DESC);

-- Reroute marker — Elyse's "2" reply moves the transaction to Jeremy's
-- queue. Stored separately so the next dispatcher run for Jeremy can
-- union his account-owned transactions with rerouted ones.
CREATE TABLE IF NOT EXISTS sms_routing_overrides (
  transaction_id           TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  user_id                  TEXT NOT NULL,
  target_person            TEXT NOT NULL CHECK (target_person IN ('jeremy','elyse')),
  source_person            TEXT NOT NULL CHECK (source_person IN ('jeremy','elyse')),
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sms_routing_target ON sms_routing_overrides(user_id, target_person);
