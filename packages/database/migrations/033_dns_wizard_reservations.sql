-- Temporary per-account wizard holds reuse the authoritative hostname registry.
ALTER TABLE dns_hostname_reservations
  ADD COLUMN wizard_user_id text REFERENCES "user"(id),
  ADD COLUMN wizard_game_id text REFERENCES game_integrations(id),
  ADD COLUMN wizard_domain_id text,
  ADD COLUMN wizard_subdomain text,
  ADD CONSTRAINT dns_wizard_reservation_complete CHECK (
    (wizard_user_id IS NULL AND wizard_game_id IS NULL AND wizard_domain_id IS NULL AND wizard_subdomain IS NULL)
    OR (wizard_user_id IS NOT NULL AND wizard_game_id IS NOT NULL AND wizard_domain_id IS NOT NULL AND wizard_subdomain IS NOT NULL AND release_after IS NOT NULL)
  );
CREATE INDEX dns_wizard_user_expiry ON dns_hostname_reservations(wizard_user_id,release_after)
  WHERE wizard_user_id IS NOT NULL;
