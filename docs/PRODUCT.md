# Product specification — NickHosting Panel

Status: approved requirements. This document governs the **end-user and Owner product behavior**; technical implementation choices are described separately.

## Purpose

Private, invite-only, free game-server hosting for friends. The public website `nickhost.ing` is separate. The app has its own configurable deployment hostname and independent `nickhosting-panel` repository. The existing Pterodactyl Panel remains a separate configurable backend; actual deployment addresses stay in local infrastructure notes. Users must never need to open Pterodactyl to manage their servers. No billing/cart/plan purchasing.

## User journeys

1. **Invite-only account**: a unique, expiring invitation link displays the registration experience; user chooses email/password or Discord. Email verification where applicable. After registration the same account can link Discord or add verified email/password. Passkeys and TOTP are opt-in.
2. **Simple server creation**: `Choose a game → Configure → Resources → Create`. `Configure` is game- and runtime-specific and may contain conditional substeps. No mandatory project/workspace before creating the first server.
3. **Self-service**: user creates any reasonable number of stored servers, subject to storage/ports/platform safety; RAM and CPU budgets limit concurrently starting/running/stopping servers, not their count while asleep/offline.
4. **First boot**: after provisioning, attempt to start if resource and node admission succeeds; otherwise persist server as offline and explain why.
5. **Daily management**: dashboard, servers list, console + CPU/RAM/network charts, files and SFTP credentials, backups, schedules/automation, settings, collaborators, game-specific content/players/worlds/properties.
6. **Sleep/wake**: on by default for integrations that support it; configurable per game/server, may be disabled. Game-specific idle detection and graceful stop. Gateway can awaken sleeping servers on actual join attempts where protocol allows; if RAM unavailable, immediately reply with a useful in-game message when supported. Manual stop disables automatic wake until deliberately changed.
7. **Game-specific content**: search/install/update/remove modpacks, mods and plugins from approved providers; support worlds and files. Compatibility, dependencies, runtime versions and safe job handling are required. Installing a modpack **on an existing server is a destructive reinstall/wipe** with explicit warning and user choice to create a verified pre-wipe backup or proceed without one.
8. **Server identity**: game integration declares `CUSTOM_SUBDOMAIN` vs `STATIC_HOST_PORT`. The domain feature appears in wizard and server settings only where enabled by integration/policy. For Minecraft Java, user can pick `name.games.example.com` plus Cloudflare DNS/SRV records; for Satisfactory, show configured `satisfactory.example.com:<assigned-port>` and appropriate game-specific ports. All domains, IPs and zone names are configurable, not code constants.
9. **Optional projects**: permit grouping/organization/collaborators across related servers. In the base experience a user sees simply “Servers” and “Create server”. Internally a personal project can be implicit.
10. **Full i18n**: English source language and Italian translation at first release; all accessible app, Owner, wizard, error, notifications, mail templates, accessibility labels and supported in-game helper messages are internationalizable. Additional locales require adding catalogs, not changing each component.

## Navigation (design requirements, not rigid CSS)

- **User:** Home, Servers, Activity, Settings. A server has Overview, Console (terminal + CPU/RAM/network), Files/SFTP, Backups, Automation, Settings, and conditional game-integrated sections.
- **Owner:** Overview, Users, Servers, Infrastructure, Game Integrations, Operations, Settings. User administration includes quotas, invites, permissions, per-user server inventory, support sessions; node and gateway diagnostics, job monitoring, rollout controls.
- Search, keyboard access, responsive operation, meaningful loading/empty/failure states, real progress when known, no fake percentages.
- **M6 only:** a complete, coherent, production-quality frontend with real screenshots for review. No temporary MVP frontend or AI-generic dashboard. Earlier milestones test via APIs and fixtures.

## Owner controls

- First-run setup wizard if there is no Owner (details in `AUTH-AND-PERMISSIONS.md`), with first Owner identity and initial Pterodactyl connection settings. No account/data seeding.
- Users, invitations, quotas, storage policy, subdomain zones, provider integrations, game runtime/egg mapping, gateway settings, job log, support impersonation and backend health.
- Per-game availability lifecycle: **development**, **allowlisted testers**, **public**, **disabled for new creations**. Disabled-for-new-creation must not orphan existing servers; existing-compatible management continues.
- **Owner support session** (also called assisted/impersonation session): interface in another user's context but Owner authority belongs only to this specifically scoped temporary session. The user's existing sessions and permissions do not change. Preserve `actor` and `subject` separately in audit.

## Launch game set

**Minecraft Java:** Vanilla, Paper, Folia, Fabric, Forge, plus other profiles (e.g. Pumpkin) only if verified and clearly marked supported/experimental; profiles have version-aware runtime and protocol handling, operations (OP/whitelist/players with optional MCHeads), mod/modpack/plugin/world managers, properties, sleep/wake, customizable subdomain+SRV. A modpack dictates loader and Minecraft version, so omit redundant wizard steps.

**Satisfactory:** dedicated wizard, multiple required ports, static host+port strategy, game settings, save management, SMR catalog, support for SMM remote management via SFTPGo and relevant mod tooling, game-specific idle/sleep/wake capability tested before declared supported. Do not promise in-game wake messages when protocol/client cannot display them.

After launch, add other games **one at a time**, with individual UX and integration work. Plugins are trusted, repo-owned versioned modules, not untrusted runtime code packages or a public marketplace.

## Non-goals

- Selling servers, invoices, paid plans, subscriptions.
- Replacing Wings/implementing a container scheduler from scratch.
- Patching or forking Pterodactyl/Wings as a baseline dependency.
- Forcing every Pterodactyl server to use the NickHosting gateway.
- Building an install-anything plugin marketplace or complex third-party sandboxing system.
- Shipping hypothetical Minecraft limbo worlds in v1; architecture may allow experimental future modes.

## Acceptance principle

Each feature must be genuinely functional for its declared support matrix. If a runtime or protocol is not tested, mark it unsupported/experimental. Prefer a clear capability limitation to a fake UI control.
