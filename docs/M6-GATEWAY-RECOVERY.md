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
Lease, evidence-age, namespace, ownership, all-provider allocation and Docker
configured-binding collision checks remain mandatory. A failed apply waits for
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
