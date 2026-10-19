# Provider API compatibility assessment

Read-only source comparison, 2026-10-19: Panel **1.11.11 → 1.15.1**, Wings
**1.11.13 → 1.13.4**, and the actual NickHosting adapter/consumers. Complements
[upgrade readiness](PROVIDER-UPGRADE-READINESS.md) and
[issue #27](https://github.com/ImJstNickDev/nickhosting-panel/issues/27).

**Conclusion:** most consumed REST paths, request bodies and response shapes are
compatible, but observable behavior is not unchanged. Do not approve deployment
based only on endpoint/schema similarity. Required fixes extend beyond the
NickHosting Blueprint extension to uploads, console and rate-limit coordination.

## Boundaries and stable contracts

The browser uses NickHosting `/v1` and Better Auth `/api/auth` endpoints. Provider
credentials, signed URLs and protocol adaptation stay in the backend. The
upstream upgrade does not itself require replacing those public NickHosting APIs,
changing authentication, or rewriting the frontend.

Coverage: **16 Application and 24 native Client method/path combinations** used
or exposed by the adapter remain present with unchanged methods/paths. All 15
corresponding Application request-validator classes are byte-identical. Of seven
Application response transformers, six are byte-identical and the server
transformer adds only `container.skip_scripts`. This counts native routes, not
the extension's separate endpoints.

| Consumed area | Tagged-source assessment |
| --- | --- |
| Application node/nest/egg/allocation/user discovery | Consumed routes and response transformers retained. |
| Application server lookup, external identity, creation, details/build/startup, deletion | Consumed methods/paths retained; existing parsed response fields retained. New `container.skip_scripts` is additive. Behavioral exceptions are listed below. |
| Client server details, permissions and REST resources | Existing consumed fields retained. REST resources still use a 20-second cache; keep the existing live Wings stream for timely observations. |
| Client file listing/read/write/mkdir/rename/delete/extract | Native request contracts retained. Native signed-token generation changes internally; extension-issued tokens and Wings upload semantics need changes below. |
| Client backup list/create/download/delete/lock/restore and Activity | Core shapes retained; restore validation and resource throttling changed. |
| Wings WebSocket status/stats/console/install events | Existing consumed names and state/resource shapes retained; new input limits, throttling and revocation semantics matter. |
| API credentials and errors | Existing Application/Client bearer-key separation and ACL approach retained. NickHosting transport consumes HTTP status rather than depending on provider error text, except for the problematic upload cancellation special case. |

## Changes requiring adaptation or explicit validation

### Scoped JWTs: definite incompatibility

Target Panel `NodeJWTService` requires explicit scopes. The current extension
does not supply them in three controllers: bulk upload, bulk download and
installation WebSocket. Set the appropriate `FileUpload`, `FileDownload` and
`Websocket` scopes using the native service. Preserve existing path, identity,
expiry and restricted installation permissions. Test both Panel generations if
one extension release must support both; unconditional modern enum/method calls
are not backward compatible.

The native new Panel supplies scopes for its own endpoints. Updating Wings alone
with the old Panel remains incompatible. See the target
[signer](https://github.com/pterodactyl/panel/blob/v1.15.1/app/Services/Nodes/NodeJWTService.php)
and [scope enum](https://github.com/pterodactyl/panel/blob/v1.15.1/app/Enum/JwtScope.php).

### Upload cancellation/replacement: definite semantic incompatibility

Old Wings parses the multipart request before writing uploaded files. New Wings
streams parts into the filesystem. Its `WriteFrom` opens the destination with
truncation and removes that path on a failed stream.

The previous adapter uploaded directly to the final filename and treated a
particular multipart-parse HTTP 400 as evidence that nothing was written. The
upgrade adaptation removes that assumption. Every streamed or bounded text write
now uses a unique sibling `.nh-upload-<operation UUID>.pending`. Publication starts
only after the complete upload and final authorization; cancellation before that
point never truncates the requested destination. Browser cancellation closes a
valid shortened multipart body, waits for Wings to acknowledge its isolated
staging write, then deletes that exact stage before releasing the claim. This
works with both buffered and streamed Wings implementations. Token rejection
also permits scoped cleanup. Lost responses and HTTP 5xx/timeout responses remain
uncertain: a proxy failure must not race a potentially still-running writer with
cleanup.

**Native Wings rename refuses existing destinations in both tested versions.**
The adapter uses native rename for new paths and the extension's existing durable
file-operation ledger for replacements: record intent and recovery paths, rename the previous file
to `.nh-upload-<UUID>.previous`, publish the stage, verify both sides, confirm,
then clean the backup. This is not an atomic replacement across the two renames.
An interrupted/uncertain publication preserves recoverable files and is never
blindly replayed. A confirmed publication whose cleanup fails may leave its backup.
There is no fallback to an unsafe direct overwrite. Additive extension migration
`000006` adds nullable `recovery_context` to that existing ledger, preserving old
receipts. Source/destination/backup paths and the pre-rename metadata observations
remain available after process failure; keep this column on code rollback.

Permission metadata is read once per parent directory during preparation, reusing
an existing caller preflight when available. Prepared text grants carry the same
metadata. Staged replacements retain the original mode. Restrictive modes such as
`0600` require an empty native write and chmod **before** streaming sensitive bytes;
other nondefault modes such as `0755` require chmod before publication. Ordinary
new files remain `0644`. This adds one publication request after upload; existing
file replacement performs two bounded directory reads, two renames and backup
deletion inside the extension. Staging also needs room for old and new content
simultaneously: a full disk may reject a replacement that in-place truncation
would previously have accepted. Sources:
[upload handler](https://github.com/pterodactyl/wings/blob/v1.13.4/router/router_server_files.go),
[filesystem writer](https://github.com/pterodactyl/wings/blob/v1.13.4/server/filesystem/filesystem.go).

### WebSocket input and throttling

New Wings bounds incoming encoded WebSocket messages and throttles events. The
current relay allows commands up to 4,096 characters, whereas the new wire limit
is 4,096 bytes for the entire encoded message; UTF-8 and JSON overhead matter.
It also ignores the new `throttled` event and resolves a send after local socket
dispatch, so a dropped command can look accepted.

Validate encoded size, handle throttling explicitly and avoid automatically
replaying commands with uncertain effects. Cover command bursts, stats/log
requests, reconnects, token refresh and concurrent API/worker/Gateway observers.
The new per-server connection cap also needs a concurrency check. Sources:
[WebSocket transport](https://github.com/pterodactyl/wings/tree/v1.13.4/router/websocket).

### HTTP rate limits and cooldown scope

Target defaults change from **720 to 256 Client requests/minute**, and **240 to
256 Application requests/minute**. Existing environment overrides still apply.
The inspected running Panel uses 720/240. Preserve or deliberately select the
effective policy during migration; do not assume the old defaults survive.

New native WebSocket token issuance allows **5 requests/minute per server**,
shared across users. Backup restore allows **3 requests/15 minutes per server**.
These resource limits are separate from the general API quota.

NickHosting currently applies every HTTP 429 cooldown across the credential's
whole API scope. A resource-specific throttle could therefore pause unrelated
file/server operations for the same account. Adapt resource/global coordination
and test recovery without weakening the upstream limits. Sources:
[HTTP defaults](https://github.com/pterodactyl/panel/blob/v1.15.1/config/http.php),
[resource limits](https://github.com/pterodactyl/panel/blob/v1.15.1/app/Enum/ResourceLimit.php),
[route bindings](https://github.com/pterodactyl/panel/blob/v1.15.1/routes/api-client.php).

### Prepared URLs, optional identifiers and operation eligibility

- New Wings can reject signed transfer URLs issued before its startup or user
  revocation. Prepared download pools now invalidate and reissue once after a
  401/403/404 response before exposing bytes to their consumer. Arbitrary streaming
  writes are never replayed. A bounded in-memory text write may use one staged
  native fallback only after a cached-token rejection and confirmed cleanup;
  publication failures or lost responses never select that fallback. Test fixtures
  exercise revoked grants; a live restart smoke test remains separate evidence.
- Keep the new `PTERODACTYL_USE_SERVER_IDENTIFIERS` feature disabled unless a
  separate identifier migration is designed. It defaults off; enabling it changes
  Client `identifier` behavior and could invalidate stored provider identities.
- Reinstall now rejects a healthy server configured to skip egg installation
  scripts. Installation/reinstallation failure states remain eligible. Normal
  NickHosting creation uses the native default with scripts enabled, but externally
  changed/imported cases need eligibility/error coverage.
- Backup restore rejects failed or incomplete backups more strictly. NickHosting
  already checks success and completion; retain that behavior and test its new
  throttle. New backup exclusions have byte, pattern-count and wildcard limits
  (32 KiB, 256 patterns, 16 wildcards per pattern). NickHosting's existing string
  length limit alone does not enforce all three. Align validation and cover
  `.pteroignore` as well as request-supplied exclusions. S3 restore URLs now have
  stricter destination checks; verify private endpoints only if actually used.
  Native `files/pull` is not used by the inspected NickHosting content pipeline,
  so its new restrictions do not justify adding an allowlist to that pipeline.
- The implemented backup preflight reads `.pteroignore` once when exclusions are
  omitted, validates its byte/pattern/wildcard limits, and sends that snapshot
  explicitly. Empty/absent files use a comment-only exclusion string so Wings
  cannot reread a subsequently changed file. Non-404 read failures block creation.
  This requires `file.read-content` as well as `backup.create`; NickHosting's
  technical owners have both, but a future backup-only provider subuser does not.
- Provider owner transfer now queues SFTP access revocation instead of completing
  it synchronously. Do not treat the details PATCH response as proof that every
  old provider SFTP session was already closed. This does not replace NickHosting's
  independent SFTPGo controls or resolve issue #18.
- Server deletion clears allocation notes. Include relevant provider data changes
  in the upgrade acceptance rather than treating the response schema as the entire
  contract.
- Eggs inheriting an install script now inherit the parent's entrypoint/container
  even if local values are non-null. Verify the effective installer for mapped
  inherited eggs; unchanged JSON field names do not prove unchanged installation
  behavior. See the target
  [Egg model](https://github.com/pterodactyl/panel/blob/v1.15.1/app/Models/Egg.php).

An unrelated pre-existing adapter gap was also found: `updateStartup` makes
`skip_scripts` optional, while both old and new native request validators require
it. Omitting it can produce 422 on either version. Record it separately from
upgrade regressions; no direct product caller was identified in this audit.

## Evidence and remaining work

The initial assessment compared exact official tagged source archives with local
adapter callers, validators and parsers, plus read-only inspection of cached
rate-limit settings. That initial audit did not run the target application or
mutate production. Subsequent isolated adaptation evidence is recorded below;
live upgrade/deployment evidence belongs to the separate upgrade report.

Old mock tests passing would not prove target compatibility. Before activation,
test the actual new PHP dependencies/signers, Wings streaming cancellation and
overwrite behavior, WebSocket limits/events, credential/resource cooldowns,
prepared-URL revocation, and the representative server/file/backup journeys.
Then run the approved bounded live smoke tests under the coordinated rollback
plan. Unchanged source contracts are useful evidence, not an end-to-end guarantee.


### Transfer adaptation evidence

Focused adapter tests cover replacement/new-file publication, cancellation,
permission preservation, uncertain receipts, scoped cleanup, one-use grants and
read-only refresh. Isolated PostgreSQL integration tests cover upload admission
and batch claims, including release after proven pre-publication rejection (34
passing checks). They use the existing test services and fresh isolated schemas;
they do not touch dev application state or historical schemas.

An isolated container compiled the actual Wings **1.13.4** filesystem package and
ran three added test-only cases. These demonstrated native `WriteFrom` truncation
and removal on interrupted overwrite, preservation of the original when staging,
valid shortened multipart cancellation followed by scoped cleanup, retention of
`0600` applied before streaming, refusal of rename-overwrite, successful
backup-then-publication, and recursive creation owned by UID/GID 988. The container
had only the private downloaded source/test-cache mount, no Docker socket, game
volumes or published ports. These tests do not establish live provider behavior
or make the two-rename replacement atomic.
