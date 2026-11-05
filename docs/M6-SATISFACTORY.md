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

## Connection hostname

Satisfactory declares `shared-host` with the fixed default label `satisfactory`.
The existing Owner DNS domain policy chooses the domain; no deployment domain is
embedded in the integration. The common DNS pipeline publishes one DNS-only shared
record per eligible domain and retains its ownership independently of individual
servers. Per-server custom labels and SRV records are not supported. Connection
addresses always include the assigned public game port, for example
`satisfactory.example.test:27001`, including when the backend uses a different port.
The UI descriptor declares the same shared-host mode and explicit-port presentation.

Existing servers require explicit DNS opt-in through the existing assignment
pipeline; changing the compiled manifest alone does not publish them. The panel
exposes the shared address only after the DNS assignment is confirmed.

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

The Satisfactory Mods workspace shares the Minecraft addon layout and visual
components: Installed, Discover and Review changes. SMR discovery includes project
artwork, authors, description, version details, published build compatibility and
Linux server targets. Installed inventory reads the real mod directories, including
`FactoryGame/Mods/GameFeatures`, and distinguishes selected roots, dependencies,
unmanaged content and discrepancies from the last committed file hashes.

Profiles retain enabled/disabled roots, exact versions or supported semver constraints,
required client/server targets and reversible disabling of all managed mods. Update checks can
stage individual or all compatible stable updates. Disabling a root preserves its
profile entry; dependencies still required by another enabled root remain installed.
Unmanaged mods remain untouched when disabling the managed selection.
SML and dependency resolution use upstream ficsit-cli. A mixed client/server profile
may contain mods present only on their relevant side; the upstream resolver validates
side requirements and only Linux server artifacts are uploaded to the server.

Preview and Apply are separate durable `satisfactory-content` jobs. Both require a
stopped server. Review can request the existing graceful stop without discarding
the staged selection. Preview resolves into private reserved staging and exposes the exact
resolved changes; Apply consumes those frozen artifacts and rejects stale selection
revisions, changed game builds and changed filesystem fingerprints. The existing
Pterodactyl file pipeline streams uploads and verifies SHA-256. Unmanaged files are
preserved; neither discovery nor a failed hash comparison silently adopts them.
The user starts the server after reviewing the completed operation.

Migration 059 stores desired roots, installed file hashes and the resolver lock.
Migration 060 adds revisioned profiles, frozen plans, external-edit state and recovery
metadata. Before replacing managed files, Apply retains verified previous file bytes
in its reserved stage. Rollback restores that snapshot, including recovery from a
partially applied operation, and refuses unexpected external changes. This is recovery
of managed mod content, not a backup of world saves. Retries use durable receipts and
completion/cleanup markers rather than resolving a different set of mods. Plans expire
after 24 hours; the existing reconciliation worker reclaims expired unreferenced stages. The latest
recovery snapshot remains charged to the existing content staging ledger until it is
superseded, restored, or its server is deleted.

Native SMM3 `.smmprofile` import/export preserves profile intent, enabled flags and
targets. Imported lockfile URLs are never trusted download authorities. An export can
include a matching trusted resolved plan; otherwise SMM resolves dependencies from
the exported choices. Importing a profile does not itself change server files.

The SMM connection helper reuses existing per-server SFTP credentials and permissions.
Use SMM Manage Servers, SFTP, the endpoint shown by NickPanel and installation root
`/` (containing `FactoryServer.sh`). SMM retains its profiles on the user's computer;
remote lockfiles alone do not synchronize those choices with the panel database.

Entering external management queues the normal graceful stop even if the cached
runtime state is offline, establishes maintenance intent and blocks NickPanel starts,
content operations and file-manager writes touching the mod tree. Wait for that stop
to finish before changing files in SMM. Close SMM's connection when done, import its
profile when needed, explicitly reconcile the observed managed files, then finish the
session. Reconciliation is also required when nothing changed. Finishing rechecks the
fingerprint and physical stop; it leaves the server manually stopped and does not
silently grant wake consent. Malformed, ambiguous or partially transferred mod metadata
must be corrected before adoption.

This coordinates NickPanel writers; it is not a distributed lock honored by every
external SFTP client. Existing SFTP sessions may still write and subsequent drift is
rejected by the reviewed plan/hash checks. Issue #18 is explicitly outside this rework
and remains the separate production-release gate; credential revocation is not used as
proof that every retained SSH transport has lost access.

API routes live under `/v1/servers/:id/satisfactory/mods`: state, inventory, catalog,
project details/versions, updates, preview, plans, apply, rollback, profiles/import/export,
reconcile and external/begin/finish. They use the existing authorization, adapter,
Activity and staging boundaries. Generic operation requests cannot bypass the reviewed
mod-plan API. English and Italian cover the complete workspace and recovery flows.

The development and runtime images include upstream ficsit-cli **v0.7.1**, pinned
by SHA-256 for Linux amd64 and arm64. The default path is `/usr/local/bin/ficsit`.
Local non-container workers can set `NH_FICSIT_CLI_PATH` and
`NH_FICSIT_CLI_SHA256` together to a verified installation. The worker verifies the
binary digest before every preparation. No server SFTP credentials are passed to
the CLI: upstream's remote SFTP implementation currently ignores host keys, so
resolution runs in a private local directory using actual server version metadata,
then the existing file bridge transfers the result. No game executable is run in
that staging directory.

Validation includes domain/profile/inventory tests, isolated database/API lifecycle
and stale-state tests, durable transfer/recovery checks, and browser journeys in
English/Italian across desktop/mobile, read-only, external-edit, error and recovery
states. The opt-in `satisfactory-smm.integration.test.ts` exercises the actual pinned
upstream ficsit binary against the existing isolated SFTPGo service: Linux discovery,
native lockfile writing, normal/GameFeature managed removal and unmanaged preservation.
Set `NH_TEST_FICSIT_PATH` to the verified local binary and run through `scripts/test-env.ts
--m2`; the test rejects any other storage root. These checks do not certify the desktop
SMM GUI itself or a new modded Satisfactory multiplayer session.

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

## Mod manager rework validation — 2026-11-01

The rework reuses the Minecraft addon primitives, workspace CSS and sanitized
Markdown renderer, with a separate Satisfactory controller and SMR/ficsit domain.
Browser tests render the real components against isolated HTTP fixtures; they are
not screenshots of a simulated production server. Reviewed sanitized evidence:

- [Installed, English desktop](screenshots/m6/satisfactory-mods-installed-en.png)
- [Discovery](screenshots/m6/satisfactory-mods-discover-en.png)
- [Resolved change review](screenshots/m6/satisfactory-mods-review-en.png)
- [Profiles](screenshots/m6/satisfactory-mods-profiles-en.png)
- [SMM external editing](screenshots/m6/satisfactory-mods-smm-en.png)
- [Stop pending](screenshots/m6/satisfactory-mods-stopping-en.png)
- [Running server and preserved draft](screenshots/m6/satisfactory-mods-running-blocked-en.png)
- [Uncertain operation](screenshots/m6/satisfactory-mods-uncertain-en.png)
- [Italian mobile](screenshots/m6/satisfactory-mods-installed-mobile-it.png)
- [English mobile](screenshots/m6/satisfactory-mods-mobile-en.png)
- [Italian desktop](screenshots/m6/satisfactory-mods-desktop-it.png)

Nine browser journeys cover profile import/export and targets, version constraints,
resolved review, staged updates/disable, confirmation focus, uncertain request replay,
rollback, external editing with and without changes, read-only access and stopping
without discarding the draft. Automated accessibility and overflow checks accompany
independent visual/content review. This does not constitute exhaustive WCAG certification.

Under the Owner's standing development authorization, migration 060 was applied
alone after a private development database backup and verification of all 59 prior
migration checksums. API, worker, Gateway and Vite were recreated using the existing
complete Compose configuration; bind mounts and published ports were verified unchanged.
All four became healthy. A read-only browser check of the actual development panel
returned the real inventory with HTTP 200, no alerts/page errors and no desktop/mobile
overflow. No game files, power state, Pterodactyl source, Blueprint extension, production
infrastructure or issue #18 behavior were changed by this activation.

Rollback: stop admitting new mod operations, let active transfers settle, retain the
current database and reserved recovery stages, and revert the application commit/image.
Migration 060 is additive; retain its tables/columns rather than dropping active plans
or snapshots. Resume the new version to finish recovery operations before attempting
an older writer. The previous development image and private pre-migration backup are
retained locally; do not restore a whole database over intervening user changes as a
routine code rollback.

Final rework checks: lint, full TypeScript, i18n parity, frontend build and runtime
compilation passed. The full unit run reported 4,434 passing tests, one skipped and
one Gateway fixture failure caused by an ephemeral-port `EADDRINUSE`; that exact
case passed when rerun alone. An earlier parallel run's three resource-sensitive
failures also passed in the isolated 90-test rerun. No test thresholds were weakened.
The broad lifecycle/registry regression run passed 439 cases; final scoped checks
passed 12 API/external-mode cases, 17 worker/inventory cases, 34 targeted domain/module
unit cases, nine browser journeys and two upstream ficsit/SFTP cases. These suites
overlap and their counts must not be summed. Independent code and visual reviewers
reported no open must-fix findings.


### Mod selection and Installed alignment

Discovery checkboxes precede the mod artwork/name in both visual and keyboard
order. Quick selection stages the latest compatible stable version as a minimum
(`>=version`), allowing that release or later versions; explicit version/policy
selection remains available in the mod dialog. Multiple choices remain in the same
draft until the existing resolved review/apply flow runs.

Installed search, filter and action controls share a bottom baseline. Mod rows use
separate artwork/content/action columns; narrow layouts put actions below the name
and metadata. Browser regression checks cover multiple selections, deselection,
submitted minimum constraints, leading checkbox geometry on desktop/mobile and
Installed control alignment. All ten browser cases passed across the suite and the
scoped new-case rerun. Web/application-test TypeScript, frontend build and lint
passed (existing lint warnings and bundle-size notices remain). Independent code
and screenshot review found no open issues. The actual dev UI was checked
read-only: inventory/catalog HTTP 200, checkbox before artwork, no page errors or
horizontal overflow. No migration, service restart, game-file/power mutation or
Pterodactyl/Blueprint change was needed.

- [Multiple selection, desktop](screenshots/m6/satisfactory-mods-multiselect-1280.png)
- [Multiple selection, mobile](screenshots/m6/satisfactory-mods-multiselect-390.png)

### Incremental mod preparation and review latency

Selection changes start background preparation immediately after the checkbox
version request completes. Version requests are never triggered by hover or focus.
The draft remains editable while one preview is running; only the latest pending
selection starts next. Results are keyed by the full selection, profile, vanilla
flag and state revision. Stale results cannot enable Apply for a different draft.
Review changes opens the already prepared result rather than enqueueing another
job. Pending work reports queue, native preparation and inventory phases. Preparation
continues to require a stopped server; running servers retain the existing stop
flow. No background task installs mods on the server.

Preview alone bypasses the generic per-operation 21-second resource-cache settling
window, using a fresh physical-stop proof instead. Apply and rollback retain their
normal stopped-state, revision, build and filesystem checks. API plan status is not
published as ready until the worker completes and releases the server operation.
Snapshot responses expose `activePreviewJobId`; plan responses expose `phase`.
There is no migration or additional infrastructure.

The native sandbox remains unchanged. A preview can seed its private download
cache from two recent completed stages belonging to the same server/build. Only
archives matching fresh native-lock SHA256 hashes are retained. Copies used by the
child have distinct inodes; verified archives are moved into the completed stage
without a second peak-size copy. Cache retention is bounded to 512 MiB/512 archives
per stage. Three preceding completed/failed previews plus the current preview are
retained, with actual retained stage bytes charged to the existing storage claims.
A missing preparation receipt clears incomplete job-owned staging before retry.
The UI retains at most four plans, revalidates returning selections and re-prepares
an evicted/conflicting plan without automatically applying it.

Measured on development, with one selected PEP_Mod and SML dependency (76 files,
61.4 MB), without applying mods or changing game files/power:

| Measurement | Before | After |
| --- | --- | --- |
| Complete preview preparation | 34.5–36.8 s | 12.6 s cold; 5.2 s with verified cache |
| Preparation block within the real worker (including launcher read) | Not separately timed | 7.2 s cold; 1.8 s warm |
| Opening Review with a prepared result | Started another preparation | 20–32 ms, no additional preview request |

The under-300 ms result measures opening a prepared Review, not the complete cold
preparation. Native dependency requests, download/extraction, hashing and current
server checks still take time in the background; no claim is made that all of
these complete within 300 ms. An isolated pinned-ficsit benchmark also measured
6.6 s cold versus 1.6–1.9 s warm with identical output; those values exclude the
application's provider/queue checks.

Validation: 12 browser journeys, including editing during preparation, stale
results, minimum-version multi-selection, cached-plan eviction/recovery and a
sub-300 ms prepared-Review paint check; 21 domain/cache/sandbox tests; 22 API/worker
integration tests; and the lifecycle suite including four preview/physical-proof/
apply guard cases passed. Full types, lint, i18n parity, frontend and runtime builds
passed (existing lint warnings and bundle notices remain). Independent code and
screenshot review found no open must-fix findings. Real dev preview-only checks
reported no page errors and never called Apply. All four dev services remained
healthy; no manual service restart, migration, Blueprint/Panel/Wings change or new
game-server test asset was needed. Issue #18 remains unchanged.

[Prepared incremental Review screenshot](screenshots/m6/satisfactory-mods-incremental-ready-en.png).
Rollback after pending preview jobs settle by reverting this application change;
retain normal operation/plan records and stages for existing recovery. Archive
caches are optional and are removed with their normal stage retention lifecycle.


### Further preview latency optimization

The checkbox remains the trigger for fetching compatible versions. The versions
endpoint overlaps SMR metadata and the current server-build read, then computes
compatibility against that live build. No authorization or build cache is added.
The UI starts the next committed draft without a debounce or intermediate
candidate render; one durable preview remains active at a time. Pending plans are
polled at 100 ms for the first ten seconds, then 250 ms during longer downloads;
final snapshot/activity refreshes run concurrently.

Core proves provider identity, host ownership and the physical stopped process
once for the locked preview delivery. The integration reuses that ephemeral proof
and keeps revocable local authorization on inventory reads. Apply and rollback
retain independent physical/process/authorization and full byte checks. Preview
alone shares its bounded directory listings between inventory metadata and the
full file fingerprint; metadata-only fingerprints are never accepted.

Native preparation and full inventory now overlap. Any branch failure aborts
and drains both branches before the connection/server lock is released, including
errors thrown while constructing native options. Worker diagnostics separately
report native duration, inventory duration and their overlapping interval. Native
timings separate setup, cache seed, child execution, publication and cleanup;
these diagnostics remain internal and contain no file contents or credentials.


Artifact publication hashes up to four files concurrently and overlaps verified
archive publication. Copies remain private inodes, use one-pass streaming
copy/SHA256 verification, and keep the existing 1 MiB buffers and storage limits.
The sandbox checks the aggregate seeded budget before starting the child and
again during/after execution. Vanilla does not copy unused archive caches.

The storage choice was measured in the actual development worker and its
configured content filesystem. Seven-run alternating tests found archive-only
warm preparation at 1.69–1.90 s versus 1.99–2.12 s when also copying verified
extracted files. Larger 4 MiB buffers did not improve this workload. Neither
additional extracted-file caching nor larger buffers was retained. The original
SHA256 checks remain; timestamps never substitute for content verification.


Final actual browser runs, same PEP_Mod/SML selection and 76 files/61.4 MB,
measured from the DOM checkbox click to the matching ready plan:

| Stage | Final run 1 | Final run 2 |
| --- | ---: | ---: |
| Version request | 367 ms | 323 ms |
| Response to preview submission | 76 ms | 78 ms |
| Preview POST | 220 ms | 309 ms |
| Queue after POST response | 12 ms | 7 ms |
| Worker prelude, metadata, admission | 1,019 ms | 724 ms |
| Native preparation, overlapping inventory | 1,774 ms | 1,801 ms |
| Inventory (already within the preceding interval) | 666 ms | 645 ms |
| Worker finish | 49 ms | 111 ms |
| Ready-plan observation | 103 ms | 135 ms |
| Complete checkbox-to-ready, including dispatch | **3,624 ms** | **3,494 ms** |
| Prepared Review paint | **32 ms** | **23 ms** |

The earlier reference was approximately 5.2 s; final runs reduce this by about
30–33%. These are observed development timings, not a guaranteed latency SLA.
The complete preparation has not reached 300 ms: fresh remote metadata, native
resolution/extraction, durable jobs and full integrity checks remain necessary.
Prepared Review remains below that target and does not submit another preview.
Both runs had zero browser errors, one preview POST, and no Apply/power/file writes.
The API alone required one authorized dev restart after its source watcher stalled
in graceful shutdown; no migration, extension or Pterodactyl/Wings change occurred.
Synthetic storage benchmarks created and cleaned only their own temporary trees.


Final validation: `pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run
--config vitest.integration.config.ts` for the lifecycle, Satisfactory API,
inventory and worker suites passed 412/412 cases. The four mod domain/cache/sandbox
suites passed 31/31, and all 12 Satisfactory browser journeys passed, including
hover/focus making no version request, rapid edits, exact-key recovery and cached
plan invalidation. `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check`, `pnpm build`
and `pnpm build:runtime` passed; existing lint warnings and bundle-size notices
remain. Independent final review found no open issues. All four dev app services
were healthy after verification. No game-server test assets were created or
mutated. Issue #18 and the remaining M6 playable-client acceptance are unchanged.
Rollback: revert this commit after pending preview deliveries settle; existing
plans, archive caches and recovery formats remain compatible, with no migration.


### Mod-manager scaling: inventories, Apply and repeated selections

Inventory now uses bounded four-way metadata, directory and file-stream work,
with existing download-grant batching in windows of 64. Preview may reuse bounded
descriptor bytes only inside that scan; Apply/reconciliation and capture always
fingerprint fresh bytes. All errors stop scheduling and drain active readers.
The actual-code synthetic 1 ms adapter benchmark improved from 604 to 188 ms for
100 mods with three tiny files each (300 to 200 downloads); 10 mods improved from
69 to 28 ms. This measures local orchestration with simulated transport, not a
100-mod installation on the live provider.

Apply reserves staging before scanning and captures before-images while hashing
the initial inventory. Listed capture sizes must match the reserved managed
manifest before any recovery file is written. Initial hashes perform destination
preflight; unchanged outputs skip mutations. Changed outputs retain fresh
pre-write ownership checks, and a final independent full inventory verifies all
resulting bytes before state commit. Unchanged managed payloads now download twice
(initial capture and final verification), down from six. Local prepared copies are
bounded, private, hash-verified streams. Large baseline/receipt manifests are
budgeted explicitly; retained recovery claims count actual remaining stage bytes.
Retries preserve the original recovery journal and final drift detection.

Checkbox version requests start only on click, with four concurrent requests and
per-mod cancellation. Functional draft updates retain out-of-order selections;
preview waits for pending checkbox lookups and prepares the latest complete draft.
The lightweight recommendation query excludes unused changelogs/dependencies.
Only public recommendation metadata is cached (30 s, 128 entries, 16 MiB); concurrent
build reads coalesce in flight and each caller authorizes before and after. Own
preview activity no longer triggers another UI inventory scan; unrelated operation
completion, revision, external-mode and runtime changes still refresh it.

Native registry snapshots (SQLite and WAL) are private verified copies, bound to
CLI checksum, game build, target set and selected root constraints. Complete
coverage may use the upstream offline resolver within 60 seconds of the original
snapshot; reuse never extends expiry. Missing/new roots, changed identity, expired
snapshots and explicit Resolve again use fresh online resolution. A failed offline
attempt clears and rebuilds its private working tree before the online retry.
The dependency graph still resolves as a whole for correctness; no claim of a
per-added-mod delta solver is made. Archives and all output bytes retain SHA256
verification. No extracted-file cache or parallel download service is introduced.

Per-job limits use one validated contract: output defaults to 2 GiB (also capped
by the server disk limit), archive cache 1 GiB, native metadata 64 MiB and 100,000
output files. Environment overrides are NH_SATISFACTORY_MOD_MAX_BYTES,
NH_SATISFACTORY_MOD_ARCHIVE_BYTES, NH_SATISFACTORY_MOD_METADATA_BYTES and
NH_SATISFACTORY_MOD_MAX_FILES. Existing Owner/user/global staging quotas and disk
admission remain authoritative. Preparation reserves the summed budgets plus
64 MiB headroom; Apply reserves payloads, recovery and bounded manifests. Optional
completed preview caches may be evicted on admission pressure, excluding recovery
assets. Frozen plans must satisfy current limits before Apply. These limits permit
larger modpacks but do not promise that any arbitrary 100-mod set fits configured
storage or has compatible dependencies.

The shared native sandbox accepts a validated per-job file-size ceiling from
NH_CONTENT_MAX_FILE_BYTES (1 byte through 16 GiB), supplied by the trusted caller;
other integrations keep the 512 MiB default. Landlock, seccomp, private stage
ownership, environment clearing and aggregate monitoring remain enforced. The
worker image must be rebuilt for this sandbox change. No database migration or
Pterodactyl/Blueprint modification is required.


Actual worker/storage native metadata-cache comparison, same small-mod fixtures:
1/5/10 selected roots (2/6/11 resolved) prepared in 414/487/825 ms with a valid
registry snapshot, versus the preceding archive-only runs at 1,087/1,101/1,209 ms.
Native startup/resolution/metadata work fell from 765/753/724 to 178/194/240 ms.
These are separate development runs with environmental variance. Outputs were
identical (23/57/103 files, 14.05/16.50/23.03 MB); new roots correctly missed the
metadata snapshot and subsequent covered selections hit it. Original expiry was
preserved across reuse. No 100-mod real-server installation was performed.

Actual full-browser PEP_Mod/SML previews measured 3.938 s (metadata hit), 3.786 s
(expired snapshot, fresh resolution) and 3.040 s (metadata hit). Prepared Review
paint took 27/13/13 ms. Each completed run issued one preview, with zero browser
errors/alerts and no Apply, power or game-file mutations. An earlier attempt
intersected source-watcher reloads and was discarded after an HTML error response;
its preview job completed normally. These full-path results do not establish a
300 ms end-to-end guarantee. Detailed stage diagnostics remain available for
larger inventories and provider transport variability.

Activation rebuilt the normal development image and recreated only the existing
dev worker, after confirming zero running operation jobs. Ports, volumes, networks
and Compose definitions were preserved. API/gateway/Vite followed existing source
watchers; no manual restart of those services, migration, Blueprint update or
Pterodactyl/Wings modification was required. All synthetic benchmark trees were
cleaned. Rollback requires settling outstanding deliveries and rebuilding the
previous worker image alongside reverting the application; older code retains
its lower content limits and cannot manage newly admitted larger mod sets.


Scaling validation: 31 worker, 12 inventory and 13 API integration cases passed,
plus 26 registry regressions, 47 domain/cache/limits/sandbox cases and 13 browser
journeys. The build singleflight fixture initially released its read before both
callers finished authorization under parallel test load; a deterministic
post-authorization barrier corrected the fixture and all 13 API cases passed on
rerun. Coverage includes two-read unchanged Apply, exact retained recovery byte
accounting, oversized baseline rejection before writing, lower-limit frozen-plan
rejection, optional-cache eviction, cancellation/drain, stale metadata, complete
offline-failure cleanup, explicit refresh and per-checkbox request cancellation.
Full types, lint (warnings remain), i18n parity and frontend/runtime builds passed.
Independent final review found no open must-fix findings. Issue #18 and the
previously outstanding full playable-client M6 acceptance remain unchanged.

## Overview, Worlds and Settings — 2026-11-02

The compiled Satisfactory UI module now declares Overview, Worlds and Settings alongside
Mods. Worlds is an integration capability; the common shell only registers bundled
renderers. Overview reads native state while running and the existing encrypted Gateway
observations while offline. Historical data is labelled with its observation time and
never presented as a live player count or current performance. Opening these screens
does not enqueue a start or wake request.

Worlds lists native sessions and save metadata with search and pagination. Save refuses
name collisions. Create and Load require explicit confirmation and first save the active
world to a uniquely named recovery save; failure of that save aborts the map change.
Native map transitions are asynchronous acknowledgements, not proof that loading has
finished. These operations reuse the platform lifecycle lock, authorization and audit
trail. Import/download opens the existing Files workspace at the integration-declared
SaveGames root; existing file permissions, transfer limits and upload/download pipelines
apply. There is no duplicate save transfer service or new filesystem authority.

Settings retains the encrypted application token and server options and adds native
advanced world settings. Only keys returned by the running game can be updated. Enabling
creative mode requires acknowledgement; the submitted session name is checked against
fresh native state to reject a draft for a different world. Native API operations require
a configured application token and a running backend; a stopped server remains stopped.

No database migration, dependency installation, Pterodactyl modification or Blueprint
update is required. Rollback is the previous application revision; preserve existing
saves, credentials and Gateway observations. This does not add factory telemetry,
mod-profile restore points or game-version rollback.

Validation: 214 game/API/transport unit tests passed, plus the five new lifecycle-lock
mutation service tests. Browser fixtures exercise real renderers against controlled API
responses: desktop/mobile EN/IT, permissions, empty/error/offline states, confirmation,
session-bound drafts, and live versus historical overview. Axe checks pass for the
covered screens; screenshots are in `docs/screenshots/m6/satisfactory-{overview,worlds,settings}-*`.
These are UI/contract tests, not a claim of new world mutations on the Owner's live server.
Native request names and payloads follow the shipped Coffee Stain API documentation
([verbatim mirror](https://github.com/robtme/satisfactory-server/wiki/Official-API-Docs)).
Application type checks and production frontend build pass. Only the development API
was restarted under the Owner's standing authorization; no game server data, power,
production infrastructure, migrations or test assets were changed.
The combined Satisfactory Mods/Settings/Worlds/Overview browser regression passes all
17 tests, including the existing mod manager journeys. Final lint passes with existing
repository warnings; typecheck, translation parity and frontend build pass.

Navigation follow-up: public dev Vite responses were verified to include all four
Satisfactory renderers. A new shared-sidebar regression checks their order, selection,
and stale Worlds-capability behavior (six navigation tests pass). Missing Overview
alongside visible Mods cannot be explained by current permission/capability filtering.
Restarted only dev Vite under standing authorization; health and public module responses
pass. Existing browser sessions may need a full reload to discard the older module.

### Registered manifest compatibility and FICSIT navigation

A dev read confirmed `game_integrations.manifest.capabilities.worlds` was still false
from initial registration. Restarting API/Vite does not update that persisted metadata.
Trusted game modules may now explicitly declare `managementCapabilities` whose values
come from their compiled manifest. Satisfactory opts in for players/mods/worlds;
`describeServer` uses these values in both detail and list responses. No DB migration
or metadata mutation is required. Lifecycle/wake/direct policy and permissions are
unchanged, and Minecraft does not opt in. A database integration regression checks the
stale-manifest case and preservation of stored `wake: unsupported` (37 tests passed).

The sidebar places FICSIT Overview in Tools before Worlds and Mods, and labels the
integration settings FICSIT Settings (localized in Italian). Navigation regression
asserts Tools placement. Only development API restarted; no game data changed.
Post-restart read-only verification through `getPlatformServer` against an existing dev
Satisfactory instance returned `worlds:true`, `mods:true`, `players:false`; API healthy.
Nine unit navigation/UI tests, 37 DB integration tests, two focused browser journeys
and typecheck pass. No credentials, world or database metadata changed.

### FICSIT Overview presentation

Overview uses an integration-scoped industrial layout with orange accents and a compact
live/saved-state badge. Removed the historical-state paragraph and standalone absolute
timestamp. A centered footer pairs the accessible refresh icon with a localized relative
last-updated time; the absolute observation time remains available on hover. The local
30-second timer updates the label without extra backend requests. Missing timestamps
are omitted, and failed refreshes retain an honest saved-state badge. Browser checks
cover relative-time advancement, loading/empty/error data, desktop/mobile and Axe;
updated EN/IT screenshots are included. No API or infrastructure change is needed.

### Readable progression labels

The integration-owned `ui/progression` resolver converts native Unreal object references
into localized labels. Project Assembly shows the current phase with a bundled vector
Space Elevator symbol; this is an original panel icon, not an extracted game asset.
Phase 0 is Establishing Phase, **not** phase 1. The initial current/target distinction
and phase 0–7 names are verified against
[SCIM SpaceElevator.js, pinned revision](https://github.com/AnthorNet/SC-InteractiveMap/blob/fb56486f6750fca69e035f53cfec032ef1805390/src/Building/SpaceElevator.js).
The next delivery is a different value and is not inferred by this display.

Active milestone recognizes 48 vanilla progression/tutorial names from the
[SatisfactoryTools 1.0 game-data export](https://github.com/greeny/SatisfactoryTools/blob/74b691c82ed69030f32cd9419d8c327c878e2ac8/data/data1.0.json),
with original namespace checks consistent with the
[modding asset tree](https://github.com/satisfactorymodding/SatisfactoryUnrealProject/tree/master/StarterProject/Content/FactoryGame/Schematics).
These are a verified baseline, not a claim that all future game/mod assets are catalogued.
Italian labels are NickPanel translations. Unknown references are converted to readable
asset labels (or a neutral unknown label for malformed input), never fetched remotely
or rendered as HTML. A mod reusing a vanilla basename does not get its translation.
`None` and empty values indicate no active phase/milestone. No API, DB, game files,
permissions, power operations or deployment changes are involved.
Validation: eight game UI/resolver tests and the focused desktop EN/mobile IT browser
journey pass, including native Phase_0/Schematic_1-1 inputs, dynamic freshness and Axe.
Typecheck, scoped lint, translation parity and frontend build pass. Updated screenshots
were inspected; the public dev frontend serves both progression resolvers.

### Worlds: streamed sessions, saved observations and safety history

The Worlds screen groups native save headers under their actual session. Its FICSIT
layout shows compact world cards. Opening one world switches to its own URL-addressable
view, with searchable/paginated history and retention settings. Browser back/forward
and reload preserve the selected session by name. Manual, autosave and platform safety
categories remain available; technical filenames remain accessible in save details.
Worlds and Overview use the same FICSIT surface, header, orange mark, source badge and
last-updated footer components and styles. Safety labels require matching server-operation evidence, not just a filename
prefix. The previously observed `nh-stop-<job UUID>` entries are lifecycle safety saves,
not separate worlds; native `ServerSettings.*.sav` is not a world either.

`GET /v1/servers/:id/satisfactory/api/worlds/stream` supplies authenticated NDJSON.
It emits the existing encrypted Gateway observation first, including its actual age,
then incrementally parses native session names and save headers over the existing
certificate-pinned transport. The browser batches rendering and does not wait for the
whole enumeration. Live records remain provisional until the full JSON envelope and
schema pass validation. Disconnect, truncation, invalid JSON or a late native error
cannot replace the last complete snapshot. There is no separate world-cache store.

Backend process state and application readiness are distinct: during startup the saved
list stays visible, actions requiring a ready native API remain disabled, and the UI
refreshes until ready. Offline reads do not start the game. No prior observation is an
unknown list, not proof of an empty server. World changes also invalidate the actual
advanced-settings query key.

Native enumeration accepts up to 16 MiB, 1,024 sessions and 32,768 save headers (4,096 per
session). Other cached API functions retain 64 KiB limits. Private Gateway snapshots
allow 32 MiB + 512 KiB to accommodate escaped JSON strings, with a route-specific body
limit applied after Gateway authentication. Ordinary requests, routing snapshots and
console responses retain their existing limits. Compressed captures have explicit
input/output bounds and two concurrent capture slots; capture saturation never holds
up native passthrough. Gateway observation caches have a 64 MiB process budget. Worlds
streams, including cached reads, are pull-driven, cancellation-aware and globally limited to four;
overlapping requests for the same server share completion.

Migrations 061–062 add per-session retention policies and immutable, job-bound safety-save
receipts. Fixed-size SHA-256 session keys support long Unicode names without exceeding
PostgreSQL index limits; the database checks each key against the complete original name. Default retention is five verified platform saves per session; the UI accepts
1–100, with `SATISFACTORY_SAFETY_SAVE_RETENTION` as the deployment override. Policies
use the existing server permission and lifecycle lock. Automatic rotation runs after
confirmed stop, preserves a verified recovery anchor, and rechecks file metadata and
SHA-256 before deletion. Manual saves and autosaves remain excluded. Owner-authorized
legacy adoption includes old `nh-stop` files only when a successful same-server lifecycle
job and native session/time metadata identify them. At confirmed stop, stable file
metadata and a streamed SHA-256 establish an immutable receipt with the historical save
time; existing receipts and deletion tombstones are never overwritten. Adoption records
the current verified bytes, not an unavailable historical hash. Failed or ambiguous
checks retain files. Maintenance failure does not turn a successful server stop into a failed one.

The common Files workspace remains the upload/download authority. Its writes share the
lifecycle lock. Direct external provider/SFTP writes cannot be made atomic with the
provider's delete endpoint; hash and metadata checks detect prior changes but cannot
provide compare-and-delete against a concurrent external writer. This does not change
the separate issue #18 production-release gate.

Rollback: restore the previous application revision while retaining migrations 061–062,
policies, receipts, encrypted observations and all remaining world data. Retention
deletions cannot be undone by a code rollback; restore an independent backup if needed.
Do not restore an old database over later user writes. No Pterodactyl/Wings patch,
Blueprint update or new transfer infrastructure is involved.

Validation (2026-11-04): 344 unit/transport tests, 452 isolated database/Gateway/lifecycle
integration tests and six real-browser Worlds journeys pass. Coverage includes native
TLS records arriving before response completion, reordered JSON fields, large Unicode
payloads, cached startup transitions, truncated responses, timeout of paused readers,
global stream admission, long uncompressible session names, receipt changes and stop
finalizer failure. Browser tests also exercise 2,500 saves with bounded rendered rows,
EN/IT desktop/mobile layouts, keyboard labels and Axe checks. Typechecks, frontend and
runtime builds pass; lint retains the existing 104 warnings and one informational item.

Read-only development evidence: the stopped Satisfactory test instance supplied one
cached session, seven saves and six journal-proven safety labels. First event 22 ms,
completion 26 ms measured inside the API container; these exclude browser/network time.
Its operation count stayed 68 before/after, with no wake or game-file mutation. Migrations
061 and 062 were applied through the normal migrator after private backups; all earlier
checksums were verified unchanged. The independent review findings on long-name indexes
and cached-stream cancellation were corrected before final deployment.

### World detail views and historical safety-save adoption — 2026-11-04

World history and retention now live inside a selected world instead of expanding
every card in the list. The session-name URL preserves selection through reload and
browser history; save actions cannot accidentally save the active world from another
world's detail screen. Overview and Worlds share the actual FICSIT framing components
and CSS, with browser assertions comparing title geometry, padding and the orange mark.
The native dotted UTC save timestamp and ISO timestamps use one browser-safe parser
for both display/sorting and retention provenance.

Legacy adoption runs inside the existing confirmed-stop finalizer, after a fresh recovery
save is captured. It checks successful completed same-server jobs, a unique matching
native session header, storage location and timestamp window (including native
second precision), then fingerprints the stable file. It adopts at most eight old
files per pass within the shared ten-second maintenance budget, and removes at most
two excess verified copies. Subsequent stops continue the backlog. Older files do not
become the newest recovery anchor when enrolled. Missing evidence, changed metadata,
symlinks and existing receipt/tombstone conflicts retain the file.

No schema change or separate job/transfer pipeline is needed. Read-only inspection of
the six historical files on the development test instance confirmed native UTC save
times, successful operation windows and file modification times one second later.
Actual enrollment and cleanup occur through subsequent normal stops; no game was
started or stopped to force cleanup during this change.

Follow-up validation: 25 unit/module/date tests, nine isolated database tests and
eight browser journeys pass, including historical adoption/rotation, cross-server
exclusion, native UTC formatting, URL history, unsaved edits and inactive-world actions.
Typechecks, frontend/runtime builds, translation compilation and lint pass. API and
worker were restarted under the standing development authorization; the public dev
frontend serves the shared frame and detail navigation. All four dev services remain
healthy. No migration, new game asset or Pterodactyl/Blueprint change was required.

### Phase 1: optional first-run setup and native API reliability — 2026-11-05

Owner decisions for issue #30: untested builds do not block creation, startup,
updates or normal gameplay; technical Gateway compatibility information is not
added to user screens. The native offline-authentication profile remains guarded.
Automatic sleep now also requires a fresh, generation-bound UDP observation of a
build supported by that profile. An unknown build stays online instead of sleeping
into an unavailable authentication flow. Manual power/forced-sleep controls and
online forwarding retain their existing semantics.

The creation wizard offers setup in the Satisfactory client (the default) or setup
in NickPanel. Client setup omits the setup object entirely, including after switching
away from populated password fields. It performs no claim, password assignment or
application-token generation. Panel setup accepts an administrator password and an
optional distinct player password; inputs are masked and omitted from review and
browser storage. The common wizard gained a declarative form page and secret-text
field support, preserving the existing installer components and styling.

Panel setup is persisted in the existing encrypted secret store, never provider
environment variables, operation plans or audit payloads. Public request hashes
contain only setup presence; an encrypted receipt preserves changed-credential
idempotency checks after setup consumption. A trusted post-start hook runs under
the current lifecycle lock and uses the existing retry/wait mechanism. Setup also
runs after a deferred first manual start when auto-start was disabled. Native
PasswordlessLogin, ClaimServer, SetClientPassword and RunCommand generate real
credentials over the existing pinned TLS transport. The resulting application
token is checked against native state and stored in the existing token namespace.
No world is created implicitly; existing Worlds/client flows remain authoritative.

Durable encrypted stages recover interrupted claims using the originally supplied
password only after a recorded claim attempt. An already-claimed server is never
reset or silently adopted. Transient API startup failures retry within ten minutes;
definitive refusal or expiry clears pending credentials, reports the setup failure
and preserves the running game. Confirmed deletion clears setup-owned secrets.
Successful setup consumes temporary credentials and is not replayed on reinstall.

Native errors now map to finite localized authentication/setup/readiness/save/action
errors; raw native messages and data are never propagated. Rejected game credentials
do not return a panel-session 401. Settings distinguish saved API credentials from
a live successful connection and refresh native options after token replacement.
No new schema migration, dependency or Blueprint/Pterodactyl change is required.

Rollback is application-code rollback, retaining existing server identities, tokens,
worlds and secret-store data. Before reverting with pending setup requests, complete
or explicitly cancel those requests; older code cannot consume their encrypted state.
Do not restore an old database over later user data. Game-client playable-session and
SMM desktop acceptance remain separate from the automated evidence recorded below.

Phase-1 validation: 37 native API/transport/route tests, 45 focused Gateway/auth
regressions and 25 wizard/SDK tests passed. Ten isolated setup DB tests and four
provisioning DB tests cover encrypted persistence, idempotency, claim-response loss,
pre-dispatch recovery, deferred first start, cleanup and installed/running-state
preservation after setup refusal. Test-fixture provider identity/clock collisions
were corrected before the final targeted passes. Three wizard browser journeys
(desktop EN/mobile IT, skip after editing credentials, masked opt-in setup) and one
Settings token-replacement regression passed. Wizard Axe checks found no violations;
reviewed screenshots are `docs/screenshots/m6/satisfactory-wizard-*`.
Full typechecks, frontend/runtime builds and lint passed (existing 104 warnings and
one informational lint item). These are automated/isolated-provider checks, not a
new real Steam/Epic playable-client or SMM desktop acceptance claim. No game instance
was created, started, claimed, reset or deleted for this phase's verification.

Development activation restarted only the verified API, worker and Gateway under
standing authorization after confirming zero running operation jobs. API/worker
and Vite health checks pass; Gateway's authenticated Unix readiness check passes
following its first snapshot. The public development frontend serves the form-page
wizard. No database, DNS, Blueprint/Pterodactyl or existing game-data mutation was
performed. Existing withheld unrelated routes retain their safety checks.


### Phase 1 — Owner native-client acceptance (2026-11-05)

The Owner completed all three agreed first-run journeys using their Arch Linux
laptop and the latest Satisfactory client available on the test date (exact build
not recorded): client-side setup, automatic panel setup, and panel setup deferred
until the first manual start. All three succeeded. The Owner explicitly removed
the fourth Gateway sleep/wake acceptance check from this phase; broader Gateway
stabilization remains a separate future scope. These observations do not assert
additional Steam/Epic, modded-client or SMM coverage.

Client-side setup intentionally does not provision an application API token. Its
`nickhosting stop` attempt correctly refused before requesting a stop because the
panel could not verify the save. To enable that operation, generate a native token
with `server.GenerateAPIToken` and verify/store it through FICSIT Settings. Both
panel-configured journeys supplied the token automatically; the Owner also
confirmed the console stop command succeeded in the automatic-setup journey.

Two fresh SteamCMD installations initially failed with `Missing configuration`
after SteamCMD bootstrap; a subsequent installation succeeded. This is installer
acceptance evidence, not a native setup failure. The requested follow-up uses
bounded automatic installation retries and keeps unrelated failure handling intact.

FICSIT Settings now shares the Overview/Worlds header and surface. Connected API
credentials hide setup instructions behind an explicit replacement action. Known
server options have English/Italian names and supported boolean encodings use
localized dropdowns without changing their native serialization. Pending boolean
values are localized too. Unknown/mod settings retain their native values. Numeric
weather/network preset mappings are not guessed; verified enum presentation is
tracked in phase 5 (#34). Three focused browser cases passed, including Italian
accessibility, world-change guards and token rejection/recovery; desktop/mobile
and unconfigured screenshots were refreshed and reviewed.

Installation retries are contributed through the existing Owner integration UI and
platform settings pipeline. `satisfactoryInstallationRetries` defaults to 2, accepts
0–5, and has environment override `NH_SATISFACTORY_INSTALLATION_RETRIES`. Only fresh
installer output matching app 1690800 `Missing configuration` qualifies. The same
operation keeps its reservations and installer state; attempt budgets are journaled
with dispatch, previous completion events are fenced out, and both game/installer
processes must be confirmed stopped before retry. Successful installation cannot
be retried. Exhaustion or unrelated errors retain normal failure/reinstall behavior.
Live adapter output covers rapid failures; a bounded log-flush grace avoids racing
collector writes. The shared failure path can wait roughly two additional seconds
for diagnostics on other games, but does not retry their installers.

Follow-up validation: 16 focused unit/adapter checks, six isolated lifecycle DB
cases, and four focused browser cases passed (three Settings and one Owner retry
control, including environment lock and zero retries). Independent review found no
remaining blockers. No database migration, Blueprint update or game operation was
required. Rollback uses the previous application code, preserving settings, TLS/API
credentials and game data; settle in-flight installation operations before rollback.

Full typechecks, frontend/runtime builds and lint passed (existing 104 warnings and
one informational item). The new optional Owner section background exposed a
rendering assumption; the common contribution renderer now guards its absence.
Development activation restarts only the existing API and worker after confirming
zero running operation jobs; no game server was started, stopped or reinstalled.
Phase 1 is accepted by the Owner; phase 2 remains unstarted.
