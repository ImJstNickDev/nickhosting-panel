# M5 WebPanel, UX and full internationalization requirements

Quill's Markdown document controls follow the same compact ViewerEngine/Scribe
interaction patterns. Its EN/IT catalog is `packages/i18n/src/quill-web.ts`;
document content and third-party syntax are not translated. See
[Quill syntax and access boundaries](M5-QUILL.md) for supported Markdown, math,
diagrams and Obsidian links. Custom directive/tab blocks remain excluded by the
Owner. External images require explicit loading, and preview task edits use the
shared draft with explicit save, undo and source-position handoff.

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

### Personal settings

Personal Settings uses the same route-based tab navigation as server pages:
Profile at `/settings` and Security at `/settings/security`. Profile contains name,
read-only username, language, email and linked login methods; Security contains
password, two-factor authentication, passkeys and sessions. Sidebar/account-menu
links, Discord linking, email-link verification and email changes return to Profile.
Reload and browser history preserve the selected tab.

Sessions and passkeys load only when Security is opened. Both tabs reuse the same
linked-account query (Security needs it to determine password availability). In-progress authenticator
setup
and recovery codes stay in the Settings layout's memory across tab changes and are
discarded when leaving Settings; neither is persisted in browser storage. Assisted
sessions retain the existing restriction on personal account settings. Both tabs
use the shared responsive forms, EN/IT catalog and keyboard-accessible navigation.

Personal Settings is centered with a bounded reading width, including its heading
and tabs. Profile opens with identity rather than a permanent form. Clicking the
name edits it in place: Enter or leaving the field saves only the name; Escape
cancels. Empty names are rejected, and failures keep the draft. Language uses
English/Italiano segments with native radio keyboard behavior and saves immediately
without another button. The interface previews the selected language immediately
and restores the previous language if saving fails. These independent operations
send partial fields so one cannot overwrite the other.

The avatar is a file-picker button with a camera badge. Dropping one photo on the
identity header opens the same validated crop flow; multiple files are rejected
and drop/picker activity cannot replace a pending upload. Email and linked login
methods share a compact surface below. Email changes and adding an email login
open inline on request; the current email remains visible until verification
completes. Unlinking uses the shared Cancel-first confirmation and never offers
removal of the last login method. Quiet icon actions have accessible names/tooltips.
Mobile wraps long identity values without overflow; text-entry focus uses its
existing border without an extra decorative outline.

Security uses compact action rows. Password and TOTP forms open on request;
password changes still revoke other sessions, and TOTP retains the existing
password/verification requirements. Passkeys support contextual naming and
Cancel-first removal. TOTP enrollment is an inline three-step flow: confirm identity,
scan a locally generated QR (or expand the manual key), then save recovery codes
after a successful six-digit verification. Setup remains resumable across the
Profile/Security tabs, including an in-flight request; it never issues a second
enrollment merely because the user navigated. The partial OTP input is cleared on
tab changes. Recovery codes offer local copy/download and Done discards them.
Set up later hides the unverified draft; it does not enable TOTP or pretend to
remove the server-side draft. Starting again after leaving Settings replaces the
unverified draft through the existing endpoint. No password or secret enters
browser storage, URLs, logs or query caches. Failed QR loading offers manual entry;
clipboard failures remain visible. Focus follows the active step and validation.
A failed non-authentication background session refresh preserves regular-session
forms/recovery codes with a retry notice; authentication failures still exit the
session. Actual successful TOTP mutations remain visible until an authoritative
session refresh catches up. Session rows derive browser/OS labels only from the
returned user-agent, expose full details on demand and confirm revocation. No
current-device claim is inferred without a matching session identity. Shared
account queries and TOTP setup memory are reused between the two routes.

### SFTP interface

SFTP uses the Files/Console visual conventions: a compact connection summary,
copyable `sftp://` host and separate port, and an always-visible additional-access
table with quiet icon actions. Revoked accesses are hidden initially; the keyboard-
accessible Show revoked switch filters locally without changing quota accounting.
Desktop uses labeled columns; mobile stacks each row without horizontal scrolling. Destructive confirmation reuses the shared file-manager dialog with
Cancel focused first. Passwords returned by issuance/rotation remain in component
memory only, masked initially. Primary Show/Copy explicitly retrieves the encrypted
password through the issuer-only API; additional accesses offer the same recovery
in their password panel. Copy retrieves a fresh value without displaying it unless
the clipboard fails. Hiding discards the primary value, and navigation/identity
changes abort pending retrieval and discard secrets. Passwords never enter query
or persistent browser caches. The
retained-SSH limitation remains available in a disclosure and relevant action
confirmations; it is not advertised as a successful session-revocation guarantee.
Missing configuration and permission restrictions preserve the existing backend
capabilities. Loading, API failure and clipboard failure are visible; the UI does
not report success before the API resolves. EN/IT text lives in `sftp-web.ts`.

### Application and integration ownership

`apps/web` uses React/Vite, React Router, TanStack Query and Lingui; versions are
pinned in its manifest/lockfile. Shared semantic primitives live in
`apps/web/src/components/ui.tsx`, with page headings, labeled fields, error/status
notices, tables and native dialogs. The shell owns ordinary/Owner navigation,
identity context and common server services. Regular platform operators have a
restricted Administration area for audit and read-only settings; Owner mutation
controls are absent and backend checks remain authoritative. It moves focus to the page heading
on navigation and supplies a skip link and a mobile navigation drawer. Desktop
navigation stays within the viewport while the page scrolls; short windows scroll
the sidebar internally so administration and account links remain reachable.
The desktop toggle changes the sidebar from 224 px to a 64 px icon rail. Its local
display preference persists across reloads and ordinary/Owner navigation. Compact
links retain accessible names, current-page markers and shared tooltips. A 200 ms
width transition keeps icons aligned while labels fade without wrapping; reduced
motion disables transitions. Mobile uses an icon-only opener and a native modal
left drawer, with a dimmed backdrop and a restrained 180 ms slide. It overlays the
page without moving its content. Full-label navigation scrolls independently inside
the viewport and respects safe areas, regardless of the saved desktop preference.
Escape, the close icon, backdrop or navigation dismiss it; background interaction
and scrolling remain locked until dismissal. Focus returns to the opener, or to
the destination heading after navigation. Resizing to desktop releases modality
and restores the desktop preference. Reduced motion removes drawer animations.
Route organization and authorization are unchanged.

The topbar uses a circular profile silhouette to open an account disclosure with
an avatar centered above the centered current name, Settings and Sign out.
Authorized users have an administration sliders icon beside the topbar avatar,
with an Admin tooltip on hover or keyboard focus; operators retain their audit
destination. The administration sidebar keeps its Home return link.
The account disclosure closes on outside click, Escape,
focus leaving the disclosure or navigation. Escape restores avatar focus;
activating Settings while already there also preserves focus. Logout uses the
existing identity/cache reset and exposes request errors with repeat submissions
disabled while pending. Assisted sessions show Exit assistance instead of personal
account actions. Profile settings allow a local PNG/JPEG/WebP photo (up to 5 MiB),
with a circular crop preview, pointer/keyboard positioning and zoom. Saving updates
the topbar and account disclosure; removal restores the silhouette. The browser
prepares a 256 px square PNG, and the API validates and re-encodes the thumbnail
before storing it. Originals and draft object URLs are discarded, not retained in
browser storage. Failed changes preserve the saved photo and expose retryable
errors. Discord image metadata is independent and does not replace this photo.

Owner Users groups search, role filtering and Invitations in one toolbar. Search
applies after a 200 ms typing pause; role changes apply immediately with the
current search text. Filter changes reset pagination, superseded requests cancel,
and pagination is disabled while filters/results are updating. Existing results
remain visible during refetch, with a compact search loading indicator, busy
semantics and visible retryable errors.
Alt+K focuses and selects the search text, with the same modifier, composition and
open-dialog guards as Files; the hint displays Option+K on Apple keyboards.

Invitations use row actions to reveal/copy a link, edit expiration and maximum
uses, or confirm revocation. Role and recipient remain read-only; used/maximum
counts distinguish exhausted invitations, and revoked rows remain in the list.
Mobile rows stack their labeled fields so status and actions remain visible
without horizontal scrolling. After revocation removes its action button, dialog
focus returns to Create invitation.
Dialogs retain drafts and display failures; clipboard failure leaves the URL
selectable. Revealed URLs exist only in component memory, never browser storage.
The UI uses the invitation GET-link/PATCH contracts in `M5-API-CONTRACTS.md`.
Encrypted tokens allow recovery after navigation or reload; editing retains the
same URL and already-consumed uses. Legacy hash-only links are explicitly
unrecoverable. Creation and revocation retain their existing API contracts,
with real error handling throughout.

Home uses compact standalone server cards, resource allowance cards and aligned
recent activity rows. Server cards open through their full surface, with a native
link, whole-card keyboard focus and a separate active-operation link when present.
Cards show only process state (Offline, Starting, Online, Stopping, or Unknown
when unconfirmed); the automatic sleep/wake state is retained on the Status page.
CPU/memory limits and measured disk use have icons beside the values, with localized
tooltips and accessible labels; the entire card remains a native navigation link.
Allowance cards preserve committed, limit and remaining values with explicit units;
they describe resource reservations, not live process measurements.

Server entry opens Console by default, with Start/Restart/Stop and their durable
operation feedback and restart confirmation. Stop is disabled when offline.
During a provider-confirmed stopping state it becomes Kill, enabled only for an
eligible current NickHosting stop operation. Force-stop confirmation explains the
risk of unsaved/corrupted data and binds to that exact operation; a changed state
or operation closes it. Status is an informational tab after
all game sections (after Content for Minecraft); its URL is `/servers/:id/status`.
The server root replaces history with `/console` when console capability or operate
permission is available. An operator without console capability retains lifecycle
controls without an unsupported stream; a viewer with neither falls back to Status.
Focused tabs scroll into view in the horizontal navigation on keyboard traversal.
Console connection state uses a compact clickable dot (green connected, yellow
connecting, red disconnected). The 40px button reconnects the stream and exposes
localized state/action text to assistive technology and its tooltip; it has no
visible label and sits inside the terminal at its top-right corner, clear of output. Retained output still survives navigation, without an explanatory
paragraph. This indicator describes the console connection, not the game process.
The terminal is not wrapped in a Console card or visible heading. On desktop it
sits beside seven compact resource cards: Address, Uptime, CPU Load, Memory, Disk,
Network (Inbound) and Network (Outbound). The three power buttons sit above that
column; the card column and terminal share both top and bottom edges. The server
name appears below the tabs, left-aligned with the terminal and vertically centered
with the power controls. Other server tabs omit the repeated server-name heading and retain their section titles. On narrow screens the
controls precede the terminal and resource cards follow it. Uptime uses measured
provider milliseconds; only confirmed offline state gets an Offline value and red
icon background. Failed, missing or expired readings remain unavailable. Cards and
graphs share validated provider stream measurements with a 30-second freshness
deadline. CPU, memory and network update as Wings sends measurements; uptime
advances locally every second only from a fresh running-process baseline. Disk
uses the cached value already included in Wings statistics, without requesting
additional scans. REST resource polling pauses while live measurements are fresh
and resumes at the existing 10-second fallback cadence on missing/stale streams.
Charts use a sliding 30-second window anchored to the latest real sample, with
at most one real sample per second. The axis and incoming sample update together;
the uptime clock does not move the graph ahead of measurements;
missing values and delivery gaps break the line. Start/end time labels are omitted
from the visible charts; measured timestamps remain in accessible summaries.
Confirmed offline state immediately resets the graph display to a flat zero line,
without storing those display zeros as measurements. CPU, memory and network cards
show a muted localized Offline label; disk keeps its latest fresh occupied-space
reading. Previous-process live traces do not return on the next start. Connection
addresses use the authorized primary endpoint, never an auxiliary/backend port.
Output follows automatically while scrolled to the bottom; scrolling up pauses
following, and returning to the bottom resumes it. No follow checkbox is needed.
The output pane uses 55% of the small viewport height, bounded to 360–680px,
with internal scrolling and a separately visible command prompt. Appended output
does not resize the terminal or the page; long lines wrap inside
the output pane, including words without spaces, without horizontal scrolling. Explicit zero-length flex sizing keeps this true inside the
auto-sized desktop grid and mobile layout.
Authorized commands use an integrated `»` prompt with a localized placeholder
and accessible name. Enter submits, preserving focus; failed requests retain the
draft and show an error, while pending requests cannot submit duplicates. Focus
underlines the prompt symbol instead of drawing a rectangle around the input.

Accepted lifecycle requests immediately disable conflicting actions and close
confirmation dialogs. Descriptor/list/Activity/quota refreshes run in the
background; acceptance is never presented as completion, and refresh errors
remain with their owning queries.

Generic operation-accepted and operation-in-progress banners are omitted throughout
the application. Pending/disabled controls and Activity provide operation state;
actual errors, uncertainty and destructive confirmations remain visible. Retried
operations retain a plain link to their new Activity record.

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
art does not become a hero panel or substitute for real state. Runtime selection
uses centered portrait cards: the integration-owned background art fades from
fully opaque at the top to transparent at the bottom over a solid dark base,
with a centered runtime label below. Compact cards wrap from the center; they do
not stretch to fill the row. Native radios remain keyboard-accessible but are
visually hidden: runtime selection uses a contained border, a subtle 4% scale
and 85% opacity on other enabled cards, without a checkmark. Transitions take
160 ms; reduced-motion preference removes both movement and animation. Version
rows retain their decorative check in a compact scrollable list.
Decorative art/checks do not duplicate accessible labels. Keyboard focus uses a
restrained high-contrast outline, always available without an opt-in; programmatic
heading focus has no decorative ring. Forced-colors mode retains selection cues.
Configured CPU/RAM on cards are labeled as limits. Disk shows occupied space from
the same Wings resources field as Console; unavailable or stale readings retain
an explicit localized fallback instead of displaying the configured allowance.

Owner Settings includes a compact storage policy flow: cached allocations render
immediately, changes update totals locally, and debounced serialized background
checks refresh real usage without overwriting newer input. There is no manual
preview/refresh control; confirmation waits for the latest verified draft.
Small circular information buttons expose explanatory copy on hover, focus and
touch. Blocking errors remain visible with retry, alongside per-user budgets,
server allocations, backup reservation and durable progress. A user budget of
zero explicitly removes that user's disk caps; the global default stays positive.
The current policy remains visible until every provider/SFTP change is confirmed.
A blocked partial application survives reload and offers retry or corrected
allocations. Files/Backups links preserve the draft in its tab; after deleting
unneeded data, returning to the tab remeasures the same plan before application.
Background refresh preserves unsaved quota/limit edits and never starts application
by itself. Cached and applying-to-blocked recovery use the same durable ledger.
Shared storage creates unlimited servers; existing finite caps remain until the
Owner explicitly applies the shared-storage plan. Storage settings are excluded
from generic editors/reset, and environment locks and read-only roles remain
visible. English/Italian copy, desktop/mobile layout, focus/error recovery and
WCAG 2.2 AA checks are covered by the storage-policy browser suite.

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
The step counter, heading region, error slot, content pane and actions have stable
positions. Errors occupy a reserved slot above the actions, clear of animated
content. Bounded scrolling accommodates long choices/player lists without moving
navigation. Enter on a selected game or runtime advances through the usual
validation; entering the Name step focuses its textbox. Entering versions focuses the selected or first enabled native radio
without selecting it; Up/Down changes selection. Entering operators focuses its
input; enabling whitelist focuses its player input. Late catalog responses do not
steal focus after the user moves elsewhere. Empty player-input Enter advances,
while nonempty Enter performs lookup and pending/composing input cannot advance.
Whitelist question and Yes/No controls move as one group; animation starts only
on a toggle, not on entry. Player
lookup temporarily makes its input read-only instead of disabling it, preserving
Enter focus without stealing focus after the user moves away. Server/player name
fields discourage password-manager autofill with field-scoped vendor hints;
authentication fields keep normal password-manager support. Shared storage has
no wizard field or reminder; limited storage retains its explicit input. Resource
preset limits remain visible without explanatory filler.
Future preset/modpack creation is tracked separately in issue #24. All submitted jobs link to
Activity; accepted, running, blocked, uncertain, failed and completed remain
distinct. A created/offline capacity-denied server is not presented as a failed
creation or automatically started again.

Console updates use bounded SSE parsing/display (300 retained lines with a
per-line bound); charts show timestamps, units and gaps. The resource section keeps
last-hour charts without a period selector, measurement table, pagination buttons or
explanatory footer. Charts appear in CPU, Memory, Network order. Memory and CPU headers omit duplicate current values already
shown in the resource cards; chart scale labels and accessible summaries remain. Chart history reads remain bounded to 100 recent samples;
backend history pagination remains available. Network traffic shares one chart
and scale: received is blue, sent is amber. Both lines are solid, with blue drawn last so
coincident values show blue rather than alternating colors. Top-right arrow icons
identify each direction and expose its current total in a localized tooltip.
These remain cumulative MiB counters, not transfer rates.

Use the shared `Tooltip` component for supplementary hover/focus descriptions,
not native `title` attributes. It uses a compact dark popup outside clipping
containers, follows viewport changes, dismisses with Escape
and supports touch. Only one tooltip is open at a time. Popups ignore pointer
input: leaving the trigger closes a hover-only hint immediately, including when
crossing over the popup. Keyboard focus or an explicit touch toggle can keep it
open; mouse-click focus alone never pins it. Files positions its tooltip near the
cursor's entry point and keeps it there until the trigger is left. There is no
pointer-following animation or per-move positioning; viewport changes still clamp
the popup within the screen. Keyboard/touch descriptions stay anchored to their controls. Triggers retain accessible names and keyboard access;
tooltips must not contain essential instructions or interactive controls. Native
triggers work directly; custom triggers must forward refs and event props. Current
consumers include the console connection indicator, network legend and Files controls. Redundant
timestamp titles are removed. Modal top-layer integration needs explicit handling
before tooltips are used inside native dialogs.
The Owner explicitly requested this transient pointer behavior on 2026-10-12.
Popup hoverability under WCAG 1.4.13 is not claimed for this mode; essential
instructions must remain visible independently of tooltips, and automated axe
results do not establish that manual criterion.

Binary uploads use Blob/XHR progress and
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

## Integration catalogs and scan feedback

Version catalogs use a bounded, keyboard-scrollable viewport, pagination, search
and integration-supplied filters. Default ordering uses official release dates,
newest first across release types; offer oldest-first and name ordering too.
Unknown dates are explicit and placed last, never inferred from insertion order.
Large catalogs and scan logs must not extend the page indefinitely.

Show real acknowledged scan progress, an indeterminate indicator before totals
are known, and an approximate remaining-time estimate only after sufficient
measurements. Keep logs in a separately scrollable region without repeatedly
announcing every line to screen readers. Preserve cancellation, honest partial
results and explicit resume. EN/IT labels, keyboard scrolling and contained mobile
overflow are required. `CatalogBrowser` and `ScanProgress` provide shared patterns
for trusted integration views rather than Minecraft-specific application rules.

Creation catalogs should preload asynchronously from Servers and reuse trusted
integration data across wizard steps. Keep authorized cache data through normal
navigation while invalidating on identity/Owner changes; never use cached choices
as mutation authorization. Catalog filters/order must remain consistent after
failed requests and retry. Owner paging/filtering is server-side, with full evidence
loaded only when details are opened. Display missing/stale local metadata honestly;
reading a list must not wait for an upstream manifest request.


### Files interaction contract (2026-10-12)

Files uses breadcrumbs rather than an always-visible path form. The direct-path
button is available on touch; ALT + G (⌥ + G on macOS) opens direct-path entry while
Files is mounted, outside dialogs. Ctrl+L remains the browser address-bar shortcut. Names
open directories or the editor. Each row has an accessible overflow menu and a
desktop context menu; destructive actions require confirmation. Ctrl/Cmd-click toggles
selection without opening the item; Shift-click selects a visible range and
Ctrl/Cmd+Shift-click adds that range to the selection. Checkbox range selection,
focused-manager Ctrl/Cmd+A, folder/breadcrumb/parent drop targets and explicit
Move/Copy dialogs provide equivalent pointer and keyboard paths.

Ctrl/Cmd+C and Ctrl/Cmd+X retain only selection metadata in the mounted file manager,
scoped to the current session/identity and server. They open no picker and perform
no mutation. After folder navigation, Ctrl/Cmd+V copies or moves into the current
folder, using the existing conflict flow. Copy can be pasted again; cut is consumed
when the move is submitted, including when its outcome is uncertain. Dismissing a
conflict before submission leaves the cut available. This clipboard does not read
or overwrite the operating-system clipboard and does not survive leaving Files or
reloading. Inputs, dialogs, the editor and selected text retain their own shortcuts.
The workspace remains a focus target when clicking empty space. Paste also works
if folder navigation has left document focus on the page body, without requiring
another click; this fallback is active only while Files is mounted and never
captures input/editor/dialog shortcuts. Selected listing text does not block file
paste. Other application controls retain their shortcuts.

Transfer preflight uses the shared identity-scoped metadata cache to plan consent;
the backend validates actual paths, identity and collisions before applying an
operation. Cold preflight reads request metadata without preparing download URLs.
A new API conflict refreshes metadata before offering new explicit overwrite
choices. The UI releases after the operation response; directory, transfer and
capability refreshes run in the background and do not extend the mutation lock.
Copy refreshes only the destination listing; move refreshes both listings. Copy
capabilities are refreshed after an ingestion claim settles, since a poll during
copy can temporarily report them unavailable. No permissions or success are
inferred optimistically.
Move and Copy use the same bounded, lazy folder tree with keyboard navigation,
expand/collapse, loading/error/retry states and a live destination path. Root is selectable;
the source and a selected folder's descendants cannot be destinations, but the
source remains expandable. Only real folders are shown, not symlinks; leaf folders
show no empty-state label. Summaries
show the first three selected names and a localized remaining count. File dialogs
use a compact X with an accessible Close label.

Delete uses the same centered confirmation layout: bounded name summary, explicit
irreversible-content warning, neutral Cancel and red Delete buttons with 48px
targets. The Delete button itself confirms the operation; no additional generic
checkbox is required. Delete/Canc opens the confirmation with Cancel focused;
arrow keys switch between Cancel and Delete, and Enter activates the focused
button. Pending
requests disable Cancel/Close/Delete and block Escape; failures remain visible
without automatically repeating the deletion.

`ConfirmDialog` in `components/ui.tsx` now owns this confirmation layout and
keyboard/pending/error behavior for Fileman deletion and Datagrid row/column deletion.
It uses the existing `Dialog`/`ActionForm` primitives and renders outside surrounding
editor forms; submission must never propagate into an editor save. Datagrid deletion
changes the shared draft only and remains undoable. Rename forms and unrelated dialogs
retain their own layouts; other destructive flows can adopt the shared confirmation
explicitly instead of changing every dialog through global styling.

Toolbar/context-menu moves, copies and folder/parent/breadcrumb drops share one
conflict flow. Drops move directly when fresh metadata has no collision. Otherwise the
current conflicting filename and destination appear in a centered confirmation
with Skip, Overwrite, Skip all and Overwrite all. Skip receives initial focus;
Overwrite actions are red and all action targets are at least 48px high. Decisions
are collected before one batch: skipped names are excluded entirely, and skipping
all files issues no mutation. All-actions apply only to currently observed,
unresolved collisions. Revalidation can require a new choice for a newly appearing
name. Folder/link/type and case-ambiguous replacements remain blocked and can be
skipped; no recursive merge/delete is introduced. Close/Escape abandons undecided
work and is blocked while requests are pending. A changed actor/subject/support
context discards the old choices and prevents a delayed preflight from submitting.

Backend validation remains authoritative. An API preflight conflict can reopen
explicit choices, while an unknown/failed POST ends with a visible error and asks
for source/destination inspection; it never retries automatically or claims rollback.
Source/destination caches refresh after a mutation. Copy preserves originals and
uses the existing streamed copy endpoint; explicit overwrite consent applies only
to exact regular-file destinations. Copy/move planning, protected-path checks and
collisions share one fresh backend directory snapshot; the browser cache is not
mutation authority. Each distinct directory is read once, using the optional
Blueprint batch transport. Identity uses the existing bounded proof with fresh
local permissions. External game/SFTP/Panel writes after preflight can still race
it; this is not an atomic filesystem transaction. Wings' native same-folder copy
cannot implement the chosen destination/overwrite contract, so copy bytes still
stream privately through the backend. Copy also refreshes transfer availability and
checks its upload capability before submission. An active claim from its own copy
may temporarily disable new copies without hiding the in-flight result. Failed or
uncertain copies ask for destination inspection; there is no automatic replay.
Multi-selection and drag/drop no longer stop at 100 items. Delete/move use
aggregated provider requests and automatically split selections larger than 1,000;
the user does not need to select batches manually. Full-selection validation and
exact overwrite consent precede mutations; uncertain effects are not replayed.
Copy/ZIP retain recursive work budgets rather than a shared selection cap. ZIP
downloads use native same-origin POST to avoid long URLs and whole-archive browser
buffering. The normal download manager handles the attachment; failed responses
open separately without navigating away from Files.
Folders precede files for every sort; search filters the current directory only.
Name, Size and Modified headers are sorting buttons in both list and grid views.
The active non-default ordering has an up/down arrow; default Name ascending has
no arrow. Header controls remain keyboard accessible on mobile.
List is default; Grid is optional. External file drops use the same upload queue
as the toolbar, with per-file progress, speed, cancellation and errors. Cancellation
is bound to an entry ID; cancelling a queued item never aborts another active file.
The explicit pre-effect `operation_busy` response keeps the same file waiting and
retries with a short bounded backoff; exhaustion preserves it at the head of the
queue for Check and resume. Cancelling during that wait removes only that item.
The retry loop adds no availability polling during backoff; normal view refreshes remain.
Shared-state failures pause the untouched queue even when availability reads look ready; the
localized Check and resume action checks admission again without replaying failed
or uncertain writes. A paused queue stays in the current Files view and warns before tab close/reload;
in-app navigation away also discards it. It is not durable across reloads.
Completed and confirmed-cancelled rows disappear automatically; failed or uncertain
uploads remain visible with their error. The queue has no manual clear-finished
link or generic partial-file warning. Active cancellation waits for backend
settlement before removing its row; uncertainty is not relabeled as cancellation.
The section disappears when no queued, active or failed entries remain.
Directory uploads are not silently flattened.

Uploads use the Owner-configured concurrency and complete only after the API
confirms the provider transfer. Display-list refreshes run separately and are coalesced during the
queue, with a final refresh on completion or pause; a slow or failed listing
does not delay the next upload or reclassify a confirmed upload as failed.
Folder entries request the API's no-overwrite preflight rather than fetching
their parent directory separately before each file. Errors and uncertain outcomes
retain the existing admission/recovery rules above.

Initial and uncached-directory loads use noninteractive skeleton rows/tiles for
the selected view, without a visible Loading paragraph. The listing and count
footer reserve the same bounded height across loading, loaded, empty and error
states, so the file manager does not collapse between folders. Existing data stays
visible during background refresh. Skeleton shapes are decorative; `aria-busy`
and a localized visually hidden status communicate loading to assistive technology.
The placeholders are static and introduce no animation or artificial delay.

The compact icon toolbar provides Refresh, New folder, New text file, Upload and
Upload folder with localized accessible names and shared tooltips. Folder selection
preserves the chosen root and descendant file paths. Preparation creates a new
tree only, refuses existing destination names, and reports partial/cancelled
preparation without deleting data. Browser directory selection does not expose
empty folders; these cannot be preserved by that picker. Use Upload folder for
directories rather than treating an external directory drop as a file. External
provider writes can still race preflight checks; this is not an atomic filesystem
transaction. The existing server-side upload policy and admission remain required.
Search sits to the left of the action icons, with List/Grid at the far right in
the same desktop toolbar; small screens wrap these controls without overflow.
The search field displays ALT + K on Windows/Linux and ⌥ + K on macOS, without
parentheses; the shortcut focuses/selects the current-folder search. It is active
only while Files is mounted and yields to open dialogs/editor shortcuts. The
input also declares its platform-specific `aria-keyshortcuts`. In the listing,
direct-path entry uses a small borderless folder/path icon, with ALT + G or ⌥ + G
in its localized tooltip. Inside the editor, the pencil beside the filename means
Rename; direct-path entry remains available through ALT + G or ⌥ + G.
Search and direct-path inputs indicate focus through their existing border color,
without an extra outline or shadow. Forced-colors mode uses the system highlight.

Direct-path entry is a compact autocomplete combobox, without an Open folder
button. Suggestions list actual folders and files from the authorized directory
listing; filename typing filters that list locally, and changing the parent path
loads its listing through the same query cache as Files. Up/Down selects a
candidate; Enter or Space confirms an explicitly selected candidate. Space remains
ordinary text when no candidate is selected. Enter also confirms an exact name or,
without one, the sole matching candidate; ambiguous prefixes require selection.
Selecting a folder appends a slash, keeps input focus and exposes its children;
Enter on a path ending in a slash opens that folder in Files. Selecting a
file opens the existing editor at that file's actual parent path. Suggestions stay
within a scrollable popup without pushing page content, with accessible active
selection and honest loading, empty and error states. Escape returns to breadcrumbs.
Focusing Search closes path entry; its shortcut always reopens and focuses/selects
the path, including when the field is already open. These shortcuts yield to dialogs.

The CodeMirror editor supports search, line numbers, undo/redo, Ctrl/Cmd+S and
unsaved-change protection; EN/IT includes editor search/validation controls.
Tab inserts the configured indentation unit at the cursor, or indents selected
lines; Shift+Tab outdents lines. Both use CodeMirror's undo history and read-only
protection. Escape closes an editor search panel first, otherwise returns to
the directory through the unsaved-change confirmation when needed. Search fields
retain normal Tab navigation; local editing and indentation remain usable during a save.
Opening a text file replaces the listing in place, without a modal. The breadcrumb
retains clickable parent directories and includes the current filename. List-only
search, upload and view controls are hidden until returning to the directory.
One compact row contains the path on the left and Open with, Back to files
(Home), Download on the right, shared by every viewer. Text editing retains
Save, Undo, Redo and Find before those common actions. Narrow screens use an
Open with icon and prioritize the current filename over parent breadcrumb
segments; Home still returns to the file list. Escape returns every viewer, including the text editor, to the current folder
through the existing Home action and unsaved-change guard. Open dialogs, menus,
search/path controls and fullscreen receive Escape first. Each action has a localized
accessible name and custom tooltip; unavailable actions are disabled. Find opens
CodeMirror's search. Archive entries keep their own download/chooser target.
Open with uses immediate-action cards with distinct first-party marks and stable
EN/IT names: Scribe (text), Frame (images), Wave (audio), Motion (video), Atlas
(archives), Datagrid (SQLite) and JSON Tree. A compact personal-choice control
above the cards defaults to one-time opening; server, game and global defaults
retain their existing precedence and apply to the file extension. Choosing a card
saves an explicitly requested preference before opening, retaining the dialog on
failure. Only X/Escape closes the chooser; no radio selectors or confirmation footer.
Keyboard activation, functional screen-reader descriptions and pending-save guards
are shared across builtins and trusted integration viewers.
Show all expands a bounded, scrollable card list beyond extension suggestions;
Show suggested restores filtering. Explicit personal choices may use a viewer not
suggested by the filename and are honored on reopening and in the context menu.
Only compiled viewers for this game and builtins are selectable. Unsupported
nested archive/database readers, unavailable transports and existing editor/parser
limits remain enforced; decoder failure keeps Open with available for recovery.
Optional viewer metadata failures do not prevent independent text editing.

ICO frame selection uses a compact custom combobox with local thumbnails,
dimensions and bit depth. Arrow keys, Home/End and Enter select; Escape cancels,
Tab or outside interaction closes it. The toolbar stays mounted during a frame
change, preserving focus. Dimensions and Fit are committed together before paint,
so a newly selected frame never appears briefly at original size. Changing frames
reuses already-decoded local images without additional provider requests.

Frame uses a single natural-pixel scale for Fit, Actual size, buttons, keyboard and
gestures; its percentage is displayed as a rounded integer while calculations
retain full precision. Confirming an unchanged rounded draft preserves the scale.
Zoom is bounded to 1–5000% for raster images/ICO and 1–50000% for SVG, including
Fit, typed values and gestures. Percentages use no thousands separator (50000%); calculations
retain full precision. SVG uses a native vector document in a viewport-sized,
non-interactive iframe, with scripts and external requests denied by sandbox/CSP.
Source markup is never injected into the application document or trusted srcdoc.
It loads/parses once per open; zoom/pan coalesce per animation frame without new
requests. A separate canvas clip preserves root-transform bounds. UTF-8 and
BOM-marked UTF-16 SVG are supported; DTD declarations are rejected before parsing.
Fit enlarges
small images and ICO frames or shrinks large ones to the viewport, using the full
canvas including transparent padding. Actual size always restores 100%. Fit follows
viewport resizing; manual zoom preserves scale and reclamps position. An image
that fits stays centered on that axis; a larger image can pan only as far as its
edges. Toolbar and CTRL/CMD +/− zoom around the viewport center; pinch follows the
gesture position, with edge constraints taking priority over anchoring. Trackpad
scrolling pans. Frame has square top corners and rounded bottom corners.
The percentage is editable: Enter applies a positive decimal (dot or comma),
Escape/blur discard the draft, and invalid input retains focus with a localized
error. Shortcuts stay within the active viewer and yield to fields/dialogs.
ICO frame changes reset geometry while preserving an active frame picker's focus.

Search uses a compact input, current/total match count, previous/next actions and
case/whole-word/regular-expression toggles. Options expose their pressed state and
localized tooltips; replacement fields appear only when requested. Search and
replacement use CodeMirror's engine, including invalid-pattern handling.
The editor reserves the listing's bounded height; both content reads and lazy module
loading use static code-line skeletons with a localized assistive loading status.
Saving submits an immutable text/revision snapshot and leaves editing and navigation
available. Only another save of the same file waits for that request to finish.
Confirmation advances the saved baseline without replacing text typed afterward;
that newer text stays unsaved. Compact status/error notices remain available across
application routes and reopen the matching pending or failed draft. A late response
cannot change another editor. Conflicts retain the draft and are not retried automatically.
Breadcrumb/path changes, Back to files and application links warn before discarding
edits that were not submitted; an in-flight submitted snapshot does not prevent
navigation. Reload/closing the browser warns about pending saves or retained failed
drafts. This state is browser memory scoped to actor, subject and support session,
cleared on identity changes: it is not a durable offline queue or a guarantee that
a save survives closing the browser.
Browser Back/Forward uses the router's navigation blocker as well. Opening a file
places focus in its text once ready, so Ctrl/Cmd+F invokes editor search; a deliberate
focus move during loading must not be overridden. A new file starts in its name
field. Returning to Files restores the original file's row when it still exists,
otherwise the breadcrumb. The editor shows caret/active-line focus without a cyan
outer frame; forced-colors mode retains a system focus indicator. The editor's rename
pencil replaces the filename with a compact inline input, initially selecting only
the basename (excluding the last extension). Its width follows the rendered text.
Enter or blur submits once; Escape cancels. No confirmation buttons or dialog appear.
Invalid names remain editable with a contextual error and no request. Provider
errors preserve the proposed name. Renaming uses the existing authorized operation;
after confirmation it keeps the current text and revision without downloading it
again. Subsequent content saves still compare that revision. Unsaved content must
be saved before renaming; rename-in-progress blocks conflicting file operations.
Submitting a valid rename returns to text immediately on Enter; blur retains the
chosen focus target. Local typing, undo/redo and search stay available during the
request, while content writes and navigation wait for its outcome. The confirmed
filename changes only after success. CodeMirror reconfigures syntax in place,
preserving cursor, scroll, history and search; completion never steals focus.
Opening a different document resets that editor state. Destinations excluded from
text editing must be renamed from the file list, so a late extension change cannot
hide newly typed content. Failed renames preserve both text and the proposed name.
Entering Files preloads the lazy editor module once; subsequent editor opens use
the same cached import. A failed preload can retry when the editor is opened.
Editor content remains local while a conflict is resolved. Availability reasons
are contextual; no empty full-size Upload panel is rendered.

File icons distinguish text, JSON, JARs, configuration, scripts and other common
types. Trusted game UI modules may declare bundled decorative icons by extension;
Minecraft supplies an original voxel-and-gear icon for `.properties`. Filenames
remain the accessible labels. Icons never establish editability. Known binary
formats do not request editor content; their inline view explains the limitation
and offers the existing download action. Unknown formats must pass the API's
bounded strict UTF-8/content checks before text editing. There are currently no
supported binary editor exceptions.

Server tabs retain their active underline without programmatically focusing the
active link on load or reload. Native keyboard focus remains visible; pointer
navigation must not add a persistent focus outline.

Text inputs and textareas indicate focus by strengthening their existing border,
without adding a second outer rectangle or shadow. Other keyboard controls retain
their focus outlines. Forced-colors mode restores an explicit system Highlight
outline for text entry; component-specific states such as invalid fields remain
visible. This is a shared field style, not an editor-only override.

### Silent directory prefetch

File navigation may display previously listed metadata immediately while refreshing
only the open directory. Leaving Files still resets the folder to root; reloading
within Files restores that folder and its bounded, tab-local snapshot. Unchanged
rows retain their identity while additions, removals and metadata changes reconcile.

Refreshing an open file restores its viewer, including a one-time Open with choice,
or reopens the text editor against the saved server content. The tab-local bookmark
contains only a file path and compiled viewer ID, scoped to the current identity
and server. It reuses the folder listing and normal authorized file reads; it does
not store file contents, signed URLs or unsaved drafts. Home/breadcrumb navigation
clears the open-file bookmark, and leaving Files clears it with the folder state.
Archive containers reopen at their root; internal archive navigation, playback
position and zoom are not restored.

Visible folder rows seed optional Blueprint directory batches. Work is limited
to three levels below the open folder, 96 candidate directories per navigation,
and one batch of at most 48 paths in flight. Visibility and per-depth budgets
prevent scrolling past a wide tree from triggering an unbounded recursive crawl.
Cached descendants are reused without recurring polling; speculative results
cannot overwrite a newer foreground response or a mutation invalidation.

Only directory metadata is cached. In-memory inactive listings use a bounded
192-directory / 8 MiB serialized-metadata budget; active view data remains usable.
This is a cache budget, not a claim that total browser heap is exactly 8 MiB.
The separate reload snapshot remains one folder, at most 5,000 entries / 1 MiB.
Identity/session/server scopes remain isolated. Background listings do not prepare
signed URLs; only the open folder does so. No new banner, progress label, toast,
marketing copy or notification accompanies prefetch. Optional failures silently
leave ordinary navigation available; foreground errors are still reported.

Wave uses centered custom playback controls and a seekable, real amplitude
waveform, not decorative peaks. Play/pause, ten-second skips, repeat, speed and
volume retain native media behavior and keyboard controls with EN/IT labels.
The playhead interpolates native currentTime between observations on display
animation frames (including high-refresh displays). Prediction is visual only,
bounded to 100 ms of wall time at the playback rate; small clock differences are
corrected gradually rather than snapping on each quantized reading. Pausing,
waiting, seeking, errors and ending snap to native time; playing resumes the
clock, and rate/loop/background changes re-anchor it. Native playback remains
authoritative. Play at the effective endpoint explicitly rewinds both audio and
visual clocks first, including after manual end seeks and with Repeat enabled. Only the timeline subtree updates on those frames; playback
controls and their formatters do not. Play synchronizes the native paused state
immediately after calling play(), without waiting for its queued event.
Wave shortcuts use Left/Right for five seconds and Shift+Left/Right for ten.
Single keypresses animate like the skip buttons; held-key repeats seek directly
and cancel the tween so the playhead never trails accumulated seeks. Space toggles
play/pause after pointer interaction, including when a control still has focus;
Tab navigation preserves native button/volume behavior. Text editing and open
menus/dialogs retain their keys. Repeated Space does not retrigger playback.
Ten-second skip buttons seek the audio immediately while the playhead and played
waveform travel together for 280 ms with cubic ease-in-out. Repeated skips retarget
from the currently displayed position; the endpoint follows ongoing playback.
Dragging/direct slider seeking remain direct and cancel this transition. Reduced
motion disables the skip animation. Dragging previews the seek position and
commits on release. Playback uses the
existing authenticated, same-origin Range stream; leaving the viewer releases it.
Audio previews up to 32 MiB request native automatic preloading; larger files
request metadata only. Browser policy may limit preloading. Brief buffering
transitions do not flash a label: the notice appears only after 200 ms of
continuous waiting. This grace period never delays the Play command.
Waveform analysis runs in a dedicated browser Worker using Mediabunny 1.61.4.
It reads the existing authorized same-origin content endpoint with HTTP Range,
then reduces decoded samples directly into 1024 peaks. Actual partial peaks are
published while data is still arriving, at most about 20 updates per second.
The first nonzero result is published promptly; no progress is fabricated.
Native playback remains independent and never waits for waveform analysis.
Raw AAC/ADTS duration is calculated from encoded frame timestamps, since native
players may overestimate it. Waveform, seek range and visible times share that
duration; an inflated native end position is clamped to the same endpoint. ADTS
analysis first scans the encoded frames, so its waveform can wait for that scan
and reread bytes outside the 2 MiB cache. Other formats retain progressive analysis.

The initial trial retains the 32 MiB / ten-minute / eight-channel eligibility
limits. The source cache is explicitly 2 MiB (upstream 1.61.4 code defaults to
64 MiB), with one fetch at a time and no automatic retries. The accumulator uses
4 KiB peaks plus 16 KiB scratch; native decoder, metadata and network buffers are
additional memory, so these are not a hard total-memory ceiling. Each sample is
closed after reduction. Leaving the viewer explicitly aborts reads and disposes
the input inside the Worker before acknowledging termination (with a one-second
termination fallback for an unresponsive Worker). Completion/error uses the same
cleanup path. Duration refinement
within the eligible range does not restart analysis. Clearly incomplete or
mismatched timelines are unavailable rather than certified as complete silence.

Wave starts flat without a loading caption. Newly received bars rise from the
center in sequence (8 ms between bars, 180 ms per reveal); later batches continue
the sequence and refinements do not restart it. This presentation-only animation
does not delay decoding, seeking or playback. File exit cancels it, resizing does
not replay it, and reduced motion shows the received bars immediately. Browser
codec support and container metadata determine how early decoding can begin.
Unsupported decoding or eligibility limits preserve native playback/seek and the
truthful waveform-unavailable fallback. This introduces no server transcoding,
provider credentials, game-file changes or new backend endpoint.

Motion keeps video playback native, with custom controls over the video rather
than browser-specific controls or a surrounding summary card. The shared Files
path/Open with/Home/Download row remains the entry and exit point. Play/pause,
ten-second skips, repeat, volume and speed follow Wave's visual vocabulary;
Left/Right seek five seconds, Shift doubles that, and Space respects pointer
versus keyboard-navigation context. Timeline scrubbing is direct. Fullscreen and
Picture-in-Picture are offered only when the browser exposes their APIs.

The control strip normally stays visible while paused, loading, seeking, using a
menu or navigating controls with the keyboard, and hides during uninterrupted
playback. An explicit right-zone click can hide it while paused; pointer movement
or keyboard focus reveals it again. The seek
bar shows actual buffered ranges, elapsed/total time, and a hover timestamp with
an optional thumbnail. Unsupported thumbnail decoding must never disable native
playback. Unsupported native video retains Open with/Download; no browser codec
support is fabricated and no server transcoding is introduced.

Timeline previews are browser-worker work requested only while exploring the
seek bar. They use authenticated same-origin Range reads, sparse keyframe access,
one pending position and a small bounded cache. They are approximate previews
of the preceding keyframe, not a guarantee of the exact hovered frame. Decoder,
source-cache and image resources are released when the source/viewer closes.
No full-video pre-analysis or decorative/fake thumbnail content is allowed.

Motion retains at most 32 thumbnail object URLs and 128 time-bucket aliases per
open video. A worker uses a 2 MiB source cache, one fetch/decode at a time and an
8 MiB streamed-read budget per request, with a six-second watchdog. These bound
optional preview work, not the browser's native video buffering or total decoder
memory. Leaving the timeline or hiding the tab cancels active preview work;
previously decoded images remain reusable until eviction or viewer exit. A
missing index, unsupported WebCodecs decoder or exhausted budget leaves the
normal timestamp preview and native playback available.


Motion stage gestures use invisible 20% / 60% / 20% zones, separate from the
control strip: hold the left side for temporary 2× playback, click the center to
play/pause, and click the right side to hide controls. Releasing or cancelling a
hold restores the prior selected speed. Space tap toggles playback on release;
a 250 ms hold applies the same temporary 2× action without pausing on release.
Holding while paused never starts playback. With focus inside Motion, F toggles
fullscreen and M mute (single-character shortcuts do not act elsewhere). Editable fields and transient menus retain their keys, and Tab-based control navigation
keeps native activation. Loss of focus/visibility clears holds. Wave's existing
Space behavior is unchanged. Motion has an embedded subtitle-track selector for
supported Matroska/WebM text tracks; external subtitle-file selection is not yet
implemented. See [subtitle formats and boundaries](M5-VIEWER-FORMATS.md#motion-embedded-subtitles).

After a right-side mouse/pen click, a 36 px invisible radius around the click
absorbs small pointer movements. Leaving that circle inside the player reveals
controls; leaving the player clears the circle without revealing them. Reentry
and keyboard focus restore normal controls. Touch gestures are unchanged.

#### Motion internal audio tracks

Motion discovers embedded audio tracks through Mediabunny's bounded Range reads.
Its compact headphone menu uses track names/languages from the container, with
localized numbered fallbacks. Unavailable codec combinations remain visible but
cannot be selected. No fake subtitle choices are supplied.

For supported multitrack files, compressed video and the selected audio are
remuxed into fragmented MP4 in the browser and appended to one MediaSource on the
same native video element. There is no server transcoding and no independent
Web Audio playback clock. Original packet timestamps are retained; native media
playback owns A/V synchronization. This is not a guarantee of one-millisecond
physical display/speaker synchronization across browsers and devices.

Switching retains position, paused/playing intent, speed, volume and mute. It may
briefly buffer. Transport changes are disabled during that transition while the
track menu remains usable to replace a pending selection. Seeking beyond the
buffer reconstructs the stream from a preceding keyframe. Native single-track
playback remains the fast path; optional metadata discovery does not replace a
working native source with an error. Unsupported media retains download access.

Container support does not imply codec support: runtime MSE capability checks
must succeed for the actual video/audio pair, and decoding failures are reported.
An indexed finite duration, bounded packet sizes and reachable keyframes are
required by the remux path. Read caches, prefetch, fragments and retained playback
windows are bounded and released on close/superseded selection. Safari's
ManagedMediaSource fallback is capability-detected, but Chromium/Firefox fixture
evidence must not be presented as Safari/iOS real-device certification. Embedded
subtitle extraction/rendering is supplied by the separate subtitle module,
following the same native video clock.

The remux reader uses 64 KiB metadata blocks and 512 KiB playback blocks, a
2 MiB block cache plus a separately capped 2 MiB demux cache, and 12-second ahead /
8-second behind playback targets (keyframes and native buffers add overhead).
Discovery is capped at 8 MiB, individual packets at 8 MiB and unflushed fragments
at 32 MiB; a validated append renews the sequential read budget. Startup, fetches
and buffer updates have 15-second deadlines. A requested point without a common
A/V range fails instead of waiting indefinitely; an initial gap under one second
may advance to the actual first common timestamp without shifting packet timing.
These limits constrain hostile or unusual files and do not certify arbitrary
high-bitrate, long-GOP, negative-timestamp or damaged media.

Motion's inline height follows the video's intrinsic aspect ratio and the space
remaining below its Files toolbar, with a 16 px bottom margin. It may grow beyond
the former 65vh / 672 px ceiling; where the video fits, the stage matches its
proportions instead of adding artificial bands. `object-fit: contain` preserves
the complete image when the viewport cannot fit that ratio. A small minimum
keeps controls usable on very short screens, allowing normal page scrolling.
Window/visual-viewport, source-dimension and control-layout changes recompute the
fit; ordinary page scrolling does not enlarge the player. The known ratio is
retained while an audio switch reloads metadata. Fullscreen keeps its own native
viewport sizing. No playback, provider or transcoding behavior changes.

### Console connection address

The Console address card uses the backend's authoritative display address: clicking
it copies that exact value, with brief checkmark feedback after clipboard success.
A separate quiet edit icon opens Connection settings, also when the address is
pending or unavailable. Long addresses truncate on one line and remain available
in a custom tooltip and accessible button name. Clipboard failure is reported
without claiming success. Publication is not presented as a reachability badge;
DNS-mode addresses never fall back to raw IPs while awaiting publication.


Gateway message editing uses trusted integration descriptors for localized state,
channel and variable labels, defaults and safe formatting tokens. The shared UI
renders only each state's supported fields and uses plain text when formatting is
not declared. Minecraft formatting is metadata owned by its integration, not a
special branch in the common editor. No arbitrary HTML/CSS or dynamic code loading
is accepted. English/Italian real-handler browser evidence and an isolated
non-Minecraft descriptor cover this boundary; see [Automation](AUTOMATION.md).
