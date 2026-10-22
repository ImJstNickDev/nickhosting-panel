-- Direct, additive server access. Existing project membership behavior is unchanged.
CREATE TABLE server_subusers (
  server_id uuid NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  permission_keys jsonb NOT NULL CHECK (jsonb_typeof(permission_keys) = 'array' AND jsonb_array_length(permission_keys) BETWEEN 1 AND 256),
  created_by text NOT NULL REFERENCES "user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX server_subusers_user_id ON server_subusers(user_id, server_id);
