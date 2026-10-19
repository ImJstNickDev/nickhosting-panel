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

NickHosting currently uploads directly to the final filename and recognizes a
particular multipart-parse HTTP 400 as evidence that nothing was written. That
assumption cannot be carried forward: cancelling an overwrite can truncate/remove
the previous destination; multi-part failures can also occur after earlier parts
were written. Even fresh-file cancellation can follow a different error path.

Adapt transfer publication/cancellation semantics before activation. Tests must
prove that cancelling or disconnecting an overwrite preserves the previous file,
new partial files are handled deliberately, completed parts are not blindly
replayed, and successful uploads retain existing behavior. This is not solved by
changing an error label. Sources:
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
  revocation. Prepared URL pools need deliberate invalidation/reissuance on
  confirmed pre-effect authentication rejection. Never blindly retry a write
  after an uncertain response. Exercise this across a Wings restart.
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

Evidence is a comparison of exact official tagged source archives with local
adapter callers, validators and parsers, plus a read-only inspection of current
cached rate-limit settings. No target application was run and no production API
mutation, game operation, image update or restart occurred.

Old mock tests passing would not prove target compatibility. Before activation,
test the actual new PHP dependencies/signers, Wings streaming cancellation and
overwrite behavior, WebSocket limits/events, credential/resource cooldowns,
prepared-URL revocation, and the representative server/file/backup journeys.
Then run the approved bounded live smoke tests under the coordinated rollback
plan. Unchanged source contracts are useful evidence, not an end-to-end guarantee.
