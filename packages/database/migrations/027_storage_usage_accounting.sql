-- A present null budget explicitly follows the current default, independently
-- of legacy compute overrides. No existing positive exception is changed.
ALTER TABLE storage_user_budgets ALTER COLUMN storage_mib DROP NOT NULL;

-- Occupied backups can outlive large live files. Unknown observations stay null.
ALTER TABLE server_metrics ADD COLUMN backup_bytes bigint CHECK (backup_bytes >= 0);
