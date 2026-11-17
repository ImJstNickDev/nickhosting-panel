-- Native session names can exceed a B-tree tuple's byte limit. Keep the full
-- name as data and index its fixed-size SHA-256 identity, checked by PostgreSQL.
ALTER TABLE satisfactory_save_retention ADD COLUMN session_key text;
UPDATE satisfactory_save_retention
SET session_key = encode(sha256(convert_to(session_name, 'UTF8')), 'hex');
ALTER TABLE satisfactory_save_retention
  ALTER COLUMN session_key SET NOT NULL,
  ADD CONSTRAINT satisfactory_save_retention_session_key_check
    CHECK (session_key = encode(sha256(convert_to(session_name, 'UTF8')), 'hex')),
  DROP CONSTRAINT satisfactory_save_retention_pkey,
  ADD PRIMARY KEY (server_id, session_key);

-- Rotation reads all receipts for one server in recovery order; the native name
-- need not be an indexed attribute and can remain an arbitrarily encoded label.
DROP INDEX satisfactory_safety_saves_rotation;
CREATE INDEX satisfactory_safety_saves_rotation ON satisfactory_safety_saves
  (server_id, created_at DESC, save_name DESC) WHERE deleted_at IS NULL;
