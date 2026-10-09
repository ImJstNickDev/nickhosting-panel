# Execution roadmap — Prepping, M0–M6

**Exactly seven numbered milestones (M0–M6), plus non-numbered Prepping. No extra milestones.** Every M0–M6 concludes with its own **open, reviewable PR into `main`**. Codex must **never merge** a PR; the Owner reviews and performs the merge. Use subagents inside milestones for parallel bounded tasks, not separate GitHub milestones for every subtask.

**General definition of done for every milestone**:

- Behavior meets acceptance tests; reproducible local commands and test outcome reported (include failures/gaps honestly).
- Docs, API contracts and ADRs updated to match actual implementation.
- Independent reviewer subagent has audited core logic and safety boundaries; issues addressed or explicitly surfaced.
- No unauthorized production changes; test server provenance and cleanup documented; no secret leaked into repo/PR.
- Milestone branch is pushed and a PR created (draft while active, ready for review only when complete). Include HEAD SHA, linked GitHub Issues, evidence and manual approval blockers.
- Owner/reviewer inspects PR before merge; next milestone branches only from the reviewed/merged state or a clearly identified review baseline.

## Prepping — Codex multi-agent readiness (no PR)

Check tool versions and `gh auth`, reconcile `.codex/config.toml` and project-scoped agents, validate AGENTS.md applies to subagents, read-only test delegation, confirm local working directory. No repository creation, deploy or Pterodactyl mutation. Use `PREPPING.md`.

## M0 — Repository & governance bootstrap (PR #1)

**Scope**

- Ensure clean intended local directory, initialize `git` with `main`, create **minimal baseline commit** (README) to make a PR base, then `gh repo create <owner>/nickhosting-panel --public --source=. --remote=origin --push` after verifying GitHub authenticated account/owner. Do not create/use the existing site repository.
- Create branch `milestone/m0-repository` from `main`. Import this spec (reconciling local edits from Prepping), templates, `.codex` files, `.gitignore`, `.env.example`, docs and ADRs.
- Set repository description/topics/homepage as appropriate; activate Issues. Use seven **GitHub Milestones M0–M6** (yes, GitHub also gets M0) and a manageable set of labels. Create a few outcome-oriented issues per milestone, not tiny tasks.
- Configure a PR template, lightweight bug/feature issue forms, optional single GitHub Project board (if useful and available). **No GitHub Actions/workflow YAML.** GitHub settings requiring Owner-only rights should be listed as manual work, not silently assumed configured.
- No LICENSE without Owner decision. Ensure public repo hygiene and `mountdata/`/secrets excluded.

**Acceptance**

- Correct public remote exists; baseline main and M0 PR compare correctly; PR remains open.
- `gh repo view`, `gh pr view`, issues/milestones, labels and templates verified; no unexpected Actions.
- Prepping config works with subagents and `AGENTS.md` visible.
- All spec links resolve locally; repo has no real `.env`, `mountdata/`, Pterodactyl config secrets or closed-source plugin content.

**PR evidence**: GitHub repo URL, PR URL/number, branch+SHA, configuration verification, what GitHub resources were created, any pending repo permissions.

## M1 — Foundation, configuration, identity & first-run (PR)

**Scope**

- TypeScript pnpm workspace scaffold, core domain/API skeleton, PostgreSQL schema/migrations, Redis/BullMQ infrastructure, typed config validation/precedence, secret encryption/storage and structured errors/logging.
- Better Auth email/password, Discord OAuth, explicit bidirectional identity linking, optional passkeys/TOTP, invite-only signup enforced on OAuth and credential paths, reset/email verification/session lifecycle.
- One-time Owner bootstrap backend (migrations but **no seed**), protected by one-time token, first-run Owner and Pterodactyl settings contracts; setup UI itself belongs to M6.
- RBAC and support-session identity separation (`actor != subject`), audit foundations, locale catalog infrastructure for English/Italian, plugin SDK foundational typed contracts and game visibility policy in DB.
- Environment example and local isolated DB/Redis test services with bind mounts under `./mountdata`, no deployment to existing infra.

**Acceptance**

- Invite links tested (valid, invalid, revoked, expired, concurrent), email and Discord register/link flows, 2FA/passkey recovery and logins; prevents direct Better Auth signup bypass.
- One-time setup race yields exactly one Owner, secrets redacted/encrypted, Owner settings < `.env` precedence tests.
- Regular user session never inherits Owner support privileges; audit records actor and subject.
- Database migrations clean on empty DB and survive restart; BullMQ/Redis round-trip works with at-least-once semantics.

## M2 — Server lifecycle, Pterodactyl adapter & services (PR)

**Scope**

- Adapter: discover nests/eggs/nodes/allocations, Owner mapping, provision/test-owned servers, read states, start/stop/restart, console relay, metrics, files, backups and other supported endpoints.
- Server registry + project semantics (projects optional), Node admission, compute reservation, storage policy (`GLOBAL_POOL` default / `PER_USER_BUDGET`), port allocations incl. multi-port games, job state/reporting and reconciliation.
- SFTPGo service abstraction, safe per-server credentials, config and isolated mount tests; Cloudflare DNS provider abstraction and per-game static/custom+SRV planning **with mocked DNS writes unless Owner approves real tests**.
- Telemetry and durable activity APIs that future UI will consume. Owner-only server management APIs, test ownership registry.
- Validate that Pterodactyl 1.x create/update paths really allow the desired active-memory quotas without modifying existing Pterodactyl configuration; surface a blocker if not.

**Acceptance**

- Using proven test-owned servers only: create, start, observe actual readiness where available, stop, reinstall/wipe test data and delete; record every ID in ledger and report cleanup.
- Parallel starts cannot exceed budget; offline configured RAM does not count in NickHosting accounting; physical capacity separate; restart retains reservation.
- Tests for Pterodactyl failures, permission boundaries, file/console/metric handling and uncertain remote effects; no raw privileged tokens leak.
- DNS allocation strategies / SRV records verified from test fixtures; SFTPGo path isolation tested outside existing Wings volumes.
- No writes to pre-existing Pterodactyl servers/config, no host network/docker changes.

## M3 — Permanent Game Gateway and sleep/wake orchestration (PR)

**Scope**

- Single persistent TCP/UDP Gateway for only registered NickHosting servers, route/control plane, per-port/protocol registry, health/observability, sleeping/waking/routing modes.
- Lifecycle orchestration, API ↔ gateway authentication, minimal interface for game-specific protocol codecs/idle detection/readiness, latency-friendly hot forwarding.
- Verify separated public/backend IP binding (same numeric port when possible), without changing existing Docker/Wings/network or binding live ports without Owner approval.
- Wake admission: when RAM unavailable, immediate denial (not pending queue). Manual stops never wake from a status ping.

**Acceptance**

- Fixture TCP+UDP/multiport routes, route isolation, restart/recovery, startup readiness and idempotent wake triggers; no unrelated Pterodactyl server is registered.
- Demonstrate same-number port forwarding on distinct interfaces in a **non-conflicting test environment**. Host-specific production bind changes are documented as proposed, not applied.
- Before binding any public Gateway listener, validate its address/port/transport against fresh inventory of **all existing direct Pterodactyl allocations**, including stopped assigned servers, and actual host listeners/Docker published ports. Resolve effective Wings bindings; check both TCP and UDP, wildcard, mapped and dual-stack overlaps. Unknown topology or ownership fails closed; never change unrelated allocations to resolve a conflict. Verify actual backend bindings and reachability from the Gateway network namespace; see [ADR 0005](decisions/0005-permanent-gateway.md).
- Stress/concurrency tests: burst joins → one wake job, restart, API loss, RAM exhaustion. No unsupported claim about a real game's wake before its game integration milestone.

## M4 — Minecraft Java integration (PR)

**Scope**

- Minecraft Game SDK integration and Owner-configured Pterodactyl mappings for Vanilla/Paper/Folia/Fabric/Forge; public runtime/version combinations require actual compatibility evidence. Pumpkin and old/future releases remain unavailable unless their compatibility is tested.
- Four-step wizard with conditional configure screens/schema; modpack determines Minecraft/loader version, OP/whitelist remains; MCHeads avatars plus UUID validation.
- Modrinth and, when API terms/credentials allow, CurseForge and approved plugin catalogs. Mod/modpack/plugin manager, version/dependency checks, world manager/import, properties editor, players/OP/whitelist.
- Server wipe/reinstall workflow with verified optional backup, Minecraft protocol version codec families (legacy/modern), status vs join, idle/sleep/wake/readiness and custom subdomain SRV via Cloudflare adapter.
- Closed-source Blueprint extensions may be inspected read-only for ideas after Owner supplies/access authorizes; do not copy code to public repo.

**Acceptance**

- End-to-end creation/configuration for actual explicitly supported profiles using Codex-owned test servers, no other server touched.
- Modpack paths skip redundant loader/version screens and apply correct selected package. Existing-server wipe confirmed and backed up as chosen.
- Mod/plugin/world install/remove tests, stale incompatible versions and failure behavior; protocol version support matrix with evidence, clear unsupported versions.
- Wake works for tested Minecraft protocols; no fake limbo feature added by default; SRV/custom hostname configuration tested using mock Cloudflare unless Owner authorizes real DNS writes.

**Owner clarification, 2026-10-09:** Vanilla alone is sufficient for M4 real-server
acceptance. Other runtime profiles still require functional mapping, metadata and
management contracts with isolated tests, but remain unverified and hidden from
ordinary users until their eggs and real behavior are tested. Pterodactyl/Wings
executes egg installation/reinstallation; integrations validate requirements and
results and orchestrate game configuration/content without duplicating installers.
See [M4 validation](M4-VALIDATION.md) for exact evidence and limitations.

## M5 — Satisfactory integration (PR)

**Scope**

- Runtime profile/egg mapping, Satisfactory-specific wizard, port-role mapping and static hostname+assigned port presentation.
- Dedicated server lifecycle, save management, game settings and player status, mod search/install/update from SMR, interoperability with SMM remote Manage Servers over SFTPGo, SML compatibility.
- Game-specific idle detection and graceful save/stop. Investigate packet/session semantics for wake, TLS and server manager/query; implement **only empirically verified** protocol-compatible wake behavior or accurately document unavailable in-game capabilities.

**Acceptance**

- Test-owned Satisfactory server can be created/started/stopped with required TCP/UDP ports and configured static-host display.
- SFTPGo access to the correct isolated server files compatible with SMM workflow in controlled environment; cannot see others' files.
- Mod catalog install/update and save operations verified; truthful capability/support matrix for idle/wake and failure messages.
- No modifications of existing Satisfactory game worlds or Pterodactyl server resources.

## M6 — Complete frontend, UX, i18n, visual verification (PR)

**Scope**

- Full React user + Owner app, original design system, all screens/routes listed in `FRONTEND-I18N.md`, first-run wizard, registration/login/linking, game wizards and game-specific management UI, console + live CPU/RAM/network charts, file browser and SFTP credential UI, backups, DNS and server controls.
- Durable Activity center, accurate progress/errors, sleep/wake/insufficient resource states, Owner management and session impersonation UI, game allowlist/rollout UI.
- English/Italian with full i18n of all user-facing surfaces; scalable locale extraction/compilation. Responsive, accessible, browser E2E tests.
- Codex runs actual app, captures sanitized real screenshots across screens/states/viewport sizes, reviews screenshots and fixes defects before PR ready for review.

**Acceptance**

- End-to-end invite → signup → create Minecraft/Satisfactory → manage → sleep/wake → backup/restore → change account/security; Owner reviews quotas, integrations/tester allowlists, and uses isolated support session. Include unavailable-feature UX honestly.
- Every flow backed by API/test evidence (mock external services only where appropriate), no temporary MVP screens or dead navigation.
- Browser screenshots in PR for desktop/mobile, both locales, main screens and edge/error states; i18n complete and accessible checks pass or exceptions documented.
- No unapproved prod deployment, DNS, Docker, firewall, or modification of Owner's existing servers.

## Suggested pull-request series

Branch names:

```text
milestone/m0-repository
milestone/m1-foundation
milestone/m2-server-management
milestone/m3-game-gateway
milestone/m4-minecraft
milestone/m5-satisfactory
milestone/m6-webpanel
```

M4/M5 can use parallel subagents **after SDK contracts stabilized**, but keep PR dependency ordering explicit. Don't branch against a stale main if a prior milestone remains unreviewed unless Owner explicitly approves that dependency.
