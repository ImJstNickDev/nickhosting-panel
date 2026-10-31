# Purpur runtime follow-up — 2026-10-31

The Owner requested Purpur using the supplied Pterodactyl installation script.
This extends the current M5 integration flow; it does not authorize production
deployment or certify live Purpur clients/plugins.

## Version and installation contract

Discovery reads the [official Purpur API](https://purpurmc.org/docs/purpur/):
`/v2/purpur`, `/v2/purpur/{version}` and `/v2/purpur/{version}/{build}`.
Each catalog entry freezes the provider's exact latest build after matching its
project, version, build and successful result. Failed refreshes preserve the
last good catalog. Raw documents retain their original SHA-256 evidence, with
bounded bytes, requests, concurrency and background refresh leases. The wizard
selects Minecraft versions; the build is fixed at creation, as for Paper.
Existing servers are not upgraded by catalog refreshes.

Pterodactyl performs installation. The binding supplies exact
`MINECRAFT_VERSION` and `BUILD_NUMBER`, a safe `SERVER_JARFILE`, and, only if
advertised by the egg, the exact official `DL_PATH`. The inspected egg declares
the first three variables; the optional path is not required. No egg changes
are needed. Ambiguous substring/latest fallbacks in the supplied script are not
used as discovery authority: installed output must match the selected artifact.

Purpur publishes MD5 for its server JAR, not SHA-256. Only Purpur's server-JAR
verification accepts this provider checksum; other runtime hash requirements
remain unchanged. NickHosting computes and stores a separate SHA-256 installed
receipt. MD5 is an upstream integrity check, not a cryptographic signature or
an independent proof of authenticity. Downloads remain fixed to the official
HTTPS API origin and exact version/build path.

Java follows Paper's version-specific baseline, raised when Mojang requires a
newer Java major. The actual egg advertises the ptero-eggs image family, with
Java 8, 11, 16, 17, 21, 22 and 25. Unknown image majors remain unavailable.

## Capabilities and UI

Purpur declares the shared modern Minecraft Gateway, readiness, idle/wake and
installation capabilities. Protocol, allocation, admission, mapping, rollout,
identity and permission checks remain mandatory. Public routing stays limited
to NickHosting-managed servers. The historical M4 live-certification runner
explicitly rejects Purpur until it has its own client-test contract.

The wizard includes Purpur with its existing runtime artwork, without a loader
selection step. The Owner catalog supports search, pagination, refresh and
loading/empty/error/stale states in English and Italian. Purpur versions sort
newest first; build dates do not reorder releases. No invented release channel
is shown. Player/world/property management reuse the supported Java contracts.

Plugin compatibility accepts Purpur, Paper, Spigot and Bukkit declarations.
Folia-only and incompatible Minecraft versions remain rejected. This does not
enable mod loaders or Purpur modpack recipes.

## Activation and rollback

Migration `055_purpur_catalog.sql` extends the metadata-provider constraint and
seeds only the Purpur catalog row. It does not create or alter mappings, eggs,
servers, allocations or user data. Applying it to an existing database requires
separate Owner approval. Without the row, background refresh safely skips Purpur.
Owner runtime-to-egg mapping is still required before creation choices appear.

The existing development Gateway must load the updated compiled declaration
before serving Purpur. No production deployment is included.

For code rollback, preserve saved Purpur combinations, receipts and catalog data;
do not relabel them as Paper or delete game data. Disable new Purpur mappings
through the normal Owner controls if necessary. A transaction that has not yet
committed migration055 can be rolled back normally; after activation, retaining
its additive provider row/constraint is safer than removing persisted evidence.

## Validation

Read-only discovery against the real API validated 41 Minecraft versions and
83 metadata documents, from 1.14.1 build63 through 26.3 build2655 at review time.
No game server was created, started, reinstalled or deleted. Catalog/API/install
integration tests use isolated databases and provider fixtures; they do not
establish external reachability or real-client compatibility.

Focused unit suites passed: 76 runtime/catalog/egg/policy, 91 UI/capability/image/plugin,
74 worker/content and 146 content-provider tests. Eleven isolated integration tests
cover catalog refresh/leases, lazy registration, creation retry, Owner access and
installed digest verification. Six Firefox browser tests cover Owner and wizard
flows; Axe reported no violations in the tested views. Typecheck, lint and web
build passed, with the pre-existing lint and bundle-size advisories. Independent
code review found no blocking issue.

Reviewed browser evidence (isolated fixture data):

- [Owner catalog desktop](screenshots/m5/purpur-catalog-desktop-en.png)
- [Owner catalog mobile, Italian](screenshots/m5/purpur-catalog-mobile-it.png)
- [Empty](screenshots/m5/purpur-catalog-empty-en.png), [queued](screenshots/m5/purpur-catalog-queued-en.png), [loading](screenshots/m5/purpur-catalog-loading-en.png), [failed refresh](screenshots/m5/purpur-catalog-error-en.png)
- [Runtime selection](screenshots/m5/purpur-wizard-runtimes.png), [Gateway address](screenshots/m5/purpur-wizard-address-en.png), [review](screenshots/m5/purpur-wizard-review-en.png)
- [Mobile keyboard version selection, Italian](screenshots/m5/purpur-wizard-versions-it-mobile.png)

Activation evidence: guarded read-only preflight verified all 54 prior migration
checksums. The Owner explicitly approved migration 055; the guarded transaction applied only
that migration and preserved every prior checksum. The worker synchronized all
41 versions without an error. The development Gateway
was restarted under standing Owner authorization after verifying Compose identity;
its image, mounts, networks and host configuration are unchanged and it returned
to healthy. No Panel/Wings
or game-server changes were performed.

Four existing Paper catalog browser tests also passed, checking the shared
Owner component for regressions.
