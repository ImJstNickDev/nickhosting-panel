-- Server-scoped activity and durable logical-operation lookup. Metadata remains
-- private; the application exposes only its explicitly selected summary fields.
CREATE INDEX audit_events_server_activity
  ON audit_events ((metadata->>'serverId'), created_at DESC, id DESC)
  WHERE metadata ? 'serverId';
CREATE INDEX audit_events_server_operation
  ON audit_events ((metadata->>'serverId'), (metadata->>'operationId'), created_at DESC, id DESC)
  WHERE metadata ? 'serverId' AND metadata ? 'operationId';
-- The authenticated callback maps the provider login to its durable local owner.
CREATE INDEX external_sftp_credentials_activity_identity
  ON external_sftp_credentials ((provider_ref->>'instanceId'), (provider_ref->>'username'))
  WHERE provider_ref IS NOT NULL;
-- Bounded first/latest hydration for a logical operation, including legacy rows
-- without operationId. Both directions use the same index; no snapshot sort.
CREATE INDEX audit_events_activity_group_history
  ON audit_events (
    (metadata->>'serverId'),
    (coalesce(nullif(metadata->>'operationId',''), nullif(metadata->>'batchId',''), id::text)),
    (coalesce(actor_user_id, '')), (coalesce(subject_user_id, '')),
    created_at DESC,
    (case when metadata->>'outcome' = 'requested' or action in
      ('server.files.requested', 'server.console.command', 'server.backup.delete_requested',
       'server.upload.batch_prepared', 'server.upload.started') then 0 else 1 end) DESC,
    id DESC
  ) WHERE metadata ? 'serverId';
