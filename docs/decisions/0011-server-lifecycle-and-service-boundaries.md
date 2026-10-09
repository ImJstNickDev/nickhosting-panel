# ADR 0011 — M2 lifecycle, admission and external service boundaries

**Status:** M2 implementation under review; narrow SFTPGo exception accepted by
the Owner for M2 only. Completion evidence is tracked in
[M2 validation](../M2-VALIDATION.md).

## Decision

Keep the Pterodactyl adapter as the only provider boundary. NickHosting UUIDs,
explicit mappings and a managed-server registry determine every target. The
Application API handles discovery/provisioning/build changes; the Client API
handles power, files, console, telemetry and backups. Privileged keys, signed
download URLs and WebSocket tokens remain on the backend. Independent direct
Pterodactyl servers are neither imported nor mutated by reconciliation.

Provision through explicitly selected free allocations and stable external IDs,
with `start_on_completion=false`. Automatic deployment's configured-capacity
selector is unsuitable for the installation's intentional stopped-server
over-allocation. Installed-source investigation and safe test-owned live evidence
are required before accepting this path; repository code alone is not proof of
capacity compatibility. Do not change Panel/Wings capacity or over-allocation
settings. Serialize NickHosting allocation claims, refresh inventory before a
remote create and verify resulting identity/allocations. Pterodactyl provides no
cross-client atomic claim shared with a direct administrator; surface conflicts
rather than asserting that independent provider writers cannot race.

PostgreSQL is authoritative for registry, persistent storage/port claims,
compute reservations, operation phases and external-effect intent. Redis/BullMQ
only dispatches work. Persist intent before effects, use a server advisory lock
and recheck current authorization before a new external effect. Recover a lost
create response by external ID. Do not automatically replay an uncertain
destructive operation or treat a remote acknowledgement as completed work.
Restore requires a fresh correlated terminal activity event. Owner resolution
can acknowledge eligible unknown outcomes as failed, with an audit reason; it
cannot manufacture success or bypass uncertain power reservations.

Atomic admission charges active compute to the server owner and separately to
its physical host. Stopped servers retain disk/ports but no active user compute
charge. Starting, restarting, stopping and uncertain effects retain reservations
until trustworthy terminal evidence permits release. Cached offline telemetry,
a timeout or elapsed grace interval alone cannot prove that a delayed start will
not occur. This is a required correctness boundary, not an accepted exception;
remaining proof/recovery review belongs in the validation report.

Restrict automatic stop release to effective egg stop settings with a nonempty
non-caret command or `^C` (case-insensitive native Docker stop), corroborated by a
fresh ordered `stopping` → `offline` transition on the authenticated backend
WebSocket, an independent exact-container Docker observation proving the process
is no longer running, and no earlier unresolved power operation. Wings can report
offline after losing its output stream while the container remains alive. Reject
unsupported stop profiles rather than modifying eggs or Wings. Unknown/caret signal modes remain
fail-closed. Restart confirmation uses the exact running Docker process start
timestamp
after the durable effect intent and distinct from the recorded previous process
when present. Invalid, future or unavailable evidence retains uncertainty without
telemetry fallback or power replay. This survives a missed short uptime reset.
This capability restriction is an adapter/admission
contract; it authorizes no infrastructure change.

An already-offline stop with no compute or installer reservation can complete
without a remote effect. It requires fresh host/provider identity and exact
physical non-running evidence, followed by an atomic recheck of both reservation
tables under the global resource lock. It does not release capacity or invent a
power transition. A retained reservation always follows the strict stop proof;
missing evidence cannot be treated as successful completion.

Host observations include actual memory/CPU usage by direct servers, the OS and
other workloads. In addition to that measured usage, M2 subtracts the full
managed reservation and configured headroom. It deliberately gives no credit for
cached managed telemetry, which is not coherent with a newer host sample and can
double-count released memory. This conservative choice can reject additional
starts early. CPU percentage limits do not promise dedicated physical cores.
Unknown or stale observations deny admission. The configured local observer must
actually observe the game host and its target filesystem; container deployment
does not authorize inventing a host-capacity measurement. An explicit
`dockerObserverSocket` binds read-only Docker CLI terminal observations to that
same host; other-host workers refuse lifecycle effects. No deployment socket
mount or permission change is implied. Such access remains privileged and needs
explicit approval before deployment.

Configured user memory and physical memory commitment are separate. Installed
Wings converts configured memory to decimal bytes and adds tiered overhead:
256 configured units produced a 294,400,000-byte cgroup limit in the live test.
An Owner-verified node `memoryOverheadPercent` bound (default 115%, range 100–400)
charges `ceil(configured × bound / 100)` physical MiB, conservatively covering
this installation. `NH_NODE_MEMORY_OVERHEAD_PERCENT` overrides the node bound;
existing physical commitments never shrink. Migration 006 backfills existing
reservations, and admission, host-policy validation and reconciliation apply the
physical bound. User quotas continue to count configured memory. No Wings
configuration or accounting policy was changed to accommodate the installation.

Installer containers have separate transient physical RAM/CPU reservations. Wings
uses the larger of the server limit and its configured installer floor; the Owner
must configure matching `installerMemoryMiB` / `installerCpuPercent` for each
managed node (upstream defaults: 1024 MiB / 100%). Atomic host admission sums
installer and game reservations. Installers do not consume the user's active-game
quota. New installs/reinstalls require fresh headroom and retain their reservation
through unknown outcomes. No production Wings setting is changed by this policy.

Installation completion requires a fresh authenticated WebSocket completion event
and a fresh successful Panel result on the same uninterrupted connection, plus an
independent observation that the exact installer container has terminated. The
event alone occurs on failure too; Panel's cleared installation status alone can
also result from daemon reset. A missed event or failed provider callback remains
uncertain, never triggers a blind reinstall, and cannot authorize auto-start.
The recorded result is provider-reported installation completion, not validation
of a game's files, installer exit code or game readiness; those need the game SDK.

Persistent storage reserves each server's disk maximum plus each allowed backup
slot. `GLOBAL_POOL` remains the default; `PER_USER_BUDGET` additionally checks a
user allowance. Both respect filesystem headroom. These are conservative
admission limits, not an instantaneous filesystem quota against external writers.
Audited Owner user-limit overrides never bypass physical safety. Multiport roles
own stable allocations while offline and may inject their actual assigned port
into a declared egg environment variable. Gateway bindings remain M3.

SFTPGo credentials have encrypted, durable intent; random instance/server/
credential identity; bounded expiry; one-time secret delivery; and one verified
server-directory mapping. Rotation or lost delivery requires a new rotation ID.
Provider identity and scope must match before mutation. A bounded worker pass
revokes expired credentials and credentials whose issuer lost server management
permission. DNS records likewise use durable desired state, unique names, random
ownership markers and remote record IDs. Foreign records are never adopted.
Cloudflare writes stay mocked during M2 unless separately authorized.

## Temporary SFTPGo 2.7.6 exception

The Owner has temporarily accepted one limitation: an authenticated SSH transport
can open another SFTP channel after account rotation, disable/deletion or explicit
connection-disconnect calls. New SSH authentication is rejected after revocation,
but existing transports do not have reliable immediate revocation. This is not
reported as fully revocable access.

Continue using SFTPGo; introduce no SSH proxy, fork or workaround. Preserve the
three strict security assertions as known expected failures, separate from normal
setup, new-login rejection and directory-isolation tests. A fixed provider that
makes those assertions pass must trigger review of the expected-failure markers.
The exception applies only to M2 and must be revisited before production release, tracked in [issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18).
It authorizes no real Wings mount, service deployment, extra filesystem access or
other weakened acceptance criterion. See the
[external-service contract](../../packages/external-services/README.md) for the
strict diagnostic command and isolated test boundaries.

## Consequences

Future clients consume the [M2 API contract](../M2-API.md), including separate
runtime/readiness/intent states, actual job phases and safe error keys. The
backend console relay and bounded file/backup proxies do not expose provider
credentials. Complete frontend and game-specific behavior remain later
milestones. Configuration keeps defaults < Owner database < explicit environment
precedence; instance-specific values and real credentials are never seeded.

Live tests require durable UUID/ID/external-ID provenance corroborated against
the provider before every mutation. No name prefix establishes ownership.
Production mounts, networking and external-service changes still require exact
Owner approval. A draft implementation or documented design is not evidence that
all acceptance checks passed; the milestone remains subject to independent
review and the coordinator's validation report.
