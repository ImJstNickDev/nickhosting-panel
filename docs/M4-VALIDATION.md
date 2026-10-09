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

No production Gateway deployment, public game bind, network/egg change or real DNS
write is authorized by this milestone. Any additional test infrastructure requires
the exact documented approval before execution. Test-server mutations require
durable provenance corroborated with the live API. Secrets, private infrastructure
notes and test ledgers stay ignored. No system Java installation is changed.

The temporary SFTPGo revocation exception and [issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18)
are unchanged. No Minecraft limbo, M5 implementation or M6 frontend is included.

Rollback during development: keep the reviewed M3 baseline in service. Do not
deploy this branch or drop durable state to roll back an uncertain external effect.
Precise migration/job rollback instructions will accompany the implemented APIs.
