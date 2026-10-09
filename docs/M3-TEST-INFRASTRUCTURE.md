# M3 isolated network fixture proposal

**Status: the Owner approved this exact isolated stack, scoped fixture stop/start
and cleanup during M3. Execution evidence is recorded separately.**

The separate unit suites validate the Gateway transport and safety gate. This
proposal exercises them together with actual Docker bindings and Linux socket
observation, without changing existing Pterodactyl allocations or networks.

## Exact proposed resources

- Compose project and newly created bridge: `nickhosting-m3-network-tests`.
- Two fixture containers: a synthetic TCP/UDP game with two roles and a persistent
  nonce challenge responder. Each is limited to 128 MiB, 0.5 CPU and 64 processes.
- Pinned, already-present official image
  `node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf`.
  This plain JavaScript fixture does not change the project's Node 24.21.0 pin.
- One read-only fixture script mount. No Docker socket, production path, Wings
  data, credentials, existing network or persistent volume enters a container.
- A generated private subnet is checked against all current Docker subnets and
  host IPv4 routes. Docker's newly created bridge gateway is the explicit backend
  bind IP for this fixture only; product code never infers a Wings bridge IP.
- Three selected high ports, checked against current host sockets and Docker
  publications. Each game port is published on the exact new private bridge IP
  for both TCP and UDP; the node-probe port is likewise private. Gateway test
  listeners use exact loopback, with the same numerical game ports.
- A normal project bridge with NAT is required. `internal:true` suppresses the
  relevant host publication on the installed Docker version. This project joins
  no existing network; Docker will create/remove only its normal rules and links
  for this new bridge. It does not edit existing networks or firewall policy.

The fixture game receives an independently generated UUID container name and
Pterodactyl-shaped labels strictly to test exact identity observation. It is not
a real Panel server and is never imported there. A private ledger under
`./mountdata/test-assets/` must record the created container IDs, network ID,
configured UUID, creating run and timestamps before scoped restart/cleanup.

## Preparation and proposed commands

Local preparation performs only read-only discovery and writes a new mode-0600,
gitignored environment; it refuses to overwrite existing state:

```sh
python3 scripts/m3-network-fixture-prepare.py
docker compose --env-file .env.m3-network.local -f compose.m3-test.yaml config --quiet
```

After reviewing that exact environment and granting approval:

```sh
scripts/dev.sh pnpm exec tsx scripts/m3-network-fixture-run.ts --owner-approved --phase preflight --existing-node-policy .codex/local/m3-network-policy.json
docker compose --env-file .env.m3-network.local -f compose.m3-test.yaml up -d --wait
# Record and corroborate the project-owned container/network provenance.
scripts/dev.sh pnpm exec tsx scripts/m3-network-fixture-run.ts --owner-approved --phase online --existing-node-policy .codex/local/m3-network-policy.json
docker compose --env-file .env.m3-network.local -f compose.m3-test.yaml stop game
# Verify sleeping-listener restart with the same-address node challenge.
scripts/dev.sh pnpm exec tsx scripts/m3-network-fixture-run.ts --owner-approved --phase sleeping --existing-node-policy .codex/local/m3-network-policy.json
docker compose --env-file .env.m3-network.local -f compose.m3-test.yaml start game
# Verify readiness, forwarding recovery and unchanged container identity.
scripts/dev.sh pnpm exec tsx scripts/m3-network-fixture-run.ts --owner-approved --phase recovered --existing-node-policy .codex/local/m3-network-policy.json
docker compose --env-file .env.m3-network.local -f compose.m3-test.yaml down
```

No real public game listener or production allocation is part of these commands.
Fresh provider allocation inventory remains mandatory before loopback Gateway
binds. The fixture harness must combine synthetic fixture ownership with read-only
inventory of existing direct servers; it must not erase real-host conflicts or
mock away host socket/Docker publication checks. Readiness means the explicit
fixture challenge response, not claimed Minecraft or Satisfactory compatibility.

## Risks, rollback and prerequisites

The new bridge consumes one disjoint route and small bounded CPU/RAM. Docker may
fail to publish the exact private IP/port; that is a failed test, not permission to
change Wings, production networks or firewall rules. New conflicts or uncertain
provenance stop execution. Cleanup is the project-scoped `down` above, after
matching the durable ledger; never use global prune or unrelated container actions.
Only local evidence files remain after cleanup.

Gateway observes its actual current-user network namespace, host sockets,
interface ownership and the pinned local Docker daemon. Production deployment
still requires independent Owner verification of the host namespace observation
path; `/proc/1/ns/net` is unreadable to the current user. No permission/mount change
is implied by this proposal. No production Gateway reachability is claimed by a
self-namespace parser smoke test or by these isolated fixtures.

The fixture harness never creates, stops, starts or deletes Docker resources and
never calls a mutating Pterodactyl method. It requires `--owner-approved`, the
exact already-created project, pinned image, reviewed private environment, exact
read-only script mount and an ignored existing-node network policy. It retains
fresh read-only inventory of every real provider node/allocation and synthesizes
only its proven fixture's ownership. Namespace and daemon identities, container
creation timestamps and Compose scope are corroborated before a durable ledger
is written. Later phases require the same recorded container/network IDs and
configuration hashes; mismatches or a stale fixture lock stop the run.

Each online phase tests four actual routes (two roles, TCP and UDP) with 32
concurrent binary clients, equal numerical ports on loopback and the separate
private binding, Gateway restart, route removal and stale snapshot rejection.
The sleeping phase requires the game container to be actually stopped, retains
the prior binding proof and verifies fresh TCP/UDP node challenges; passive
status probes must not request wake. Actual backend challenge responses establish
readiness after the coordinator separately starts the same fixture container.
All raw metadata, proof digests and provenance remain in ignored local state.

The first approved online run passed the complete combined safety/transport
harness against 400 existing provider allocations. Four actual TCP/UDP routes,
32 concurrent binary clients, Gateway restart, route reconciliation and stale
snapshot rejection passed. The fixture UUID is
`24a0618f-1450-4ae6-a333-28a5ad32bd88`; its two container identities, network identity
and four reachability proofs are recorded in the ignored test-asset ledger.
The approved sleeping phase also passed after the coordinator stopped only the
proven fixture game container. Four permanent handlers retained exact prior
binding proofs, verified fresh TCP/UDP challenges to the persistent same-address
node responder, answered passive status with zero wake requests, and survived
Gateway restart, route removal and stale-snapshot rejection.
After the coordinator corroborated provenance and started the same game container,
the recovered phase passed all four real backend readiness challenges and repeated
the online forwarding, 32-client concurrency, Gateway restart and reconciliation
checks. The three harness phases exited successfully and closed their own Gateway
sockets. The coordinator owns final project-scoped cleanup and its verification.
The initial harness used an overly generous test-only lease/deadline. Repeating
it with the supported 30-second lease and default 3-second validation deadline
exposed a timeout before any listener opened. The safety layer now collects
independent read-only metadata concurrently with bounded provider fan-out;
observations and sockets remain fresh on every validation call, with no cache.
The supported-policy online rerun passed: four-route startup **11,915 ms**,
Gateway restart **12,098 ms**, and two-route reconciliation **3,109 ms**. These
measurements established the 30-second configuration for this fixture topology.
The data plane then removed duplicate online backend inspections: complete online
validation already checks actual backend identity, reachability and readiness.
Both the initial complete validation and the fresh pre-bind validation remain.
One subsequent bounded online run passed with the **default 15-second lease and
3-second probe deadline**: four-route startup **6,564 ms**, full four-route lease
renewal **2,916 ms**, Gateway restart **5,660 ms**, and two-route reconciliation
**1,508 ms**. This repeated all forwarding, concurrency and stale-snapshot checks
against the same 400 existing provider allocations; 88 focused safety/observer
regressions passed. No observation cache was introduced. These measurements apply
to four fixture routes, not larger deployments or sustained provider API load;
deployment sizing must account for complete allocation pagination and fresh
per-route inspections. The bounded harness used a 10-second automatic poll
interval and measured renewal explicitly rather than applying sustained load to
the production read-only API.
This is isolated Docker binding/current-process namespace evidence, not a claim
of production Gateway deployment or real game protocol compatibility.

## Docker random publication semantics

Installed Docker reports 29.6.2, Git commit `3d80467`. Its
[container operation source](https://github.com/moby/moby/blob/3d80467/daemon/container_operations.go#L125)
treats an empty configured host port as a request for an ephemeral port, and clears
effective port mappings when releasing container networking. Its
[bridge external-connectivity implementation](https://github.com/moby/moby/blob/3d80467/daemon/libnetwork/drivers/bridge/bridge_linux.go#L1553)
only establishes NAT publications for selected gateway endpoints; internal bridge
networks provide no such gateway. This is source/version correspondence, not a
binary audit.

The observer separately reports proven unassigned random declarations for stopped
containers or running containers attached exclusively to observed internal NAT
bridges. They own no assigned host port. It still checks every effective binding,
all explicit stopped declarations and actual host sockets. Missing, contradictory,
unknown, mixed or routed mappings fail closed. Pterodactyl server allocations
remain fixed, complete and protected even while stopped. No cross-writer atomicity
against an unrelated administrator's later Docker changes is claimed.

## Final scoped cleanup

Coordinator revalidated exact ledger IDs, creation times, pinned images, Compose
project/service/working-directory labels and exclusive network membership before
executing the approved project-scoped `down`. Both fixture containers and their
single bridge are confirmed absent. Gateway sockets were already closed. The
ignored ledger retains all phase/timing results and the cleanup timestamp. No
Pterodactyl server, existing network or unrelated data was removed.
