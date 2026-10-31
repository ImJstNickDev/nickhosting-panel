# NeoForge integration — 2026-10-31

The requested M5 follow-up adds NeoForge to the existing Minecraft integration.
The initial analysis traced Forge/Fabric/Paper catalog discovery, immutable runtime
registration, egg bindings, installation receipts, startup, modpack replacement,
Owner administration and the creation wizard before implementation.

## Behavior and scope

- Two official aggregate Maven XML manifests feed the existing leased, last-good
  local catalog. No foreground discovery matrix or replicated installer.
- Exact raw loader versions reach `NEOFORGE_VERSION`, including legacy
  `1.20.1-47.1.*`; `MC_VERSION` carries the selected Minecraft version.
- Minecraft 1.20.1–1.21.x and documented 26.x release/beta coordinates are supported.
  Java requirements and actual egg image availability remain validated.
- Creation and modpacks share exact pair resolution, mapping revisions and normal
  authorization, node/resource and rollout checks. NeoForge receives installation
  and mod-management capabilities. The subsequent Owner-requested Gateway follow-up
  below adds shared modern protocol support. Direct connections still require
  explicit Owner endpoints.
- Startup pins the concrete installed argument file; output validation checks the
  runtime identity and persists the usual installation receipt.
- Owner catalog and user wizard ship English/Italian text, the existing NeoForge
  artwork and desktop/mobile loading, empty, queued and error behavior.

Snapshots with `+` in the coordinate are intentionally excluded: the supplied egg
uses the raw coordinate inside `grep -E`, where `+` is interpreted as a regex
operator. Both installer and universal filename matching fail for the exact
published name. This is an egg contract limitation, not a general NeoForge or
Java limitation. No production egg was edited. Future unreviewed numbering
schemes remain unavailable.

## Evidence

Public read-only verification parsed both real manifests: 23 Minecraft versions,
1,898 selectable loader builds at the time of the check. Exact runtime resolution
using the product metadata transport passed for:

| Minecraft | NeoForge | Java |
| --- | --- | --- |
| 1.20.1 | 1.20.1-47.1.106 | 17 |
| 1.21.1 | 21.1.72 | 21 |
| 26.1 | 26.1.0.1-beta | 25 |
| 26.3 | 26.3.0.100 | 25 |

Published installer ZIP metadata/argument templates were inspected without
execution for legacy, modern and 26.x families. These checks establish metadata
and output contracts; they do not certify real installation or client gameplay.

Focused core tests passed 75 cases, with a final 21-case rerun after hardening.
UI unit tests passed 39 cases; artwork rendering passed 8 cases. New NeoForge
browser tests passed 7 cases, and the Forge/catalog regression batch passed 11.
Desktop Owner and Italian mobile wizard screenshots received independent review.
The independent code review found no blocking issue.

Backend unit suites passed 56 cases. The final Node 24.21 integration run passed
37 cases across five files, with 130 nonmatching cases skipped by the explicit
filter: NeoForge catalog/registration, content receipts, modpack runtime and API.
Every new backend case ran, including 26.1 output, exact direct-only modpacks and
Owner-only queued refresh. The earlier broader integration run had 124 passes and
10 failures: seven used `Promise.withResolvers` under an accidentally selected
Node 20, and three new registration fixtures advertised the wrong image family.
The fixtures were corrected and all ten failing cases passed in the Node 24 rerun.

Commands used the existing Node 24.21 toolchain and `pnpm`:

```sh
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm build
pnpm test
pnpm exec vitest run --maxWorkers=4 scripts/m4-live.test.ts packages/content-providers/src/plugins.test.ts apps/worker/src/main.test.ts games/minecraft/src/world.test.ts apps/game-gateway/src/data-plane.test.ts apps/web/src/features/game-ui.test.ts
pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/neoforge-catalog.integration.test.ts packages/server-management/src/neoforge-registration.integration.test.ts packages/server-management/src/minecraft-content.integration.test.ts packages/server-management/src/modpack-runtime.integration.test.ts apps/api/src/minecraft.integration.test.ts -t 'NeoForge|neoforge|browses local|loader absent|selected accepted|revoked|mapping revision|serves local discovery|coalesces Owner|preserves snapshots|undeployed catalog|overlaps the fresh|settles an in-flight|imports a matching world online|imports a different version world online|imports a legacy Anvil world online'
python3 scripts/check-governance.py
```

The full unit run initially passed 251 files and failed six. Three failures were
timeouts under unrestricted parallelism; the others exposed the historical M4
bootstrap profile count, obsolete artwork assertions and an unrelated plugin
fixture relying on host free-space percentage. The bootstrap runner remains
restricted to its original five profiles, artwork assertions now cover NeoForge,
and the plugin receipt fixture uses explicit test capacity settings (production
capacity policy is unchanged). All six suites subsequently passed: 287 tests with
four workers. The full run's other 3,708 passing cases and one existing skip are
retained; the retry is not counted as additional coverage.

Root/web/browser typechecks, lint and web build passed. Existing 30 lint warnings,
one informational diagnostic and the bundle-size advisory remain.

## Screenshots

- [Owner catalog, English desktop](screenshots/m5/neoforge-catalog-desktop-en.png)
- [Owner catalog, Italian mobile](screenshots/m5/neoforge-catalog-mobile-it.png)
- [Wizard, English](screenshots/m5/neoforge-wizard-loaders-en.png)
- [Wizard, Italian mobile](screenshots/m5/neoforge-wizard-loaders-it-mobile.png)
- Loading, empty, queued and error catalog screenshots use the same filename
  prefix in `docs/screenshots/m5/`.

## Configuration, safety and rollback

Migration 054 adds the NeoForge metadata catalog row/constraint. New catalog API
routes follow existing Owner/user authorization. No dependency, secret or
environment variable is added. The Owner must map an actual compatible egg and
enable it through normal rollout; no existing server/mapping is rewritten.

No production API access, infrastructure mutation, manual container restart,
deployment, live game installation or Pterodactyl test asset creation/cleanup was
performed. Tests use isolated fixtures/services; public upstream reads are separate
from production. Issue #18 remains a production-release gate.

Rollback: disable new NeoForge mappings before reverting this change and drain
any pending runtime/content work. Retain additive migration 054 and its checksum;
do not restore old databases or game files. Existing NeoForge servers need a
reviewed management plan before reverting code that recognizes their runtime.

Review requests: exact legacy/26.x version rules, egg startup/receipt checks,
Owner activation and direct-endpoint requirements, and the localized screenshots.
PR #21 remains the M5 review vehicle and must not be merged by the agent.

## Defined by integration mapping correction — 2026-10-31

An Owner-reported mapping rejection exposed two integration defects. The actual
NeoForge egg advertises `ghcr.io/ptero-eggs/yolks`, while the original declaration
selected `ghcr.io/pterodactyl/yolks`; their exact-image intersection was empty.
NeoForge now declares the egg's Java 17/21/25 family. An egg offering only Java 22,
an unrelated image or the old family cannot satisfy this integration policy.

Mapping validation also used the previously registered database manifest, which
can predate a shipped runtime even though discovery uses the compiled module.
For an already registered game, mapping validation now uses its trusted compiled
runtime/port contract when available. It preserves the registration requirement,
stored rollout and exact egg image checks; it does not rewrite manifests or
implicitly register games. Other integrations retain the stored-manifest fallback.

Validation: 19 focused unit tests and 17 isolated integration tests passed,
including the actual egg image shape, exact Java 17/21/25 runtime registration,
unsupported images, an older stored Minecraft manifest and absent registration.
Root/web/browser typecheck, lint and independent review passed. No UI behavior or
copy changed, so previous screenshots still apply.

Live investigation was read-only: the reported request was a mapping validation
error, actual egg metadata confirmed the image family, and the app database still
had 53 migrations without the NeoForge catalog row. Migration 054 is a separate
activation prerequisite. Its prepared guarded operation verifies every previous
migration checksum, applies only 054 in one transaction, and uses bounded lock and
statement timeouts. The Owner approved and migration 054 was applied successfully;
all 53 previous checksums remained unchanged. The existing worker then synced 23
Minecraft versions without errors. No egg, existing mapping, rollout or server was
changed, and no container restart was needed. No test servers created.

Rollback of this correction is source revert; it restores the previous mapping
rejection. Retain any applied additive migration and existing server data.

## Wizard identity lookup and Gateway follow-up — 2026-10-31

The Owner reported slow player lookup and a port error at creation. Read-only
diagnostics reproduced a timeout from the legacy Mojang name endpoint while
Minecraft Services returned the matching profile. Sessionserver also exhibited
intermittent transport timeouts. The shared identity provider now permits one
first-party Minecraft Services fallbacks for both name and UUID lookups on transport failures,
429 or 5xx, each within the original shared ten-second lookup budget (two bounded attempts). Missing users return
404, malformed responses do not trigger retries, and name/UUID agreement remains
mandatory. Fetch and body reads are bounded and cancelled; unavailable upstreams
still fail rather than admitting an unverified player.

The allocation pool had free backend ports but no direct endpoints. NeoForge's
initial direct-only capability forced a connection mode incompatible with that
pool. The Owner explicitly selected the permanent Gateway. NeoForge now declares
its own shared modern Minecraft Gateway support only for supported release
versions, a Netty protocol family and a known protocol ID. It uses the existing
transparent forwarding/status/readiness/idle/wake implementations; there is no new
network listener policy or bypass of allocation, identity or admission checks.
Snapshot/unknown/future version restrictions remain, and fixtures do not certify
every real client or modpack.

When direct mode is selected without configured endpoints, the API now returns
localized `direct_connection_unavailable` (409), explaining the missing Owner
configuration. Busy/configured allocations still return `allocation_unavailable`.
Both rejection paths leave server/allocation records unchanged.

Validation: 46 identity tests, 97 core/protocol tests, five targeted Gateway/
registration/modpack integration cases and two direct-error integration cases
passed. A final overlapping four-file unit batch passed 81 cases. The three-case
NeoForge browser suite now adds a verified fixture player in the Operators step
and checks that the selected name reaches the exact server-creation payload.
Root/web/browser types, lint, build and independent review passed; existing
lint/bundle advisories remain. English/Italian wizard screenshots were refreshed.

Read-only verification from the running API container reproduced legacy endpoint
timeouts and then verified the supplied player's name/UUID end-to-end using the
fallback (about 9.7 seconds in that check). Upstream response time remains variable;
this is a bounded recovery mechanism, not a guarantee of provider availability.
The actual registered NeoForge choice now declares Gateway support with the global
Gateway enabled. Only the existing development Gateway was restarted under the
standing Owner authorization to load the new compiled declaration. Its identity,
image, mounts, networks and host configuration stayed unchanged and health passed.
No server was created, no existing allocation or game state was changed, and no
additional migration was required. Real client gameplay remains untested here.
