-- Working-state columns on raw_transactions. Edits live on the raw row
-- until approval, when the row is INSERT-ed into the transactions ledger
-- with these fields carried forward and the raw row marked 'processed'.

ALTER TABLE raw_transactions
  ADD COLUMN entity_id              TEXT REFERENCES entities(id),
  ADD COLUMN category_id            TEXT REFERENCES categories(id),
  ADD COLUMN classification_method  TEXT CHECK (classification_method IN ('rule', 'ai', 'manual', 'historical')),
  ADD COLUMN ai_confidence          NUMERIC(4,3),
  ADD COLUMN ai_notes               TEXT,
  ADD COLUMN human_notes            TEXT,
  ADD COLUMN is_transfer            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN is_reimbursable        BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_raw_transactions_entity ON raw_transactions(entity_id);
CREATE INDEX idx_raw_transactions_category ON raw_transactions(category_id);
