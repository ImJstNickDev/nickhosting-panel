-- Usernames are stable login/connection identifiers; name remains the display name.
ALTER TABLE "user" ADD COLUMN username text;
-- Assign existing accounts deterministic, unique handles without deriving them from names.
WITH handles AS (
  SELECT id, 'user_' || row_number() OVER (ORDER BY id)::text AS username FROM "user"
)
UPDATE "user" SET username=handles.username FROM handles WHERE "user".id=handles.id;
ALTER TABLE "user"
  ALTER COLUMN username SET DEFAULT ('user_' || replace(gen_random_uuid()::text, '-', '')),
  ALTER COLUMN username SET NOT NULL,
  ADD CONSTRAINT identity_username_format CHECK (username ~ '^[a-z0-9][a-z0-9_-]{2,39}$'),
  ADD CONSTRAINT identity_username_unique UNIQUE (username);
