-- Existing hash-only invitations remain valid for redemption. Their original
-- tokens cannot be recovered, so only newly created invitations are revealable.
ALTER TABLE invitation ADD COLUMN "tokenCiphertext" jsonb;
