# M5 common-platform integration acceptance

M5 delivers the complete WebPanel and the common API/worker/SDK behavior required
by its journeys. Satisfactory is M6 and is not a prerequisite. This document is
the mandatory traceability checklist, not an authorization to deploy or merge.
The original M4 audit is preserved below as a historical baseline.

## Owner policy amendment — 2026-10-10

Trusted integration declarations now determine supported Vanilla installation and
optional features; local per-mapping signed reports are diagnostic, not an ordinary
creation prerequisite. Direct-only versions remain usable without Gateway or
sleep/wake. The Owner configures explicit player endpoints; no network changes or
external reachability are implied. See the [ADR 0013 amendment](decisions/0013-minecraft-evidence-and-content.md)
and [current API contracts](M5-API-CONTRACTS.md). Earlier evidence-gate requirements
below describe the historical audit, not an additional current Vanilla gate.
Other runtimes are not automatically promoted. Identity, installation integrity,
admission, permissions and truthful evidence remain required.

## Implementation checkpoint — 2026-10-09

The current source implements the former gaps through additive contracts; the
M1–M4 lifecycle, ownership, admission, provider and game-evidence boundaries remain
authoritative. [M5 API contracts](M5-API-CONTRACTS.md) describes the wire behavior;
[M5 task flows](M5-JOURNEYS.md) records entries, permissions and failure states.

The table identifies actual implementation and executable coverage. **A test path
alone is not a test result.** [Final validation](M5-VALIDATION.md) records the
consolidated 848-unit and 35-browser passes, the full integration run's sole
obsolete-fixture failure and affected 30-case correction, three expected SFTPGo
failures, review corrections and deployment prerequisites. Historical targeted
checkpoints below remain distinct from those final results.
No generic operation below is assigned to M6 to avoid completing M5.

| Surface | Implemented solution | Actual coverage and evidence boundary |
| --- | --- | --- |
| WebPanel shell and navigation | [React application](../apps/web/src/app/), shared UI primitives, Home/Servers/Activity/Settings and separate Owner routes; one light theme, responsive navigation, explicit loading/empty/error/permission states. | [Platform browser journeys](../apps/web/tests/platform.browser.test.ts), [account journeys](../apps/web/tests/account.browser.test.ts), [client tests](../apps/web/src/api/client.test.ts). Real Chromium screenshots and automated accessibility checks; final independent rendered-screen review remains required. |
| First-run and invitations | [Setup/auth screens](../apps/web/src/features/auth.tsx) use existing protected bootstrap, verification, provider validation and invitation handlers. No user/Owner seed. Discord invitation context remains in the real authentication flow. | [Account browser journeys](../apps/web/tests/account.browser.test.ts), [Discord journeys](../apps/web/tests/discord.browser.test.ts), existing M1 authentication tests. Isolated mail/OAuth providers; NickHosting routes are not mocked. |
| Account and security | [Account UI](../apps/web/src/features/account.tsx) uses Better Auth for profile/locale, password recovery, sessions, explicit email/Discord linking, TOTP/recovery and passkeys. [Browser session adapter](../apps/api/src/web-session.ts) preserves regular versus assisted identity. | Account and Discord browser suites; [web-session API tests](../apps/api/src/web-session.integration.test.ts). WebAuthn uses Chromium's virtual authenticator; OAuth transport is isolated, not a live Discord certification. |
| Projects and sharing | [Platform queries](../packages/server-management/src/platform-queries.ts) add scoped project/member discovery, exact verified-email collaborator lookup, rename/delete and server regrouping. [Projects UI](../apps/web/src/features/projects.tsx) reuses project membership roles. Deleting a project detaches rather than deletes servers. | [Platform DB tests](../packages/server-management/src/platform-queries.integration.test.ts), [HTTP tests](../apps/api/src/platform.integration.test.ts), platform browser sharing/revocation journey. Resource charges remain attached to the server owner. |
| Server list and settings | Cursor pagination, literal search, state/game/owner/project filtering, display metadata and separate permissions/action hints; locked rename/regroup. [Server UI](../apps/web/src/features/servers.tsx) retains immutable runtime/provider identity and existing resource configuration operations. | Platform DB/API/browser suites cover scoping, unauthorized access, metadata, pagination and immediate membership changes. Hints never bypass handler checks. |
| Creation and first boot | [Four-step generic wizard](../apps/web/src/features/create-server.tsx) calls the trusted module; accepted jobs link to Activity. Server DTO exposes the durable first-start denial separately from successful provisioning. No duplicate automatic start or capacity waiting queue. | Platform browser creation journey runs the real provision job, verifies the created/offline capacity-denied outcome; existing [lifecycle integration](../packages/server-management/src/lifecycle.integration.test.ts) remains the admission/confirmation authority. |
| Quotas and Owner users | Ordinary-user quota reads and Owner paginated directory/detail expose active commitments, storage allowance, optional count limit, measured samples, missing/stale observations and override expiry. [Owner users](../apps/web/src/features/owner-users.tsx) connects roles, invitations, limits, audit history and assisted access. | Platform DB/API/browser tests cover quota edits, role boundaries and stored rollout/settings. No invented account suspension control; configured RAM is not presented as physical consumption. |
| Console and telemetry | [Console UI](../apps/web/src/features/console.tsx) uses the mediated SSE/command API, bounded lines and reconnect controls. Additive history queries accept time windows/cursors; charts show actual units/timestamps and missing data. | [Services browser journeys](../apps/web/tests/services.browser.test.ts), [stream buffer tests](../apps/api/src/stream-buffer.test.ts), client stream tests and existing M2 transfer/authorization coverage. External console/metrics are stateful fixtures, not a live server measurement. |
| Files and large transfers | [Files UI](../apps/web/src/features/files.tsx) provides browse/edit/mkdir/rename/delete and binary transfers with cancellation/progress. Transfer DTO explains provider limits/configuration. Native downloads avoid whole-response JavaScript buffering; text editor alone is bounded. | Services browser suite includes 12 MiB upload/download byte equality through actual handlers and stale editor-response isolation; existing M2 streaming/revocation tests remain applicable. This representative browser size is not a maximum or proof of every multi-gigabyte transfer. No unsupported archive/copy buttons. |
| SFTP | [SFTP UI](../apps/web/src/features/backups-sftp.tsx) uses existing scoped issue/list/rotate/revoke APIs and one-time credential display. Explicit public hostname/port is required; private API hostnames are not guessed as client endpoints. | Services browser credential lifecycle plus existing isolated SFTPGo tests. [Issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18) remains a separate production-release gate; browser revocation success does not prove termination of retained SSH transports. |
| Backups and restoration | Same service UI selects completed backups, confirms destructive restore, follows durable job proof, lists/deletes/downloads backups. Existing lifecycle correlation and Minecraft restore verification remain in force. | Services browser backup → file change → restore → actual-content verification; platform uncertain-result journey; M2/M4 lifecycle coverage. API acceptance is not restored success and acknowledgement of uncertainty is not rollback. |
| Network, allocations and DNS | [Connection DTO](../packages/server-management/src/platform-queries.ts) joins allocation roles/transports to explicit public Gateway routes and configured hostname/DNS records; [network UI](../apps/web/src/features/network.tsx) shows available/unavailable/unconfigured states. Owner allocation discovery is separate. | Platform query/API tests, services browser unconfigured-route state, [SDK fixtures](../packages/game-sdk/src/ui.test.ts), retained M2/M3 collision and namespace-reachability tests. M5 browser tests do not bind public ports or write real DNS. |
| Sleep/wake and automation | Complete stored policy reads plus [durable schedules/explicit consent](../packages/server-management/src/schedules.ts) and [automation UI](../apps/web/src/features/automation.tsx). PostgreSQL occurrences dispatch through existing admission/jobs; revision, current creator permission and manual-stop/Gateway generation are checked before new effects. | [Schedule unit](../packages/server-management/src/schedules.test.ts), [DB](../packages/server-management/src/schedules.integration.test.ts), [API](../apps/api/src/schedules.integration.test.ts) and services browser tests cover CRUD, consent, concurrency/recovery and denied dispatch. No automatic capacity queue or hidden manual-stop override. |
| Activity, retry and uncertainty | [Scoped query/detail/retry](../apps/api/src/platform.ts) and [Activity UI](../apps/web/src/features/activity.tsx). Retry creates a new intent only after a known effect-free failure. Owner recovery DTO exposes timing/eligibility for the existing locked acknowledgement path; it never replays an unknown effect. | Platform DB/API/browser tests include a lost backup response after the provider created it, minimum-age guard, explicit acknowledgement and immutable failed history. Existing lifecycle tests preserve reservation and remote-state fences. |
| Owner infrastructure and health | [Owner health](../packages/server-management/src/health.ts), scoped worker heartbeat and authenticated Gateway contact distinguish fresh/stale/unknown/unconfigured. [Infrastructure UI](../apps/web/src/features/owner-infrastructure.tsx) uses existing host/node/runtime/route configuration and adapter discovery. Reconciliation reports checked/failed subsets. | [Health unit](../packages/server-management/src/health.test.ts), [DB](../packages/server-management/src/health.integration.test.ts), [HTTP](../apps/api/src/health.integration.test.ts), platform and services browser tests. Contact is not listener readiness; stored configuration is not a network deployment. |
| Owner rollout and runtime administration | [Trusted backend module registry](../packages/server-management/src/game-modules.ts), [compiled module discovery](../apps/api/src/game-modules.ts) and [Owner UI](../apps/web/src/features/owner-integrations.tsx) reuse stored rollout/tester lists and mapping APIs. Minecraft internal evidence remains Owner-only. | [Module integration tests](../packages/server-management/src/game-modules.integration.test.ts), platform rollout browser journey, [Minecraft browser suite](../apps/web/tests/minecraft.browser.test.ts), M4 evidence regressions. Administrative toggles cannot mint verified compatibility. |
| Audit, support and settings | Paginated attributable audit; regular platform operators have audit/read-only-settings navigation without Owner write controls; typed setting schema/read/source/reset, environment locks and write-only secret updates. [Support cookie](../apps/api/src/web-session.ts) is HttpOnly and parent-session-bound, with persistent actor/subject display and Exit even after stale parent authority. | Web-session API and account/platform/services browser suites cover revoked sessions, CSRF, quotas/settings, one-time secret delivery and partial reconciliation. Identity/admin changes remain unavailable under assisted authority. |
| Minecraft management | [Trusted game UI](../games/minecraft/src/ui/) renders evidence-supported Vanilla choices/properties, independent identities/OP/whitelist, worlds and compatible content/replacement. Property reads use the actual bounded provider file, intersected with safe editable keys; writes retain signed runtime evidence and durable jobs. | [Minecraft browser journeys](../apps/web/tests/minecraft.browser.test.ts), [module unit tests](../games/minecraft/src/ui/ui.test.ts), existing M4 API/content/queued/runtime suites. Browser artifacts/signatures are explicitly synthetic fixtures; real Vanilla support still comes solely from [M4 validation](M4-VALIDATION.md). Other runtimes remain unverified. |

### Targeted evidence recorded at this checkpoint

These are development runs, not a replacement for the final consolidated checks:

- Platform DB/API implementation: 20 passed; subsequent HTTP-only run: 5 passed.
  Cursor and Owner-recovery additions each passed their affected regression case.
- Platform browser file: initial six-case run had four passes and two test-harness
  expectation failures; both affected cases then passed. Three later additions
  (uncertainty acknowledgement, Owner settings/rollout, EN-mobile/IT-desktop) each
  passed targeted execution. A single final nine-case run was still pending at
  this documentation checkpoint; do not relabel these as one full-suite result.
- Account browser file: five passed. Services browser initial run: six passed and
  one failed transfer case; the corrected transfer case passed in isolation, and
  the subsequently added partial-reconciliation case passed separately.
- Trusted game dispatch: existing affected M4 tests passed in the initial run;
  two new fixture-test failures were corrected, then all five module cases passed.
- Stateful provider fixture integration: four passed, using actual application
  lifecycle/transfer handlers with isolated external adapters and database state.
- Production browser build passed with a JavaScript chunk-size advisory. i18n unit
  checks passed (three); catalog compilation passed. Final size, catalog counts,
  browser/device inventory and suite totals belong in the final validation record.

Screenshots are sanitized real-browser captures under the ignored
`.codex/local/m5-browser/screenshots/` evidence directory; reviewed copies are in
the [public inventory](M5-SCREENSHOTS.md). They include EN/IT,
desktop/mobile, creation, sharing, capacity refusal, uncertainty, Owner settings,
account and server services. Automated axe checks and limited manual keyboard/
reflow checks do not establish complete WCAG 2.2 AA conformance by themselves.
The independent accessibility and UX/content review records its defects,
resolutions and remaining limitations in [final validation](M5-VALIDATION.md).

### Remaining acceptance and release boundaries

The contract cross-check found and resolved platform-operator navigation: regular
operators can open audit and read-only settings, with no Owner mutation controls.
The targeted browser regression verifies role promotion/demotion, safe secret
presence, settings and secret-write rejection, Owner health exclusion and immediate
loss of read access after demotion. The first attempt used an incorrect heading
selector; after correcting it to “Audit log”, the scenario passed (one passed, nine
skipped). This is an additional targeted run, not the final ten-case suite.

Final consolidation is recorded in [M5 validation](M5-VALIDATION.md), preserving
failed attempts and distinguishing affected reruns. [Screenshots](M5-SCREENSHOTS.md)
document rendered behavior without claiming new game/runtime certification.
Deployment still requires real configured mail/OAuth/provider endpoints, secrets,
runtime mappings, fresh Gateway topology/reachability evidence and specifically
approved network/filesystem changes. A configured setting is not proof of service
availability. SFTPGo #18 remains open as a production-release blocker.

## Historical baseline — M4 closure, 2026-10-09

The following audit is preserved as recorded before M5 implementation. Statements
about missing implementation describe that baseline, not the current source.

Planning only, following the Owner's revised milestone order. M5 delivers the
complete WebPanel and **all remaining generic backend/API work needed by that
WebPanel**, using the M1–M4 baseline. This audit does not authorize implementation,
deployment or a milestone merge. Satisfactory is not an M5 prerequisite.

The code was inspected at `14b2eac9bfeeceb574683b067745cce531c7ebe7` during M4
closure. References below identify actual routes/functions, not merely earlier
documentation promises. No tests or infrastructure operations were performed for
this audit. The tables are M5 acceptance work, not deferred common-platform debt.

## Existing contracts and remaining work

| Surface | Existing implementation and evidence | Missing contract or mismatch | Required M5 outcome |
| --- | --- | --- | --- |
| WebPanel shell and navigation | The [application tree](../apps/) contains API, worker and Gateway services; [SDK manifests](../packages/game-sdk/src/index.ts) declare wizard steps and management sections. | No browser application connects these contracts into the required user/Owner journeys. | Deliver actual Home, Servers, Activity, Settings and Owner navigation, responsive layouts and real loading/empty/error states. No dead navigation, mock screens or controls without supported operations. |
| First-run and invitations | [Identity](../packages/auth/src/index.ts): `bootstrapStatus`, `claimOwner`, `completeSetup`, invitation inspection/creation/revocation. [API](../apps/api/src/app.ts): `/v1/setup/*`, `/v1/invitations/:token`, `/v1/owner/invitations`. | Browser setup, invitation redirects and recovery states are absent. | A fresh migrated database completes protected, race-safe Owner setup and validates initial Pterodactyl settings; no seed. Email and Discord registration preserve invitations through redirects; missing/expired/consumed/revoked invitations give useful localized states. |
| Account and security | [Better Auth configuration](../packages/auth/src/better-auth.ts): verified email/password, explicit Discord linking, passkeys, TOTP, recovery and session policy; [identity service](../packages/auth/src/index.ts): verified email linking and step-up; [API](../apps/api/src/app.ts) delegates `/api/auth/*`. | These are backend/library endpoints, not finished account screens or a browser client contract. Do not incorrectly classify existing Better Auth session/profile functionality as missing just because it is delegated. | Wire sign-in, reset/verification, profile/language, both linking directions, passkey/TOTP enrollment and recovery, session inspection/revocation. Verify browser CSRF/cookie/redirect behavior, stale sessions and actual actor/subject boundaries. Add narrowly scoped backend adapters only where the configured library contract does not support the required journey. |
| Projects and sharing | [Registry](../packages/server-management/src/registry.ts): `createProject`, `setProjectMember`, `authorizeServer`; [permissions](../packages/core/src/permissions.ts): manager/operator/viewer; [routes](../apps/api/src/servers.ts): project list/create and membership upsert/removal via nullable role. | No project detail/member-list, rename/delete, authorized collaborator lookup or server regrouping routes. Server sharing is project-based; no standalone per-server membership contract. | Complete optional project organization and discoverable membership management without exposing unrelated accounts. Make standalone-server sharing usable through an explicit project or a scoped membership design. Verify immediate permission revocation and charge resources to the server owner, not the collaborator. |
| Server list and settings | [Registry](../packages/server-management/src/registry.ts): `listServers`, `publicServer`, `createManagedServer`, `operationSchema`; [routes](../apps/api/src/servers.ts): list/detail, resources, metrics, lifecycle operations. | List is capped at 1,000 without pagination/filter parameters; DTO lacks game/runtime display metadata and effective permitted actions. No managed-server rename or project reassignment endpoint. `configure` changes resource limits, not arbitrary startup/egg configuration. | Add usable search/filter/pagination and authorized metadata/settings operations. Expose runtime, readiness, operation and sleep states separately; stable per-user permitted actions must be enforced server-side. Preserve optional server-count limits, active-compute admission and immutable runtime mappings. |
| Creation and first boot | [Registry](../packages/server-management/src/registry.ts): `createServerSchema` defaults `autoStart=true` and `createManagedServer` persists it in the provision plan; [Minecraft create route](../apps/api/src/minecraft.ts) retains that contract. [Lifecycle](../packages/server-management/src/lifecycle.ts): `processServerOperation` performs installation/configuration, admission and `initial_start` confirmation in the same job. On `resources_unavailable`, it retains the offline server and emits `servers.operation.initial_start_denied`; [existing integration cases](../packages/server-management/src/lifecycle.integration.test.ts) cover both outcomes. | The first-start orchestration exists; queuing a provision job does not mean it only provisions. A denied first start still yields a successful creation job, so job status alone cannot explain the offline outcome. | Wire both outcomes into creation progress/detail: created and starting only after admission, or created and stopped with its durable localized capacity reason. Preserve an explicit no-autostart choice, do not enqueue a duplicate start or auto-wait for resources, and do not call a running container game-ready. |
| Quotas and Owner user administration | [Admission](../packages/server-management/src/admission.ts): atomic reservations and `setUserLimits`; [settings](../packages/database/src/settings.ts): policy validation; [identity](../packages/auth/src/index.ts): `setRole`; [routes](../apps/api/src/servers.ts): Owner user-limit write. | No NickHosting user directory/detail/search or per-user quota/usage read API. No complete browser view of active commitments versus measured usage, storage budgets, overrides and expiry. Pterodactyl `listUsers` is adapter configuration discovery, not a NickHosting directory. | Implement Owner user/invitation/role/quota/per-user-server views and ordinary-user quota summaries. Define any account restriction control before displaying it, including session/job implications. Expose explicit audited overrides and remaining capacity without treating configured RAM as physical consumption. |
| Console and telemetry | [Server routes](../apps/api/src/servers.ts): mediated console SSE/commands, live resources, history (last 500 samples), activity stream; [stream buffer](../apps/api/src/stream-buffer.ts). | No browser terminal/charts; historical queries have no selected time window or pagination. | Provide bounded, reconnectable console and CPU/RAM/network charts with live authorization, meaningful gaps/staleness and history navigation. Never expose privileged provider tokens or confuse missing telemetry with zero consumption. |
| Files and large transfers | [Server routes](../apps/api/src/servers.ts): list, streamed content download, binary upload, write/mkdir/delete/rename; [upload admission](../packages/server-management/src/upload-admission.ts), [adapter uploads](../packages/pterodactyl-adapter/src/uploads.ts) and [downloads](../packages/pterodactyl-adapter/src/downloads.ts); [runtime](../packages/server-management/src/runtime.ts): `assertFileMutation`, `authorizeTransfer`. | No file-manager UI or transfer-capacity discovery DTO. Text editing is intentionally bounded; streamed binary routes already exist. Generic archive/copy actions are not implemented and must not appear as functioning controls. | Ship browse/edit/create/rename/delete/upload/download with progress, cancellation, quota/provider-limit explanations and protected-runtime-path errors. Verify representative large modpacks/worlds/backups without whole-body buffering, privileged URLs or fixed JSON upload limits; authorization must remain live during transfers. Implement any additional common file action actually exposed by the UI. |
| SFTP | [External service workflows](../packages/server-management/src/external.ts): `createSftpCredential`, `listSftpCredentials`, rotation, revocation and reconciliation; [routes](../apps/api/src/servers.ts): `/sftp`. | Browser credential issuance/one-time delivery, expiry and unavailable-provider states are absent. Existing SSH transport revocation has the documented SFTPGo exception. | Connect the real scoped credential workflow; show truthful status and configuration prerequisites. Preserve [issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18) as a separate production-release gate. Resolving that upstream limitation is not a new WebPanel implementation prerequisite and M5 must not claim it fixed. |
| Backups **and restoration** | [Operation schema](../packages/server-management/src/registry.ts): `backup` and `restore`; [lifecycle](../packages/server-management/src/lifecycle.ts): `processServerOperation` verifies a completed backup, records an activity baseline and requires a fresh correlated terminal restore event; [adapter](../packages/pterodactyl-adapter/src/adapter.ts): `restoreBackup`, `listBackupActivity`; [Minecraft verifier](../packages/server-management/src/minecraft-content.ts): `verifyMinecraftRestore`. List/delete/streamed download routes already exist. | Restoration is **implemented**, not a missing operation. Browser selection, destructive/truncate confirmation, progress and uncertain/failure handling remain. | Exercise backup → modification → confirmed restore → verification through the WebPanel. Preserve stopped-server, ownership and game verification fences. HTTP acceptance or cleared provider status alone must never display restored success. Include deletion/download and failed/incomplete backup states. |
| Network, allocations and DNS | [Allocation pool](../packages/server-management/src/allocation-pool.ts), [runtime mapping](../packages/server-management/src/registry.ts): transport/role selection; [SDK](../packages/game-sdk/src/index.ts): `portRequirementSchema`, `connectionModeSchema`; [external workflows](../packages/server-management/src/external.ts): DNS preview/assign/update/delete; [Gateway routes](../packages/server-management/src/gateway-registry.ts). | Ordinary server detail returns role/port/protocols but no unified public connection descriptor. DNS, backend allocations and Gateway endpoints are separate contracts. | Present every required TCP/UDP port and its role, custom subdomain/SRV or static hostname plus assigned port according to capability/policy. Add a safe public connection DTO and configuration/availability states. Preserve provider-versus-effective backend addresses, namespace reachability, collision checks and ownership; never expose backend addresses as a guessed public endpoint. Real DNS/network mutations retain approval boundaries. |
| Sleep/wake and automation | [Orchestration](../packages/server-management/src/gateway-orchestration.ts): `gatewayPolicySchema`, `getGatewayState`, `setGatewayPolicy`, real startup estimates; [routes](../apps/api/src/gateway.ts): per-server policy/state. | The state response does not return all editable policy fields, so a form cannot reliably load its current idle/readiness configuration. No general persisted schedule/cron CRUD or execution contract exists. | Add complete editable policy reads and capability-driven automation controls. Preserve manual-stop suppression, immediate admission refusal, readiness proof and honest estimates. Complete the product's common scheduling workflow: persisted authorized create/read/update/delete and enable/disable, due execution through existing durable jobs, duplicate/restart protection, visible outcomes and permission/resource checks at execution. Define explicit scheduled-start behavior without silently weakening manual-stop wake suppression or resource admission. This required workflow cannot be postponed by hiding its UI; sleep/wake alone is not a general scheduler. |
| Activity, retries and uncertainty | [Server routes](../apps/api/src/servers.ts): last 100 operations and cursor-based events; [job store](../packages/jobs/src/store.ts): `getJobStatus`; [lifecycle](../packages/server-management/src/lifecycle.ts): durable effects/reconciliation and `resolveUncertainOperation`. | No paginated user/Owner global Activity API or general safe retry action. Single-job authorization checks resource ownership but does not resolve project membership, unlike per-server operation listing. Owner uncertainty resolution intentionally excludes power operations and does not prove rollback. | Provide scope-consistent Activity/detail/progress and actionable error states. Define safe retry/new-attempt semantics per operation without resetting historical jobs or replaying uncertain effects. Complete any missing generic recovery path needed by the UI, preserve evidence/reservations, and clearly identify actions requiring Owner investigation. Browser closure/reconnection must not restart jobs. |
| Owner infrastructure and health | [Server routes](../apps/api/src/servers.ts): nodes/nests/eggs/allocations, physical hosts, mappings, reconciliation and upload recovery; [Gateway](../apps/game-gateway/src/main.ts): local `/healthz`, `/readyz`, `/metrics` diagnostics; [Gateway API](../apps/api/src/gateway.ts): route administration. | No authenticated aggregate Owner health contract connecting API, worker, database/Redis, observers, provider capabilities and local Gateway diagnostics. | Build useful health/route/capacity views with freshness, missing permissions and unavailable-dependency reasons. Surface safe configuration and diagnostics without applying unapproved networking changes or treating direct Pterodactyl servers as managed assets. |
| Owner rollout and runtime administration | [Settings](../packages/database/src/settings.ts): `registerGame`, `gameCatalog`; [registry](../packages/server-management/src/registry.ts): `setRuntimeMapping`; [Minecraft Owner routes](../apps/api/src/minecraft.ts): evidence-backed compatibility/availability administration. | Generic `GET /v1/games` returns eligible catalog/access, not the complete editable stored rollout state/allowlist. Runtime mappings and generic creation choices have no ordinary-user safe selection contract. | Supply Owner catalog, allowlist and mapping edit/read flows plus capability-filtered user choices. Validate actual nests/eggs/images/variables and preserve existing mapping immutability. Owner availability changes cannot manufacture Minecraft compatibility; unverified profiles remain Owner/tester-only. |
| Audit, support and platform settings | [Identity](../packages/auth/src/index.ts): `startSupport`, `endSupport`, `listAudit` (last 200); [API](../apps/api/src/app.ts): Owner settings/secrets; [settings](../packages/database/src/settings.ts): defaults/database/environment resolution, locked fields and secret-presence metadata. | No complete audit search/pagination or browser assisted-session lifecycle. Settings are typed values, not yet a usable grouped form; optional providers lack a unified readiness/capability presentation. | Deliver searchable attributable audit, persistent actor/subject support banner and Exit/expiry handling, settings with source/lock indicators and write-only credentials. Support must not mutate the target's ordinary session; safe provider validation must never disclose secrets or silently increase permissions. |
| Minecraft management | [Minecraft routes](../apps/api/src/minecraft.ts), [source routes](../apps/api/src/minecraft-sources.ts), [content command schema](../packages/server-management/src/minecraft-content-contracts.ts), [content worker](../packages/server-management/src/minecraft-content.ts). | Rich backend functions have no browser integration. Provider metadata support does not imply that a Vanilla server accepts mods/plugins, a loader switch, or arbitrary archives. | Connect verified Vanilla creation, properties, independent player identity/OP/whitelist, worlds, content inventory and applicable provider/source flows. Modpacks determine version/loader; incompatible choices stay unavailable. Replacement requires exact wipe consent and the selected verified-backup policy; partial failures remain visible. Keep protocol/support matrices Owner-only and distinguish real-server evidence from fixture coverage. |

## Generic SDK and integration work is part of M5

The existing [`GameManifest`](../packages/game-sdk/src/index.ts) provides capability
booleans, runtime IDs, connection modes, port roles and wizard fields with one
simple conditional form. It does not yet describe a complete rendered form:
field types/constraints/options, dependent asynchronous choices, operation
availability/reasons, settings schemas and management component registration need
a shared contract. `RuntimeEggMapping` and `GameRuntimeHandler` are useful
foundations, not proof that every declared game has an executable UI or handler.

There are real Minecraft-specific integration points in
[`createApp`](../apps/api/src/app.ts) (catalog filtering),
[`createManagementRuntime`](../packages/server-management/src/runtime.ts)
(configuration/content/restore and launch validation) and the
[`Gateway route schema`](../packages/game-sdk/src/gateway.ts). M5 must establish
trusted game-module registration and generic dispatch/UI composition instead of
scattering new game-name checks across shared Core or screens. Moving a hook must
preserve all M4 evidence, identity, runtime-file, readiness and admission fences.
Do not turn a declared capability into an unconditional permission or availability
claim: combine game support, verified runtime, configured provider, current
resource state and the user's actual authority.

M5 accepts this work only when a shared shell renders game/runtime-specific
configuration, conditional wizard steps and management sections from those
contracts; another trusted game can declare its ports and connection strategy
without changing each shared screen. Use isolated SDK fixtures to prove this
without implementing Satisfactory or offering fictional production choices.
Pterodactyl/Wings remains responsible for egg installation/reinstallation.

## Completion evidence required in M5

1. Map every table row to implementation and browser acceptance evidence, including
   its listed missing backend operations. No generic gap may be moved to an
   unspecified later game milestone to declare the WebPanel complete.
2. Run real typed API/browser journeys for first-run, both registration paths,
   account security, projects/sharing, lifecycle/settings, console/files/SFTP,
   backup restoration, network/automation, Activity/recovery and all Owner views.
   Include unauthorized/revoked access, provider outage, empty/loading/error,
   concurrency and uncertain-operation cases appropriate to each change.
3. Use the verified Vanilla baseline for Minecraft journeys. Additional profiles
   retain truthful evidence gates; Satisfactory and unresolved provider licensing
   or credentials do not justify fake available choices. Reuse M4 evidence where
   valid and test changed integration paths rather than repeating unrelated live
   workloads.
4. Ship English and Italian across common/game/Owner screens, validation, mail and
   accessibility labels. Capture actual desktop/mobile screenshots and browser
   checks for responsiveness, keyboard/focus behavior and representative failures;
   screenshots or design mocks alone are not functionality evidence.
5. Preserve all M1–M4 authorization, durable jobs, resource reservations, managed
   ownership, external-service mediation and production-safety boundaries. Report
   approved test resources and cleanup separately from application readiness.
   Issue #18 remains a production-release gate; it is neither silently solved nor
   a reason to postpone the rest of the functional M5 WebPanel.
