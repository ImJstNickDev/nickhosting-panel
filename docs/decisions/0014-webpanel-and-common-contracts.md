# ADR 0014 — WebPanel, trusted UI contributions and common operations

Date: 2026-10-09
Status: Implemented on M5 branch; final milestone acceptance requires PR review.

## Context

The Owner-approved amendment to [ADR 0008](0008-complete-frontend.md) makes M5 the
complete WebPanel and common platform integration milestone. The M1–M4 APIs are
retained. Minecraft Vanilla is the first real-server-verified integration; no
Satisfactory or additional runtime certification is required or implied.

## Decision

Use React, React Router and TanStack Query in `apps/web`, built with Vite. The API
and browser share one public origin; browser requests use same-origin cookies.
Keep Better Auth as the identity authority. A narrow HttpOnly support cookie
transports the existing parent-bound assistance token; it does not replace the
Owner's session or create a session belonging to the subject. Exit clears stale
browser context even if the original parent session has expired.

The application owns common navigation, permissions, operations, files, backups,
network presentation and automation. Build-time first-party Game SDK modules own
typed configuration/conditional forms, management descriptors, translations,
controllers and artwork. Descriptor validation is separate from authorization.
Neither an Owner-provided descriptor nor an API response can import executable
code. Artwork is bundled with its integration and accompanied by provenance.
The initial Minecraft landscape is original illustrative SVG, not copied game art.

Common query contracts add scoped pagination, project membership discovery,
metadata editing, quota/history reads, connection/transfer availability and
Owner administration. Provider and runtime identities remain immutable.
Readiness, runtime process status, operation status and configured capacity remain
separate facts. Accepted operations never imply completed external effects.

Schedules persist in PostgreSQL with revision, actor and due-run claims. The
worker submits through existing jobs and admission. Missed runs do not create
an unbounded catch-up queue. Scheduled starts require explicit automation consent;
manual stop withdraws it. Permission, consent and schedule revisions are checked
again after slow runtime proofs, immediately before an effect. Uncertainty
recovery acknowledges an unknown failure where the existing lifecycle permits
it; it does not claim rollback, release quarantined reservations or replay power.

Use Lingui compiled catalogs and Intl with complete English/Italian strings.
One restrained light theme is supported initially. Real loading/error/blocked/
uncertain states, keyboard operation, responsive layouts and reviewed browser
screenshots are acceptance work. A screenshot does not establish functionality.

## Consequences

Ordinary users only see eligible verified choices. Internal protocol IDs and
compatibility evidence remain Owner-only. Minecraft property reads use bounded,
authorized provider access and expose only editable safe keys, excluding bind,
RCON and credential fields. Game views refresh after durable completion rather
than treating HTTP acceptance as success.

Text editing and console buffers are bounded. Binary upload/download paths stay
streamed and mediated; no privileged provider URLs or keys enter browser DTOs.
External provider mocks in browser tests exercise actual Hono, identity,
PostgreSQL and durable-job code, but do not establish provider transport or new
Minecraft compatibility. Existing M1–M4 integration/live evidence remains relevant.

No production deployment, network change, live game mutation or new Docker test
resource follows from this decision. SFTPGo [issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18)
remains an independent production-release gate.
