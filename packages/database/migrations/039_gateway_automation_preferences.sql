-- Preferences are independent of the operational Gateway/sleep switch. Existing
-- rows inherit the current globally enabled wake behavior without changing intent.
ALTER TABLE gateway_server_states
  ADD COLUMN auto_wake_override boolean,
  ADD COLUMN owner_auto_wake_override boolean,
  ADD COLUMN owner_auto_wake_user_access text
    CHECK (owner_auto_wake_user_access IN ('hidden', 'editable', 'disable-only')),
  ADD COLUMN gateway_messages jsonb NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(gateway_messages) = 'object');
