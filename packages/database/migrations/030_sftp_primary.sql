-- Existing credentials remain auxiliary, preserving identity, password and expiry.
ALTER TABLE external_sftp_credentials
  ADD COLUMN kind text NOT NULL DEFAULT 'auxiliary' CHECK (kind IN ('primary', 'auxiliary')),
  ADD COLUMN label text CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80),
  ADD COLUMN primary_username text,
  ALTER COLUMN expires_at DROP NOT NULL;

ALTER TABLE external_sftp_credentials ADD CONSTRAINT sftp_credential_kind_fields CHECK (
  (kind = 'primary' AND expires_at IS NULL AND label IS NULL AND primary_username IS NOT NULL)
  OR (kind = 'auxiliary' AND expires_at IS NOT NULL AND primary_username IS NULL)
);

-- Reserve identity before any external write, including uncertain provider outcomes.
CREATE UNIQUE INDEX sftp_primary_actor_server ON external_sftp_credentials(actor_id, server_id)
  WHERE kind = 'primary' AND state <> 'revoked';
CREATE UNIQUE INDEX sftp_primary_username ON external_sftp_credentials(primary_username)
  WHERE kind = 'primary' AND state <> 'revoked';
CREATE INDEX sftp_actor_server ON external_sftp_credentials(actor_id, server_id);
