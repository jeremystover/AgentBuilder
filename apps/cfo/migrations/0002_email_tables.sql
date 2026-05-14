-- Email enrichment dedup table. Tracks which Gmail message IDs have been
-- processed per vendor so re-running sync doesn't re-process them.

CREATE TABLE email_processed (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  vendor         TEXT NOT NULL CHECK (vendor IN ('amazon', 'venmo', 'apple', 'etsy')),
  message_id     TEXT NOT NULL,
  processed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  parse_success  BOOLEAN NOT NULL DEFAULT false,
  match_found    BOOLEAN NOT NULL DEFAULT false,
  transaction_id TEXT REFERENCES raw_transactions(id),
  error_message  TEXT,
  UNIQUE (vendor, message_id)
);

CREATE INDEX idx_email_processed_vendor_message ON email_processed(vendor, message_id);
