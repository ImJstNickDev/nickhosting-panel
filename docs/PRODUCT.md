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
- **M5:** a complete, coherent WebPanel with real screenshots and [common platform readiness](M5-COMMON-INTEGRATION.md). Earlier milestones test via APIs and fixtures; M6 adds game integrations to the finished shared interface. No temporary MVP, mock dashboard or dead navigation.

The panel is an operational application. Put server state, connection details and
the next useful action first. Avoid marketing headlines, promotional hero sections,
decorative KPI cards, filler copy and technical architecture explanations in normal
user journeys. Use a restrained, consistent visual system and concise English/Italian
microcopy. Apply the documented [usability and accessibility requirements](FRONTEND-I18N.md)
to the real account, server and Owner tasks.

## Owner controls

- First-run setup wizard if there is no Owner (details in `AUTH-AND-PERMISSIONS.md`), with first Owner identity and initial Pterodactyl connection settings. No account/data seeding.
- Users, invitations, quotas, storage policy, subdomain zones, provider integrations, game runtime/egg mapping, gateway settings, job log, support impersonation and backend health.
- Per-game availability lifecycle: **development**, **allowlisted testers**, **public**, **disabled for new creations**. Disabled-for-new-creation must not orphan existing servers; existing-compatible management continues.
- **Owner support session** (also called assisted/impersonation session): interface in another user's context but Owner authority belongs only to this specifically scoped temporary session. The user's existing sessions and permissions do not change. Preserve `actor` and `subject` separately in audit.

## Game delivery and truthful availability

**M5 Minecraft Java:** Vanilla is the only runtime with M4 real-server verification; availability still requires the exact version/runtime evidence and Owner enablement. Paper, Folia, Fabric, Forge and other profiles remain hidden from ordinary users until their required evidence passes. Profile/protocol support states, test evidence and experimental testing controls belong to Owner administration, not ordinary creation screens. Existing rollout/tester allowlists govern private testing; an Owner checkbox cannot establish compatibility. Supported features include version-aware runtime/protocol handling, OP/whitelist/players with optional MCHeads, applicable content/world management, properties, sleep/wake and subdomain/SRV configuration. A supported modpack determines loader and Minecraft version, so omit redundant questions. Do not expose mod/plugin actions on Vanilla as if it supported those runtimes.

**M6 Satisfactory:** dedicated wizard, multiple required ports, static host+port strategy, game settings, save management, SMR catalog, SMM remote management via SFTPGo and relevant mod tooling, with game-specific idle/sleep/wake tested before it is declared supported. Do not promise in-game messages when the client cannot display them. Satisfactory is not a dependency for M5: its shared wizard, tab, networking, file, SFTP, backup and job foundations must already work through the M5 common platform. Do not ship fake Satisfactory screens to satisfy M5.

After launch, add other games **one at a time**, with individual UX and integration work. Plugins are trusted, repo-owned versioned modules, not untrusted runtime code packages or a public marketplace.

## Non-goals

- Selling servers, invoices, paid plans, subscriptions.
- Replacing Wings/implementing a container scheduler from scratch.
- Patching or forking Pterodactyl/Wings as a baseline dependency.
- Forcing every Pterodactyl server to use the NickHosting gateway.
- Building an install-anything plugin marketplace or complex third-party sandboxing system.
- Shipping hypothetical Minecraft limbo worlds in v1; architecture may allow experimental future modes.

## Acceptance principle

Each offered feature must function for its declared support matrix. Record untested
runtime/protocol states as unsupported, unverified or experimental in internal and
Owner administration; ordinary users see only eligible choices. Prefer an
actionable capability limitation to a fake UI control. M5 requires the complete
shared platform and UX acceptance; M6 adds separately verified game behavior.
