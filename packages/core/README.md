# Core foundation

`resolveConfig(ownerSettings, env)` validates a strict nonsecret configuration object, then applies compiled defaults, Owner database settings and explicitly present environment overrides. Empty overrides are errors; `undefined` means absent. `sources` and `lockedKeys` let the future Owner UI explain environment locks. Call `assertConfigWritable` before accepting a settings patch and validate the resulting complete settings again. Public URLs have no instance defaults; API startup must call `assertPublicUrls`.

`parseSecretEnvironment` is separate from ordinary settings. It requires a session secret of at least 32 characters and a canonical base64 encoding of a 32-byte encryption key. An empty database additionally requires `requireSetupToken: true`; after setup the token can be removed. Optional credentials are required by their enabled integration, not by unrelated startup paths.

`SecretCodec` encrypts using AES-256-GCM, a random 96-bit nonce and authenticated version, key ID and caller-provided record context. Bind context to the stable secret record name/ID and use the same context on retrieval. Swapping ciphertext between records fails authentication. The codec accepts multiple explicitly supplied keys for rotation and encrypts with the active key. Keep old keys available until records have been re-encrypted and verified. Store only the envelope in the protected database table; never return it from public settings endpoints.

Build `AuthContext` from verified session and authoritative database records. Ordinary sessions must have equal actor/subject IDs and no Owner elevation. Support sessions require a real Owner actor, separate subject, reason, active record, idle timeout and absolute timeout. Resource ownership/membership must also come from trusted records. Permission checks do not grant quota overrides or replace audit writes: persist both actor and subject for every audited action.

Structured `DomainError` responses expose only a stable code/message key/status. Translate them through `@nickhosting/i18n`. Diagnostic details stay server-side. `createLogger` requires fixed event identifiers and recursively redacts sensitive structured fields, known credential formats and credential URLs. Redaction is defense in depth: never log whole request bodies, OAuth callbacks, mail contents or credentials under arbitrary metadata keys.

Run the package tests from the repository root:

```sh
scripts/dev.sh pnpm test -- packages/core
```
