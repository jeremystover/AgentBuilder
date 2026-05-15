-- Expense flagging for CFO review workflow. Allows marking a transaction
-- as one to cut from the budget or as a one-time expense, for future
-- analysis without affecting the approval/ledger flow.

ALTER TABLE raw_transactions
  ADD COLUMN expense_flag TEXT CHECK (expense_flag IN ('cut', 'one_time'));

ALTER TABLE transactions
  ADD COLUMN expense_flag TEXT CHECK (expense_flag IN ('cut', 'one_time'));
