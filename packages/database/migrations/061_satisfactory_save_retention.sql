CREATE TABLE satisfactory_save_retention (
  server_id uuid NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
  session_name text NOT NULL CHECK (length(session_name) BETWEEN 1 AND 4096),
  keep_count integer NOT NULL CHECK (keep_count BETWEEN 1 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, session_name)
);

-- Only newly captured, content-addressed platform saves qualify for rotation.
-- Historical filenames and operation journals never authorize file deletion.
CREATE TABLE satisfactory_safety_saves (
  server_id uuid NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
  save_name text NOT NULL CHECK (save_name ~ '^nh-stop-[0-9a-f-]{36}$'),
  session_name text NOT NULL CHECK (length(session_name) BETWEEN 1 AND 4096),
  job_id uuid NOT NULL REFERENCES operation_jobs(id),
  path text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size > 0),
  modified_at text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (server_id, save_name)
);
CREATE INDEX satisfactory_safety_saves_rotation ON satisfactory_safety_saves
  (server_id, session_name, created_at DESC) WHERE deleted_at IS NULL;
