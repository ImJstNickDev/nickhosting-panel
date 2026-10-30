-- Existing sources retain their full-hash verification fallback until re-uploaded.
-- A seal binds a private immutable source file to its verified content and scope.
ALTER TABLE minecraft_sources ADD COLUMN source_seal jsonb;
ALTER TABLE minecraft_sources ADD CONSTRAINT minecraft_sources_seal_object
  CHECK (source_seal IS NULL OR jsonb_typeof(source_seal) = 'object');
