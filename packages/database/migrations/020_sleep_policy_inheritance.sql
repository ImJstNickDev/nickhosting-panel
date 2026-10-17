-- Preserve every legacy explicit timeout, including NULL (automatic sleep disabled).
-- New policies opt into game/runtime defaults without changing wake authorization.
ALTER TABLE gateway_server_states
  ADD COLUMN idle_timeout_inherited boolean NOT NULL DEFAULT false;
