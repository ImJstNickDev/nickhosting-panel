# Server creation and installation

M5 keeps the user in the server Console after the creation request is accepted.
The installation view is part of that page, not a blocking wizard or a separate
provisioning system. Users can navigate away and return, or reload the page.

## Progress and output

The existing durable operation journal supplies five stages: preparing the
server, installing its runtime, applying game configuration, starting it, and
ready. Stage changes and timestamps describe work actually reached by the
worker. Queue delivery/retry states are not presented as installation progress.
There is an elapsed clock, but no invented percentage or estimated completion.
The starting stage is omitted when the operation does not request a first start,
including ordinary reinstalls; setup completion does not imply a running process.

The terminal shows the installer stream while installation is active, then
switches to the ordinary runtime console. The progress panel uses short labels,
small phase transitions and activity lights; reduced-motion settings suppress
animation. Completion, installation failure, uncertain outcome and a successful
creation whose first start was denied by admission are separate outcomes.
Reinstall uses the existing authorized operation and consequence confirmation.
It is not an automatic replay of an uncertain provisioning request.

When an open Console observes completion, a compact confirmation appears for five
seconds and fades out over 240 ms. It overlays the viewport without moving the
layout or intercepting clicks; it never takes focus. Reduced motion removes the
animation. Reloading or returning to an already completed installation does not
replay the confirmation. Failures and uncertain outcomes retain their recovery UI.
The bounded installation transcript remains accessible from Status, including after
a page reload, rather than beneath the runtime console. The existing transcript
expiry and access checks still apply.

`GET /v1/servers/:id/provisioning` returns the latest provision/reinstall operation
and its bounded transcript. `GET /v1/servers/:id/provisioning/stream` supplies
updated snapshots from NickHosting's database/cache. Both enforce current server
access; provider credentials and Wings URLs never enter either response. There
is no provider connection or provider polling loop for each browser. Stream
frames are bounded; the installation client permits its larger transcript frame
without increasing limits on unrelated streams. A delayed HTTP refresh cannot
overwrite a newer streamed phase or newly appended log lines.

## Installer transport

Blueprint 1.7 adds a dedicated Client route for installation WebSocket
credentials. Normal technical accounts cannot use Pterodactyl's standard
installing-server WebSocket route, and their wildcard permission does not include
Wings' administrative installation channel. The new route verifies the existing
NickHosting link, exact server identity and technical owner, then issues only
`websocket.connect` and `admin.websocket.install`. It grants no power, console
command or unrelated-server access. The existing adapter owns token validation,
pinned destinations, redaction and the socket transport.

One worker collector per operation receives live installation output. It starts
after the provider identity/link is known and uses a distributed lease to fence
worker replicas. The transcript is kept in the existing encrypted, bounded Redis
cache, rather than writing each line to PostgreSQL. Collection does not depend on
an open browser. Worker shutdown aborts the collector and releases its lease.

The existing bounded installation-confirmation observer may hold a second
socket while establishing terminal proof. That observer has a different lifetime
from transcript collection. This change does not multiply either socket by the
number of connected browsers or replace confirmation with a log message.

The current replay window is at most 1,000 lines and 256 KiB of text with a
15-minute expiry since the last saved batch. `logsAvailable` means a subscription
succeeded or retained output exists, not that a socket is currently connected.
This is a diagnostic transcript, not a permanent log archive.
Wings does not provide installer backlog through its ordinary `send logs`
message. Output before subscription, during a disconnected interval, or after
cache expiry may be unavailable; the UI does not fabricate it. Saved raw Wings
installation log files are not fetched because their headers can contain server
environment variables.

Blueprint also publishes `installation.updated` through the existing signed,
durable change feed after a committed model change. This wakes the normal
operation worker promptly. The WebSocket `install completed` event is only a
wakeup hint: Wings emits it on both success and failure. Completion still uses
the existing lifecycle's installation and game-configuration checks. Bounded
reconciliation remains the fallback if the event or socket is unavailable.

## Activation and evidence boundary

This feature needs the new Blueprint package for live installation output and
event-driven confirmation. Installing it is a separate, reviewed infrastructure
operation; source development does not authorize running Blueprint on the live
Panel. No game server needs to be created or modified to validate the local
contracts and rendered states.

The native Blueprint installer retains its normal Panel cache, PHP queue and
ownership housekeeping. Preserve the approved separated Panel/Wings mounts and
the controlled Panel entrypoint. Before activation, pin the package hash, retain
the previous extension/configuration and archive, check current container/mount
identity, and prepare a scoped rollback. Never restore the old shared game-data
mount as part of an extension rollback.

Local transport, PHP, database and browser fixtures establish behavior at their
respective boundaries. They do not establish receipt of a real installer's first
line or successful installation of a particular Minecraft/Loader combination.
The Owner's next creation is the live end-to-end confirmation.
