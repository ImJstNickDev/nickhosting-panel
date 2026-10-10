-- Existing mappings retain their exact static image and evidence identity.
ALTER TABLE runtime_egg_mappings ADD COLUMN image_mode text NOT NULL DEFAULT 'static' CHECK (image_mode IN ('static', 'integration'));
ALTER TABLE runtime_egg_mappings ADD CONSTRAINT runtime_image_mode_value CHECK ((image_mode = 'static' AND length(docker_image) > 0) OR (image_mode = 'integration' AND docker_image = ''));
