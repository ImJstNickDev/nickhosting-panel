SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

CREATE INDEX server_events_initial_start_denials ON server_events(server_id, id DESC)
WHERE message_key = 'servers.operation.initial_start_denied';
