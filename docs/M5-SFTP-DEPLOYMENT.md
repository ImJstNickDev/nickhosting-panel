# Development user SFTP — preparation, not activation

Prepared on 2026-10-14 within M5 PR #21. The Owner selected
`sftp.dev.hub.nickhost.ing` for development and provisionally
`sftp.hub.nickhost.ing` for production. **Neither hostname selection nor this
proposal authorizes starting infrastructure.** Production is outside this task.
The private viewer service and its read-only mount remain unchanged.

## Proposed first activation

Append `compose.dev.sftp.yaml` to the current complete development overlay chain.
It adds only `sftpgo-users` (`nickhosting-dev-sftpgo-users-1`) to `nickhosting-dev`,
using the existing pinned SFTPGo 2.7.6 image. Reuses the existing `data` and `egress`
networks; does not join `prod-frontend`, use host networking, or mount Docker.
The existing non-internal egress bridge supports the approved published SSH port.
REST management port 8080 stays unpublished and authenticated.

Publish only host TCP **2023** to service TCP **2022**, on one explicitly approved
host address, not an implicit wildcard. The exact host address and filesystem
source are recorded in ignored `.codex/local/sftp-users-activation-plan.json`.
Read-only inspection found no TCP listener, Docker binding, or proposed container
name collision; recheck immediately before activation. The hostname did not resolve
from this host during preparation; no DNS record was changed.

| Resource | Access / purpose |
| --- | --- |
| `mountdata/dev/sftpgo-users` → `/var/lib/sftpgo` | New dedicated writable database, host key and administrator state. Never reuse viewer state. |
| Explicit existing managed-server directory → `/srv/nickhosting-sftp/servers/<provider UUID>` | One approved server, read/write. Its parent remains on the read-only container filesystem, preventing creation of substitute homes for unmapped UUIDs. |
| `/tmp` | 32 MiB noexec/nosuid tmpfs. |

The source directory is the Owner's existing managed development test server,
corroborated in private deployment notes. Its owner differs from the Wings volume
root and the viewer process identity. Run the new service as that **existing
nonroot server file owner**, not root and not the viewer reader. No recursive
chmod/chown, ACL edits or initialization of game files is proposed. Binds use
`create_host_path: false`; the direct `sftpgo` entrypoint bypasses image ownership
initializers. Root filesystem is read-only, capabilities dropped, no-new-privileges
set; service limits are 256 MiB, one CPU, 128 PIDs, with health checks, bounded
logs, restart-unless-stopped and a 30-second stop grace period.

**This first activation enables only the explicitly mounted server.** Future
managed servers need additional approved UUID child mounts (and compatible file
ownership). Do not mount all existing Wings data to avoid reviewing this scope.
Current SFTP availability is global configuration, not a per-mounted-server
capability: issuing a credential for an unmapped server can succeed at the REST
layer but cannot make its missing SSH home accessible. Do not claim fleet-wide
readiness from this first test. Broader automated mount provisioning is not added
in this preparation pass.

## Credentials and Owner settings

`deploy/dev-sftp.env.example` lists the required inputs. During approved activation
create `.env.dev.sftp.local` exclusively, mode 0600; never overwrite an existing
file. Use the reviewed private plan for UID/GID, source UUID/directory, bind address
and port. Generate a new administrator password and instance UUID, keeping both
stable across restarts. Do not reuse viewer credentials or provider credentials.

Once the new service is healthy, the coordinator can authenticate privately to
its `/api/v2/token`, then create a dedicated admin API key through
`POST /api/v2/apikeys` with scope 1 and the new instance administrator. Capture its
one-time secret in memory/private storage, never logs or chat. This mutates only
the new SFTPGo database and must be included in activation approval.

Use the existing protected Owner settings interface and encrypted secret store:

| Setting | Value |
| --- | --- |
| `sftpgoBaseUrl` | `http://sftpgo-users:8080` |
| `sftpgoDataRoot` | `/srv/nickhosting-sftp/servers` (no trailing slash) |
| `sftpgoInstanceId` | Newly generated stable instance UUID |
| Secret `sftpgoApiKey` | New user-SFTP management key; write-only |
| `sftpPublicHostname` | `sftp.dev.hub.nickhost.ing` |
| `sftpPublicPort` | `2023` |
| `sftpCredentialTtlSeconds` | Retain the current Owner setting unless separately requested |

Inspect configuration source precedence first: environment overrides must not
silently retain simulator values. Do not alter `fileViewers` or
`viewerSftpgoApiKey`. No application rebuild, migration, database reset or API/
worker restart is planned. Snapshot previous protected settings privately for
rollback; do not copy secret values into public evidence.

The adapter confines each account to the verified provider UUID home and grants
list/download/upload/overwrite/delete/rename/create-directory permissions. It
neither imports existing Panel servers nor offers shell commands. Its existing
ownership and permission checks remain in use. FTP, WebDAV, WebAdmin, WebClient,
SSH commands and telemetry listeners are disabled.

Quota tracking is **2**, not the viewer's disabled accounting. Finite quotas use
the adapter's existing per-credential quota. Existing files and writes made through
Wings/game processes can make SFTPGo counters stale; this is not authoritative
shared-pool accounting. A managed server with unlimited disk currently issues
`quotaBytes=0`. Do not represent this setup as new aggregate quota enforcement.
See [upstream Docker behavior](https://github.com/sftpgo/docs/blob/main/docs/docker.md)
and [quota configuration](https://github.com/sftpgo/docs/blob/main/docs/config-file.md).
The known retained-SSH-transport revocation defect, issue #18, remains an explicit
production-release gate, temporarily accepted for development testing.

## Commands — do not execute before exact approval

Preserve all currently active overlay files. Recheck container Compose labels if
other development changes have landed since this proposal.

```bash
sftp_compose=(docker compose
  --env-file .env.dev.local --env-file .env.dev.viewer.local
  --env-file .env.dev.sftp.local
  -f compose.dev.yaml -f compose.dev.real.yaml -f compose.dev.observer.yaml
  -f compose.dev.gateway.yaml -f compose.dev.gateway-live.yaml
  -f compose.dev.viewers.yaml -f compose.dev.sftp.yaml)

# Non-mutating validation; never print interpolated secrets.
"${sftp_compose[@]}" config --quiet

# AFTER approval: load this trusted private file without echoing its contents.
set -a
source .env.dev.sftp.local
set +a
bash deploy/prepare-sftp-users-state.sh --owner-approved \
  "$NH_SFTP_USERS_UID" "$NH_SFTP_USERS_GID"
"${sftp_compose[@]}" up -d --no-deps --wait sftpgo-users

# Scoped lifecycle, preserving state and game data:
"${sftp_compose[@]}" stop sftpgo-users
"${sftp_compose[@]}" start sftpgo-users
```

The state helper uses one short-lived pinned-image container,
`nickhosting-dev-sftp-users-prepare`, with no network and only the **new empty state
directory** mounted. It assigns the approved UID/GID and mode0700 to that directory
alone. It never mounts game data, repairs existing state, or removes anything on
failure. Existing state/name/symlink conflicts stop preparation. The image must
already exist locally; preparation performs no implicit pull.

## DNS, connection and activation evidence

The Owner configures DNS separately: resolve the hostname to the selected LAN
address for local tests, or to the WAN address with explicit router TCP forwarding
for remote access. An HTTP NPM proxy host and HTTPS certificate do not carry SFTP.
If using a DNS provider with an HTTP proxy, use ordinary DNS resolution for this
SSH endpoint. No NPM, DNS, certificate, firewall or router changes are authorized
by this proposal. Initial verification may use the approved LAN address directly.

After approved activation, verify:

1. Only the named service/helper/state were created; no existing service recreated,
   no new networks, only TCP2023 published, management API unpublished.
2. Health, UID/GID, expected mounts and read-only container root; preserve startup
   logs without credentials. Existing game-file owners/permissions unchanged.
3. Private management connectivity from NickHosting; exact effective Owner settings,
   separate viewer configuration still intact. Record SSH host public-key fingerprint.
4. Owner issues a credential from the server SFTP tab. Connect with SFTP (not FTP)
   using advertised host/port, username/password and verified host fingerprint.
5. Only with approval for a new `/sftp-activation-test-20261014/` directory on the
   selected server (abort if it already exists): list, upload a tiny
   synthetic file, download and compare hash, rename, delete only that file, and
   remove only the empty newly created test directory. Do not touch existing files.
6. Revoke the test credential and verify a **new transport** cannot authenticate.
   Do not call retained-transport behavior a security pass; issue #18 persists.
7. Preserve all state across a separately approved scoped stop/start if included
   in activation. External hostname/router reachability requires a client-side test.

## Rollback and approval boundary

Stop only `sftpgo-users`; stopping interrupts its active SFTP sessions. Restore
only the previous user-SFTP Owner settings/secret if those were changed. Retain
state, SSH keys and all game data. Never run `down -v`, prune, orphan removal,
recursive permissions, or cleanup of other servers. Optional later removal of the
stopped container/state requires a separate explicit request. Existing viewer
service, Panel/Wings and all game processes remain running throughout.

Activation approval must explicitly cover: the new service, LAN TCP2023 binding,
existing dev network attachments, the single existing server's read/write mount,
new dedicated state and temporary ownership helper, new SFTPGo admin/API key,
protected dev Owner configuration updates, and any exact scoped test writes.
Without that approval, this task stops at reviewed configuration and evidence.

## Preparation evidence — 2026-10-14

- Rendered the current complete Compose configuration and proposed configuration
  with private in-memory interpolation values. Every existing service and network
  compares equal; only `sftpgo-users` is added. Asserted project name, nonroot user,
  direct entrypoint, quota2, exactly two bind mounts with auto-creation disabled,
  one UUID child data target, data/egress networks and a single SSH publication.
  Interpolated credentials were never printed or written to evidence.
- No proposed container/helper name or TCP2023 Docker/listener collision found.
  Dedicated state is absent. Existing state parent is owned by the development
  user, mode0700, not a symlink. Existing viewer read-only metadata confirms the
  selected server directory and a representative file belong to the intended
  new SFTP process identity; no host permission changes were attempted.
- API belongs to `nickhosting-dev` and has no explicit environment overrides for
  the six user-SFTP endpoint/secret settings, so protected Owner settings can apply.
- Host had approximately 45 GiB disk available and 24 GiB available RAM. This is a
  preparation snapshot, not capacity reserved for arbitrary future uploads.
- `bash -n deploy/prepare-sftp-users-state.sh` passed. Missing approval flag,
  missing arguments and root UID inputs fail before mutation. Positive helper
  execution was deliberately not tested against Docker/state without approval.
- Secret/state ignore checks and whitespace checks passed. Independent static
  security/configuration review: no must-fix findings. Runtime startup, actual
  writes, SSH authentication, persistence and client reachability are pending
  exact activation approval. No infrastructure or game files changed.
