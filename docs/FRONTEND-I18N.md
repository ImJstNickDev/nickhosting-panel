# M6 frontend and full internationalization requirements

## Delivery standard

M6 is **one dedicated frontend milestone**, after Core, Gateway and both initial game integrations are in place. No disposable MVP/mock-dashboard deliverable: complete user and Owner experiences connected to real typed APIs, documented capability limitations, accurate states and validated user journeys. Earlier milestones use API tests, SDK harnesses and fixtures; they do not implement partial competing UIs.

UI must be distinct from Pterodactyl and consistent with NickHosting's own identity: precise hierarchy, dense where appropriate, accessible keyboard interaction, restrained motion, carefully chosen typography, no gratuitous generic gradient/glass dashboard design. No verbose, self-referential product copy. Form microcopy should be short and natural.

## Routes / surfaces

- Public invite registration, sign-in, password reset/recovery, Discord auth redirect, one-time protected Owner setup.
- User Home, Servers (filters/search), Create Server four-step game wizard, Activity/jobs, Settings (profile, language, password, linked Discord, passkeys, TOTP, sessions).
- Per-server: Overview, **Console with live CPU/RAM/network charts and commands**, Files (upload/edit/download, SFTP credential details), Backups/Restore, Network/connection address, Automation/Sleep, Settings, project sharing; game-specific tabs injected through SDK.
- Owner: Overview/health, Users/invites/quotas/support, all NickHosting servers, Infrastructure/nodes/gateway, Game Integration catalog/allowlist/egg mappings, Operations/job failures/audit, platform settings/credentials.
- Owner assisted session persistent visually identifiable banner with Exit and separate actor/subject, no ordinary user session mutation.

## UX principles

- Operations continue if browser closes; Activity shows durable jobs, real step progress, retry and error details. Never report completion before external operation verification.
- Clear status: runtime online/offline vs readiness vs sleep/wake vs blocked by resources.
- Disk/RAM quota transparency; offer explicit stop-another-server flow if manual start is blocked. Wake attempts that lack RAM get immediate refusal rather than automatic queue.
- Modpack on existing server always requires destructive warning, optional verified backup and explicit acknowledgement.
- Forms: validate in-line, preserve draft, accommodate game plugin conditional steps. Game integration controls plugin-specific UI, not global hardcoded game switches.
- Full desktop/mobile responsiveness; file manager and console should remain usable on smaller screens. Keyboard shortcuts where useful; accessibility, focus, reduced-motion.

## Internationalization

Use **Lingui or a similarly robust React i18n framework** after checking current versions. English is source locale, Italian is shipped at launch. Every string visible to end users, including Owner, game integrations, error/dialog/success notifications, tooltips, ARIA labels, time estimates, emails and authentication messages must use translation catalogs. No hardcoded English UI text.

- Base catalogs live in shared i18n package; each `games/*` integration owns namespaced catalogs, code-split/lazy-loaded where appropriate.
- Native `Intl` for locale-sensitive number, relative time, memory units and datetime formatting. Server/game raw console output, remote catalog descriptions and raw player chat are unmodified source text, not magically translated.
- Add locale through one registration step + extraction + translation + compilation; missing keys fall back to English and fail appropriate checks for required release locales.
- Detect browser locale for anonymous visit, persist user preference in account settings after login, allow manual override; no requirement for locale-prefixed panel URLs.
- Translate supported in-game wake/sleep helper messages based on client protocol language if available, else Owner-configured server locale.
- Pseudo-localization/long-string tests, RTL readiness in layout where feasible, verify no overflow/truncation of critical status or buttons.

## Screenshot acceptance

Codex must run the actual frontend in a reproducible environment and capture screenshots (e.g. Playwright) of desktop/mobile, dark/light if provided, and representative states: login/invite, Home, Servers, create wizard (Minecraft/modpack and Satisfactory), console+graphs, Files/SFTP, Minecraft mods/players/worlds, Satisfactory pages, sleeping/waking/insufficient resources, Activity errors, Owner dashboard/users/assisted session, i18n Italian/English. Attach sanitized screenshot evidence/links to M6 PR and iterate after reviewer feedback; do not generate mock screenshots or claim to have viewed pages without running them.

## Required checks

Build, lint, type checks, unit and browser E2E tests, internationalization completeness, accessibility checks, responsive review, screenshot review, core error/loading/empty flows, backend authorization and session transitions. External provider tokens/test assets sanitized.
