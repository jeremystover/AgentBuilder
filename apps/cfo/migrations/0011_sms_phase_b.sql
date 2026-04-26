-- Phase B additions to the SMS categorization schema.
--
-- batch_json — when present, the session represents a 3-pack rather than
-- a single transaction. Shape:
--   [
--     { "label": "A", "transaction_id": "...", "merchant": "...",
--       "amount": -42.13, "date": "2026-04-12",
--       "suggested_entity": "...", "suggested_category_tax": "...",
--       "suggested_category_budget": "...", "suggested_confidence": 0.7,
--       "suggested_method": "rule" },
--     { "label": "B", ... },
--     { "label": "C", ... }
--   ]
--
-- For backwards-compat the existing single-transaction columns
-- (sms_sessions.transaction_id, suggested_*) still hold the "A" item so
-- existing read paths see something sensible. Inbound logic treats a
-- session as a batch when batch_json IS NOT NULL.

ALTER TABLE sms_sessions ADD COLUMN batch_json TEXT;
