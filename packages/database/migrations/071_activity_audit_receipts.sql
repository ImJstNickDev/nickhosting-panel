-- Keep grouping and filtering off toasted historical payloads. The authoritative
-- first and latest snapshots are fetched from audit_events once the page is known.
CREATE TABLE activity_audit_receipts (
  audit_id text PRIMARY KEY REFERENCES audit_events(id) ON UPDATE CASCADE ON DELETE CASCADE,
  server_id uuid NOT NULL,
  group_id text NOT NULL,
  grouped boolean NOT NULL,
  actor_user_id text,
  subject_user_id text,
  created_at timestamptz NOT NULL,
  terminal_order integer NOT NULL,
  job_id uuid,
  action text NOT NULL,
  outcome text,
  source text,
  has_detail_action boolean NOT NULL,
  detail_action text
);
CREATE INDEX activity_audit_receipts_server ON activity_audit_receipts(server_id);

-- The old join compared the canonical UUID string, including case. Malformed
-- legacy references simply have no matching server/job.
CREATE FUNCTION activity_receipt_uuid(value text)
RETURNS uuid LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT (CASE WHEN value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN value END)::uuid
$$;

CREATE FUNCTION activity_receipt_fields(event audit_events)
RETURNS SETOF activity_audit_receipts LANGUAGE sql IMMUTABLE PARALLEL SAFE ROWS 1 AS $$
  SELECT event.id, server.id,
    coalesce(nullif(event.metadata->>'operationId',''),nullif(event.metadata->>'batchId',''),event.id),
    coalesce(nullif(event.metadata->>'operationId',''),nullif(event.metadata->>'batchId','')) IS NOT NULL,
    event.actor_user_id, event.subject_user_id, event.created_at,
    CASE WHEN event.metadata->>'outcome' = 'requested' OR event.action IN
      ('server.files.requested','server.console.command','server.backup.delete_requested',
       'server.upload.batch_prepared','server.upload.started') THEN 0 ELSE 1 END,
    activity_receipt_uuid(event.metadata->>'jobId'),
    event.action,event.metadata->>'outcome',event.metadata->>'source',event.metadata ? 'action',event.metadata->>'action'
  FROM (VALUES (activity_receipt_uuid(event.metadata->>'serverId'))) AS server(id)
  WHERE server.id IS NOT NULL
$$;

CREATE FUNCTION sync_activity_audit_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM activity_audit_receipts WHERE audit_id IN (OLD.id,NEW.id);
  END IF;
  INSERT INTO activity_audit_receipts SELECT * FROM activity_receipt_fields(NEW);
  RETURN NULL;
END
$$;
CREATE TRIGGER activity_receipt_insert AFTER INSERT ON audit_events FOR EACH ROW
  WHEN (NEW.metadata ? 'serverId') EXECUTE FUNCTION sync_activity_audit_receipt();
CREATE TRIGGER activity_receipt_update AFTER UPDATE ON audit_events FOR EACH ROW
  WHEN (OLD.metadata ? 'serverId' OR NEW.metadata ? 'serverId') EXECUTE FUNCTION sync_activity_audit_receipt();

INSERT INTO activity_audit_receipts
SELECT fields.* FROM audit_events event CROSS JOIN LATERAL activity_receipt_fields(event) fields
WHERE event.metadata ? 'serverId';
ANALYZE activity_audit_receipts;
