-- Reverse email enrichment ("discovery"): for un-enriched Teller
-- transactions, Gmail is searched for a matching email. email_search_at
-- records when that search ran so the nightly pass doesn't repeat it.

ALTER TABLE raw_transactions ADD COLUMN email_search_at TIMESTAMPTZ;
