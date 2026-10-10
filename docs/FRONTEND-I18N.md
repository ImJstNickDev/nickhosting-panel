# M5 WebPanel, UX and full internationalization requirements

## Delivery standard

M5 delivers **Complete WebPanel & Common Platform Readiness** after the M1–M4
foundation, lifecycle, Gateway and Minecraft work. It includes the shared backend,
API, worker and SDK gaps required by complete user and Owner journeys. Satisfactory
and other game expansion belong to M6 and are not prerequisites for M5. The
[M5 common integration gate](M5-COMMON-INTEGRATION.md) is part of acceptance;
[ADR 0008's dated amendment](decisions/0008-complete-frontend.md) preserves the
original sequencing decision.

Deliver the complete application connected to real typed APIs, with accurate
capabilities and verified user journeys. Earlier milestones use API tests, SDK
harnesses and fixtures, not competing partial UIs. No disposable MVP, mocked
operational dashboard, dead navigation or feature-shaped placeholder counts as
finished. A UI control must perform an authorized operation or explain a real,
applicable restriction; omit unsupported game functions from ordinary journeys.

Vanilla alone has M4 real-server verification. Normal creation shows only exact
version/runtime combinations with sufficient evidence and Owner enablement.
Paper/Folia/Fabric/Forge and other combinations stay hidden until verified;
experimental access follows the existing private-testing allowlist. Internal
protocol IDs, test checklists and support badges belong to Owner administration.
An administrative checkbox cannot manufacture compatibility. M5 must neither
promise a modded Vanilla runtime nor provide fake Satisfactory functionality.

## Implemented conventions — M5, 2026-10-09

The [task-flow inventory](M5-JOURNEYS.md) precedes the implemented screens. The
[common integration checklist](M5-COMMON-INTEGRATION.md) connects each journey to
actual API, job and browser coverage; [M5 API contracts](M5-API-CONTRACTS.md)
defines permission, uncertainty, stream and configuration behavior. These
implementation notes do not replace the acceptance standards below or claim the
pending final consolidated review has passed.

### Application and integration ownership

`apps/web` uses React/Vite, React Router, TanStack Query and Lingui; versions are
pinned in its manifest/lockfile. Shared semantic primitives live in
`apps/web/src/components/ui.tsx`, with page headings, labeled fields, error/status
notices, tables and native dialogs. The shell owns ordinary/Owner navigation,
identity context and common server services. Regular platform operators have a
restricted Administration area for audit and read-only settings; Owner mutation
controls are absent and backend checks remain authoritative. It moves focus to the page heading
on navigation and supplies a skip link and a mobile navigation disclosure.

Trusted first-party game modules own validated creation/management descriptors,
handlers, namespaced catalogs and bundled artwork. The generic renderers use the
browser-safe Game SDK; API JSON cannot install executable UI, remote imports or
arbitrary asset URLs. Available controls combine effective permissions with
verified runtime/capability, rollout, configured provider and current server state.
Do not replace these checks with a game-name conditional in each shared screen.

Game cards use the integration's bundled art through the static registry, with a
consistent crop and bounded useful width. Adjacent game/server text supplies the
name; redundant artwork has empty alternative text. Unknown modules retain an
honest text fallback. Source/provenance belongs with the game integration. The
art does not become a hero panel, background effect or substitute for real state.
Configured CPU/RAM/disk on cards are labeled as limits, not current usage.

### Visual and behavior conventions

M5 currently supports **one light theme**. Use warm neutral background, white
working surfaces, dark text, restrained blue actions and named semantic state
colors. System fonts, compact consistent spacing, tabular resource numbers and
contained table scrolling prioritize working information. A dark theme is not an
available preference and is not silently represented by untested screenshots.
The initial overly wide single-server artwork card was constrained during actual
screenshot review; preserve that density as content grows.

Forms preserve entered data on request failure. Destructive dialogs state actual
loss and require the supported confirmation; no fabricated undo. The creation installer keeps relevant choices/drafts across Back and uses
server-filtered runtime choices. Its current Vanilla path is Game → Runtime → Name → Version → Operators →
Whitelist → Resources → Create. Runtime selection is explicit even when only
Vanilla is eligible; version rows show only the release identifier. It has separate
player-count/resource controls; the final Create
action records EULA acceptance. No project or content-source picker is shown.
Future preset/modpack creation is tracked separately in issue #24. All submitted jobs link to
Activity; accepted, running, blocked, uncertain, failed and completed remain
distinct. A created/offline capacity-denied server is not presented as a failed
creation or automatically started again.

Console updates use bounded SSE parsing/display (300 retained lines with a
per-line bound); charts show timestamps, units and gaps. Historical reads paginate
instead of accumulating unbounded data. Binary uploads use Blob/XHR progress and
cancellation, and file/backup downloads use native same-origin streaming links.
Only the text editor has its own size limit. Authority is checked server-side
throughout transfers; the browser never sees a privileged provider URL/token.
An uncertain upload or restore cannot be described as rolled back without proof.

### Catalogs and locale behavior

English is the source language and Italian is required. Shared EN/IT message
pairs are in `packages/i18n/src/*web.ts`; game catalogs live with their first-party
module. `scripts/compile-web-i18n.ts` merges those reviewed sources and compiles
Lingui ICU messages for `en`, `it` and a development pseudolocale. Missing locale
keys/empty pairs or malformed ICU fail compilation. The compiled JSON is build
output checked by `pnpm i18n:check`; do not hand-edit it.

`useT` localizes application content/errors; unknown keys show a localized generic
fallback, not a raw implementation key. `useFormat` uses `Intl` for dates, relative
time, numbers and byte units. Real remote console/player/catalog content remains
source text. Browser preference is used before sign-in; the account locale takes
over after authentication. Explicit locale changes persist through the existing
profile operation. The pseudolocale is for development verification, not an
advertised third translation. EN/IT completeness and ICU plural/long-text behavior
are tested in `apps/web/src/app/i18n.test.ts`; localization also includes existing
backend mail/job/error catalogs and game contributions.

### Reproducible browser evidence

Browser tests start the actual Hono/React application through
`apps/web/tests/harness.ts`, use migrated disposable schemas on the approved
isolated services and create identities through real setup/invitation handlers.
Playwright runs Chromium under Vitest. NickHosting API routes are not route-mocked;
mail, Discord transport and the stateful Pterodactyl/SFTP/content providers are
isolated fixtures. Browser Minecraft fixture signatures explicitly identify
synthetic evidence and do not certify real game/runtime combinations.

The account, Discord, platform, services and Minecraft browser files cover actual
mutations and results alongside axe checks and sanitized screenshots. Include
both EN/IT and desktop/mobile in the final inventory. This is not cross-browser,
assistive-technology or complete WCAG certification: record the actual devices,
manual keyboard/focus/reflow checks, omissions and independent findings. Review
screenshots for density, wording, meaningful unavailable states and truthful
resource labels. Do not replace a failed scenario with a screenshot-only claim.
Final full-suite results and independent UX/accessibility acceptance remain a
separate consolidation step; targeted development runs are preserved honestly.

## Routes and surfaces

- Public invite registration, sign-in, password reset/recovery, Discord redirect/linking, optional passkeys/TOTP, email verification, and protected one-time Owner setup.
- User Home, Servers with search/filters, centered Create Server installer, Activity/jobs, Settings: profile, locale, password, linked Discord, passkeys, TOTP and active sessions.
- Per-server Overview; Console with live CPU/RAM/network charts and commands; Files with binary uploads, editing and streamed downloads; SFTP credential management; Backups/Restore; Network/connection details; Automation/Sleep; Settings; project grouping, sharing and permissions. SDK-defined management sections appear only for supported capabilities.
- Minecraft management for eligible combinations: properties, independent player identity/OP/whitelist, worlds and applicable content workflows, including explicit replacement consent and verified backup choice. Unsupported mod/plugin operations are not shown as available for Vanilla.
- Owner Overview/health; Users/invites/quotas/support; all NickHosting servers; Infrastructure/nodes/Gateway; Game Integrations/allowlists/egg and runtime mappings/compatibility evidence; Operations/failures/audit; platform settings and protected credentials.
- Assisted sessions have a persistent identifiable banner, clear Exit, actor/subject separation and scoped authority. They do not alter the user's ordinary sessions.

Implement common conditional wizard rendering, extension tabs, multiport TCP/UDP
presentation, static-host and custom-domain modes, jobs/recovery, files/SFTP,
backups and project-sharing permissions in M5. Use isolated SDK fixtures where
Vanilla does not exercise a contract. The UI and shared services must be ready
for M6; a fixture never establishes another game's compatibility.

## Task flows before visual implementation

Document each user/Owner task, entry point, required permission, API/job result,
next action and relevant failure states before implementing its visual screen.
Identify the primary action, destructive consequences and recovery route. Review
the information architecture and the four-step creation flow before styling;
validate that users can complete tasks without opening Pterodactyl or finding
Owner-only identifiers.

Create a route/state inventory covering real loading, empty, validation failure,
permission denial, resource blocking, provider outage, uncertain remote results,
partial failure and success. Job uncertainty is a real state: distinguish an
operation being reconciled from one known to have failed. Closing a browser must
not cancel or lose a durable operation. Activity must explain what is known and
what the user can do; it must never claim completion or rollback without proof.

## Product copy: operational, concise and natural

**NickHosting is an application, not a marketing landing page.** Labels, cards and
paragraphs are not unique selling propositions. Do not use “Unlock your full
potential”, “Seamlessly manage”, “Powerful tools at your fingertips”, “Take complete
control”, or similar promotional filler in either locale.

Prefer factual task vocabulary:

| English | Italian |
|---|---|
| Servers | Server |
| Create server | Crea server |
| Server offline | Server offline |
| Start | Avvia |
| Backup completed | Backup completato |
| Not enough memory to start this server | Memoria insufficiente per avviare questo server |
| Installation failed. View details. | Installazione non riuscita. Visualizza i dettagli. |

Do not automatically add a subtitle to every heading, describe obvious controls,
repeat the same explanation across cards, or fill empty states with inspirational
prose. Add a sentence only when it supplies information or an action the user
needs. Empty states explain why there are no results and offer the relevant next
action. Errors state what happened and how to proceed, with optional diagnostics
kept separate. Destructive warnings name the server/data affected, actual loss,
backup choice and consequences; they do not use vague alarm or claim reversibility
that has not been tested. Review the complete English and Italian copy in context,
including terse button labels, plural forms and narrow mobile layouts.

## Visual and interaction requirements

Use an original, polished NickHosting visual system, distinct from Pterodactyl.
Prioritize readable information, useful density and efficient frequent actions.
Make hierarchy, typography, alignment and spacing consistent; choose compact
layouts where they improve comparison without reducing legibility or target size.
Keep secondary/advanced controls discoverable through progressive disclosure.
Owner administration must remain powerful without showing every diagnostic and
setting on every screen.

Prohibit gratuitous gradients, glass effects, giant empty cards, meaningless
statistics, overdecorated icons, hero sections, unnecessary animation and generic
SaaS dashboard templates. Use charts for actual operational questions, with units,
source timestamps and honest missing/stale data. Icons supplement clear labels;
color must not carry meaning alone. Offer restrained motion only when it helps
understand a transition and honor reduced-motion preferences.

Maintain predictable navigation, stable control locations and visible keyboard
focus. Preserve drafts and browser Back behavior across wizard steps; ask only
relevant questions. A supported modpack determines Minecraft/loader versions,
removing redundant questions while retaining OP/whitelist and relevant settings.
Provide safe cancellation and undo only when the underlying operation supports it.

Show runtime state, game readiness, sleep/wake and resource blocking distinctly.
Show actual storage/active compute usage and relevant limits. If a manual start is
blocked, the user may deliberately stop another authorized server; never do this
automatically. A resource-denied wake is refused immediately, without an automatic
waiting queue. Never invent job percentages, startup estimates or placeholder data.

Desktop and mobile layouts must support real work: usable console controls,
accessible file actions, legible tables/charts and contained horizontal scrolling
where necessary. Do not replace functional mobile screens with an unsupported
message or hide the only available action.

## Usability references and review standard

Use the following primary guidance, researched 2026-10-09, as design/review
references. NickHosting keeps its own visual identity; these references do not
imply certification or endorsement.

Apply NN/G's heuristics to concrete tasks: keep operational state visible; use
familiar server/account language; provide understandable exits; keep terminology
and interactions consistent; prevent costly mistakes; show relevant choices
instead of relying on memory; support efficient repeated work; remove irrelevant
content; explain recovery; provide concise contextual help. A reviewer must tie
findings to actual screens and task failures, not a stylistic checklist.
[NN/G usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/).

Use GOV.UK's task-oriented service guidance to evaluate whether journeys are
understandable and complete. Adapt question-page guidance by asking only needed
questions, preserving previous answers and Back behavior, and keeping labels and
optional fields explicit. Apply error-summary patterns to long forms: focus a
concise summary after failed submission, link to affected fields and repeat the
same useful error near each input. These are interaction references, not a request
to copy GOV.UK branding or impose one-field pages on every server-management task.
[GOV.UK service simplicity](https://www.gov.uk/service-manual/service-standard/point-4-make-the-service-simple-to-use),
[question pages](https://design-system.service.gov.uk/patterns/question-pages/),
[error summary](https://design-system.service.gov.uk/components/error-summary/).

For interface writing, use plain familiar words and put essential actions first.
Name buttons for the operation they perform; remove words that add no useful
meaning. Apply the same factual standard in Italian rather than literal
translations of English promotional phrasing.
[GOV.UK clear-language guidance](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/writing-guidelines/clear-language/),
[GOV.UK button labels](https://design-system.service.gov.uk/components/button/).

## Accessibility acceptance

Target **WCAG 2.2 Level AA**, covering applicable Level A and AA criteria across
complete journeys, not selected components. Use semantic structure, associated
labels, keyboard operation, sensible focus order, visible/unobscured focus,
accessible names and status announcements. Check text/non-text contrast, zoom and
reflow, usable pointer targets, non-drag alternatives, error identification and
recovery. Avoid color-only state, keyboard traps and inaccessible time limits.
Automated checks supplement manual keyboard, assistive-technology and responsive
review; a passing scanner alone cannot establish conformance.
[WCAG 2.2 Recommendation](https://www.w3.org/TR/WCAG22/).

Authentication must permit password managers and paste, with accessible supported
alternatives rather than an unnecessary memory/transcription challenge. Keep focus
from being hidden by sticky controls, dialogs or assisted-session banners.
[W3C accessible authentication](https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html),
[focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html).
Record the tested browser/device/assistive-technology combinations, findings and
fixes. Do not present unresolved failures as WCAG conformance.

## Internationalization

Use **Lingui or a similarly robust React i18n framework** after checking current
versions. English is the source locale; Italian ships in M5. Every visible string,
including Owner/game sections, errors, dialogs, notifications, tooltips, ARIA labels,
estimates, email and authentication messages, belongs in translation catalogs.
No hardcoded English UI text.

- Shared catalogs live in the i18n package; each `games/*` integration owns namespaced catalogs, loaded on demand where useful.
- Use native `Intl` for numbers, relative times, memory units and dates. Raw server console, player chat and remote catalog descriptions remain source text; do not claim they are translated.
- Add a locale through registration, extraction, translation and compilation. Required release locales must have matching complete catalogs; missing translations fail compilation/completeness checks. An unrecognized runtime key displays a localized generic fallback, never the raw implementation key.
- Detect browser locale anonymously, persist account preference after sign-in and allow explicit switching. Locale-prefixed panel URLs are not required.
- Supported game wake/sleep helper messages use client language where the protocol supplies it, otherwise the Owner-configured server locale.
- Test pseudo-localization/long strings, flexible layouts and RTL readiness where feasible. Critical actions and statuses must not be lost to clipping or truncation.

## Screenshot and independent UX acceptance

Run the actual frontend in a reproducible environment. Capture sanitized browser
screenshots of desktop/mobile, both locales and each supported theme. Cover
invite/login/recovery/setup, Home, Servers, eligible Minecraft creation and
conditional SDK fixture variants, console/charts, Files/SFTP, backups, network,
Minecraft properties/players/worlds and supported content, Activity, sleep/wake,
resource denial and uncertainty, account security, Owner users/quotas/integrations,
audit and assisted sessions. Include useful loading, empty and failure views.
Do not generate mock screenshots or claim to inspect an unrun page.

Review screenshot evidence for layout, density, hierarchy, legibility and copy;
iterate on defects before marking the M5 PR ready. Require an **independent UX and
content review** as well as technical review. It must explicitly flag verbosity,
marketing language, repetitive obvious-feature descriptions, generic AI/SaaS
styling, confusing controls and keyboard/mobile problems. Report findings and
resolutions with actual screenshots and task evidence.

M6 adds real Satisfactory/expanded-game journeys, localized screens and screenshots
only as their behavior becomes verified. Those future game screens are not M5
placeholders or blockers for the common platform.

## Required checks

Build/lint/types, unit and browser E2E tests, backend authorization/session
transitions, shared integration acceptance, complete English/Italian copy review,
i18n completeness, automated/manual accessibility, keyboard/focus review,
desktop/mobile density and screenshot iteration. Exercise real job recovery and
uncertain/blocked states. Sanitize credentials and test assets. The SFTPGo
revocation exception in issue #18 remains a cross-milestone production-release
gate; neither this milestone reorder nor a UI warning resolves it or authorizes
deployment.
