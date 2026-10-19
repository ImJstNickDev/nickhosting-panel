# Game Integration SDK and content providers

## Principle

A game integration owns **game behavior**, including its wizard steps, user management panels, runtime profiles, protocol codecs, idle detection, wake signaling, readiness, DNS mode, port roles and optional content catalogs. Core owns identity, permissions, quota admission, jobs, Pterodactyl calls, files and networking primitives. First-party plugins are reviewed, versioned packages in this monorepo; no runtime untrusted-code marketplace.

## Contracts (illustrative TypeScript shape)

```ts
type ConnectionMode =
  | { mode: "shared-host"; defaultLabel: string; allowCustomSubdomain: boolean }
  | { mode: "custom-subdomain"; zoneSettingKey: string; srv?: { service: string; proto: "tcp" | "udp" } }
  | { mode: "static-host-port"; hostnameSettingKey: string; showPort: true };

type PortRequirement = {
  role: string;
  transport: "tcp" | "udp" | "both";
  defaultPort?: number;
  required: boolean;
};

interface GameIntegration {
  id: string;                      // stable ID, e.g. "minecraft"
  version: string;                 // independently versioned integration
  capabilities: GameCapabilities;
  connection: ConnectionMode;
  ports: PortRequirement[];
  runtimes: RuntimeProfile[];      // e.g. vanilla, paper, fabric
  wizard: WizardDescriptor;        // schema + custom widgets + conditionals
  lifecycle: IdleSleepWakeProvider;
  management: ManagementExtension[];
  contentProviders?: ContentProviderBinding[];
  localizations: LocaleCatalogManifest;
}
interface RuntimeProfile {
  id: string;                      // stable symbolic ID, never Ptero numeric egg ID
  supportedGameVersions: string[] | VersionResolver;
  supports: Record<string, boolean>;
  variables: RuntimeVariableSchema;
  configureServer(plan: ServerPlan, services: AuthorizedGameServices): Promise<void>;
}
interface ProtocolHandler {
  supports(gameVersion: string, protocolVersion?: number): boolean;
  parseJoinAttempt(input: PacketOrDatagram): JoinIntent;
  sleepingStatus?(ctx: ProtocolContext): Response;
  wakingResponse?(ctx: ProtocolContext): Response;
  resourcesUnavailable?(ctx: ProtocolContext): Response;
}
```

Design final contracts before code, keep them small. Do not make every optional method mandatory. Every custom handler receives authorized capability-limited services, not a direct application admin API key.

## Milestone ownership

M4 establishes Minecraft contracts and verified Vanilla behavior. M5 completes the
WebPanel and **all shared integration readiness** in
[M5 common integration readiness](M5-COMMON-INTEGRATION.md): conditional wizards,
capability-driven tabs, translated UI contributions, multiport/transport roles,
connection presentation, files/SFTP, backups, authorization, jobs and recovery.
Use isolated SDK fixtures to prove contracts not exercised by Vanilla; do not
claim those fixtures prove another game's compatibility.

M6 adds Satisfactory and evidence-backed game/runtime expansion through that
working platform. Satisfactory-specific saves, SMR/SML/SMM and protocol behavior
remain M6; generic capabilities must not wait for Satisfactory. No fake game page,
unsupported action or placeholder integration counts toward M5 readiness.

## Runtime ↔ Pterodactyl mapping

- In Owner Center, each `(game, runtime profile)` references a configured Pterodactyl **nest + egg**, validated against installed versions. Optionally support multiple mappings per Egg version/runtime preset.
- Discovery occurs via Pterodactyl adapter; don't encode numeric nest IDs, egg IDs or server-specific paths in plugin source.
- Mapping includes startup variables, Docker image compatibility, install environment and supported feature flags. When mapping missing/mismatched, Owner sees a precise integration error; user cannot create a broken server.
- Revisit mapping behavior if Pterodactyl 2.x changes its nest/egg APIs; adapter owns version translation.

## Integration-owned container image selection

Runtime descriptors may declare `imagePolicy`: a fixed integration image or rules
with image references, inclusive version bounds and/or trusted runtime requirements.
The SDK requires exactly one matching rule. Version ordering belongs to the
integration (an explicit comparator), never an assumed SemVer parser. Missing
metadata, unsupported requirements and ambiguous matches fail closed.

Owner egg mappings select `imageMode: integration` or the existing `static` mode.
Static remains the default for old API requests and existing database rows; these
are never automatically converted. Integration mode has no Owner-selected Docker
image. Only compiled first-party policy is authoritative, not a manifest edited
in the database. The Owner UI shows “Defined by integration” and retains a fixed
image alternative. No game-specific image decisions belong in shared UI components.

Minecraft derives Java requirements from its existing release/build/loader metadata
resolver. Its runtime descriptors declare explicit known Java-major → official
Pterodactyl Yolks image rules; they do not infer future tag names or invent release
ranges that disagree with metadata. This is the version-dependent behavior for
Vanilla, Paper, Folia, Fabric and Forge. The generic SDK also supports literal
version ranges and fixed-image games. Image requirements do **not** certify those
runtimes; Vanilla remains the only M4 real-server-verified profile.

Fabric shares the integration's existing Minecraft Java baseline with Vanilla,
then takes `max(Minecraft baseline, Fabric recommendation, exact loader launcherMeta.min_java_version)`.
The range fallback is available when older release metadata omits Java; hash-verified
Mojang metadata must agree with known release baselines. Snapshots use metadata,
not release-name sorting. Missing loader metadata is not treated as Java 8.

For Fabric's integration-managed mode, the image family is
`ghcr.io/ptero-eggs/yolks:java_<major>` (FabricUpdated); the declared majors are
8, 11, 16, 17, 21, 22, 23, 24 and 25. Other profiles retain their existing
`ghcr.io/pterodactyl/yolks` policy. The public manifest and runtime resolver share
the same profile-policy selector. The egg still must allow the exact selected
image. No automatic egg edits, registry substitution or mapping conversion occurs.

| Minecraft release with Fabric | Base Java | Fabric image suffix |
| --- | --- | --- |
| 1.14–1.16.5 | 8 | `java_8` |
| 1.17–1.20.4 | 17 | `java_17` |
| 1.20.5–1.21.11 | 21 | `java_21` |
| 26.1 onward, while metadata agrees | 25 | `java_25` |

These are base requirements, not guarantees for arbitrary mods or old loaders.
A higher exact loader requirement selects the corresponding declared image, or
fails if that major has no image rule. Fabric's current guide recommends Java 17
for 1.17; the integration follows that recommendation for stable 1.17/1.17.1,
while Vanilla retains its Java 16 baseline and snapshots retain their metadata
requirements. This affects new resolutions, not existing immutable bindings. Installer-image Java is separate from runtime Java.
Fabric remains behind its existing exact binding/evidence/rollout gates; this change
does not enable public creation or install mods. Owner catalog registration supports Vanilla and Fabric; registration alone does not enable Fabric creation.

Sources checked 2026-10-19: [Mojang manifest and linked version metadata](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json),
[Fabric Java 16 transition](https://fabricmc.net/2021/05/27/117-for-developers.html),
[Java 17 transition](https://fabricmc.net/2021/11/30/118.html),
[current server recommendation](https://wiki.fabricmc.net/install),
[Java 25 guide](https://docs.fabricmc.net/players/installing-java/windows),
[exact loader metadata example](https://meta.fabricmc.net/v2/versions/loader/26.1/0.19.5),
[loader Java minimum declaration](https://github.com/FabricMC/fabric-loader/blob/master/src/main/resources/fabric-installer.json),
and [ptero-eggs build matrix](https://github.com/ptero-eggs/yolks/blob/main/.github/workflows/java.yml).
Live read-only metadata checks covered the nine release boundaries in this table
(including 1.17.1) and loader 0.19.5 for seven release pairs; its reported minimum
was Java 8. These checks did not run game servers or establish gameplay compatibility.

References for the declared image families: [upstream Java build matrix](https://raw.githubusercontent.com/pterodactyl/yolks/master/.github/workflows/java.yml)
and [Java 25 image definition](https://raw.githubusercontent.com/pterodactyl/yolks/master/java/25/Dockerfile).
No image was pulled/run to establish new game support in this change.

The actual image and Java requirement are resolved when registering an exact
Minecraft combination, checked against the selected egg, and included in its
immutable binding. Diagnostic reports retain their exact signed identity; they are
not required to enable declared Vanilla installation. The provision plan copies
that frozen image. Queued jobs
and existing servers cannot silently acquire a different image when rules change.
Image availability is rechecked against the provider before execution; Pterodactyl
still owns egg installation, and runtime image selection does not fix an incompatible
installer image/script. No egg mutation or automatic fallback is performed.

Migration `016_runtime_images.sql` adds a default-static mode. Static evidence
canonicalization excludes that new default field, preserving historical signatures;
integration mode participates in the mapping digest. Existing populated mappings
retain their identity/mode/image immutability. Do not downgrade by blindly dropping
the column after integration-managed mappings exist.

## Wizard architecture

Top-level steps always `Choose a game → Configure → Resources → Create`; `Configure` has plugin-defined conditional steps, defaults, validators and rich interactive widgets. UI uses common components with game-specific contributors. Progressive disclosure: simple Vanilla server requires few inputs; modded setup introduces appropriate options.

Minecraft example:

- Show Owner-enabled runtime/version choices supported by the compiled integration and locally validated against the selected egg. Vanilla installation/direct access does not require a signed test for each mapping. Gateway/sleep/wake are separate declared capabilities. Paper/Folia/Fabric/Forge retain their existing evidence/private-testing controls; they are not promoted by Vanilla support.
- If user **selects a modpack**, detect loader and Minecraft version from modpack metadata and skip redundant runtime/version selection. Still ask operators/whitelist and relevant gameplay options.
- Players/OP UI may use MCHeads renders via `https://api.mcheads.org/head/{player}/{size}` but must verify account UUID/identity separately and handle cache/errors.
- Existing-server modpack install triggers explicit wipe warning and pre-wipe verified backup option, never a silent merge.

## DNS/connection strategy

Integrations declare the address behavior; Core owns the domain registry, naming,
Cloudflare ownership and recovery. No game-specific hostname rules belong in the
shared UI.

- `custom-subdomain`: one primary hostname per server. A blank label generates
  three short English words; the 64-word vocabulary offers 262,144 candidates.
  Uniqueness is reserved in PostgreSQL, not assumed from randomness. Minecraft
  declares `_minecraft._tcp` SRV support so the primary game address omits its
  explicit port. Other roles/transports retain their ports.
- `shared-host`: the integration declares a default label and whether users may
  replace it with a personal hostname. Shared hosts always show the assigned port;
  they have integration/domain ownership independent of any server's lifecycle.
  The worker provisions them without importing or mutating game servers.
- `static-host-port`: compatibility contract for an externally configured hostname
  without NickHosting-managed DNS. It remains supported.

Owner `dnsDomains` entries hold stable ID, hostname, Cloudflare zone ID, optional
target and availability. Targets inherit `dnsTarget` when omitted. Existing
`dnsBaseDomain`/`cloudflareZoneId` settings remain a single-domain fallback with ID
`legacy`. Integration policies select all domains, an allowlist or a denylist and
an optional preferred domain/shared label. Domains are not hardcoded in games.
A selector appears only when several eligible domains exist. Changing eligibility
or the default affects new choices, not an already-confirmed address.

The Owner blacklist starts empty. Exact-label, hyphen-separated word/phrase and
substring rules are case-insensitive. Platform service labels are reserved
separately. Renames create the replacement before removing the previous name;
failures retain the last confirmed address and durable recovery intent. Old names
remain reserved until cleanup, plus optional Owner-configured reuse delay. DNS
caches can retain an old answer for its TTL; an application rename cannot eliminate
that external propagation delay.

New server creation persists an optional `{connection:{domainId?,subdomain?}}`
choice with the provisioning intent. The worker assigns its address once public
connection information is available. Existing servers are not silently opted into
DNS publication: their Connection tab can explicitly activate the primary address.
Console and Connection use the same authoritative `displayAddress`.

All records are DNS-only and use Cloudflare ownership markers/ledgers; foreign
records are never adopted or overwritten. Real DNS tests require scoped approval.
Cloudflare reference: [record types](https://developers.cloudflare.com/dns/manage-dns-records/reference/dns-record-types/)
and [record creation API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/).

## Content providers and management

Providers are independent adapters with capabilities `search`, `versions`, `resolveDependencies`, `download`, `install` and optional `update/remove`. Honor API license and distribution constraints. No unapproved copying of closed-source Blueprint extension code into this public repo.

**Minecraft:** Modrinth; CurseForge subject to approval/API requirements; plugin catalogs where supported; world library, upload/import, properties editing, OP/whitelist/players, mod and modpack installation, server restart needs. Distinguish loader compatibility, server/client-only mods, dependency resolution and installed version state.

**Satisfactory:** SMR (repository), SML (mod loader) and SMM remote manager interoperability using SFTPGo. Save management, game configuration, mod install/update, multiple required ports, idle/wake based on tested protocol. Avoid conflating SMR/SMM/SML.

## Plugin availability and rollout

States: `development`, `private-testing`, `public`, `disabled-for-new-servers`. The allowlist for private testing consists of NickHosting user IDs; Owner always retains access. Visibility is filtered consistently on game catalog, creation API and dynamic routes. Existing servers stay manageable when an integration is disabled for new creations; handling removed plugin binaries requires a migration/fallback strategy.

The M5 Owner area exposes signed compatibility evidence, tested combinations,
runtime/egg mappings and internal support states. Ordinary creation uses simple
eligible release/runtime choices: no protocol IDs, support checklist or experimental
badges. Owner enablement cannot manufacture test evidence or undeclared Gateway support. Missing
provider credentials or unsupported capabilities produce honest actionable states,
never a working-looking control backed by a placeholder.

## Game protocol versioning

Some Minecraft releases have incompatible handshake/status/login packet structures (notably legacy 1.5.2 vs modern releases). Introduce version-specific codec families and mappings tested with representative client/server pairs. A protocol adapter must consider both **configured server version** and **connecting client protocol**, rejecting incompatible requests intelligibly without triggering unwanted wakes. Never claim an untested version works.

A protocol adapter for Minecraft Java can explore `node-minecraft-protocol` as a maintained starting point for supported versions; very old versions may require a separate codec. The experimental idea of an in-game limbo/wake button is **out of scope for first release**; keep networking extensible enough not to exclude it forever.

## Tests required per game profile

- Wizard variants, defaults, conditional steps, compatibility, mapping validation.
- Create/provision/first start, required port roles and static/custom DNS behavior.
- Content install/update/remove, conflict/duplicate/dependency failure handling.
- Wipe + backup success/failure and data-preservation behavior.
- Idle detection with players joining/leaving, manual-stop suppression and wake after sleep.
- Client protocol compatibility matrix, status-ping vs join behavior, unavailable resources replies.
- First-party UI sections register translations and accessibility metadata.

### Integration-owned Vanilla discovery — 2026-10-10

The Owner no longer needs to author each Vanilla version's binding. The integration
owns its Java ranges (8 through 1.16.5, 16 for 1.17–1.17.1, 17 for 1.18–1.20.4,
21 for 1.20.5–1.21.11, 25 from 26.1), checked against hash-verified official
metadata. Snapshot Java requirements come from metadata, not lexical ordering.
Other loaders retain their own requirements. Download availability, Java suitability
and protocol/game evidence remain distinct facts.

Owner `POST /v1/owner/minecraft/catalog/sync` accepts a mapping, optional historical
versions and a bounded cursor/limit. It reads the official catalog, validates an
actual server download and registers combinations using the integration's known
Vanilla egg variable/JAR contract. Repeated pages are idempotent. Unknown eggs
report their unsupported contract; advanced explicit registration remains available.
It does not run an installer or create a remote server. Declared Vanilla candidates
can become eligible through the existing Owner availability/rollout controls without
entering per-version bindings or signing local test reports. Catalog synchronization
accepts `enableSupported: true` as an explicit Owner request to enable the declared
candidates it registers; this does not change integration rollout.

A metadata candidate is not a real-server test result. Existing exact signed reports
cannot be rebound to another mapping, image or artifact. The compiled integration
declares Vanilla installation/direct access independently of those reports. Gateway,
readiness, player-idleness and sleep/wake support are separately declared. The M5
[protocol-family amendment](MINECRAFT-MULTIPROTOCOL.md) extends the Java responder
to modern and historical families while retaining unknown idle counts where no
backend status profile exists. This is not a per-version real-client certification
or an expansion of historical installation/egg support. Other runtime profiles are unchanged.
Owner diagnostics show declared capability and actual test evidence separately.

Creation uses trusted SDK installer-page descriptors for a centered sequence,
with no Vanilla content-source or project picker. The trusted `address` page kind
places common connection selection where the integration declares it; Minecraft
places it immediately after the version, before operators. It is not a game-owned
DNS implementation. Runtime choice lists use
release types to reveal snapshots/historical candidates only on request, while
server-side eligibility remains authoritative. MCHeads images are optional
presentation; independent Mojang name/UUID validation authorizes no action and
remains required when recording players. Preset player counts are resource
suggestions, not performance guarantees. Shared storage is Owner-managed through
`defaultServerStorageMiB` (environment `NH_DEFAULT_SERVER_STORAGE_MIB`); omitted
disk is resolved server-side only in global-pool mode, then frozen in the durable
request. Pool/headroom/backup accounting and optional personal budgets remain.

Future project-context creation and game presets are tracked in issues
[#23](https://github.com/ImJstNickDev/nickhosting-panel/issues/23) and
[#24](https://github.com/ImJstNickDev/nickhosting-panel/issues/24), not implemented here.

Discovery references: [Mojang's hash-bearing version manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)
and the [upstream Vanilla egg contract](https://raw.githubusercontent.com/pterodactyl/panel/develop/database/Seeders/eggs/minecraft/egg-vanilla-minecraft.json).
The manifest is the v2 counterpart of the requested launcher catalog and supplies
hashes for individual version metadata. No Pterodactyl installer code is copied.

### Direct delivery and support authority — Owner amendment, 2026-10-10

The integration is authoritative for its declared functionality. A newly configured
Vanilla mapping does not require `minecraftEvidenceKey` or a signed local report to
install and run a supported server. Official artifact integrity, runtime/egg/image
validation, resource admission, rollout and managed-provider identity remain mandatory.
Observed runtime identity is retained without inventing a historical certification.

Provisioning freezes `connection_mode` as `gateway` or `direct`. Direct mode is used
when the integration does not declare Gateway support or Gateway is disabled. It
requires an explicit Owner-advertised `directEndpoint` for each selected allocation;
private backend IPs and provider aliases are never silently promoted to public
addresses. Eligible public provider bindings require an explicitly direct pool entry.
Configuration does not prove NAT, firewall or Internet reachability and does not
change any network or listener.

Direct servers retain manual lifecycle, admission, files and supported game operations.
They have no Gateway routes, automatic player-idle sleep or join-triggered wake.
Authorized schedules remain separate and preserve manual-stop suppression. Existing
servers retain their previous delivery identity; changing a pool or support declaration
does not silently reroute them. See the dated [ADR 0013 amendment](decisions/0013-minecraft-evidence-and-content.md#owner-amendment--2026-10-10-declared-capabilities-and-direct-delivery).

## Owner administration workspace

`/owner/integrations` lists installed trusted modules. Each module opens a tabbed
workspace at `/owner/integrations/:gameId/:section`:

- **General:** rollout and tester allowlist.
- **Runtime:** the single runtime/egg mapping editor, scoped to the integration.
- **Versions:** Minecraft's compiled contribution for catalog discovery, filtering,
  mapping-specific availability and evidence detail; other games can contribute
  their own declared sections.
- **Connection:** allowed/default domains, plus Minecraft's Gateway response text
  editor. DNS zones, credentials and platform domains remain global settings.
- **Sleep/Wake:** game default and runtime overrides, when supported. Global
  defaults remain in Settings; individual server policy remains on the server.
- **Content limits:** per-integration restrictions within the shared platform budget.

Infrastructure retains physical hosts, managed nodes, allocations, Gateway routes
and provider discovery. Its mapping overview links to Runtime rather than offering
a second editor. A used mapping permits enabled/disabled changes only; immutable
provider/runtime identity is not silently retargeted. The existing unique
(game, runtime, node) contract remains in force.

The Game SDK's optional `administration` metadata supplies validated section IDs,
translation keys and compiled component IDs. The application resolves those IDs
through its trusted first-party component registry; no API response imports
executable code or grants permissions. Generic tabs work without a bespoke game
renderer. Detailed version/protocol evidence remains Owner-only.

Tabs fetch their own data on first visit. Catalog filters and selected evidence
remain in URL query parameters. A started catalog scan continues when switching
tabs within the integration; only its coordinator stays mounted. Leaving that
workspace or reloading still cancels browser-driven discovery. This is not a new
durable background job.

Paths, staging budgets, concurrency and download-origin configuration are shared
Core content policy. Integrations can narrow budgets/trust and raise free-space
minimums, never multiply global capacity. Protocol sources, Minecraft response
formats and Minecraft player/runtime rules remain Minecraft-specific. See
[configuration and migration](CONFIGURATION-AND-DEPLOYMENT.md#shared-content-limits-and-integration-overrides-2026-10-16).


## Integration-owned Gateway message descriptors

`GameManifest.gatewayMessages` is an optional SDK-validated, versioned descriptor
from compiled first-party code. It declares channels (not necessarily MOTD or
login replies), message states, EN/IT labels/defaults, template variables and
preview values, per-channel text limits/multiline support, and optional formatting
tokens. Different states may expose different channel subsets. Formatting tokens
have a small safe style vocabulary and optional case-insensitive matching; they
cannot inject HTML, CSS rules or executable code. A game without a descriptor has
no message editor even if stale stored metadata claims a boolean capability.

The generic service authorizes the current server manager, validates submitted
state/channel/template values against the selected trusted descriptor, and stores
`{stateId: {channelId: text}}`. The generic Gateway transports these overrides and
operational facts; it never interprets text, placeholders or formatting. The game
protocol adapter chooses its presentation state, substitutes values and emits its
own protocol bytes. Presentation state identifiers are separate from authoritative
lifecycle modes. Cosmetic edits cannot grant routing, wake or readiness authority.

An optional compiled `resolveGatewayMessages` module hook resolves Owner defaults
and preview context. Minecraft owns its legacy `minecraftGatewayResponses` binding,
all message defaults, state mapping, formatting and template expansion. Existing
settings/environment precedence and persisted server overrides are preserved;
there is no database migration. Routing protocol identity/compatibility contracts
are unchanged by this presentation refactor.

The [SDK descriptor tests](../packages/game-sdk/src/gateway-messages.test.ts),
[service tests](../packages/server-management/src/gateway-messages.integration.test.ts)
and browser fixture exercise non-Minecraft announcement channels, custom states
and variables. They demonstrate extensibility, not support for an additional game.


The optional preview resolver receives generic bounded `context.variables`
from local server bindings and confirmed connection metadata. Minecraft translates
its runtime ID and exposes `{version}`, `{runtime}`, `{address}` and `{elapsed}`
alongside existing placeholders. Live substitution remains integration-owned;
Core and the generic Gateway do not interpret those names. See the
[Minecraft editor reference](MINECRAFT-MESSAGE-EDITOR.md) for reference-client
layout guides and their measurement limits.

### Per-server game workspace — 2026-10-17

The shared server shell groups each integration's declared sections beneath its
translated game name. Existing `/servers/:id/game/:sectionId` links remain valid;
`/servers/:id/game` opens the first section available to the user's permissions
and server capabilities. The current Minecraft subsections are Settings, Players,
Worlds, Mods, Plugins, Datapacks and Modpacks. Mods and Plugins appear only for
their declared runtimes. Only the active section loads. Generic Files, Backups,
Connection and Automation retain their existing places and authority.

A form can declare a bounded `renderer` key resolved only through bundled
first-party presentation components. The shared form still owns validation,
permissions, stopped-state requirements, idempotency and durable job tracking.
`submitChangedOnly` opts a patch-style form into submitting changed supported
fields; other forms retain full payloads. Destructive forms retain the shared
confirmation presentation. Minecraft Settings uses this extension point for
compact grouped properties, with save/reset appearing only for changed values.
It preserves drafts on failure and waits for confirmed job completion plus a fresh
profile before clearing them; unresolved effects remain blocked and observable.
Historical numeric difficulty/game-mode properties are presented as named choices
and written back using the installed encoding. This is not a certification of all
historical property values (e.g. game-mode availability still needs finer profiles).

Presets mean **Owner-curated, personally tested configurations**, especially custom
maps with exact Minecraft versions and server.properties overrides. Ordinary
modpack/map installation is not itself a verified preset. Players, Worlds, Content
and preset workflow changes follow in separate work; this Settings pass does not
implement them or expand runtime eligibility.

### Minecraft Players — 2026-10-17

Players now uses a bundled section renderer (`minecraft-players`), the same trusted
registry model as custom form views. Core owns section access and durable job
tracking; the integration owns its roster, list controls and typed commands.
Executable code is never loaded from API metadata. The loader reads authoritative
`ops.json`, `whitelist.json`, `banned-players.json` and whitelist properties together,
not stale configuration intent or the unrelated content inventory. Only the
integration's declared player-management capability enables this UI.

The whitelist enable switch lives in Players; version-supported enforcement and
idle-kick properties remain in Settings. Existing offline list changes and whitelist
property changes reuse durable Minecraft operations. At runtime, typed op/deop,
whitelist add/remove/on/off, ban/pardon and kick go through the regular managed
provider boundary. No tempban is advertised for Vanilla. Command dispatch is not
presented as game-side execution; persistent list effects are checked before
synchronizing replay configuration, and uncertain delivery is never automatically
retried. Existing-row operations carry their selected UUID to prevent a renamed
or reclaimed username from silently changing the target identity. Authoritative
server-file UUIDs have explicit `server-file` provenance; Mojang lookup remains
the verifier for new offline additions.

Online names come from a fresh bounded console `list` receipt, not the incomplete
server-list status sample. The initial parser supports the English timestamped
Vanilla server-thread response; unsupported formats report unavailable. No chat or
console history is returned. Observation is requested only while Players is open
and running (15-second refresh); same-server/provider observations coalesce for
five seconds, with caller authorization checked independently. List loading is a
constant four-file fanout, not a request per player. Rendering is limited to 50 rows
per page, with search and filters over the loaded list.

Reference: [Mojang's commands overview](https://www.minecraft.net/en-us/article/minecraft-commands)
and the existing locally cached official 26.1 client language resource
(`commands.list.players`, `commands.op`, `commands.whitelist`, `commands.ban`,
`commands.pardon`, `commands.kick`). This implements management contracts; it does
not expand runtime installation or Gateway certification.

### Minecraft Worlds — 2026-10-17

#### World catalogs — M5, 2026-10-18

Worlds → **Find worlds** searches the official CurseForge Worlds class, then lists
the project's published files. The existing protected `curseforgeApiKey` and shared
content-download configuration are reused; credentials and download URLs never
enter the browser. The adapter resolves the Worlds class from CurseForge category
metadata, rather than applying the mod loader/category filters to maps. Search is
debounced, paginated (20 items) and cached/coalesced for 60 seconds with a bounded
128-entry metadata cache. Effective credential/origin changes replace the provider
instance. Opening this catalog makes no Pterodactyl discovery/file requests.

Selecting a file acquires its exact project/file identity into the existing
quota-accounted source store, verifies its declared size/hash during streaming,
then opens the normal world-import confirmation. The verified streaming digest is
reused for the source seal; the archive is not read again solely to recompute it.
No new provider transfer or world-installation implementation is introduced.
Provider-declared Minecraft versions are advisory and do not hide old maps; actual
compatibility continues to come from `level.dat`. Import never selects the world.
Unavailable distribution or missing download/integrity metadata is not bypassed.

Closing the catalog does not deliberately cancel an in-flight source acquisition
or reopen the import dialog on completion. A completed source is deduplicated when
selected again. Network/process interruptions retain the existing uncertain-source
reservation and Owner recovery semantics; this is not a resumable-download system.

Provider boundaries checked on 2026-10-18:

| Provider | Worlds behavior | Basis |
| --- | --- | --- |
| CurseForge | Integrated search, file selection and server-side ZIP acquisition | [Official API](https://docs.curseforge.com/rest-api/) and [Worlds catalog](https://www.curseforge.com/minecraft/worlds). Requires an authorized API key and permitted file distribution. |
| Modrinth | No world/map catalog offered in this screen | [Current project types](https://api.modrinth.com/v2/tag/project_type) include datapacks, not worlds/maps. World-generation datapacks are not saved worlds. Existing mod/modpack integration remains separate. |
| MinecraftMaps | External site link, then import the user-downloaded ZIP/folder | No documented public catalog API found; [site terms](https://www.minecraftmaps.com/terms) prohibit automated collection. No scraping or guessed private endpoints. |

This catalog does not turn downloaded maps into Owner-verified presets. Preset
properties/version overrides remain a separate future workflow.

Worlds uses the trusted `minecraft-worlds` section renderer. A single authorized
inventory response supplies the configured `level-name`, installed state, server
release and each discovered world's compatibility. The shared Fileman read-access
boundary supplies its existing managed-identity proof; there is no second identity
cache. Discovery lists the root once, batches candidate directories through
Fileman's configured transport, and reads their actual `level.dat` files with
bounded concurrency. Region/chunk contents are not read.

Missing installation or unknown release metadata does not hide the inventory.
World-format compatibility uses the integration's bundled exact-release DataVersion
catalog, independently of signed per-server reports (M5 correction, 2026-10-18).
The M5 world-format amendment (2026-10-18) separates structural import from
activation compatibility. Modern metadata and recognized legacy Java worlds can be
imported into an inactive folder even when the source differs from the target or
its release is unknown. Saved display names and unambiguous catalog identities are
shown without inventing missing versions. Compatible, incompatible, unknown,
invalid and unreadable states remain distinct. Unknown target metadata does not
disable import/removal, while selection and replacement of the configured world
retain strict compatibility. No automatic world upgrade/downgrade is introduced.
See [world metadata evidence](MINECRAFT-WORLD-FORMATS.md) and the current
[import/selection contract](M4-WORLDS.md#version-detection-and-cross-version-imports--m5-2026-10-18).

The configured world is marked independently of compatibility. Importing a ZIP
creates its requested folder; selecting it is a separate durable operation and
changes which world the next server start uses. Selection and replacement retain
stopped-state enforcement. Additive imports and deletion of an inactive world
may run online. Import/selection retain bounded archive/NBT validation; replacement
retains exact-path consent. A requested backup retains its stopped-state and
verified-completion requirements. All mutations preserve uncertain-effect recovery.
Deleting the selected world is unavailable. World ZIP download reuses the generic
Fileman streaming archive endpoint; the UI offers it when stopped. It is a file
export, not an atomic snapshot or replacement for the Backups workflow.

Worlds opening prepares the process-stopped observation, world inventory and an
exact-path properties upload grant. Prepared selection reuses that observation and
world metadata; it checks current local offline state, latest power-job revision,
host binding and quiescent reservations rather than repeating physical observation
or directory/NBT reads on the click. Missing/expired observations require refreshing
Worlds. An external Panel start may precede local state updates: this is an
opening-time observation, not continuous physical-state monitoring.

Selection reuses Fileman's bounded identity proof; its current node/allocation
snapshot is also used for the identity comparison, without duplicate queries.
After acquiring the server lock, operation/job metadata is read together, and the
local stopped-state/recent-power check uses one database snapshot. A fresh properties
read overlaps local desired-content construction and plan persistence. The write
waits for both, preserves the source-hash comparison and final current authorization,
and uses Fileman's prepared Wings upload transport. Adjacent duplicate selection
checks and unrelated modpack receipts are omitted. An initially missing properties
file still requires a fresh listing to detect external creation. Uncertain replies
read fresh bytes to reconcile the persisted after-image without replaying the write.
Selection completion remains atomic under the server lock but does not acquire the
global resource lock or delete installation reservations: it changes no capacity.
Operations that reserve or release resources retain their existing locking.
After confirmed job success, the UI changes `selectedWorld` in the already loaded
inventory and cancels older reads. Selection does not trigger another world scan;
acceptance alone never changes the selection. Explicit refresh/reopening the tab
continues to discover external file changes.

Read-only collaborators can browse/download within their existing file permission;
managed mutations require `server:manage`. No custom-map catalog, Owner presets,
new runtime support or Blueprint extension update is introduced by this UI pass.

### Fileman host services — M5, 2026-10-18

The Game SDK declares backend `FilemanReadService` and `FilemanJobServices`
contracts for trusted compiled integrations. Core supplies the transport and
authorization; an integration supplies its format interpretation, staging,
destination and game-specific preconditions. These are backend services, separate
from ViewerEngine's browser presentation extensions.

- Reads use Fileman's existing managed-identity access and private signed Wings
  downloads. `readMany` prepares URLs together and reads at most four files at a
  time. Limits are 8 MiB per metadata file and 16 MiB per read group. Explicit 404
  can mean an optional absent file; forbidden/unavailable responses cannot.
- `list`/`listMany` share request-local directory snapshots. The runtime supplies
  Fileman's existing Owner-configured Blueprint directory batch adapter; native
  Client API/Wings remains the fallback when the optional endpoint is absent.
  Single-directory reads use this same transport, including the root directory.
  No second cache, filesystem proxy, or provider credentials reach the browser.
- `FilemanJobServices.readScope()` gives durable jobs the same bounded transport.
  A private read phase shares one authorization result and its directory metadata,
  never cached file bytes. Mutations still require current lifecycle authorization;
  recovery or reads after a possible mutation use a new scope.
- `uploadStaged` creates a new destination tree from one immutable manifest per
  durable operation, with at most 20,000 files. The caller resolves trusted staged
  streams and owns replacement consent/backup/selection semantics. One ingestion
  reservation covers the transfer; the configured Fileman `uploadConcurrency`
  controls streams. One lane takes large files while remaining lanes drain small
  ones. Bulk grants use windows of at most 500 and renew only unused grants.
  Destination ancestors retain collision checks and a durable root marker.
  Fileman owns the fresh destination check immediately before creating the tree;
  integrations do not repeat that check for additive imports or supply cached
  directory metadata across durable effect preparation.
  Descendant directories are created by Wings' existing native upload path,
  without separate mkdir requests. This is verified against Wings 1.11.13:
  `Filesystem.Write` calls `UnixFS.Touch`, which creates missing parents using
  `MkdirAll`. The file-only manifest does not promise empty-directory preservation.
  Failure stops queued streams and drains in-flight work before releasing admission.
  Shared-pool storage skips per-server disk telemetry, while physical free space
  and transfer budgets remain covered by the batch reservation.
- Source bytes are hashed while streaming. A successful Wings response and
  durable per-file receipt confirm that upload; they do not certify gameplay or
  an atomic filesystem snapshot. Normal completion does not download the same
  bytes again. Unacknowledged dispatches stay uncertain and are never replayed
  automatically. Active streams settle before releasing coordination.
- The operation detail exposes only confirmed file/byte counters, within its
  existing access scope. Manifests, staging paths, hashes and grants remain private.

Minecraft Settings and Players read through this service. Player-file reads are
prepared together. Text editing derives content and hash from one snapshot, keeps
the final fresh precondition, and uses the acknowledged write as its receipt;
uncertain write recovery still verifies the after-image before avoiding replay.
Settings, Players and Worlds use one authorized API read scope, sharing the
managed-identity proof and checking current access and provider binding again
before returning. Settings overlaps independent profile/content lookups with the
file read. Settings and Players prepare the few applicable private write grants
in the background; an optional preparation failure cannot invalidate a valid
identity proof or prevent browsing. No grants are sent to the browser.
Live player commands confirm only the affected list or whitelist property with
fresh reads, rather than rereading all player files. Stored configuration merges
only that observed field; legacy profiles initialize both identity lists from
the actual files once. The short online-roster cache also coalesces resource
observations, keyed by provider binding and lifecycle state. Each caller retains
current authorization. Saved lists and the online roster refresh independently
in parallel; an old response cannot clear a newer uncertain command.
Settings waits for confirmed job completion before reloading saved values.
Completion patches are scoped to their originating game section, so navigating
between sections cannot suppress the current section's refresh.
Prepared property/player edits without a backup share the metadata lifecycle
path: atomic journal preparation/completion under the server lock, without the
global capacity lock or unrelated reservation deletion. Their resource exclusions
are checked once at dispatch. One fresh physical stopped-process proof immediately
before the write replaces repeated checks and the generic offline settling wait;
current effect authorization follows that proof. This does not enable editing
offline-only files while running. Pending transfers, installation/compute claims,
concurrent file changes and uncertain writes remain guarded. Backup, runtime and
installation operations keep their existing resource and recovery semantics.
The physical proof and final authorization share one host-preflight promise for
that handoff; permissions are checked again after it settles. The promise is not
a cache across operations.
Ordinary settings/player/world changes on confirmed installations reuse the
installed runtime proof and validate the local mapping identity/digest, rather
than downloading the runtime JAR again. Lifecycle authorization and provider
identity corroboration remain in force. Unconfirmed installation, explicit audit,
restore and runtime-changing content paths retain artifact verification.
Worlds overlaps properties/root reads, batches candidate directories and prepares
download URLs only for actual `level.dat` files. Additive world imports use `uploadArchive` when Blueprint declares the capability.
The integration locates the unique `level.dat` root and imports only that world
subtree. Package artwork/instructions outside it are excluded; archives containing
multiple worlds remain ambiguous and are rejected. Every archive entry still
passes path, duplicate and size checks, while staging reserves only selected world
bytes. The integration reads only `level.dat` and selects canonical members;
Fileman streams one sanitized ZIP to Wings without recompression or expanded local staging.
CRC, decoded sizes and per-file hashes are checked while bytes flow, before the
terminal ZIP record. One Blueprint request extracts into an operation-specific
scratch directory, verifies expected metadata, publishes the destination and removes
scratch. Stock Wings extraction alone is not an integrity proof (see the pinned
[experiment](../scripts/experiments/world-transfer/README.md)).

One admission claim covers compressed and expanded space plus Wings multipart
storage. The exact provider commit request and immutable manifest are journaled;
recovery asks for the same receipt without uploading again. Receipt persistence
and claim settlement are atomic. Once selected, this transport cannot silently
fall back during recovery. Replacement/backup, active-world imports, unsupported
Blueprint installations and ZIP32/10,000-member/manifest-size overflow retain
`uploadStaged` and their existing offline/compatibility guards. A missing response
never means success. Native Wings rename is not an atomic no-replace guarantee
against concurrent out-of-band filesystem writers.

Source uploads hash bytes during ingestion, close the writer, restrict the private
file and seal its source identity, digest and nanosecond filesystem metadata in
PostgreSQL. Resolution checks the sealed file rather than rereading the whole ZIP.
Legacy unsealed ready sources are hashed once before upgrade. Invalid existing seals
fail closed. The ephemeral proof is never accepted from browser input. These seals
assume service-owned private storage, not immunity to a malicious host/root process.
The transfer still validates actual archive members. The source PUT response is
reused directly by the browser instead of followed by a redundant GET.

Additive inactive imports need no process/host observation, including during a
power transition. Local authority, provider identity, storage admission and
normalized active-world protection remain enforced. The existing legacy transfer
retains its own staging budget, hashing, collision and recovery contracts.

The Worlds UI shows confirmed transfer counts and follows the current server job
after remount. Completion refreshes the inventory; accepted/uncertain/failed jobs
are not presented as successful imports. During local submission and transfer it
shows progress; a reload during archive staging precedes the persisted counters.

### Inactive world deletion — M5, 2026-10-18

Deletion is a single recursive provider file operation under the existing durable
job/server lock. It does not change installation state, reserve compute, read the
runtime JAR, verify EULA, parse `level.dat`, or wait for an offline settling timer.
Preparation records intent without listing the root. With Blueprint 1.6,
`FilemanJobServices.removeDirectory` obtains one compact inspection containing
managed identity, target metadata and a bounded regular configuration file. The
integration rejects the configured world, its enclosing folder and sibling
dimension folders. The guarded delete endpoint checks the same configuration hash
and target observation, corroborates managed ownership, and issues one recursive
Wings delete. Its durable provider receipt prevents retries from deleting a
recreated folder. The observation is metadata, not an inode-based atomic CAS.

For this exact guarded path the lifecycle delegates remote identity verification
to the provider mutation boundary, retaining current local authorization and
identity checks. Legacy operations retain Application API corroboration and the
existing missing-target recovery check. A pinned bridge operation never falls
back to stock deletion when the extension becomes unavailable. Optional backup
retains its offline prerequisite; old pending-content fences remain intact.

The Worlds view removes the row after confirmed job success, without waiting for
full inventory/server refresh; older in-flight inventory responses are cancelled.
Terminal lifecycle transactions notify the existing authorized server-event SSE
stream through one shared PostgreSQL listener per API pool. Notifications are
hints: the browser rereads the durable job, then updates confirmed inventory.
Resumable cursors and an initial ready notification close reconnect races. Local
job polling remains a fallback; no provider polling is added.

### Minecraft content navigation split — M5, 2026-10-18

The former Content section is split into Mods, Plugins, Datapacks and Modpacks;
Worlds remains the existing single workspace. The trusted UI descriptor accepts
optional `runtimeIds` and bounded, unambiguous route `aliases`. Navigation and
section loaders share the same permission, capability and runtime filter. These
are presentation rules, not authorization or runtime rollout approval. Minecraft's
manifest and UI reuse one content-runtime declaration: Fabric/Forge for Mods,
Paper/Folia for Plugins. Vanilla displays neither. No provider request is added
for navigation and no runtime eligibility is changed.

`/servers/:id/game/content` redirects with history replacement to `modpacks`,
preserving query/hash. Existing verification and pack replacement remain there;
the existing mod removal form moves to Mods. The category lists project the
existing tracked installation inventory by path; Modpacks retains the complete
pack inventory. They do not scan manually uploaded files or add installation,
discovery, update or version-compatibility behavior. Datapacks is an inventory-only
section at this stage, including on historical versions: its presence does not
claim that such versions can install or run datapacks. This paragraph describes
the initial navigation split; the Datapacks placeholder is superseded below.
Other category-specific workflows remain separate work.

### World-scoped datapacks

Datapacks now has a dedicated world-scoped inventory and preparation/apply flow,
reusing Fileman reads and transfers. Catalog acquisition and ZIP validation happen
before Apply; prepared `.pending` files are published in batches, with a single
reload for ordinary changes to the active running world. Disabled ZIPs use
`.disabled`; disabled folders must live outside the scanned datapacks directory.
Filesystem state, saved native selection and reload dispatch are distinct.
See [datapack workflow, limits and contracts](M5-MINECRAFT-DATAPACKS.md).

### Fabric version discovery

Owner → Integrations → Minecraft → Versions → Fabric exposes three independent
catalogs: supported Minecraft versions, Loader versions and Installer versions.
The creation wizard selects Minecraft and Loader separately; it defaults to the
first recommended Loader (falling back to the first entry). Every listed Loader
remains selectable. This is selection availability, not certification of every pair.
No registered-combination scan or signed per-pair report is required for Fabric.

`GET /v1/owner/minecraft/fabric/catalog` is a local-only Owner read.
`POST` to the same path accepts `{}`, durably queues a refresh and immediately
returns HTTP202 with the current cached DTO. Duplicate requests coalesce and
attempts have a 60-second minimum interval. The UI retains the last good catalog.
`GET /v1/minecraft/fabric/catalog` exposes the local catalog to authenticated users
with Minecraft rollout access, without granting provisioning permission.

The DTO contains `games`, `loaders`, `installers`, `latestInstallerVersion`,
`synced`, freshness/error timestamps and `syncState` (idle/queued/refreshing).
Historical optional `relations` remain readable but do not restrict selections.
The next successful sync replaces that legacy data with the three independent lists.

Migration 045 seeds the cache; migration 046 adds the durable request timestamp.
Every 15 minutes the independent Fabric worker reads exactly three root endpoints
from the official [Fabric Meta API](https://meta.fabricmc.net/):
`/v2/versions/game`, `/v2/versions/loader`, `/v2/versions/installer`.
Manual sync uses the same path. There are no per-game sweeps, pair downloads or
Cartesian products. At most two requests run concurrently. Publication retains
the existing renewable lease, deadline and last-good-snapshot recovery; metadata
is bounded to 8MiB cumulative bytes and 2,000 Minecraft versions.

Upstream newest-first order is preserved. Minecraft `stable` distinguishes releases;
Loader/Installer `stable` is a recommendation flag, not a prerelease classifier.
Installer is always latest from the accepted local snapshot and is frozen to its
exact version when the server is created. No installer chooser is exposed.

### Fabric creation snapshots

The runtime/egg mapping, managed node, rollout and user permissions remain
necessary. Fabric's immutable combination is resolved only for the selected
Minecraft/Loader at creation, using the latest cached Installer and the integration's
Java/image policy. The saved snapshot records the exact versions and binding so
existing servers do not change when catalogs refresh. Registry rows are diagnostic
snapshots, not a Fabric availability whitelist. Other undeclared runtimes retain
their existing evidence controls.

FabricUpdated binds `MC_VERSION`, `LOADER_VERSION`, `FABRIC_VERSION` and optional
`SERVER_JARFILE=server.jar`; extra egg variables require explicit mapping values.
The installer produces `server.jar` as the Fabric launcher and
`minecraft-server.jar` as the Mojang server, with `fabric-server-launcher.properties`
pointing to the latter. Installation verification runs on installation completion;
it does not download JARs at every start. Support for installation/direct connection
does not automatically declare Gateway, sleep/wake or real-client verification.

Legacy Owner registration endpoints remain available for diagnostic integrations;
they are not called by the Fabric wizard or required by Owner version management.
