-- Account/integration removal releases only their unconsumed wizard holds.
-- Consumed server claims have null wizard identity and remain protected.
ALTER TABLE dns_hostname_reservations
  DROP CONSTRAINT dns_hostname_reservations_wizard_user_id_fkey,
  DROP CONSTRAINT dns_hostname_reservations_wizard_game_id_fkey,
  ADD CONSTRAINT dns_hostname_reservations_wizard_user_id_fkey
    FOREIGN KEY(wizard_user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  ADD CONSTRAINT dns_hostname_reservations_wizard_game_id_fkey
    FOREIGN KEY(wizard_game_id) REFERENCES game_integrations(id) ON DELETE CASCADE;
