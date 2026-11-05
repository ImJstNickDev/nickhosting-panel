CREATE TABLE satisfactory_mod_states (
  server_id uuid PRIMARY KEY REFERENCES managed_servers(id) ON DELETE CASCADE,
  selection jsonb NOT NULL DEFAULT '[]'::jsonb,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  lock jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
