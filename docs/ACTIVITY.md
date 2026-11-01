# Server Activity

Activity combines durable server operations and selected server audit records.
It answers who requested a change, what was affected, when it happened and what
outcome NickHosting actually observed. It is not the administrative audit log or
a complete history of changes performed outside NickHosting.

## User journeys and presentation

- A server's Activity opens in its current permission scope. Global Activity shows
  the same events across accessible servers and includes a server column.
- Search finds actions, paths and actor identities. Category, source, outcome and
  date filters narrow the timeline; choosing an actor narrows to that identity.
- Rows expand inline to show safe operation details. Durable jobs retain their
  existing detail/recovery page. Reading a record never replays an operation.
- Multi-file operations are grouped by their operation/batch identity, with item
  counts and bounded details. Requested and terminal records form one visible row.
- Initial loading preserves the table footprint. A failed refresh keeps the last
  successful data with an explicit retry. Empty results and no history are distinct.
- Keyboard users can operate every filter and disclosure. Mobile stacks row fields;
  long paths/commands wrap without causing page overflow. EN/IT copy is complete.

## Attribution and evidence

Human actions display the NickHosting actor. Assisted actions preserve actor and
subject separately. Automations show their system/schedule origin, even when
execution authority comes from a server owner. SFTP events display the credential
owner's NickHosting username; the specific SFTP username appears in details.

Console history stores the submitted command, not console output. A dispatched
command is not proof that the game accepted or successfully executed it. Commands
are available only to principals permitted to manage the server. Known transport
failures remain distinct from unknown remote outcomes; nothing is resent for audit.

File events contain paths/counts, never file contents or signed URLs. Historical
requested-only records remain requests rather than invented successes. Incomplete
external effects remain uncertain/partial. No extra provider reads are introduced
to manufacture confirmation for Activity.

## Included and excluded events

Included families are lifecycle, file operations, backups, access, configuration
and console. Project membership changes are anchored to the servers in that project
at the time of the change, including removal; later reassignment does not import
unrelated project history. Existing durable jobs are reused; their queue audit rows are not
shown again. File read-ahead, viewer range reads, directory enumeration, resource
samples and internal upload reservations are excluded from the user timeline.

Actions performed directly through Pterodactyl are intentionally not imported.
Existing provider callbacks still confirm NickHosting jobs such as backups.
SFTP filesystem notifications use the separate authenticated transport described
in [SFTP Activity](SFTP-ACTIVITY.md). Technical viewer accounts are excluded.
The provider's delivery limitations must not be mistaken for complete audit coverage.

## Safety and performance

Activity reads use local PostgreSQL state, current server/project authorization,
selected metadata and bounded cursor pages. The default page selects logical groups
before fetching first/latest snapshots via an expression index; large JSON histories
are not window-sorted. Outcome/content filters inspect the latest matching snapshots.
Compact upload progress shows the latest affected item, never stale preparation
states; terminal manifests expose at most 100 item details. No Pterodactyl/SFTP polling is needed
for a browser to open or refresh Activity. Operation correlation must not merge
different servers or actors. The administrative audit remains separately protected.
Existing historical records are retained; missing fields are not reconstructed
from guesses. No credentials are returned in Activity responses.

Implementation and validation evidence are recorded in M5-VALIDATION.md after
completion. Live SFTP event-rule activation is an operation-specific infrastructure
change and is not implied by local implementation.
