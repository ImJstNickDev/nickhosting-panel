-- Native provider outcomes are separate from advisory resource-limit revisions.
ALTER TABLE provider_change_feeds ADD COLUMN backup_events boolean NOT NULL DEFAULT false;
ALTER TABLE provider_change_feeds ADD COLUMN capabilities_checked_at timestamptz;
CREATE TABLE provider_backup_events (
  event_id uuid PRIMARY KEY,
  instance_id uuid NOT NULL REFERENCES provider_change_feeds(instance_id),
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  backup_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('backup.completed', 'backup.restore-completed')),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_backup_completion ON provider_backup_events(server_id, backup_id, type, occurred_at DESC);
CREATE TABLE backup_labels (
  server_id uuid NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
  backup_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 191),
  PRIMARY KEY (server_id, backup_id)
);
ALTER TABLE server_schedules ADD COLUMN backup_options jsonb NOT NULL DEFAULT '{}';

-- Commit-only hints. No file contents, identities or credentials leave the database.
CREATE FUNCTION notify_backup_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE server_ref uuid;
BEGIN
  IF TG_TABLE_NAME = 'provider_backup_events' THEN
    server_ref := NEW.server_id;
  ELSE
    SELECT server_id INTO server_ref FROM server_operations
      WHERE job_id = NEW.id AND action IN ('backup', 'restore');
  END IF;
  IF server_ref IS NOT NULL THEN
    PERFORM pg_notify('nh_backups_' || md5(current_database() || ':' || current_schema()), server_ref::text);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER backup_event_notification AFTER INSERT ON provider_backup_events
  FOR EACH ROW EXECUTE FUNCTION notify_backup_change();
CREATE TRIGGER backup_job_notification AFTER UPDATE OF state, error_code, completed_at ON operation_jobs
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.error_code IS DISTINCT FROM NEW.error_code OR OLD.completed_at IS DISTINCT FROM NEW.completed_at)
  EXECUTE FUNCTION notify_backup_change();
