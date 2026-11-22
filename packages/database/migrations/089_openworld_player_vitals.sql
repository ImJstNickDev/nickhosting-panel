CREATE TABLE openworld_player_vitals (
    server_id uuid NOT NULL REFERENCES openworld_server_profiles(server_id) ON DELETE CASCADE,
    account_id uuid NOT NULL,
    binding text NOT NULL,
    observed_at timestamptz NOT NULL,
    vitals jsonb NOT NULL CHECK (jsonb_typeof(vitals) = 'object'),
    PRIMARY KEY (server_id, account_id)
);
