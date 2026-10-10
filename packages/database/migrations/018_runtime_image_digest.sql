ALTER TABLE minecraft_server_profiles
  ADD COLUMN runtime_image_digest text
  CHECK (runtime_image_digest IS NULL OR runtime_image_digest ~ '^sha256:[a-f0-9]{64}$');
