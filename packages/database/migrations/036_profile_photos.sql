-- Local profile photos are independent from identity-provider account images.
CREATE TABLE user_profile_photos (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 307200),
  revision text NOT NULL CHECK (revision ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
