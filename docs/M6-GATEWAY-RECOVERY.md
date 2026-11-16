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
ordered protocol roles within each server. Before opening new listeners it uses
fresh provider and host evidence. Host observations for pre-bind checks may be
shared only while a read is in progress; later admissions require another read.
The complete Docker container/network inspection uses a pool of at most four
commands, preserving per-chunk identities, final inventory checks and corroboration
of every reported disappearance. Lease, evidence-age, namespace, ownership,
all-provider allocation and Docker configured-binding collision checks remain mandatory. A failed apply waits for
issued bind workers and closes their staged listeners before returning.

Diagnostics preserve finite validation reasons instead of reporting every local
validation failure as a Core communication failure. The lease duration and safety
age limits are unchanged.

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
