# Development operational prerequisites

## Owner decision: direct Docker observation

On 2026-10-10 the Owner explicitly chose direct Docker socket access for both dev
and future production. Dev and prod will **never run simultaneously** on this
host. Their independent reservation databases therefore do not need a shared
admission coordinator under this constraint. This is an operating requirement,
not an automatically enforced distributed lock.

API/worker use the existing Pterodactyl adapter's fixed Docker observation commands.
The development overlay is [compose.dev.observer.yaml](../compose.dev.observer.yaml);
production has its [separate overlay](../compose.prod.observer.yaml), configuration
only. A pinned Docker CLI is included in both application image stages. Neither
frontend nor migration tools receive the socket or observer configuration.

Direct socket access grants Docker API authority even with a read-only bind mount.
The application currently issues read-only observation commands, but compromise
could affect unrelated containers or the host. Non-root UID, capability dropping
and no-new-privileges do not remove this authority. The Owner accepted this interim
risk; [issue #22](https://github.com/ImJstNickDev/nickhosting-panel/issues/22) tracks
restricted observation alternatives. SFTPGo issue #18 remains a separate gate.

The previously prepared host helper was **never activated** and has been removed
from the active implementation. Its historical commit `3fe39e5` remains a possible
reference for future hardening. No user service, lingering change, new network,
Wings mount, production deployment or host socket permission change is required.

## Configuration and daily operation

Private development environment inputs:

```dotenv
COMPOSE_FILE=compose.dev.yaml:compose.dev.real.yaml:compose.dev.observer.yaml
NH_DEV_PHYSICAL_HOST_ID=your-stable-host-identity
NH_DEV_DOCKER_GID=your-existing-socket-group-id
```

Use the actual numeric Docker socket group, without chmod/chown on the host socket.
The overlay injects paired scoped socket/observer settings only into API/worker.
The disk probe `/app/mountdata` uses the already-existing application bind mount;
it must be on the same verified filesystem as game storage. Recheck this if storage
moves; do not infer disk capacity from an unrelated container overlay filesystem.
Physical memory comes from host `/proc/meminfo`; CPU uses the full host CPU counter
set rather than the API/worker cgroup quota. Invalid samples fail closed.

```sh
docker compose --env-file .env.dev.local config --quiet
docker compose --env-file .env.dev.local build api
docker compose --env-file .env.dev.local up -d --no-deps --wait api worker
# Normal later lifecycle, preserving all data:
docker compose --env-file .env.dev.local stop
docker compose --env-file .env.dev.local up -d --wait
```

No explicit `-f compose.dev.yaml`: that would discard the private overlay selection.
The dev web ingress stays on its existing external network with unchanged HTTPS
and Vite WSS/HMR. No host ports are added. PostgreSQL, Redis, mail and Owner data
remain independent from production and are not reset.

Production uses `compose.prod.yaml:compose.prod.observer.yaml`, its own private
`NH_PROD_PHYSICAL_HOST_ID`, `NH_PROD_DOCKER_GID` and immutable application images.
Stop dev before any separately approved production deployment. No production
service is started by preparing or activating the development configuration.

Rollback: restore the previous two-file dev `COMPOSE_FILE` and recreate only
API/worker. Keep all data and Owner settings. Without observation, operations that
require resource admission correctly fail closed. No cleanup of game resources.

## What the Owner configures

No physical host, managed node, runtime mapping, rollout or evidence row is seeded.
Use the private handoff values for observer identity and `/app/mountdata` as the
verified filesystem probe. Choose budgets/headroom from actual host measurements,
not aggregate Pterodactyl allocations. The container Docker socket path is supplied
by the environment and does not need to be entered again in Owner settings.

Then configure the provider node, provisioning account, explicit backend allocation
pool, and Vanilla egg/image/startup/variables. Application users-read permission and
a Client key controlling the provisioning account are required. Set the Minecraft
metadata user-agent with a real HTTPS contact URL and configure trusted Wings
WebSocket/upload/download origins as appropriate. No existing servers are imported.

Minecraft evidence must match the exact runtime/mapping/binding and its trusted
verification key. Historical M4 evidence cannot automatically certify newly created
mapping identities. Configuration alone does not create evidence. Separately
approved Gateway endpoints/listeners remain necessary for Gateway gameplay and
sleep/wake. This change does not start that service or open game ports. SFTPGo stays
disabled as accepted by the Owner. Environment observation readiness is distinct
from completed game certification and an end-to-end Create/Start/Play validation.
