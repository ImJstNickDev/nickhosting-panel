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
- One-time Owner bootstrap backend (migrations but **no seed**), protected by one-time token, first-run Owner and Pterodactyl settings contracts; setup UI itself belongs to M5.
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

## M5 — Complete WebPanel & Common Platform Readiness (PR)

**Owner-approved roadmap amendment, 2026-10-09:** M5 delivers the complete WebPanel
and proves the shared platform before additional games. M6 delivers Satisfactory
and game integration expansion. M0–M4 retain their approved historical scope;
this reordering neither starts M5 nor authorizes deployment. See the dated
[ADR 0008 amendment](decisions/0008-complete-frontend.md).

**Scope**

- Full React user + Owner app, original design system and every applicable route in [Frontend and i18n](FRONTEND-I18N.md): first-run setup, invite/account/security flows, server creation and management, console with live CPU/RAM/network charts, streamed files, SFTP credentials, backups/restore, network/DNS, automation and settings.
- Durable Activity, accurate progress/errors, sleep/wake/resource-denial states, Owner users/invites/quotas/support sessions, infrastructure diagnostics, settings/secrets, game rollout/tester allowlists, runtime mappings and Owner-only compatibility administration.
- Complete the shared backend/API/worker/SDK capabilities needed by those journeys. Conditional wizard steps, capability-driven management tabs, multiple port roles and TCP/UDP connection presentation, files/SFTP, backup/restore, permissions, jobs/recovery and common integration configuration belong to M5 even when first motivated by Satisfactory. Their completion cannot depend on a Satisfactory server or protocol implementation.
- Complete optional project grouping, server/project sharing and their actual permission contracts; surface and fix common backend/API gaps rather than building controls around missing behavior.
- Meet [M5 common integration readiness](M5-COMMON-INTEGRATION.md) as an explicit acceptance gate, integrating existing M1–M4 contracts rather than introducing a parallel platform. Exercise generic contracts through isolated fixtures and actual supported Vanilla journeys; report the distinction.
- English/Italian on every user-facing surface, responsive layouts, WCAG 2.2 AA accessibility and browser E2E coverage. Apply the sourced usability and product-copy requirements in [Frontend and i18n](FRONTEND-I18N.md).
- Run the real app, capture sanitized desktop/mobile screenshots in both locales, review them and fix defects before making the PR ready. No temporary mock dashboard, dead navigation, fake controls or fabricated progress.

**Acceptance**

- Complete invite → signup/link/recover/secure account → create an eligible Minecraft Vanilla server → configure/manage → sleep/wake → files → backup/restore → account/session settings journeys. Owner setup, quotas, integrations/allowlists, runtime settings and isolated assisted sessions work end to end.
- All requirements in [M5 common integration readiness](M5-COMMON-INTEGRATION.md) have explicit API/job/browser evidence, failure/recovery coverage and documented deployment prerequisites. Shared platform gaps must be resolved in M5 rather than deferred to game expansion.
- Only evidence-backed, Owner-enabled combinations appear in ordinary creation. Vanilla is the only runtime with M4 real-server verification; Paper/Folia/Fabric/Forge and other unverified combinations remain hidden from ordinary users. Owner/tester access follows existing rollout and signed-evidence rules. Satisfactory is not an M5 dependency and has no pretend functional UI.
- Every offered action reaches a real authorized API and its verified result; loading, empty, denied, unavailable and partial-failure states remain useful. Appropriate external-provider mocks do not establish real deployment or game compatibility.
- Browser screenshots and automated/manual accessibility evidence cover desktop/mobile, English/Italian, supported game management, Owner flows and edge states. Fix must-fix visual/usability/accessibility defects; document remaining limitations without claiming unverified WCAG conformance.
- Document task flows before visual implementation, exercise real loading/empty/error/blocked/uncertain jobs, review useful information density and every English/Italian string, and obtain independent UX/content review explicitly checking verbosity, marketing filler, repetitive descriptions and generic AI/SaaS styling. Iterate on real screenshots.
- Preserve production approval boundaries, test provenance and the SFTPGo revocation exception tracked in issue #18. That exception must be revisited before production release; M5 completion is not permission to deploy or silently waive it.

**GitHub tracking:** retain the existing seven milestone objects (M5 ID 6,
M6 ID 7), rename their scope and move the frontend issues #14/#15 to M5 and
Satisfactory issues #12/#13 to M6 without replacing issue identities/history.
Issue #18 stays open as a cross-milestone **production-release gate**, detached
from the former frontend milestone. It is neither an implicit M5 implementation
requirement nor permission to defer the defect to M6. This document records the
approved tracking plan; GitHub metadata must be verified separately.

## M6 — Satisfactory & Game Integration Expansion (PR)

**Scope**

- Build on the completed M5 WebPanel and common platform. Add Satisfactory runtime/egg mapping, a dedicated conditional wizard and management contributions, multiple required TCP/UDP port roles and static hostname+assigned-port presentation.
- Satisfactory lifecycle, saves, game settings and player status; SMR mod search/install/update, SML compatibility and SMM remote Manage Servers interoperability through SFTPGo. Preserve the common service and permission boundaries established in M5.
- Game-specific idle detection and graceful save/stop. Investigate packet/session, TLS and server-manager/query behavior; implement only empirically verified wake behavior and document unavailable in-game capabilities accurately.
- Later Minecraft certifications may include Paper, Folia, Fabric, Forge or Pumpkin when suitable eggs and actual evidence are available. These are optional evidence-dependent expansion targets, not automatic support claims or M5 prerequisites.
- Expand runtime/game support only with scoped implementation, compatible runtime/egg metadata and actual evidence. Complete each added integration's localized, accessible UI through the M5 SDK surfaces; no second frontend foundation or automatic support promotion.

**Acceptance**

- A provenance-verified test-owned Satisfactory server can be created, configured, started/stopped and managed with the necessary ports and correct connection details through the existing WebPanel.
- SFTPGo filesystem isolation and SMM interoperability are verified in an approved controlled environment; preserve issue #18 and all production-release constraints.
- Mod catalog install/update, save operations and failure/recovery behavior pass; idle/wake capability claims match actual client/server evidence. UI, English/Italian translations, browser journeys and screenshots cover the added integration.
- Any additional profile/game remains Owner-gated until its own required compatibility evidence passes. No modification of existing game worlds, direct Pterodactyl servers, production eggs or infrastructure without the existing explicit approvals.

## Suggested pull-request series

Branch names:

```text
milestone/m0-repository
milestone/m1-foundation
milestone/m2-server-management
milestone/m3-game-gateway
milestone/m4-minecraft
milestone/m5-webpanel
milestone/m6-game-integrations
```

Use bounded subagents within the assigned milestone. M5 follows reviewed M4; M6 follows the complete M5 platform. Do not begin either milestone or branch from an unreviewed baseline without the Owner's explicit authorization.
