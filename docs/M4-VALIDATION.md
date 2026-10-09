# M4 Minecraft Java integration — work in progress

M3 PR #19 was squash-merged with explicit one-time Owner authorization at
`fdfbb8c730a52a11fb4aff29aa580a1904248e49`, after verifying its exact approved
HEAD `89d3e45b894114b39d2e09287e2396ed7bc87fda`. Issues #8/#9 are closed.
M4 work starts from that tree on `milestone/m4-minecraft`.

This is an execution record, not a compatibility or completion claim. M4 remains
draft until its actual acceptance tests and independent review pass.

## Acceptance evidence to collect

- Separate release, protocol, loader/build and Java-runtime metadata; Owner-only
  evidence-backed compatibility administration and safe user catalog filtering.
- Bounded status/login handling, passive-query suppression, readiness and truthful
  idle evidence integrated with M3 leases/fences and M2 admission.
- Configurable Vanilla/Paper/Folia/Fabric/Forge mappings and dynamic backend wizard.
- Prism Launcher source/license research before implementing server-side Modrinth
  and optional permitted CurseForge content workflows.
- Durable content install/update/remove, world and property management, independent
  player identity validation, consent/backup-gated replacement and recovery.
- Unit, protocol, database, installation and provenance-verified real-server tests,
  distinguishing fixture evidence from real runtime/client evidence.
- Independent protocol, content-integrity, licensing, authorization and recovery
  review; commands, results, safety, cleanup and rollback recorded before readiness.

## Safety and existing limitations

No production Gateway deployment, network/egg change or real DNS write is
authorized. The Owner separately approved the exact existing test allocation and
its possible exposure, loopback Gateway and scoped nonce endpoint described in
[M4 live tests](M4-LIVE-TESTS.md), and accepted the Minecraft EULA for these tests. Any additional test infrastructure requires
the exact documented approval before execution. Test-server mutations require
durable provenance corroborated with the live API. Secrets, private infrastructure
notes and test ledgers stay ignored. No system Java installation is changed.

The temporary SFTPGo revocation exception and [issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18)
are unchanged. No Minecraft limbo, M5 implementation or M6 frontend is included.

Rollback during development: keep the reviewed M3 baseline in service. Do not
deploy this branch or drop durable state to roll back an uncertain external effect.
Precise migration/job rollback instructions will accompany the implemented APIs.

## Integrated checkpoint — 2026-10-09 (work continues)

- `scripts/dev.sh pnpm test`: 691 passed across 41 files. This checkpoint
  predates the final generated-loader-JAR evidence correction and live helpers.
- `scripts/dev.sh pnpm test:m3`: 541 passed and **3 expected failures** across
  31 files. Uses the previously approved M2 isolated PostgreSQL/Redis/SFTPGo
  services. The expected failures are exactly the accepted SFTPGo transport
  revocation defect; they are not passing security assertions.
- `scripts/dev.sh pnpm audit --prod --json`: no reported advisories among
  216 production dependencies. This is a dependency advisory check, not proof
  that application logic has no vulnerabilities.
- Independent review confirmed fixes for persisted content conflicts, scoped
  archive reuse, UUID/OP-level persistence, inventory preservation, shared disk
  claims, queued authorization, runtime-image identity and initial-configuration
  fencing. The live-runner review additionally required positive resource caps
  and cleanup independent of creation capacity/upstream availability; both fixed.
- First bootstrap attempt failed during isolated local mapping validation before
  any provider server creation. Its empty-asset ledger was preserved and its
  exact generated database schema was subsequently cleaned. The fixture manifest
  namespace was corrected and regression-tested. No compatibility evidence was
  issued from that attempt.

Live acceptance, full final checks and independent review remain in progress.
The PR stays draft; there is no completed M4 compatibility claim at this checkpoint.
