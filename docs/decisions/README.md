# Architecture decision records

Each ADR is a short record of an intentional project decision and the consequences it creates. `Accepted` means approved direction; it does **not** mean technically implemented or validated.

- [0001 Separate panel repository & milestone PRs](0001-repository-and-reviews.md)
- [0002 TypeScript stack, config and jobs](0002-stack-and-runtime-configuration.md)
- [0003 Invite auth, linking and first-run](0003-authentication-and-setup.md)
- [0004 Active compute quotas](0004-resource-policy.md)
- [0005 Permanent gateway isolation](0005-permanent-gateway.md)
- [0006 Game SDK and connection policies](0006-game-integrations-and-domains.md)
- [0007 SFTPGo and persistent mounts](0007-file-transfer-and-storage.md)
- [0008 Complete frontend — original M6 decision, amended 2026-10-09 to M5 WebPanel/common readiness and M6 game expansion](0008-complete-frontend.md)
- [0009 Production test permissions](0009-production-safety.md)
- [0010 M1 identity, configuration and durability](0010-foundation-identity-and-durability.md)
- [0011 M2 lifecycle, admission and external services](0011-server-lifecycle-and-service-boundaries.md)

- [0012 M3 Gateway leases and sleep authority](0012-gateway-leases-and-sleep.md)

When a new decision supersedes an ADR, link a new ADR and mark old one `Superseded`, rather than deleting historical context.

An explicitly approved sequencing amendment may be appended with its date while
retaining the original decision and consequences, as in ADR 0008. Read its current
status and amendment before applying historical milestone numbers.

- [0013 — Minecraft evidence and recoverable content](0013-minecraft-evidence-and-content.md)

- [0014 — WebPanel and common platform contracts](0014-webpanel-and-common-contracts.md)
