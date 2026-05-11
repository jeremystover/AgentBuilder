-- Cuts tracking: per-transaction flag for "expenses I want to eliminate".
--
-- Lifecycle:
--   NULL       — unflagged (default, no opinion)
--   'flagged'  — earmarked for elimination, not yet acted on
--   'complete' — eliminated; kept for "what we cut" reporting
--
-- The cuts report annualizes 'complete' rows by deduping on merchant_name
-- and summing each merchant's trailing-12-month spend, so a single Spotify
-- charge marked complete still represents the full annualized savings.

ALTER TABLE classifications ADD COLUMN cut_status TEXT
  CHECK (cut_status IS NULL OR cut_status IN ('flagged', 'complete'));

ALTER TABLE classification_history ADD COLUMN cut_status TEXT;

CREATE INDEX IF NOT EXISTS idx_classifications_cut_status
  ON classifications(cut_status) WHERE cut_status IS NOT NULL;
