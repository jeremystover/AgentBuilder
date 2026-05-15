-- Check images captured by the WF Check Extractor Chrome extension.
-- Front + back image bytes live in R2; this table holds metadata, the
-- vision-extracted payee, and the link back to the matched transaction.

CREATE TABLE IF NOT EXISTS check_images (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  account_id              TEXT NOT NULL REFERENCES gather_accounts(id),
  check_number            TEXT,
  check_date              DATE,
  amount                  NUMERIC(12,2),
  description             TEXT,

  -- R2 object keys (under bucket binding STORAGE)
  front_image_key         TEXT NOT NULL,
  back_image_key          TEXT,
  front_image_size        INTEGER,
  back_image_size         INTEGER,

  -- Claude vision extraction
  extracted_payee         TEXT,
  extracted_amount        NUMERIC(12,2),
  extracted_date          DATE,
  extracted_memo          TEXT,
  extraction_confidence   NUMERIC(4,3),
  extraction_raw_json     JSONB,
  extraction_error        TEXT,

  -- Pipeline state machine
  status                  TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'analyzed', 'attached', 'match_failed', 'error')),

  -- Matched downstream rows (one or the other, not both)
  matched_transaction_id  TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  matched_raw_id          TEXT REFERENCES raw_transactions(id) ON DELETE SET NULL,
  match_method            TEXT,

  uploaded_by             TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One image per (account, check_number). Re-uploading the same check
  -- replaces the existing row (handled in the upload handler with ON CONFLICT).
  UNIQUE (account_id, check_number)
);

CREATE INDEX IF NOT EXISTS idx_check_images_status ON check_images(status);
CREATE INDEX IF NOT EXISTS idx_check_images_account ON check_images(account_id);
CREATE INDEX IF NOT EXISTS idx_check_images_matched_tx ON check_images(matched_transaction_id) WHERE matched_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_check_images_matched_raw ON check_images(matched_raw_id) WHERE matched_raw_id IS NOT NULL;
