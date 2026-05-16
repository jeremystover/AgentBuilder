-- Apple receipt splitting: a multi-item Apple receipt is split into one
-- child raw_transactions row per item (plus a tax/fees row when the item
-- prices don't sum to the charged amount). The original bank row is kept
-- with status 'split' so Teller re-sync still dedupes against it; it never
-- enters the transactions ledger — the per-item children do.

ALTER TABLE raw_transactions
  ADD COLUMN IF NOT EXISTS parent_raw_id TEXT REFERENCES raw_transactions(id);

CREATE INDEX IF NOT EXISTS idx_raw_transactions_parent ON raw_transactions(parent_raw_id);

ALTER TABLE raw_transactions DROP CONSTRAINT IF EXISTS raw_transactions_status_check;
ALTER TABLE raw_transactions ADD CONSTRAINT raw_transactions_status_check
  CHECK (status IN ('staged', 'waiting', 'ready', 'processed', 'split'));
