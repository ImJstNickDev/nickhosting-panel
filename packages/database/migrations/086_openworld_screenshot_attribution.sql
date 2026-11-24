CREATE TABLE openworld_capture_cursors (
    server_id uuid PRIMARY KEY REFERENCES openworld_server_profiles(server_id) ON DELETE CASCADE,
    next_scan_at timestamptz NOT NULL,
    lease uuid NOT NULL,
    binding text,
    process_ref text,
    evidence jsonb
);
CREATE INDEX openworld_capture_due ON openworld_capture_cursors (next_scan_at, server_id);

CREATE TABLE openworld_capture_owners (
    server_id uuid NOT NULL REFERENCES openworld_server_profiles(server_id) ON DELETE CASCADE,
    binding text NOT NULL,
    file_name text NOT NULL,
    file_bytes bigint NOT NULL,
    mtime_ms bigint NOT NULL,
    process_ref text NOT NULL,
    account_id uuid,
    connection_id bigint NOT NULL,
    request_id bigint NOT NULL,
    requested_seq bigint NOT NULL,
    written_seq bigint NOT NULL,
    PRIMARY KEY (server_id, binding, file_name, file_bytes, mtime_ms)
);
CREATE INDEX openworld_capture_profile ON openworld_capture_owners (server_id, binding, account_id)
    WHERE account_id IS NOT NULL;
