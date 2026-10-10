# Game Integration SDK and content providers

## Principle

A game integration owns **game behavior**, including its wizard steps, user management panels, runtime profiles, protocol codecs, idle detection, wake signaling, readiness, DNS mode, port roles and optional content catalogs. Core owns identity, permissions, quota admission, jobs, Pterodactyl calls, files and networking primitives. First-party plugins are reviewed, versioned packages in this monorepo; no runtime untrusted-code marketplace.

## Contracts (illustrative TypeScript shape)

```ts
type ConnectionMode =
  | { mode: "custom-subdomain"; zoneSettingKey: string; srv?: { service: string; proto: "tcp" | "udp" } }
  | { mode: "static-host-port"; hostnameSettingKey: string; showPort: true };

type PortRequirement = {
  role: string;
  transport: "tcp" | "udp" | "both";
  defaultPort?: number;
  required: boolean;
};

interface GameIntegration {
  id: string;                      // stable ID, e.g. "minecraft-java"
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

References for the declared image families: [upstream Java build matrix](https://raw.githubusercontent.com/pterodactyl/yolks/master/.github/workflows/java.yml)
and [Java 25 image definition](https://raw.githubusercontent.com/pterodactyl/yolks/master/java/25/Dockerfile).
No image was pulled/run to establish new game support in this change.

The actual image and Java requirement are resolved when registering an exact
Minecraft combination, checked against the selected egg, and included in its
existing signed binding. The provision plan copies that frozen image. Queued jobs
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

- Show only evidence-backed, Owner-enabled runtime/version choices. Vanilla is the only runtime with M4 real-server verification; Paper/Folia/Fabric/Forge remain unavailable to ordinary users until their evidence passes. Private testing follows the existing rollout/allowlist contracts.
- If user **selects a modpack**, detect loader and Minecraft version from modpack metadata and skip redundant runtime/version selection. Still ask operators/whitelist and relevant gameplay options.
- Players/OP UI may use MCHeads renders via `https://api.mcheads.org/head/{player}/{size}` but must verify account UUID/identity separately and handle cache/errors.
- Existing-server modpack install triggers explicit wipe warning and pre-wipe verified backup option, never a silent merge.

## DNS/connection strategy

Integrations declare if the user can manage a per-server hostname in the wizard and server settings. No universal subdomain toggle.

- `custom-subdomain`: choose and validate prefix, reserve uniqueness, create/edit/delete Cloudflare A/AAAA as appropriate plus protocol SRV if supported (Minecraft Java). All zone/target values are configurable by Owner. Use DNS-only for raw game TCP/UDP unless specialized supported services are configured.
- `static-host-port`: plugin points to an Owner-configured hostname (e.g. `satisfactory.example.com`), app displays `hostname:assigned-port`; no per-server custom subdomain UI. It can still declare multiple ports for different roles.
- Domain operations run through core Cloudflare provider with job logs/retries and explicit cleanup. Codex test executions against real Cloudflare require specific approval.

## Content providers and management

Providers are independent adapters with capabilities `search`, `versions`, `resolveDependencies`, `download`, `install` and optional `update/remove`. Honor API license and distribution constraints. No unapproved copying of closed-source Blueprint extension code into this public repo.

**Minecraft:** Modrinth; CurseForge subject to approval/API requirements; plugin catalogs where supported; world library, upload/import, properties editing, OP/whitelist/players, mod and modpack installation, server restart needs. Distinguish loader compatibility, server/client-only mods, dependency resolution and installed version state.

**Satisfactory:** SMR (repository), SML (mod loader) and SMM remote manager interoperability using SFTPGo. Save management, game configuration, mod install/update, multiple required ports, idle/wake based on tested protocol. Avoid conflating SMR/SMM/SML.

## Plugin availability and rollout

States: `development`, `private-testing`, `public`, `disabled-for-new-servers`. The allowlist for private testing consists of NickHosting user IDs; Owner always retains access. Visibility is filtered consistently on game catalog, creation API and dynamic routes. Existing servers stay manageable when an integration is disabled for new creations; handling removed plugin binaries requires a migration/fallback strategy.

The M5 Owner area exposes signed compatibility evidence, tested combinations,
runtime/egg mappings and internal support states. Ordinary creation uses simple
eligible release/runtime choices: no protocol IDs, support checklist or experimental
badges. Owner enablement cannot manufacture missing compatibility evidence. Missing
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
It does not run an installer, create a remote server or enable a version.

A metadata candidate is not a certification. Existing exact mapping/binding signed
evidence cannot be rebound to another local mapping, image or artifact. Newly
registered choices remain disabled/unverified until their legitimate evidence and
Owner availability prerequisites are satisfied. A Java range does not establish
old-protocol, snapshot or future-release Gateway compatibility. In particular,
ordinary users still cannot create from an empty verified catalog.

Creation uses trusted SDK installer-page descriptors for a centered sequence,
with no Vanilla content-source or project picker. Runtime choice lists use
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
