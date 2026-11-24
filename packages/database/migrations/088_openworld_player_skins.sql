CREATE TABLE openworld_player_skins (
    server_id uuid NOT NULL REFERENCES openworld_server_profiles(server_id) ON DELETE CASCADE,
    account_id text NOT NULL,
    binding text NOT NULL,
    skin_hash text NOT NULL CHECK (skin_hash ~ '^[0-9a-f]{8}$'),
    observed_at timestamptz NOT NULL,
    head_png bytea NOT NULL CHECK (octet_length(head_png) BETWEEN 45 AND 524288),
    body_png bytea NOT NULL CHECK (octet_length(body_png) BETWEEN 45 AND 524288),
    PRIMARY KEY (server_id, account_id)
);
