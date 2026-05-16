-- eBay email enrichment: allow 'email_ebay' as a raw_transactions.source.
-- eBay orders are single-item, so there is no splitting — enrichment only
-- rewrites the description to the item name and matches the order total.

ALTER TABLE raw_transactions DROP CONSTRAINT raw_transactions_source_check;
ALTER TABLE raw_transactions ADD CONSTRAINT raw_transactions_source_check
  CHECK (source IN ('teller', 'email_amazon', 'email_venmo', 'email_apple', 'email_etsy', 'email_ebay', 'chrome_extension', 'manual'));
