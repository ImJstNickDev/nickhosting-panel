-- Zero is an explicit unlimited personal budget; null still follows the default.
-- The platform default remains positive and existing budgets are unchanged.
ALTER TABLE storage_user_budgets
  DROP CONSTRAINT storage_user_budgets_storage_mib_check;
ALTER TABLE storage_user_budgets
  ADD CONSTRAINT storage_user_budgets_storage_mib_check
  CHECK (storage_mib >= 0 AND storage_mib <= 1073741824);
