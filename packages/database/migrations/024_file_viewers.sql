-- Private viewer accounts are separate from user-facing SFTP credentials.
CREATE TABLE viewer_sftp_credentials (
  id uuid PRIMARY KEY,
  server_id uuid NOT NULL REFERENCES managed_servers(id) ON DELETE RESTRICT,
  binding text NOT NULL,
  envelope jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'revoked', 'retired')),
  external_user_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX viewer_current_credential ON viewer_sftp_credentials(server_id,binding) WHERE status <> 'retired';
CREATE TABLE file_viewer_preferences (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('server','game','global')),
  scope_id text NOT NULL,
  extension text NOT NULL CHECK (length(extension) BETWEEN 1 AND 64),
  viewer_id text NOT NULL CHECK (length(viewer_id) BETWEEN 1 AND 128),
  PRIMARY KEY (user_id, scope, scope_id, extension)
);
