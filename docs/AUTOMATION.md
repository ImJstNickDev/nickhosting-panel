# Server automation

Automation belongs to M5 and reuses the existing durable jobs, admission,
managed-server identities, resource reservations and Gateway leases. It does not
create provider schedules or a second lifecycle executor.

## Access and navigation

The server's Automation tab contains Schedules and Sleep/wake. Gateway messages
appear for Gateway-connected servers whose integration declares that capability;
direct or unsupported deep links show an unavailable state. The Backups schedules
link enters the same Schedules view, filtered to backup schedules. Server managers
and Owners can edit; other authorized readers can inspect. Assisted sessions cannot
make persistent changes. Every API checks current authorization independently of
visible controls and capabilities.

## Scheduled operations

Supported actions are start, stop, restart and backup, subject to server
capabilities. Timing supports one occurrence, elapsed intervals (minimum five
minutes), daily local time, and selected ISO weekdays (Monday=1, Sunday=7).
Calendar timing stores an IANA timezone. Repeated DST times use the earlier
occurrence; nonexistent local times shift forward by the timezone gap, matching
[Temporal's `compatible` disambiguation](https://tc39.es/proposal-temporal/docs/zoneddatetime.html).
The implementation uses the runtime's Intl/ICU timezone rules, without a new date
library. Interval timing remains elapsed time. In the form, one-shot and interval
start dates use the browser's local timezone; their separate timezone field only
changes preview/display. Daily and weekly times use the chosen recurrence timezone.
The API previews upcoming occurrences using the same calculation as dispatch.

A separate worker loop checks due work every second after its previous poll ends,
with a bounded batch of 25 candidates. Slow provider reconciliation does not delay
this poll. This is not a deadline guarantee: external admission and worker load
still apply. A failing candidate does not abort unrelated candidates. Overdue
occurrences coalesce to the latest slot; the existing five-minute lateness limit
and consumed capacity-denied outcomes remain. There is no capacity waiting queue.

Run now is revision-protected and idempotent per requesting actor/key. It records
a separate occurrence without advancing or enabling the recurrence. It uses the
same authorization, manual-stop suppression, admission and durable execution as
scheduled dispatch. Accepted means queued, not successful. Changing or deleting
an authorization can invalidate a queued operation before an external effect;
uncertain external results are reconciled rather than blindly replayed.

A scheduled stop preserves future automatic-start consent, unless manual stop or
maintenance already suppressed it. It does not override the separate autowake
preference. Manual stop still suppresses automatic starts. A confirmed scheduled
stop returns the Gateway to sleeping when automatic-start consent remains valid;
manual-stop and maintenance suppression remain authoritative. Revoked, pre-effect
stops retire safely, while unresolved effects remain uncertain. Completed one-shot
schedules cannot be rearmed without a new future instant.

The schedule table shows the latest outcome and current authorizer. History
includes job state, Activity links, backup completion, cleanup/resume and retention
outcomes. Manual occurrences retain the requesting actor ID; full job attribution
is available through Activity. New schedules preserve their original creator
separately from their current authorizer. Migration040 cannot recover an earlier creator that the previous schema already overwrote: existing
values are retained without inventing historical identity.

No console-command schedules or multi-operation chains are introduced.

## Independent wake and sleep policies

`defaultAutoWakeEnabled` (default true), `autoWakeUserAccess` (default editable)
and `gameAutoWakePolicies` provide separate autowake policy. Owner settings
resolve global → integration → runtime → Owner server baseline; a permitted
server-manager override takes precedence. Access is `hidden`, `editable` or
`disable-only`. Reset removes an override; it does not force the inherited value.
The existing defaults < Owner database < environment precedence applies.
Environment names are `NH_DEFAULT_AUTO_WAKE_ENABLED`, `NH_AUTO_WAKE_USER_ACCESS`
and `NH_GAME_AUTO_WAKE_POLICIES`.

Disabling autowake blocks Gateway-triggered joins only. It neither disables idle
sleep nor denies manual starts or authorized schedules. Both join admission and
final queued-wake authorization enforce the preference. Existing operational
Gateway enablement, manual-stop suppression and resource-admission checks remain.
Status requests never wake servers. Sleep continues to use its independent
hierarchy and hidden/editable/shorten-only controls.

### Server policy controls

Sleep/wake uses aligned settings rows with the saved effective value and its
source. Sleep offers Inherit, Custom and Disabled; wake offers Inherit, Enabled
and Disabled. Custom sleep starts from the inherited duration rather than
implicitly disabling sleep. Save/Cancel appear only for changes; Cancel discards
the draft and clears rejected-save errors. Operational-state refreshes do not
reset an edited duration. Owner access controls and technical Gateway settings
remain collapsed until needed. Automatic-start consent is a separate control;
changing wake never implicitly changes sleep or that consent.

## Per-server Gateway messages

Trusted integrations opt in with `capabilities.gatewayMessages`. Minecraft does;
direct connections cannot customize a fake endpoint that they do not use.
Each supported state has independent MOTD and login-disconnect overrides:
sleeping, waking, stopping, blocked, maintenance, manually stopped, wake disabled,
capacity denied and temporarily unavailable. Online gameplay/MOTD is forwarded
from the real server, not replaced by this editor.

Omitted values inherit existing Owner protocol defaults, then built-in EN/IT
messages. Supported variables are `{server}`, `{state}` and `{eta}`; Minecraft
formatting codes remain supported. `{eta}` is a historical estimate only while
starting and positive; it never delays routing or claims readiness. Templates
are bounded to 512 UTF-16 code units; unknown placeholders and ASCII control characters
other than tab/newline/carriage return are rejected. Expanded output is bounded
to 1,024 code units without ending on an isolated high surrogate. State text is presentation only. Active stops display stopping
without changing routing or weakening readiness.

Writes use a revision to reject stale edits, emit an audit event and notify the
Gateway. Cosmetic changes do not reset lifecycle generation or established
forwarding connections. Legacy clients retain their required encoding and
single-line adaptation. Unknown capabilities do not acquire management rights.

## API and migrations

- GET/PUT `/v1/platform/servers/:id/auto-wake-policy`.
- GET/PUT `/v1/owner/integrations/:gameId/auto-wake-policy`.
- GET/PUT `/v1/servers/:id/gateway-messages` (revision plus overrides on PUT).
- POST `/v1/servers/:id/schedules/preview` (`timing`, `timeZone`).
- POST `/v1/servers/:id/schedules/:scheduleId/run` (`revision`, `idempotencyKey`).
- Existing schedule CRUD/history and automation-consent APIs remain in use.

Migration039 adds nullable autowake preferences and an empty message-override map.
Migration040 adds authorizer and manual-occurrence metadata; calendar recurrence
uses the existing timing JSON column. Neither
migration seeds schedules, sends provider commands or resets existing data.
Activation is explicit; development startup does not migrate production.

Rollback must first stop the updated dev workers and inspect queued/running work.
Preserve the database and backup; do not restore over new review data or blindly
replay uncertain jobs. A downgrade must account for daily/weekly timing and new
occurrence metadata before reverting application code. Existing pre-change images
are recovery artifacts, not permission for a destructive restore.
