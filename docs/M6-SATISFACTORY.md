# Satisfactory integration

This work uses the M5 review baseline on `milestone/m6-game-integrations`, following
the Owner's explicit request to begin Satisfactory. It does not merge or deploy M5.

## Provisioning and identity

The compiled `satisfactory` integration uses runtime `dedicated`. The existing
Owner mapping chooses the Pterodactyl egg and Linux container. SteamCMD remains
owned by that egg; NickHosting binds app 1690800, branch and update selection.
Required roles are `game` (TCP and UDP on one number) and `reliable` (TCP).
Startup explicitly binds `-Port`, `-ReliablePort` and `-ExternalReliablePort`.

Creation generates a per-server self-signed RSA certificate using OpenSSL. The
existing encrypted secret store persists the private identity under the managed
server UUID. It is not part of a route snapshot or browser response. Provisioning
uploads certificate and key into `FactoryGame/Certificates` through the existing
bounded, authorized upload pipeline before start. Private staging and published
files use mode 0600. Restore/reinstall reuses the saved identity. Database backup
and encryption-key recovery are necessary to preserve this identity across hosts.

The authenticated Gateway control endpoint validates the current route revision
before returning identity material with `Cache-Control: no-store`. The Gateway
holds identities in memory while their listener remains valid. Clearing sessions
invalidates the cached identity.

## Gateway

Load the compiled `games/satisfactory/src/gateway-module.js` through the existing
`NH_GATEWAY_PROTOCOL_MODULES` configuration. No separate listener service exists.
Existing allocation ownership, binding checks, leases and connection limits apply.

Lightweight Query implements the documented binary envelope, uint64 cookie and
flags, NetCL, substates and UTF-8 server name. Responses use observed backend data,
with persisted cache in `satisfactory_server_state`. No invented NetCL is sent
when no backend observation exists. Query observations are kept outside routing
authority and cannot change route revisions. After a Gateway restart, offline
queries hydrate the observed cache through a revision-checked internal endpoint.
Only actual backend probes establish readiness. During automatic sleep, query responses retain the last actually observed Idle or
Playing snapshot, allowing the Server Manager to continue its normal API flow.
Waking reports Loading; manual stop, maintenance, blocked routes and sleeping
routes with automatic wake disabled report Offline.
Transient shutdown/loading probes do not overwrite the durable ready snapshot,
but still immediately revoke live readiness. No cached snapshot authorizes backend
forwarding or proves that a world is currently running.

HTTPS uses a stable per-server identity in both Gateway and backend. The Gateway
terminates incoming TLS and creates a separate upstream TLS session, pinning the
exact server certificate before forwarding request bytes. Existing sessions are
not transplanted between TLS endpoints. Online API responses and credentials pass
through unchanged, except the reserved `nickhosting` console namespace described below. Offline HealthCheck reports slow. Claimed, automatically sleeping
instances support native PasswordlessLogin, PasswordLogin and VerifyAuthenticationToken
for the verified build profile. Core reads the stopped instance's native credential
state and computes the same persistent tokens as the backend. It never issues
multiplayer tickets. Protected reads require a currently valid native player token;
a previously cached successful response supplies no authentication authority.

QueryServerState, GetServerOptions, GetAdvancedGameSettings and Administrator-only
EnumerateSessions retain schema-checked,
encrypted backend observations. Core's live application observation records
QueryServerState and refreshes the three other native reads in parallel, with a
shared 1.5-second deadline and a 30-second cadence. It does not require a player
to have opened those tabs previously. Failed or malformed reads retain only the
last genuine observation; missing metadata is never replaced with invented defaults.
While sleeping, Status reports zero connected players and tick rate, a paused world,
and a localized suspended/Join label on the last observed active session. It does
not invent a world when the last native state had none. These are historical game
values with an explicit sleeping presentation, not evidence of a running process.

The exact Coffee Stain `JoinGameRequest` is recognized separately from polling.
A strictly formed player join request can request wake even without a cached
session; this is an intent classification, not authentication. As with Minecraft
Login Start, the existing core admits/coalesces the start before the game backend
authenticates the player. The HTTPS request waits within the existing Core TCP idle budget for readiness
before being forwarded unchanged. Pending reads during an already authorized
startup follow the same bounded wait without requesting wake or extending idle
activity. A sleeping-to-waking transition during offline authentication discards
the stopped-instance result and forwards the original request only after readiness. Application tokens, malformed requests, polling
and arbitrary TCP/UDP traffic never trigger wake. The backend alone validates the
original credential and issues the multiplayer ticket; a rejected credential is
forwarded as a rejection, never converted into a successful join.
A rejected online credential invalidates its transient bearer-cache entries; successful
mutations clear that transient cache. The separate historical observations are
refreshed by subsequent native reads and never grant authentication. Both use the
existing encrypted store and authenticated Gateway control channel.

Reliable TCP remains raw forwarding. Its readiness requires a recent game-query
observation and a successful TCP connection. UDP polling does not request wake.

## Capability limits and acceptance evidence

Coffee Stain's public controller headers establish the exact join function. The
Owner's native-client test exposed two blockers: reporting Offline prevented the
Server Manager flow, and offline VerifyAuthenticationToken returned 503. Sleeping
routes now preserve their last native Idle/Playing presentation; the native
credential implementation below resolves authentication without waking on polling.
Bidirectional interoperability and password revocation are verified against the
real dedicated server. A complete visual Server Manager → Join → playable session
acceptance check remains distinct from protocol-level evidence; the manifest does
not claim real-client certification from API-only tests.

The Settings section accepts a server application token, validates it against the
pinned backend, and stores it encrypted. It never returns that token. State,
player counts and server options use the authenticated API. Option updates share
the lifecycle lock and authorization/audit boundaries. When a token is configured,
stop/restart and stopped-backup flows save a running world before the existing
provider-confirmed stop; absent a token, the native egg graceful stop remains.

A newly created, ledger-proven test server was installed through the actual egg,
configured with the real upload pipeline, started, claimed and queried over pinned
TLS. The first Steam download failed with Missing configuration; retry succeeded.
Provisioning now verifies the game executable instead of trusting installed state
alone. Real multiplayer/client compatibility is not established by API tests.
Only ledger-proven test servers have been mutated; existing games and Panel source remain
untouched. Development migrations/restarts are described below.

## References

- [Developer API document mirror (1.0)](https://gist.github.com/alydevs/5148f83d68d3702aabf6819bf5514b83)
- [Lightweight Query](https://satisfactory.wiki.gg/wiki/Dedicated_servers/Lightweight_Query_API)
- [HTTPS API](https://satisfactory.wiki.gg/wiki/Dedicated_servers/HTTPS_API)
- [Dedicated servers](https://satisfactory.wiki.gg/wiki/Dedicated_servers)
- [Coffee Stain JoinGameRequest controller](https://github.com/satisfactorymodding/SatisfactoryModLoader/blob/master/Source/FactoryDedicatedServer/Public/Controller/FGServerStateController.h)
- [FICSIT dedicated servers](https://docs.ficsit.app/satisfactory-modding/latest/ForUsers/DedicatedServerSetup.html)

## Rollback

Revert the application commit before activating new integrations. For an activated
installation, stop new Satisfactory admissions, preserve encrypted TLS identities,
server files and database backup, and review active operations before rolling back.
Do not delete certificates or drop durable mod-operation tables as routine rollback.

## Native mods

The Satisfactory Mods section searches SMR, shows Linux server releases and their
published game-build requirements, and lets users select exact versions, remove
selected roots, or replace a version. Apply uses the shared `satisfactory-content`
operation and Activity tracking, stops the server, resolves dependencies/SML with
ficsit-cli, uploads through the existing Pterodactyl file pipeline, verifies every
file with streaming SHA-256, then commits the installed selection and dependency
lock. Only previously managed files with matching hashes may be replaced/removed;
manual files are not silently adopted or deleted. The user starts the server after
reviewing the completed operation.

Migration 059 stores desired roots, installed file hashes and the resolver lock.
Per-job staging receipts freeze resolved output across worker retries. Completion
is recorded before deleting the operation-owned staging directory, allowing cleanup
to resume safely. Staging uses the existing content reservation ledger and limits;
failed jobs retain their charged staging data for controlled recovery.

The development and runtime images include upstream ficsit-cli **v0.7.1**, pinned
by SHA-256 for Linux amd64 and arm64. The default path is `/usr/local/bin/ficsit`.
Local non-container workers can set `NH_FICSIT_CLI_PATH` and
`NH_FICSIT_CLI_SHA256` together to a verified installation. The worker verifies the
binary digest before every preparation. No server SFTP credentials are passed to
the CLI: upstream's remote SFTP implementation currently ignores host keys, so
resolution runs in a private local directory using actual server version metadata,
then the existing file bridge transfers the result. No game executable is run in
that staging directory.

Verified checks: seven catalog/resolver tests, three durable transfer tests
(including a 2 MiB binary and symlink/ownership conflicts), and one isolated browser
journey covering exact-version selection, durable request, English desktop,
Italian mobile/read-only, no horizontal overflow and automated WCAG checks.
Screenshots are under `.codex/local/m6-browser/screenshots/` (local evidence).
These checks do not certify a real modded Satisfactory client/server session.

Sources: [ficsit-cli v0.7.1](https://github.com/satisfactorymodding/ficsit-cli/releases/tag/v0.7.1),
[upstream release checksums](https://github.com/satisfactorymodding/ficsit-cli/releases/download/v0.7.1/checksums.txt),
[SMR protocol implementation](https://github.com/satisfactorymodding/ficsit-cli/tree/master/ficsit).

The CLI subprocess runs through `nh-content-sandbox`, built from the reviewed
Landlock helper. It clears inherited environment, grants writes only inside its
private stage, denies other filesystem reads except runtime libraries/certificates,
and limits individual file size. It requires Landlock ABI 2 or newer plus a seccomp filter denying path-based
truncate, read-only O_TRUNC opens and openat2. ABI 3+ additionally enforces native
Landlock truncation rights. Inherited nonstandard file descriptors are closed;
writable regular standard descriptors are rejected. The current host reports ABI 2:
actual confinement tests verify traversal, outside reads/writes/rename/truncation
and environment isolation. Unsupported kernels fail before running the CLI.
No host/kernel configuration was changed.
`NH_CONTENT_SANDBOX_PATH` may select the locally compiled helper for non-container
workers; there is no unsandboxed fallback.

## Development activation — 2026-11-01

The Owner explicitly authorized development database migrations and dev service
restarts for the entire Satisfactory implementation. The standard transactional
migrator applied 058 and 059 after a private PostgreSQL backup; existing migration
checksums were verified by the migrator. API, worker, Vite and Gateway were
recreated through the existing complete Compose stack, retaining networks, host
ports and persistent mounts. The new game source bind and trusted protocol module
were added to the existing dev configuration. No Pterodactyl Panel source changed.

The Owner also authorized updates to our Blueprint extension exclusively through
its normal `blueprint -i name.blueprint` installation/update workflow; no such
extension update has been necessary so far.

The upstream v0.7.1 binary was also exercised through the actual sandbox on this
host: installation/profile initialization, empty selection preparation and an SML
3.9.1 resolution/download/extraction using synthetic build metadata (NetCL 400000).
The SML run returned 17 validated files totaling 21,946,377 bytes. Temporary files
were removed. This smoke check does not install a Pterodactyl server or launch game
code. A periodic aggregate staging scan aborts CLI work above its 1.5 GiB reserved
budget, in addition to the per-file and final output limits.

Settings browser evidence also covers unconfigured/configured API connection,
password-field token submission and clearing, no token in GET responses or visible
text, changed-only option submission, player-state display and read-only Italian
mobile controls. Desktop/mobile captures and automated Axe checks passed. The
sandbox metadata escape found during independent review was fixed by denying
chmod/chown/xattr/time mutations and ioctl; the actual SML smoke passed again after
that hardening.

The aggregate staging watchdog detects excess usage every 500 ms; it is not a
filesystem hard quota and transient overshoot is possible. The per-file limit is
kernel-enforced. io_uring and legacy asynchronous I/O syscalls are denied so they
cannot bypass the synchronous open/truncate seccomp checks.

A subsequent resolver smoke used the exact installed metadata from the isolated
Pterodactyl test server: `Engine/Binaries/Linux/FactoryServer-Linux-Shipping.version`,
GameVersion 1.2.4.1 / Changelist 513885. SMR's newest stable LinuxServer SML 3.12.0
requires game build >=491125. The hardened sandbox resolved and extracted that
exact SML version into 17 verified files (14,025,213 bytes). This preparation used
a nonexecuted launcher existence marker and did not modify the provider server.
Both documented Linux version-file paths are supported by the discovery code.

Artifact preparation and upload are streamed: output contains path/size/SHA-256
metadata, validated artifacts move into the durable job stage, and binary hashing
and upload use bounded read streams. Web-stream buffering is explicitly measured
in bytes (64 KiB), avoiding payload-sized Buffers under the worker memory limit.
An 8 MiB sparse artifact test verifies durable spooling without returned bytes.

## Integrated routing and player observations

The compiled readiness capability is enabled, so the common provision transaction
reserves and activates all three routes: game UDP, game TCP and Reliable TCP.
Creation tests cover both automatic start choices through the real admission,
registry and lifecycle implementation with an isolated provider. Certificate upload
precedes the first start and provider-installed status alone cannot bypass the
executable check.

Gateway validates independent servers with a bounded pool of four, while retaining
sequential checks for each server and immediate pre-bind validation. An integration
priority orders Satisfactory game UDP, game TCP, then Reliable; this also applies
to observation cycles. Listener leases, live binding proof and generation fences
remain unchanged. A Reliable-first UUID regression uses real UDP/TCP fixtures.

Authenticated application observations are requested through the existing private
Gateway control plane. The API validates current route ownership/revision and uses
the encrypted server application token with certificate pinning. It returns only
readiness, idle and player count. No application token reaches the Gateway. The UDP
role obtains the live sample; other roles reuse it only within five seconds and
the same generation. Missing tokens, failed calls and unknown counts never prove
an empty server or authorize sleep. The integration supplies readiness, idle and
graceful-stop capabilities through the existing platform lifecycle contracts.

On a real test server (GameVersion 1.2.4.1 / NetCL 513885), six UDP samples validated
distinct cookies and returned state 3, flags 0 and stable substates. Reliable TCP
accepted connections, and all three startup port arguments matched the allocation.
The request cookie is excluded from persisted state; otherwise its bigint would
prevent JSON serialization. The query codec retains full cookie validation.

The actual native mod job installed SML 3.12.0, resumed an interrupted upload by
checking existing hashes, and started a modded world successfully. A second durable
job removed only managed SML files; the TLS identity and file permissions remained
unchanged. Save and restart preserved the world. These server-side checks do not
establish multiplayer client interoperability.

Wings can emit a finite negative uptime value immediately before its terminal
`offline` frame. The adapter now treats that single unavailable metric as absent,
without accepting invalid memory/CPU/disk values or weakening ordered stop proof.
An isolated WebSocket regression and the real server stop both confirm that the
terminal frame reaches the existing host-observer confirmation path.

A terminal installer receipt followed by a definitively missing Satisfactory
shipping executable is an installation failure. It is not retried indefinitely as
a provider outage. The normal reinstall action remains available; transient file
API errors retain their existing recovery behavior.

Satisfactory automatically suspends only after a world exists and the backend has
zero players, no active work and no client requests for the configured idle timeout.
An active world is saved by the existing graceful-stop hook. With no active world,
each idle observation requires fresh, authenticated `EnumerateSessions` metadata
containing at least one valid save header. Empty sessions, old session names,
historical snapshots, unavailable permissions and failed or malformed enumeration
never authorize sleep. This keeps first-time setup online until a world is created;
a saved but unloaded world remains eligible for normal idle suspension.

While online, all admitted client UDP requests (including server-list queries) and
forwarded HTTPS requests (including status, authentication and settings reads)
prevent idle suspension. Leaving the Server Manager polling the server therefore
keeps it awake. The Core's optional `clientRequestsPreventIdle` protocol capability
retains activity between observation ticks until a successful report; requests
arriving during that report remain pending for the next one. Long HTTPS requests
also retain the existing active-operation protection. Counts remain actual player
and session counts; activity is not represented as a fictitious player. Internal
readiness/application probes and backend responses do not count as client activity.
Existing quiescence fences still apply to a stop already committed. Sleeping or
starting query responses remain passive: Join or an authenticated `nickhosting start` request can wake, and pending
reads count as activity only once forwarded to an online backend. Other games
retain their existing idle policy.

The runtime also coalesces unfinished host-inventory reads and shares one immutable
host observation across the initial checks of a validation batch. The original
observation timestamp remains authoritative; expired evidence is rejected. A second
check of a route, including its final pre-bind check, rereads host sockets/topology.
Nothing is cached across completed batches. This avoids repeated Docker/process
scans exhausting the Gateway CPU budget and creating gaps between listener leases.

SMR browsing omits its search filter when empty; nonempty searches require at least
three characters, matching the upstream API. Custom management sections declare
explicit UI write permissions while API authorization remains authoritative. The
Satisfactory sections require `server:manage` for changes and retain read-only
browsing for `server:read`.

Long Steam installations retain a bounded one-hour native event subscription. The
existing worker installation collector also persists an actual authenticated
completion event in `server_events`, correlated with the active job, provider UUID
and exact effect-start timestamp, before waking the lifecycle worker. Recovery
requires that exact receipt plus fresh managed identity and host proof that both
installer and game are stopped. Ordinary Panel status updates never substitute for
completion. This closes the gap where a download longer than the old five-minute
window completed after its confirmation subscriber had disconnected.

Control requests for one route rebuild only that route with the same fresh policy,
identity, eligibility and evidence checks under the existing resource lock. They do
not rebuild every unrelated route or renew unrelated leases. Full snapshots remain
the only writer of aggregate snapshot revisions. This removes the serialized
all-route work previously repeated by every context/proof/cache request.


## End-to-end development checks

A second ledger-owned server was created through the ordinary NickPanel server API,
admission transaction and worker. A failed first Steam download exposed the native
retry flow; the subsequent reinstall completed through the same lifecycle and
activated all three reserved routes. A real application token was stored through
the protected API, and both the Settings and Mods pages were exercised against
that instance without browser errors.

Automatic idle suspension was verified against the physically stopped backend.
Repeated UDP queries and HTTPS HealthCheck requests did not enqueue another start.
The Gateway continued returning the observed NetCL, server name and substates,
and protected read responses matched actual previously observed native responses.
A Gateway-only restart repeated these checks with empty in-memory caches, retaining
the same TLS identity. Persisted read snapshots are best-effort: a write rejected
by a changed route revision can leave an earlier genuine snapshot until its original
expiry. They do not promise the most recent in-memory sample.


The final strict JoinGameRequest test held the original HTTPS connection across
backend startup and enqueued exactly one wake operation. The real backend returned
HTTP 200 with its native `no_game_running` error because that test instance had no
loaded world. The Gateway preserved this response and did not create a ticket.
This verifies request continuity and wake orchestration; it is not a successful
multiplayer join or Steam/Epic client certification.

Managed protocols now reserve each upstream stream separately from their incoming
connection and activity count. Unforwarded requests may survive temporary backend
churn within the same route generation. Actual upstream streams are revoked when
the backend loses validity; generation, identity, route and lease revocations still
close all affected connections. Tests cover both preservation and revocation,
including refusal to send upstream bytes before fresh readiness is established.


After acceptance, the original idle policy was restored and the canonical manual
stop completed with fresh host evidence that both installer and game were stopped.
A subsequent valid join request returned HTTP 503 and created no start operation,
confirming that manual stop prevents automatic wake. Both ledger-owned test servers
were retained stopped, without OOM termination; no active jobs remained.


## Automatic-sleep Server Manager correction

The Owner reproduced the Offline message after an actual idle timeout. Inspection
confirmed successful automatic stop and a persisted native Idle snapshot. The
previous unconditional conversion to Offline caused the presentation failure.
The correction replays only observed Idle/Playing state for sleeping routes and
retains the distinction from manual stop. Tests cover both ready states, cold
hydration, transient stop/loading probes and non-wakeable modes.

Managed API diagnostics emit only allowlisted operation names (otherwise `other`),
fixed outcomes, route/server identifiers and mode. They exclude credentials,
player identifiers, headers and bodies, throttle repeated events to once per
30 seconds, and bound diagnostic memory. Forwarding-attempt and wake-result events
are diagnostics, not proof of delivery or successful admission. These allow the
remaining native client authentication sequence to be investigated without recording
secrets or treating automatic login/verification as play intent.


## Native offline authentication and interoperability

The Owner explicitly requires **wake only for Join**. Login, token verification,
UDP query, HealthCheck and Status reads do not start the backend. Manual stop and
maintenance remain unavailable to offline authentication. An unclaimed server must
be claimed while running; no offline claim or administrative mutation is emulated.

Core's service-only `/internal/gateway/:gatewayId/offline-api` requires the exact
current route revision, Satisfactory game TCP role and automatic sleeping policy.
The credential reader shares the existing lifecycle advisory lock, rejects queued
or active jobs, verifies the managed provider identity and game allocation, and
independently confirms both installer and server containers stopped before and
after reading. It rejects symlink paths, unstable/oversized settings and unknown
native formats/builds. At most two credential reads can acquire database connections at once; additional
distinct reads fail without queuing. Identical overlapping authority reads coalesce
and return independent copies, with no settled credential-authority cache. Existing
Blueprint directory batches reduce metadata round trips without changing guards. Credentials never enter route snapshots,
public API responses, logs or the Gateway's persisted read cache.

The supported profile is dedicated-server build **513885**, GVAS 3 / UE 5.6.1. The
native password is SHA-512 of binary salt followed by UTF-8 password bytes. A native
persistent player token combines the base64 privilege JSON and an HMAC-SHA-512
fingerprint of the serialized player provider/replication bytes, privilege and
corresponding stored password hash, using the native server secret. Verify takes
the raw fingerprint plus PrivilegeLevel, and returns native empty HTTP 204 on
success. Wrong password, invalid token, missing parameters and privilege failures
retain native response semantics. Supported identities are absent/INVALID, Steam
(provider 6, eight replication bytes), and Epic (provider 1, 32 ASCII hex bytes).
Epic identifier casing is preserved; only outer wire hex is case-insensitive.
Unknown identity encodings/build profiles fail closed. Application tokens and
InitialAdmin are not accepted as offline player credentials.

The implementation was checked against a ledger-proven isolated dedicated server:
- Native Client/Administrator tokens verify locally; locally generated tokens are
  accepted by native VerifyAuthenticationToken and QueryServerState.
- No-player, distinct Steam identities and both Epic identifier cases interoperate;
  player/privilege changes and tampered signatures are rejected.
- Native Client can read all three retained functions. Session enumeration additionally requires native Administrator scope; no
  administrative mutation is exposed through the offline endpoint.
- Changing native client and administrator passwords revokes the previous tokens;
  new tokens interoperate, including Unicode passwords. Original native settings
  were restored byte-for-byte, original credentials reverified, and the test
  server stopped again.
- Native HTTP defaults to ISO-8859-1 when charset is absent. Gateway decoding
  preserves this behavior; NickPanel's own native API transport explicitly sends
  UTF-8. JSON escaping remains lossless in either case.

The private native files used for interoperability inspection are excluded from
Git. Committed tests use independently constructed synthetic settings and crypto
vectors. Public HTTPS limits bound requests per server/peer and password attempts;
the authenticated Core request is also size-bounded. Missing state returns a JSON
native-style unavailable error rather than an empty 503 (`no_content`).

TLS certificate persistence is independent of authentication. No multiplayer
entry ticket is generated offline: Join still uses existing Core admission and
wake, then forwards the original request to the real backend for final verification
and its actual ticket. A cached success is never converted into current authority.

Primary contract declarations:
- [Native authentication types](https://github.com/satisfactorymodding/SatisfactoryModLoader/blob/master/Source/FactoryGame/Public/Server/FGDSAuthenticationTypes.h)
- [Native authentication controller](https://github.com/satisfactorymodding/SatisfactoryModLoader/blob/master/Source/FactoryDedicatedServer/Public/Controller/FGServerAuthenticationController.h)
- [Client authentication requester](https://github.com/satisfactorymodding/SatisfactoryModLoader/blob/master/Source/FactoryDedicatedClient/Public/RequestEmitters/FGClientAuthenticationRequester.h)

No database migration or Blueprint update is required for this change. Deploy Core
and restart the existing Gateway together. Rollback reverts the native offline hook
and restarts those services; it does not change game files, native credentials, TLS
identity, allocations or worlds. Encrypted historical observations can remain
unused after rollback. A real Server Manager acceptance test is still required
before claiming that the complete visible client flow has passed.

Development verification on 2026-11-01: the existing public TLS endpoint returned
PasswordlessLogin 200, VerifyAuthenticationToken 204, all three protected reads
200 and invalid-token 401 while the backend remained offline with zero additional
start jobs. The Owner then confirmed Status is visible in the unmodified game
client. Its message requires creating/loading a game before Join, matching the
last native observation that no world is loaded. That remaining initial-world
setup is distinct from authentication; no Owner game files were changed to bypass
it. Full Join acceptance requires a real loaded world and subsequent automatic
sleep. Private native test credentials/settings were restored and its backend
stopped. Historical per-function observation times are retained independently.

## Native Server Manager selection and startup follow-up

The Owner's next test exposed an uncached Administrator EnumerateSessions request
on server selection, producing503 while Status remained visible. Native save
enumeration can use gzip; its original compressed response had previously been
forwarded but excluded from cache capture. The Gateway now observes bounded gzip
and deflate JSON while forwarding the exact original bytes. Expanded observations
are capped64KiB, schema-checked, encrypted and served only after fresh native
Administrator verification. A valid Client receives403 insufficient_scope. Actual
ledger-owned native-server enumeration passed both identity and gzip with the
expected session/header fields. That test instance was stopped with host proof.

The observed first cold Join took roughly43seconds to reach readiness, beyond the
former25-second wait. The independent cutoff is removed. Pending requests are
bounded at8/connection,64/server and128/process, with64KiB body limits and prompt
cleanup on close, abort, revoked authority or forbidden mode. Native authentication
and tickets still come from their respective verified authority; no pending ticket
is invented. Controlled HTTPS tests cross43seconds and preserve the original
request; real client timeout policy remains outside Gateway control.

Satisfactory now opts into the existing provider-running **startup hint** to
schedule priority native probes. It does not declare provider-running as a
readiness source: UDP readiness, Reliable TCP and all authority checks remain.
Idle/player RPCs are skipped only while waking, since they cannot authorize sleep
then; fresh authenticated player observations resume online.

The Owner reported that a subsequent Join reached the game and was rejected by
their client mods, an expected separate compatibility issue. During development,
API source reloads also produced transient lease interruptions; final verification
uses stable services. Public offline checks passed native Admin enumeration200,
Client enumeration403, token verification204 and state/options200 with zero new
starts. A missing Advanced settings observation discovered in that check motivated
the proactive metadata refresh above. The Owner then retried Join: the real
backend supplied all four snapshots, including Advanced settings, and the Gateway
forwarded Join at18:44:57UTC after the successful readiness report at18:44:53UTC.
This confirms routing and metadata acquisition; it does not assert which native
client request/retry remained open or that the mod-mismatched client played.

After the Owner-triggered retry and confirmed automatic sleep at18:46:40UTC,
public TLS validation passed Health200, native Login200, Verify204,
QueryServerState/GetServerOptions/GetAdvancedGameSettings200, and native Admin
EnumerateSessions200. A Client token was correctly refused enumeration403 and an
invalid token401. The backend remained offline with zero additional start jobs.
Final validation:316 targeted tests,68 API integration tests, TypeScript/runtime
build and changed-file lint pass; independent reviews passed the authority,
compression, concurrency and readiness changes.


## Setup and client-request idle policy — 2026-11-01

The Owner requested that first-time setup remain online without a created world,
and that all client requests keep an online server awake. Both rules use the
existing application observation and Core idle timer, with no schema migration or
separate scheduler. Client polling while sleeping still never requests a start.
The gateway protocol capability is enabled only for Satisfactory.

Validation: all 142 Satisfactory unit tests and all 197 Gateway data-plane tests
pass; 167 isolated Gateway API/orchestration integration tests pass. Coverage
includes active and unloaded saved worlds, absent/malformed/unavailable save
metadata, short HTTPS reads between observations, continuous UDP polling, internal
probes, failed reports, concurrent activity during reporting and listener generation
changes. Full TypeScript checks, runtime compilation and changed-file Biome pass.
Independent review found no remaining must-fix issue. The existing development
API and Gateway were restarted under standing Owner authorization. No migration,
Blueprint/Panel/Wings change, new game test asset or user server power/file/world
mutation was needed. This change has automated protocol/control-plane evidence;
the new keep-awake policy has not yet been observed in a real game-client session.


## Native Server Manager console

The Gateway handles the `nickhosting` namespace inside native HTTPS `RunCommand`.
The existing TLS listener and authenticated control plane provide this surface;
no game mod, Unreal-console emulator or shell interpreter is involved. Other
online commands reach the backend unchanged. While sleeping, native commands
receive an authenticated textual explanation instead of being queued or executed.

| Command | Behavior |
| --- | --- |
| `nickhosting` / `nickhosting help [command]` | Lists descriptors or explains one command. |
| `nickhosting status` | Current Core state and safe failure information. |
| `nickhosting info` | Server name, game and configured public address. |
| `nickhosting version` | Integration version and last observed game NetCL; never an invented current version. |
| `nickhosting idle` | Effective timeout and prerequisites; live player/world evidence when available. Reading it online is itself client activity. |
| `nickhosting start` | Uses normal wake admission, consent and coalescing. This is an explicit additional wake trigger alongside Join. |
| `nickhosting stop` | Requests immediate forced sleep without waiting for inactivity or zero players. Saves first, disconnects players, confirms stop and remains wakeable. |
| `nickhosting restart` | Saves and restarts an online instance through existing admission/readiness. A sleeping instance directs the administrator to `start`. |
| `nickhosting mods` | Returns exactly `Coming Soon :)`, as requested; no mod-manager operation is exposed yet. |

All commands, including help and mods, require a native Administrator token bound
to the native caller identity (Steam/Epic or the native anonymous identity when
the optional player header is absent/`INVALID`). Malformed identities never fall
back to anonymous authentication. Online authorization uses the
original bearer and player ID over certificate-pinned HTTPS, accepting only native
HTTP 204 fingerprint verification. Offline authorization reads fresh credentials
from the physically stopped managed instance. Neither cached responses nor the
platform application token authorize the caller. Unknown commands, ambiguous
case-duplicate parameters, control characters and extra arguments do not execute.
English/Italian output uses the existing catalogs and route locale. The command
descriptors/parser are separate from Core handlers so future subcommands can be
added without changing transport or authentication.

The route-scoped internal `console-command` endpoint rechecks revision/generation
after native authorization; power admission rechecks again under the existing
resource transaction lock. Native player attribution is audited without credentials.
Explicit sleep/restart jobs have a durable `gatewayConsole` plan marker and remain
subject to current ownership, identity, operation, wake-consent and maintenance
checks at every worker effect. They do not fabricate idle observations. Required
save failure occurs before the power journal, preventing a false or uncertain stop
claim when no stop was sent. Missing platform save credentials block these commands.
No new database schema, scheduler or provider-control boundary is introduced.

A stop/restart can change route authority before its HTTP response is flushed.
The Gateway therefore allows only the bounded, unforwarded console reply to drain
across the matching Core-confirmed mode/generation transition, then closes it.
Gameplay and further requests are fenced immediately. Lease expiry, topology or
identity changes, route withdrawal, manual-stop and wake revocation still close
all affected sockets. The internal transition proof is never sent to the game.

Validation includes native-token rejection, exact verification status/player
binding, offline reads with no wake, complete command output, Core acceptance and
route races, forced sleep with players/no idle proof, save failures, restart
admission/recovery, duplicate requests, consent revocation and actual TLS response
flushing across a lifecycle transition. Real-client rendering and multiplayer
forced-disconnect behavior remain separate acceptance checks; automated fixtures
are not represented as a connected game-client session.


Console validation: 441 unit tests across Satisfactory, Gateway data plane/control,
pinned transport, save hook and i18n; 563 integration cases across Gateway API,
general lifecycle, Gateway orchestration and activity (final anonymous-identity
cases rerun as targeted regressions). Full typecheck, runtime build and i18n parity
pass. Repository lint passes with 34 warnings and one informational item.
Independent security review found no remaining must-fix issue.

After the authorized restart of existing dev API, worker and Gateway, all three
services were healthy. Public certificate-pinned HTTPS returned successful native
console envelopes for help, command help, status, info, version, idle and mods;
mods matched the requested string exactly. Client-scope and invalid credentials
received HTTP 401. The user-used server remained physically stopped/sleeping, with
zero operation jobs added. No user server start/stop/restart or world/file mutation
was performed to test power commands; those paths were exercised through isolated
Core lifecycle and transport fixtures. No new game test assets, migrations,
Blueprint update, Panel/Wings change or infrastructure reconfiguration were needed.

Rollback this follow-up only after console lifecycle jobs have settled. Revert the
code commit and restart the same dev services; no schema rollback is required.
Do not delete pending job plans, TLS identities, native credentials or game data.
