# ADR 0013: Minecraft evidence and recoverable content

Status: implemented and validated for M4; pending Owner milestone review.

## Decision

Minecraft release labels, wire protocol IDs, runtime/loader builds, Java major
versions and Pterodactyl bindings remain separate typed facts. Upstream metadata
is bounded, integrity checked and attributable. Intended egg compatibility is not
rejected solely because its display label predates a release. Actual files and
runtime behavior still need evidence; no loader or Java substitution is silent.

Compatibility is an internal and regular-Owner administration contract. A signed
runner report binds the combination, Minecraft mapping and M2 mapping. Availability
is a separate flag. Current complete real-server evidence can establish `verified`;
fixture evidence cannot. Latest matching evidence governs and expires. Ordinary
users receive only eligible simple version/runtime choices. Private experiments
require the existing explicit tester rollout.

An `installation-bootstrap` report records a provenance-verified M2 validation
server's actual installation, Java/image identity and real status/readiness probes.
It establishes only `experimental` access for private validation. This breaks the
otherwise circular dependency between first real installation tests and a fully
verified M4 creation choice without fabricating a passing full integration report.
All untested checks remain false. Full M4 creation, Gateway/wake and management
checks must then run against another provenance-verified server before promotion.
A later failed real report overrides earlier bootstrap success.

Installed files and playable state are distinct. Wings may create the runtime
container only on first start. Absence is recorded as unobserved, never as an
invented image digest. Starts use existing M2 admission; actual Docker `.Image`
content identity must match signed Java/runtime evidence before Core can issue
playable process/readiness proof. M3 binds that proof to the exact process epoch.
The container image hash itself does not establish a Java version. Mutable image
tags alone never establish verified runtime identity.

The existing persistent jobs execute content effects. Sources and expanded
staging retain durable disk claims across failures and charge the common M2/M4
physical-disk budget. Archive extraction is bounded and refuses unsafe paths,
symlinks, conflicting files and protected configuration. Provider integrity and
distribution restrictions are enforced before staging. Prism Launcher remains a
GPL reference, not copied implementation; package licenses are recorded separately.

Destructive replacement requires explicit scope consent and optional completed
pre-wipe backup. Before a content mutation, a durable fence records expected
output hashes/removals and invalidates installation readiness. A failed partial
pack cannot start or become playable because an unrelated setting edit succeeds.
Recovery verifies the actual complete plan or a verified pre-change backup;
absence of evidence is not rollback. Player identity persists by verified UUID
and preserves explicit operator privileges across reinstalls.

## Consequences

Owner choice availability cannot substitute for compatibility tests. Unknown
protocol families and unsupported runtime combinations remain hidden by default.
The Gateway uses its existing service and fencing, with attested per-route codec
metadata; it does not implement authentication, protocol translation or limbo.

Some safe failures require explicit repair and retain disk claims until audited
cleanup. Independently proved separate filesystems may support less conservative
capacity accounting later. Existing server runtime changes require reprovisioning,
not mutation of immutable egg/loader mappings. No production network change,
public Gateway bind or new provider credential is implied by these APIs.

See [M4 APIs](../M4-API.md), [protocol](../M4-PROTOCOL.md),
[content](../M4-CONTENT.md), [research/licenses](../M4-CONTENT-RESEARCH.md) and
[validation](../M4-VALIDATION.md).

## Installation ownership

Pterodactyl/Wings executes the selected egg's installation and reinstall scripts.
The integration's metadata resolver and read-only artifact verifier do not run a
second loader installer. Core waits for provider installation confirmation and
a verified stopped state before game configuration or content changes. New
installation behavior beyond an egg's capabilities needs explicit capability
checks; it must not compete with the egg installer. The Owner approved Vanilla
alone for M4 live acceptance, with other profile/egg combinations remaining
unverified until future real tests.
