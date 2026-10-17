-- Existing creator_id held the most recent authorizer. Preserve that identity;
-- creation history before this migration is not reconstructed or invented.
ALTER TABLE server_schedules ADD COLUMN authorizer_id text REFERENCES "user"(id);
UPDATE server_schedules SET authorizer_id = creator_id;
ALTER TABLE server_schedules ALTER COLUMN authorizer_id SET NOT NULL;

ALTER TABLE schedule_occurrences ADD COLUMN trigger text NOT NULL DEFAULT 'scheduled'
  CHECK (trigger IN ('scheduled', 'manual'));
ALTER TABLE schedule_occurrences ADD COLUMN request_key text;
ALTER TABLE schedule_occurrences ADD COLUMN requester_id text REFERENCES "user"(id);
ALTER TABLE schedule_occurrences DROP CONSTRAINT schedule_occurrences_schedule_id_revision_due_at_key;
CREATE UNIQUE INDEX schedule_occurrences_due_identity ON schedule_occurrences(schedule_id, revision, due_at)
  WHERE trigger = 'scheduled';
CREATE UNIQUE INDEX schedule_occurrences_manual_identity ON schedule_occurrences(schedule_id, requester_id, request_key)
  WHERE trigger = 'manual';
ALTER TABLE schedule_occurrences ADD CONSTRAINT schedule_occurrences_request_identity CHECK (
  (trigger = 'scheduled' AND request_key IS NULL AND requester_id IS NULL) OR
  (trigger = 'manual' AND request_key IS NOT NULL AND requester_id IS NOT NULL)
);
