# M5 task flows and implementation plan

Status: implementation in progress, not acceptance evidence. M4 PR #20 was
squash-merged with the Owner's exact-HEAD authorization on 2026-10-09. The new
main is `45fff047781899d0543a47f02dcb106487123ffe`; issues #10/#11 closed.
M5 starts on `milestone/m5-webpanel`. No production deployment is authorized.

The [common integration audit](M5-COMMON-INTEGRATION.md) is the mandatory
acceptance checklist. Every row must receive implementation and test evidence
before the PR becomes ready. Existing M1–M4 evidence is retained; ordinary M5
browser fixtures do not certify new game/runtime combinations.

## Information architecture and tasks

The ordinary shell contains Home, Servers, Activity and Settings. Projects are
optional organization within Servers. Server navigation groups frequent work
(Overview, Console), data (Files, Backups), connection/automation and Settings,
with trusted game sections contributed through the SDK. Owner navigation is a
separate context: Overview, Users, Servers, Infrastructure, Integrations,
Operations and Settings. Support mode shows actor, subject, expiry and Exit on
every screen, never changing the subject's ordinary sessions.

| Entry and task | Authority and existing contract | Required completion/result | Failure/recovery and evidence |
| --- | --- | --- | --- |
| Setup → claim Owner → verify → connect provider | Public status, bootstrap token, then verified regular Owner; M1 setup/auth | One durable claim, read-only provider validation, encrypted settings | Race, bad token, mail/provider failure, resend; real handler/browser tests, no seeded Owner |
| Invitation → registration | Valid invitation on email and Discord entry points | Verified account, invitation consumed atomically | Expired/revoked/exhausted invite, OAuth refusal; browser cookies/redirects and API bypass regressions |
| Sign-in → recovery/security | Better Auth ordinary session and configured providers | Email/Discord/passkey login, TOTP challenge, verified recovery | Unavailable provider, invalid challenge, revoked session; real auth handlers with isolated mail/OAuth/WebAuthn fixtures |
| Settings → account/security | Ordinary identity only, no support token | Profile/locale, explicit bidirectional linking, passwords, TOTP/recovery, passkeys, session revocation | Conflicts retain identities; secrets shown once; keyboard/focus, session refresh and EN/IT tests |
| Home/Servers → find server | Scoped registry plus quota reads | Paginated search/filter, distinct process/readiness/operation states | Empty/loading/denied/stale; no configured-RAM-as-use claim; cross-user/project tests |
| Servers → create | Rollout plus exact runtime evidence and resource authority | Four steps; SDK conditional configuration, resources, reviewed create | Preserve Back/drafts; EULA and destructive intent explicit; accepted job is not completion; denied first start stays created/offline |
| Servers → projects/sharing | Project owner/platform Owner; existing resource roles | Detail, members, exact collaborator lookup, rename/delete/regroup | Revocation immediate; delete group retains servers; immutable provider/runtime identity; authorization/concurrency tests |
| Server → lifecycle/settings | Read/operate/manage permission from server/project | Existing durable operations and safe metadata editing | Confirm wipe/delete/restore consequences; uncertainty never blindly retried; admission remains charged to server owner |
| Console → command/telemetry | Authorized server stream and command endpoints | Reconnecting bounded console, historical/live units and timestamps | Missing/stale data stays unknown; fetch SSE carries support context; revoke/slow-consumer tests |
| Files → edit/transfer | Existing scoped paths and streaming routes | Browse, edit, mkdir, rename, confirmed delete, binary upload/download | Protected runtime paths, provider bounds, cancellation, partial write honesty; bounded-memory browser/API evidence |
| Files → SFTP | Regular manager; existing credential service | Issue/rotate once, list expiry, revoke | Missing service shown honestly; retained-transport #18 remains release blocker, not a security pass |
| Backups → restore | Operate/create; manage/restore; existing durable proof | Select completed backup, explicit truncate consent, correlated result | Pending/failed/uncertain never shown restored; verified-game restoration fences retained |
| Network → connect/domain | Scoped safe public descriptor and DNS abstraction | Role/transport/hostname/port, static and custom/SRV modes | Never guess public endpoints from backend IP; no live DNS writes in tests |
| Automation → sleep/schedule | Regular authorized manager, fresh execution authority | Complete policy reads; durable schedule CRUD, enable/disable and outcomes | Manual-stop suppression remains; denied capacity does not queue; duplicate/crash/revocation tests |
| Activity → operation/detail/recovery | User/project scope or regular Owner | Pagination, progress/events, actionable known failure and uncertainty | Retry creates only authorized safe new intent; no historical reset or replay of unknown external effects |
| Owner → users/quotas/invites | Regular Owner, audit operator where explicitly allowed | Directory/detail, role/invite, usage/current and historical limits | Temporary audited overrides never bypass physical headroom; target ordinary sessions unchanged |
| Owner → health/infrastructure | Regular Owner and existing read-only adapter discovery | API/DB/Redis/worker/Gateway/provider status and freshness; host/node/mapping forms | Unknown/unconfigured distinct from healthy; saving configuration applies no unauthorized infrastructure change |
| Owner → integrations/evidence | Regular Owner, trusted modules | Stored rollout/allowlists and mappings; Minecraft internal evidence | Checkbox cannot mint evidence; ordinary users see no protocol/support matrix; fixture integrations never public choices |
| Owner → audit/settings/support | Regular Owner, step-up for support | Filtered audit; typed settings/provenance/locks; write-only secrets; reliable Exit | Failed saves retain edits; elevated identity always visible; expiry/revocation and secret-isolation tests |
| Server → Minecraft sections | Scoped management plus exact capability/runtime evidence | Vanilla properties, identity/OP/whitelist, worlds and supported content | Stopped/backup/wipe consent and immutable runtime fences; no mod/plugin install offered on Vanilla; real M4 evidence reused |

## Shared visual and interaction rules

One restrained light theme initially: warm neutral page background, white working
surfaces, dark ink, one blue action color, semantic green/amber/red state accents.
States always include text. No gradients, hero panels, decorative statistics or
empty cards. Use system fonts, a compact consistent spacing scale and tabular
numbers for resources. Desktop uses a narrow navigation rail and readable working
area; mobile has an accessible navigation disclosure and keeps primary actions
reachable. Tables scroll within their own labeled regions when needed.

Reusable vocabulary: labeled fields with inline errors, focused error summaries,
task-named buttons, compact tables/lists, state badges, native accessible dialogs,
progress by actual job phase, and bounded live regions. Route changes move focus
to the page heading; dialogs restore trigger focus; Escape closes non-destructive
dialogs. No automatic subtitle under headings. Preserve entered values on failures.
Destructive confirmation names the affected resource and actual data consequence.

English and Italian catalogs cover application/game/Owner/auth/accessibility copy;
Intl handles numbers, dates and units. Remote console/catalog text stays original.
Keyboard, focus, zoom/reflow, contrast, pseudolocalization and real screenshots
are acceptance checks, alongside behavior. [Frontend standards](FRONTEND-I18N.md)
and their NN/G, GOV.UK and WCAG 2.2 sources govern independent review.

## Slices and validation

1. Establish browser-safe typed contracts, shared request/session/i18n handling,
   trusted game descriptors and common read APIs.
2. Account/setup and ordinary shell; server/project/activity/quota journeys.
3. Server services and durable scheduling through existing jobs/admission.
4. Minecraft UI contributions and complete Owner administration.
5. Isolated real-handler browser journeys, responsive screenshots and independent
   technical, accessibility and UX/content reviews; resolve must-fix findings.
6. Full final build/lint/format/types/unit/integration/browser/governance checks,
   acceptance traceability and PR evidence. Targeted tests during implementation.

Already running approved M2 PostgreSQL/Redis/SFTPGo resources passed the existing
test wrapper's provenance/network/endpoint checks. No container operation was
performed. Reuse isolated schemas/key prefixes and external provider fixtures.
New resources require exact approval. No live Minecraft rerun, production server
mutation, Gateway deployment, public bind or real DNS write is planned.
