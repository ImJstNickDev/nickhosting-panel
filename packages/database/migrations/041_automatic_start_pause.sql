-- Automatic-start consent is independent from the runtime/idle-sleep lifecycle.
ALTER TABLE managed_servers
  ADD COLUMN automatic_starts_paused boolean NOT NULL DEFAULT false;

-- Preserve explicit revocations made by the old consent endpoint only when its
-- latest audit still agrees with the manual-stop intent. Do not repair runtime,
-- readiness, Gateway generations, jobs, or reservations during migration.
UPDATE managed_servers AS server
SET automatic_starts_paused = true
FROM (
  SELECT DISTINCT ON (metadata->>'serverId')
    metadata->>'serverId' AS server_id, metadata->'allowed' AS allowed, created_at
  FROM audit_events
  WHERE action = 'server.automation_consent.updated'
  ORDER BY metadata->>'serverId', created_at DESC, id DESC
) AS consent
WHERE server.id::text = consent.server_id
  AND server.intent = 'manually_stopped'
  AND consent.allowed = 'false'::jsonb
  -- UUID order cannot establish consent order for tied timestamps. Do not infer
  -- an explicit pause when a tied grant contradicts the selected revocation.
  AND NOT EXISTS (
    SELECT 1 FROM audit_events AS conflicting
    WHERE conflicting.action = 'server.automation_consent.updated'
      AND conflicting.metadata->>'serverId' = consent.server_id
      AND conflicting.created_at = consent.created_at
      AND conflicting.metadata->'allowed' = 'true'::jsonb
  );
