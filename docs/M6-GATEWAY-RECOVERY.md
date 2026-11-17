# Gateway restart recovery and immediate resource changes

This scoped M6 follow-up fixes Gateway recovery after a host reboot and removes
fixed waits from resource-limit changes. It does not change game files, provider
configuration, admission policies or the production-release gate in issue #18.

## Host reboot

Development Gateway Compose mounts the host init process's network namespace
(`/proc/1/ns/net`) and socket tables (`/proc/1/net`) read-only. It no longer binds
the proc directory of a user-session PID that disappears after reboot.

The observer supports both the legacy proc symlink and a mounted namespace handle.
For the handle it opens without following symlinks, verifies Linux `nsfs`, and
compares the inode with the current network namespace and the Owner's namespace
pin. It repeats the identity check after collecting socket metadata. Missing,
unreadable, foreign or ordinary-file proofs fail closed. Existing service UID,
capabilities, network mode and Docker-daemon identity checks remain in force.

The live deployment preflight used an isolated disposable container with the
service UID, no capabilities and the existing confinement settings. The mounted
namespace and all four socket tables were readable. A second preflight exercised
the real network observer against the existing host inventory without opening a
listener. A full host reboot was not performed.

## Route validation

The Gateway validates independent server groups with bounded concurrency, retaining
ordered protocol roles within each server. Previously withheld routes join the
shared renewal pass, avoiding repeated pre-bind scans while they remain withheld;
a recovered route still requires fresh admission. Existing listeners renew once; new
listeners receive one complete fresh admission immediately before staged binding.
All issued work settles before rollback and no staged listener forwards until commit.

Core supplies one authenticated evidence envelope with configuration, route snapshot,
contexts, persisted proofs and provider inventories. Original source timestamps,
complete inventory checks and exact route identities remain authoritative. Contexts,
claims and proofs use set-based reads; snapshot state/protocol resolution is shared
only within one construction, once per server rather than once per role.

Host observations use pooled GET-only Docker Unix HTTP with bounded concurrency,
response sizes and deadlines. There are no Docker CLI child processes. All containers
(including stopped configured publications), all networks and provider allocations
remain included. Native missing-container responses require exact disappearance
corroboration; invalid sibling evidence prevents a churn retry. Namespace identity
and socket ownership checks remain in place.

Container, network, publication and socket indexes are built once from a private
immutable host observation; allocation indexes are scoped to one provider batch.
For exactly unchanged routes, fresh host acquisition overlaps the Core request.
New, changed and rebound routes use a distinct post-Core observation epoch, never
an older in-flight read. Prefetch is cycle-local and cannot grant or extend authority.
Identical
in-flight game and node probes share work without caching settled reachability.
Periodic gameplay observations use committed route authority. Unknown infrastructure
observations suppress lifecycle reports rather than reporting a negative game result.
The probe, control, provider and host-observation paths accept cancellation; shared
work is cancelled when its last consumer leaves. Abandoned work cannot start subsequent proof writes or publish a late grant or
observation. Already-issued writes retain their Core revision checks; repeated
callers cannot queue obsolete renewals.

Lease duration, evidence-age, namespace, ownership, all-provider allocation and
Docker configured-binding collision checks remain mandatory. Diagnostics preserve
finite failure reasons, including validation timeouts.

## Resource limits

`configure` now requires a fresh physical stopped proof and no conflicting resource
reservation, instead of waiting for the cached-resource settling timer. It repeats
the proof at the effect boundary after durable preparation and authorization.

After the absolute build PATCH it immediately reads back the provider server using
the existing ownership check. Completion requires matching allocation, resource
limits and feature limits. A lost PATCH response can complete only if that readback
proves the desired configuration. An unavailable or mismatching readback retains
recovery, with phase-local retry backoff; normal successful changes need no delayed
job delivery. Settling rules for destructive operations are unchanged.

## Administrator capacity override

Manual operations submitted by a platform Owner can exceed the resource owner's
active CPU/RAM quota as well as the existing physical compute limits. This covers,
for example, an Owner starting a server configured at 600% CPU while the user's
default quota remains 400%. The quotas themselves are not rewritten.

The request and current actor must both have Owner authority. Automatic wake,
schedules and Gateway-console operations do not inherit this exception. Required
host observations, enabled nodes, ownership, storage checks and serialized
reservations remain enforced. A waived capacity check creates a durable audit event
and job attribution; the worker rechecks that attribution and current role before
dispatch. No client-supplied bypass flag is accepted.

## Validation and activation

Focused tests cover mounted namespace identity and replacement, missing evidence,
Compose confinement, multi-route lease budgets, bind rollback, configured-binding
collisions, immediate resource-change completion, physical proof failures and
uncertain provider responses. Commands and final live verification are recorded
with the change's review evidence.

Activation requires the complete existing Compose overlay and private-env chain.
Recreate only the Gateway to adopt its new mounts; reload API/worker only as needed
for lifecycle code. No database migration or dependency upgrade is required.
Preserve old images and private configuration before activation.

Rollback is a code/image rollback with matching deployment configuration. Do not
restore database or game data. The legacy proc-PID mount must be reverified before
reuse; restoring a path to a dead PID cannot restore service. Retain a valid host
namespace proof and all configured safety checks.

### Recorded checks

All commands use `scripts/dev.sh` to select the repository-pinned Node runtime.

- `pnpm exec vitest run apps/game-gateway/src/data-plane.test.ts packages/gateway-safety/src/validator.test.ts`: **379 passed**.
- `pnpm exec vitest run packages/pterodactyl-adapter/src/network-observer.test.ts scripts/gateway-deployment.test.ts`: **69 passed**.
- `pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/lifecycle.integration.test.ts packages/server-management/src/lifecycle-delivery.integration.test.ts`: **400 passed**; the final configure-focused rerun passed **17** cases.
- `pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/admin-capacity.integration.test.ts packages/server-management/src/runtime.integration.test.ts`: **124 passed**, including final override regressions. The earlier admission/admin run passed **45** cases.
- `pnpm typecheck`: passed, including web and test types. Final root TypeScript check after the override also passed.
- `pnpm lint`: passed with existing warnings; modified source files passed scoped Biome checks.
- `pnpm test --maxWorkers=2`: **4,670 passed, 1 skipped, 1 failed**. The failure is the existing missing `owner.config.satisfactoryInstallationRetries` catalog label. The schema, catalog and failing test were unchanged by this follow-up. The initial unrestricted run was interrupted after resource-contention timeouts; the bounded run completed without those timeouts.

Independent review covered bind freshness/rollback, namespace evidence and the
Owner override's final-effect authorization. API and worker were restarted only
within the approved application scope; the Gateway was recreated with the latest
local image and stable proof mounts. No provider or host-network configuration was
changed. The Owner authorized one normal Start on the affected existing server;
the API accepted it and recorded the user-compute exception in the audit.

The final observer refinement passed **58 observer tests** and TypeScript/Biome;
its validator regression suite passed. An existing wall-clock data-plane test
failed once during combined execution and passed on its focused rerun. Three
read-only observations in a disposable container with the Gateway's 256 MiB/1 CPU
limits took **1,490 / 1,159 / 1,433 ms**, versus the earlier 2,746 ms observation.
A diagnostic attempt to load an additional TypeScript runtime inside the live
Gateway exited 137 and coincided with one automatic Gateway restart. Subsequent
benchmarks used disposable containers; no memory limit was increased.

Final activation used the reviewed observer pool and retained the existing image,
confinement and stable mounts. The Gateway became healthy with **18 admitted routes
of 26**, eight withheld under their existing safety conditions. Authenticated
readiness returned HTTP 200; snapshot refresh was approximately **3.0 s**, backend
observation approximately **0.5 s**, and snapshot errors/lease expirations were
both **zero after the final restart**. No full host reboot was performed.

The affected server completed its Owner-authorized start at 600% CPU. Both its
LAN IP:port and hostname returned the real Minecraft 1.16.5/Forge status; server
logs also confirmed an actual client login. The normal idle policy subsequently
slept it after the player left, and the Owner later started it again. No further
agent game-power operation was performed. Final IP and hostname status checks
again passed after the Gateway restart. Internet-side reachability and a complete
Minecraft play session were not independently exercised by the agent.


## Efficiency follow-up — 2026-11-17

The first recovery proved short-term reachability, not sustained stability. Further
live evidence showed recurring lease expiry and full admission repeated during
recovery. The follow-up above removes duplicate work rather than extending leases.
Direct backend status measurements were 81–92 ms including Python startup; the
initial failing full refresh exceeded 15 seconds and later reached 25 seconds.

The work is separated into native observer transport, aggregate Core evidence,
single admission/probe coordination, snapshot query reuse, and cancellation. Each
has focused regression coverage and independent source review. No game power or
file operation is needed for this follow-up. Final measured activation evidence is
recorded below after verification; intermediate healthy checks are not a durability
claim. Background/event-only inventory caching is not used to weaken freshness or
hide incomplete inventories.


### Targeted follow-up validation

- Native observer/transport: 51 focused tests, plus identity/duplicate and cancellation regressions.
- Final data-plane/validator suites: **403 passed** (215 data-plane, 188 validator), including single admission, 18 retained/8 withheld renewal, cancellation and fresh prefetch fences.
- Runtime/control/node challenge suites: **83 passed** after signal wiring; final coalescer suite **13 passed** after independent fresh epochs.
- API evidence: **4 isolated integration cases passed**, including membership addition/withdrawal and identity change during provider reads.
- Snapshot state reuse: one focused integration regression passed, proving one state read for sibling routes and fresh state on the next snapshot.
- `scripts/dev.sh pnpm typecheck`: passed for root and web. Root TypeScript passed again after the final prefetch integration.
- `scripts/dev.sh pnpm lint`: passed with the existing 104 warnings and one informational diagnostic. Changed files passed scoped Biome; `git diff --check` passed.
- Independent reviews covered native transport, evidence identity/freshness, cancellation, indexing, withheld-route recovery and distinct prefetch/prebind epochs. Existing very short wall-clock tests that failed under combined load passed focused reruns; their deadlines were not relaxed.

No broad unrelated test suite was repeated for this follow-up. No dependency,
DB migration, host port/network/DNS change or game-power operation was required.


### Final live acceptance

Final Gateway activation: 2026-11-17 16:39:33 UTC. The final Core-only cleanup was
activated afterward; its cold API restart exceeded the 15-second lease and caused
one maintenance disconnection. Minecraft itself was never restarted or stopped.
This incident is separate from the subsequent steady-state acceptance window.

During the final **139-second window**, **70 refresh cycles** completed with **zero
new snapshot errors and zero new lease expirations**. All 45 sampled readiness
responses were healthy, with two active connections. Both the configured LAN
endpoint and hostname returned actual Minecraft/Forge status with two players.

| Measured phase | Median | 95th percentile | Maximum sampled |
| --- | ---: | ---: | ---: |
| Complete renewal | 975 ms | 1,414 ms | 1,720 ms |
| Core evidence fetch | 690 ms | 1,092 ms | 1,490 ms |
| Snapshot validation/application after fetch | 253 ms | 489 ms | 601 ms |
| Periodic backend probe | 13 ms | 118 ms | 247 ms |

Host acquisition overlaps the Core request, so the application phase is the
remaining validation/application work, not a separate measurement of the entire
host scan. These are sampled steady-state measurements, not startup latency or a
latency guarantee. Typical complete renewal is now subsecond, but the proposed
**one-second p95 target was not reached**. Core-fetch tails remain measurable;
no lease or observation-age limit was increased to conceal them.

Root/web type checks and scoped regression evidence are recorded above. Final
Core cleanup additionally passed its targeted history/policy regression, root
TypeScript in the isolated checkout and independent review. Only scoped API/Gateway
activation occurred; no new real game asset, provider/host configuration or game data
change. Temporary implementation worktrees were removed. No full host reboot or
Internet-side client test was performed.
