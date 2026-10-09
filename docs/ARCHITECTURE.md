# Architecture and component contracts

## Deployment shape (one physical machine initially)

- `apps/web`: M5 React/TypeScript user + Owner app, single product but separate from existing public website.
- `apps/api`: Hono + Better Auth, policy engine, public APIs, administration, authorization, configuration.
- `apps/worker`: BullMQ consumers, install/provisioning/backup jobs, reconciliation and game integration handlers.
- `apps/game-gateway`: standalone long-running Node/TypeScript process bound only to configured public game endpoints of NickHosting-managed servers; TCP+UDP routing and protocol-specific behavior.
- `packages/database`: PostgreSQL migrations and typed data access.
- `packages/auth`, `packages/core`, `packages/pterodactyl-adapter`, `packages/game-sdk`, `packages/ui`, `packages/i18n`, `packages/content-providers`.
- `games/minecraft` and the planned M6 `games/satisfactory`: first-party, versioned integrations, backend + capability-driven UI contributions and protocol handlers.
- Supporting services: PostgreSQL, Redis/BullMQ, SFTPGo (for per-server external SFTP), Pterodactyl/Wings (existing; outside repository).

Use **pnpm workspaces**. Do not introduce Nx/Turborepo without measured need. Use TypeScript type sharing where appropriate; validate every external payload at runtime (e.g., Zod). The `docs` package is not a separate running app.

## Authority and isolation

| Data/operation | Authority |
|---|---|
| NickHosting user identity, invites, linked auth, roles | NickHosting/PostgreSQL + Better Auth |
| NickHosting-owned server/project registry and game integration settings | NickHosting/PostgreSQL |
| Quota, current reservations, admission and resource policy | NickHosting/PostgreSQL |
| Job orchestration/state | PostgreSQL authoritative; Redis/BullMQ delivery/execution |
| Actual Pterodactyl server process/allocations/containers | Pterodactyl/Wings |
| DNS records | Cloudflare external state, reconciled by NickHosting |
| Real files | Wings-owned server data volumes; web files API via adapter; SFTPGo accesses same files only after approved filesystem mapping |
| Gateway public listeners/session flows | Game Gateway and NickHosting server registry |

**No application logic accesses Pterodactyl through scattered API calls.** The adapter has independently testable, typed methods and maps upstream errors/capabilities into NickHosting domain errors. No client API key, admin key, signed privileged Wings token or secret is given raw to browsers.

### Suggested interfaces (conceptual, not prescribed code)

```ts
interface InfrastructureAdapter {
  getNodeCapacity(nodeId: string): Promise<NodeSnapshot>;
  discoverNestsAndEggs(): Promise<RuntimeCatalog>;
  createServer(input: ProvisionPlan): Promise<ExternalServerRef>;
  getServer(ref: ExternalServerRef): Promise<RuntimeSnapshot>;
  changePower(ref: ExternalServerRef, action: "start" | "stop" | "restart"): Promise<void>;
  getTelemetry(ref: ExternalServerRef): AsyncIterable<TelemetryEvent>;
  fileOperations(ref: ExternalServerRef): ServerFileOps;
  createBackup(ref: ExternalServerRef, options: BackupOptions): Promise<BackupRef>;
}
interface AdmissionService {
  reserveStart(serverId: string, operationId: string): Promise<AdmissionDecision>;
  confirmStopped(serverId: string): Promise<void>;
  reconcile(serverId: string): Promise<void>;
}
interface GatewayControl {
  register(endpoint: PublicEndpoint, backend: PrivateEndpoint, game: GameProtocolRef): Promise<void>;
  setMode(serverId: string, mode: "sleeping" | "waking" | "routing" | "disabled"): Promise<void>;
  unregister(serverId: string): Promise<void>;
}
```

Use stable NickHosting UUIDs in APIs and store separate external Pterodactyl IDs and UUIDs. Do not encode egg IDs or numeric node IDs in game plugins.

## API/application boundaries

- **Web ↔ API**: authenticated typed HTTP routes; SSE/WebSocket or equivalent subscription for job and telemetry updates; streaming console through a controlled gateway, never a privileged Pterodactyl token leaked to browser.
- **API ↔ worker**: durable job command + `jobId`, idempotency key, actor, target, policy snapshot and progress events. Commit changes to PostgreSQL atomically where needed; Redis transport can redeliver.
- **Core ↔ game SDK**: declared capabilities and typed commands; a plugin requests infrastructure actions only through core services, never bypasses authorization or quota admission.
- **Gateway ↔ Core**: authenticated control messages for server route/mode and wake request. Hot path packet forwarding must not require a PostgreSQL/API round-trip per packet.
- **SFTPGo ↔ NickHosting**: provision ephemeral/revocable per-server credentials and enforce access to an explicitly mapped single server directory; normal user identity remains NickHosting-only.

## Minimal initial DB entities

`users`, Better Auth tables, `invitations`, `projects` (implicit personal project supported), `project_members`, `servers`, `server_runtime_profiles`, `server_allocations`, `nodes`, `resource_policies`, `resource_reservations`, `operation_jobs`, `job_steps`, `activity_events`, `game_integrations`, `game_rollouts`, `runtime_egg_mappings`, `gateway_endpoints`, `dns_assignments`, `external_sftp_credentials`, `support_sessions`, `audit_events`, `platform_settings`, `encrypted_secrets`, `test_asset_provenance`. Normalized schema and constraints to be finalized in M1/M2.

Never store raw game console output, auth secrets, Cloudflare tokens or SFTP passwords in ordinary audit metadata. Database migrations are permitted; **do not seed users or an Owner**.

## Key workflows

**First creation:** parse plugin manifest → wizard plan → validate runtime/egg mapping → check disk/ports/nodes → reserve durable resources/allocations → idempotent Pterodactyl create → register server/endpoint/credentials → configure game → attempt first start via admission → complete/persist failure with meaningful status. If first start has no RAM, server remains created/offline.

**Start/wake:** inspect desired vs actual state → atomic budget + capacity admission → reserve RAM/CPU → BullMQ job → Pterodactyl power API → game-specific readiness probe → mark online/route gateway → release on confirmed final stop or failed startup. Restart retains reservation.

**Sleep:** game idle observer meets policy → graceful save/stop → Wings confirms process stopped → release reservation → gateway marks sleeping; wake only on game-specific intentional join.

**Reconciliation:** periodic comparison between NickHosting DB and Pterodactyl actual state and Gateway routes; never silently import unrelated Owner-created Pterodactyl servers. Where external operator changed server state, report drift and reconcile conservatively.

**Modpack replacement:** verified user permission + explicit wipe consent → optional successful pre-wipe backup → stop → install/wipe via game integration → readiness/recovery. Do not claim rollback exists unless verified.

## Main technical risks to validate early

1. Pterodactyl 1.x calculates node usage from the **configured** RAM and disk across all servers including stopped ones; NickHosting models RAM admission from *active reservations*. An explicit node/allocation choice avoids some automatic-deployment checks but is **not proven to bypass every server creation/update capacity check**; validate exact installed Panel/Wings version via isolated test servers. See `RESOURCE-AND-OPERATIONS.md`.
2. Using Pterodactyl privileged keys to obtain console/Wings tokens could leak authority. Build a least-capability backend relay or other verified design.
3. Shared port number with distinct bound IP addresses works in principle; binding/routing on this actual Docker network requires read-only discovery then Owner-approved deployment changes. Provider allocation and effective backend addresses are separate (including explicitly verified Wings loopback remapping). M3 must prove Gateway-namespace reachability and validate every public listener against existing direct Pterodactyl allocations and actual host/Docker bindings before binding; [ADR 0005](decisions/0005-permanent-gateway.md) defines the collision gate.
4. SFTPGo mapping onto real Wings volumes may require host mounts/permissions changes; do not implement changes on the host automatically.
5. Satisfactory network wake behavior and TLS/client interaction require empirical protocol tests; do not promise unsupported capabilities.

## Technology selection

Node.js (current supported LTS, verify compatibility), TypeScript, pnpm workspaces, React + Vite + TanStack Router/Query as appropriate, Hono, Better Auth, PostgreSQL, Redis + BullMQ, game gateway TCP/UDP. UI primitives may use accessible libraries but visual system must be bespoke. Select ORM after evaluating migration ergonomics, Better Auth adapter compatibility and transaction support. Follow existing conventions after M0 rather than overbuilding an abstraction hierarchy.

## Implemented M3 boundaries

`apps/game-gateway` is a separate persistent process with authenticated leased
control snapshots, bounded TCP/UDP data paths and a private diagnostics socket.
`packages/gateway-safety` checks complete provider inventory and read-only adapter
host/Docker observations before binding. Core persists explicit routes and
reachability proofs; the worker reuses M2 jobs/admission for sleep and wake.
Migrations 010/011 add `gateway_server_states`, `gateway_startup_samples`,
`gateway_routes`, `gateway_control_state` and `gateway_reachability_proofs` without
instance seeds. Existing conceptual interface sketches above are not wire formats;
[M3 API](M3-API.md) contains the implemented contracts.

Complete multiport readiness/idle evidence and a bounded forwarding fence prevent
sleep based on a partial or outdated zero-session report. Short route leases and
lease-aware deletion prevent stale routing into reassigned backend allocations.
[ADR 0012](decisions/0012-gateway-leases-and-sleep.md) records the recovery choices.
Real game handlers belong to M4 (Minecraft) and M6 (Satisfactory/expansion);
the complete graphical app and common platform readiness belong to M5.

## M5 shared platform boundary

M5 completes the WebPanel and the reusable Core/API/worker/SDK functionality its
journeys require. [M5 common integration readiness](M5-COMMON-INTEGRATION.md)
is an acceptance gate, not a post-frontend follow-up. The web app consumes existing
typed contracts and capability declarations; it must not duplicate lifecycle,
resource admission, provider integration, evidence verification or job recovery.

Conditional wizard rendering, contributed management tabs, multiport TCP/UDP
connection presentation, files/SFTP, backups/restore, authorization and durable
operations are common platform responsibilities even when an additional game
motivates them. Exercise these contracts with isolated SDK fixtures and supported
Vanilla journeys in M5. A fixture does not establish Satisfactory protocol or
runtime compatibility. M6 supplies those game-specific implementations and their
complete UI contributions through the already working M5 extension surfaces.

Only evidence-backed, Owner-enabled combinations enter ordinary creation;
Vanilla is the sole runtime with M4 real-server verification. Owner-only support
administration and private tester controls remain distinct from user wizard data.
Follow [Frontend and i18n](FRONTEND-I18N.md) for the M5 UX, internationalization,
accessibility and screenshot acceptance requirements. Reordering milestones does
not authorize any production deployment or expand infrastructure permissions.

## M4 Minecraft boundaries

`games/minecraft` supplies metadata/runtime resolution, controlled management
plans, wizard descriptors and a protocol module loaded by the existing Gateway.
`packages/content-providers` handles provider semantics and verified staging;
`packages/server-management` owns authorization, resource claims, persistent
installation effects and partial-failure recovery. The Pterodactyl adapter remains
the sole provider boundary, including minimal read-only runtime-image observation.
The signed compatibility registry is Owner-only; public discovery contains simple
eligible release/runtime choices. [M4 APIs](M4-API.md) and
[ADR 0013](decisions/0013-minecraft-evidence-and-content.md) describe the contracts.
Actual compatibility claims are limited to [recorded validation](M4-VALIDATION.md).
