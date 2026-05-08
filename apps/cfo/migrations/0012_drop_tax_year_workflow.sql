-- Remove tax-year workflow ceremony. The CFO is now year-round; ingestion
-- (Teller sync, CSV/Amazon/Tiller imports, classification) no longer
-- requires an active tax year. Schedule C/E reports take an explicit year
-- query param instead of reading ambient state from these tables.
--
-- The `imports.tax_year` column is left in place (SQLite cannot drop columns
-- without recreating the table). It will be NULL for all new imports.

DROP TABLE IF EXISTS tax_year_checklist_items;
DROP TABLE IF EXISTS tax_year_workflows;
