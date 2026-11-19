ALTER TABLE step_up_grants
  ADD COLUMN purpose text NOT NULL DEFAULT 'support' CHECK (purpose IN ('support', 'recovery-link')),
  ADD COLUMN subject_user_id text,
  ADD CHECK (purpose <> 'recovery-link' OR subject_user_id IS NOT NULL);

-- Better Auth consumes and deletes this same row during a successful reset.
-- The recoverable token disappears with its verification or credential account.
ALTER TABLE verification
  ADD COLUMN owner_recovery_account_id text REFERENCES account(id) ON DELETE CASCADE,
  ADD COLUMN owner_recovery_ciphertext jsonb,
  ADD CHECK ((owner_recovery_account_id IS NULL) = (owner_recovery_ciphertext IS NULL));
CREATE UNIQUE INDEX verification_owner_recovery_account ON verification(owner_recovery_account_id)
  WHERE owner_recovery_account_id IS NOT NULL;

-- A later credential change supersedes any outstanding Owner-issued link.
CREATE FUNCTION invalidate_owner_password_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM verification WHERE owner_recovery_account_id = NEW.id;
  RETURN NEW;
END
$$;
CREATE TRIGGER invalidate_owner_password_recovery
  AFTER UPDATE OF password ON account FOR EACH ROW
  WHEN (OLD.password IS DISTINCT FROM NEW.password)
  EXECUTE FUNCTION invalidate_owner_password_recovery();
