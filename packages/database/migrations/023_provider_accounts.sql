-- Enrollment is committed atomically with invitation registration, without external I/O.
CREATE TABLE provider_accounts (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE RESTRICT,
  instance_id uuid REFERENCES provider_change_feeds(instance_id) ON DELETE RESTRICT,
  provider_url text,
  provider_id integer,
  provider_uuid uuid,
  external_id text,
  key_operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  key_identifier text,
  key_envelope jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','provisioning','ready','failed')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  retry_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_url, provider_id),
  UNIQUE(provider_url, provider_uuid),
  CHECK ((instance_id IS NULL) = (provider_url IS NULL)),
  CHECK (status <> 'ready' OR (provider_id IS NOT NULL AND provider_uuid IS NOT NULL AND external_id IS NOT NULL AND key_identifier IS NOT NULL AND key_envelope IS NOT NULL))
);
CREATE FUNCTION enqueue_provider_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO provider_accounts(user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER user_provider_account AFTER INSERT ON "user" FOR EACH ROW EXECUTE FUNCTION enqueue_provider_account();
INSERT INTO provider_accounts(user_id) SELECT id FROM "user" ON CONFLICT DO NOTHING;
-- Existing servers remain assigned to their original provider user. No remote reassignment.
ALTER TABLE managed_servers ADD COLUMN provider_user_id integer;
UPDATE managed_servers s SET provider_user_id = n.provision_user_id FROM managed_nodes n WHERE s.node_id = n.id;
