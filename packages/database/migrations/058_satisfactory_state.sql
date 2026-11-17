-- Durable protocol observations survive Gateway/worker restarts; TLS identity uses
-- the existing encrypted_secrets store and is bound to the managed server UUID.
CREATE TABLE satisfactory_server_state (
  server_id uuid PRIMARY KEY REFERENCES managed_servers(id) ON DELETE CASCADE,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE server_operations DROP CONSTRAINT server_operations_action_check;
ALTER TABLE server_operations ADD CONSTRAINT server_operations_action_check
  CHECK (action IN ('provision','start','stop','restart','reinstall','wipe','delete','backup','restore','configure','minecraft-content','satisfactory-content'));
