CREATE TABLE openworld_player_directories (
    server_id uuid PRIMARY KEY REFERENCES openworld_server_profiles(server_id) ON DELETE CASCADE,
    binding text NOT NULL,
    indexed_at timestamptz NOT NULL,
    indexing boolean NOT NULL
);
CREATE TABLE openworld_saved_players (
    server_id uuid NOT NULL REFERENCES openworld_player_directories(server_id) ON DELETE CASCADE,
    file_stem text NOT NULL,
    revision text NOT NULL,
    account_id text,
    display_name text,
    saved_at timestamptz,
    PRIMARY KEY (server_id, file_stem)
);
CREATE INDEX openworld_saved_players_order
    ON openworld_saved_players (server_id, account_id, saved_at DESC NULLS LAST, file_stem)
    WHERE account_id IS NOT NULL;
