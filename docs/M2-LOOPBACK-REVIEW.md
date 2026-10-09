# M2 loopback allocation compatibility review

This correction follows Owner review of PR #17 at
`c63f750915e90174f7415686f8c41ff67986c9f4`, on
`milestone/m2-server-management`. It supersedes the prior blanket rejection of
loopback provider allocations. Earlier restart, optional count-limit and browser
transfer corrections remain intact in [the prior review record](M2-REVIEW-REVISIONS.md).
M2 remains open for Owner/ChatGPT review; no merge or M3 implementation is authorized.

## Verified behavior and limits of the evidence

Wings 1.11.13 publishes both TCP and UDP for each allocation. Its Docker binding
conversion replaces exact `127.0.0.1` with the configured Docker network
interface, preserving the port; ISPN removes those loopback bindings instead.
Other loopback addresses do not receive this conversion.
See [the pinned allocation implementation](https://github.com/pterodactyl/wings/blob/v1.11.13/environment/allocations.go#L34).

The actual network driver matters. The interface cannot safely be derived from
IPAM's gateway for an existing bridge. Host mode and overlay/ISPN follow different
paths. Egg `force_outgoing_ip` changes network selection and can cause Wings to
create a separate network, so selected loopback eggs must be verified with that
flag disabled. It does not rewrite DockerBindings' HostIP.
See [network configuration](https://github.com/pterodactyl/wings/blob/v1.11.13/environment/docker.go#L30)
and [container creation](https://github.com/pterodactyl/wings/blob/v1.11.13/environment/docker/container.go#L178).
Docker also distinguishes [host networking](https://docs.docker.com/engine/network/drivers/host/)
and [bridge NAT/routed publishing](https://docs.docker.com/engine/network/port-publishing/).
The supported declaration is restricted to bridge/NAT with ISPN disabled.

Selective read-only inspection of the installed instance confirmed Wings reports
**1.11.13**. Its image source/version/revision metadata matches the upstream tag
revision `71c5338549801ca1dde46919f3ea81500269264d`. This is matching metadata
and reported version, **not a byte-for-byte audit of the running binary**.
The configured and actual network driver is bridge, ISPN is false, the selected
network mode names that network, and the configured private IPv4 interface exists
on the host. That interface differs from the Docker IPAM gateway. Four existing
running Pterodactyl containers use the configured network, but none supplies a
live loopback-remap example. No production allocation or network was changed to
manufacture one; actual Gateway-namespace reachability is still an M3 gate.
Machine-specific addresses, names, paths and credentials remain private.

Installed Panel 1.11.11 server-configuration, egg-transformer and
allocation-transformer source paths matched upstream. The
[server configuration builder](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Services/Servers/ServerConfigurationStructureService.php#L68)
reads `force_outgoing_ip` from the selected egg, but the
[Application egg transformer](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Transformers/Api/Application/EggTransformer.php#L39)
does not expose it. The new per-egg declaration is therefore an Owner attestation
after read-only verification, not an automatically discovered API capability.

## Contract and implementation

- Pool pins distinguish exact provider `address` from effective `backendAddress`.
  Direct RFC1918/ULA bindings remain compatible; omitted effective address defaults
  to the provider address, and arbitrary rewriting is refused.
- Exact `127.0.0.1` requires an explicit Wings 1.11.13 bridge/NAT/network/interface
  declaration, ISPN false, matching private IPv4 effective address and a verified
  nest/egg entry with `forceOutgoingIp:false`. No hardcoded bridge or node exists.
  Other loopback, wildcard, public, mapped, scoped and unsupported network cases
  cannot establish a selected backend binding.
- Fresh provider node identity, allocation IDs, raw IPs, ports and assigned state
  remain authoritative. Both enqueue and pre-create checks validate loopback egg
  eligibility. Mutation identity checks compare remote provider IP/port/assigned
  state to the provider claim, never to the effective address.
- Collision checks compare effective endpoints across assigned provider inventory,
  same-host managed-node pools and retained claims, including disabled pools.
  Unknown same-port loopback semantics fail closed. Offline multiport claims remain
  stable; different transport roles cannot evade Wings' TCP-and-UDP bindings.
- Migration 009 backfills existing direct claims with `backend_address=address`
  and prevents retargeting provider ID, node, server, either address or port.
  Environment/Owner pool edits cannot silently retarget retained claims.

[M2 API](M2-API.md) specifies the exact shape and
[deployment prerequisites](CONFIGURATION-AND-DEPLOYMENT.md) describe verification.
Existing-server recovery remains possible with a disabled pool. This does not
claim continuous verification of actual Docker bindings after external changes.

## M3 collision and reachability gate

[M3 acceptance](MILESTONES.md) and [ADR 0005](decisions/0005-permanent-gateway.md)
now explicitly require validation **before binding any public Gateway listener**:
fresh inventory of all direct Pterodactyl allocations, including assigned stopped
servers; verified effective Wings bindings; actual host listeners and Docker
published ports; TCP and UDP, wildcard, mapped and dual-stack overlap checks.
Unknown topology or ownership fails closed. M3 must also verify actual container
bindings and reachability from the Gateway's own namespace before routing,
including after external configuration changes. An Owner declaration is not that
proof. Unrelated servers/allocations must remain untouched. M2 creates no listeners.

## Validation and independent review

Validation date: 2026-10-09. Toolchain remains user-local Node **24.21.0**, pnpm
**10.33.0**, TypeScript **7.0.2**, with no installation/dependency changes.
Full-suite results and approved restart evidence are recorded below.

| Command/check | Result |
| --- | --- |
| `scripts/dev.sh pnpm test` | 293 unit tests passed across 17 files; 4.13 seconds. |
| `scripts/dev.sh pnpm test:m2` | 405 ordinary tests passed plus 3 known expected failures across 19 files; 163.27 seconds. |
| `scripts/dev.sh pnpm typecheck` | Passed. |
| `scripts/dev.sh pnpm lint` | Passed, 115 files. |
| `scripts/dev.sh pnpm format:check` | Passed, 115 files. |
| `python3 scripts/check-test-persistence.py --m2 --restart-approved-test-services` | All nine migrations, settings, queued job, outbox/checkpoint, ambiguous upload claim, distinct provider/effective allocation addresses and Redis marker survived actual scoped restarts. Immutable allocation identity still rejected retargeting; generated fixtures cleaned. |
| `python3 scripts/check-governance.py` | 183 indexed text files, 69 relative links, 4 TOML files and 44 ignore cases passed. |
| Staged publication/credential inspection | Diff/whitespace inspection passed; 7 protected environment literals absent from all 183 indexed files; 3 protected local-file fingerprints unchanged. |
| Final isolated-resource audit | Zero ordinary test schemas, Redis keys, SFTP users/connections or fixture directories; exactly 3 historical failed-run schemas retained. |
| `docker compose --env-file .env.m2-test.local -f compose.m2-test.yaml down` | Approved stack removed; follow-up project-label queries found zero containers and networks. Ignored bind data retained. |

Focused runs passed 101 allocation/registry tests, including **42 new loopback
regressions**, plus 114 lifecycle/runtime/delivery tests. They cover direct
IPv4/ULA compatibility, effective binding collisions, multiport stability,
unsupported network declarations, per-egg preflight, raw provider identity drift,
immutable claims and upgrade backfill. Focused counts overlap the full suites.

Independent review of implementation, regression coverage and updated M3 gates
found no must-fix issue. It confirmed the distinction between Owner declarations
and actual future Docker/Gateway evidence. Restart protection and scoped cleanup
were also reviewed before marking the PR ready.
A separate read-only publication audit inspected all 23 staged correction files
and the final evidence additions; it found no publication blocker.

**SFTPGo exception remains unchanged:** the three retained-SSH-transport revocation
regressions are known expected failures, not passing revocation guarantees. No
proxy, fork or workaround was added. [Issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18)
must be revisited before production release.

## Safety, cleanup and rollback

The exact previously approved project-isolated PostgreSQL/Redis/SFTPGo stack was
used. Before starting it, the host had over 22 GiB available RAM and 81 GiB free
workspace disk. The resource limits, internal network and project bind mounts
were unchanged. Scoped PostgreSQL/Redis restarts passed, and the final isolated
audit found only the three deliberately retained historical failed-run schemas.
The three isolated containers and their internal network were removed; follow-up
project-label queries returned zero containers and networks. Bind data is retained.
Historical failed-run schemas and private provenance ledgers remain
retained; no new live Pterodactyl test server was created this correction round.
The ten historical test UUIDs and their prior verified deletion remain in
[the original validation record](M2-VALIDATION.md), not newly rerun live evidence.

Production interaction was selective read-only source, version and network/binding
metadata inspection. No pre-existing server, allocation, network, Panel/Wings
configuration, DNS, firewall, service or production database was changed. No actual
environment file, private notes, persistent data or credentials are published.

Deployment still requires Owner-verified pools/network/egg declarations and the
existing transfer/observation prerequisites. Any required infrastructure mutation
needs separate exact approval. No new approval is implied by this contract.
Rollback before merge is to leave PR #17 unmerged and retain ignored diagnostics;
migration 009 ran only in isolated test schemas, not production. A future rollout
needs a reviewed backup/migration plan; do not rewrite history or delete claims.

No implementation or review blocker remains for this M2 correction under the
existing temporary SFTPGo waiver. The deployment prerequisites and M3 reachability
gate are explicit future requirements, not permission to deploy or begin M3.
PR #17 remains open and unmerged for final Owner/ChatGPT review.
