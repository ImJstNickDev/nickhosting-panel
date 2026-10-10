-- Owner policy and ordinary-user preference must never share an authority field.
ALTER TABLE gateway_server_states
  ADD COLUMN owner_idle_timeout_seconds integer NULL
    CHECK (owner_idle_timeout_seconds = -1 OR owner_idle_timeout_seconds BETWEEN 1 AND 604800),
  ADD COLUMN owner_idle_timeout_user_access text NULL
    CHECK (owner_idle_timeout_user_access IN ('hidden', 'editable', 'shorten-only'));

-- Existing explicit policies remain Owner policy, including legacy NULL=disabled.
UPDATE gateway_server_states
  SET owner_idle_timeout_seconds = COALESCE(idle_timeout_seconds, -1),
      idle_timeout_seconds = NULL,
      idle_timeout_inherited = true
  WHERE idle_timeout_inherited = false;
