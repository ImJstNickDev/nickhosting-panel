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

## Runtime ↔ Pterodactyl mapping

- In Owner Center, each `(game, runtime profile)` references a configured Pterodactyl **nest + egg**, validated against installed versions. Optionally support multiple mappings per Egg version/runtime preset.
- Discovery occurs via Pterodactyl adapter; don't encode numeric nest IDs, egg IDs or server-specific paths in plugin source.
- Mapping includes startup variables, Docker image compatibility, install environment and supported feature flags. When mapping missing/mismatched, Owner sees a precise integration error; user cannot create a broken server.
- Revisit mapping behavior if Pterodactyl 2.x changes its nest/egg APIs; adapter owns version translation.

## Wizard architecture

Top-level steps always `Choose a game → Configure → Resources → Create`; `Configure` has plugin-defined conditional steps, defaults, validators and rich interactive widgets. UI uses common components with game-specific contributors. Progressive disclosure: simple Vanilla server requires few inputs; modded setup introduces appropriate options.

Minecraft example:

- Vanilla/Paper/Folia/Fabric/Forge/runtime selection with compatible version lists.
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
