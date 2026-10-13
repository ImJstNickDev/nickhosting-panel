# Private viewer SFTPGo deployment proposal

M5 preparation, **2026-10-13**. This document is an activation proposal, not an
activation record. The existing isolated `nickhosting-m2-tests` SFTPGo service
and its fixture directories remain separate and unchanged.

## Resources and data boundaries

`compose.dev.viewers.yaml` adds one service to the existing `nickhosting-dev`
project: `sftpgo-viewer`, with expected container name
`nickhosting-dev-sftpgo-viewer-1`. It joins only the existing internal
`nickhosting-dev-data` network. It publishes no host ports and has no attachment
to `prod-frontend`, egress, a Docker socket or host networking. Internal service
addresses are `sftpgo-viewer:2022` for SSH and `http://sftpgo-viewer:8080` for its
protected management API. NPM, DNS and certificates need no change.

The pinned image is SFTPGo **2.7.6**, with the same reviewed digest as the M2
fixtures. Its read-only root filesystem, dropped capabilities, nonroot configured
UID/GID, 256 MiB memory limit and one CPU apply to this service only.

| Host source | Container target | Access |
| --- | --- | --- |
| `mountdata/dev/sftpgo-viewer` | `/var/lib/sftpgo` | Read/write; dedicated account database, SSH host keys and service state. |
| Explicit `NH_VIEWER_WINGS_DATA_ROOT` | `/srv/nickhosting-viewer/servers` | **Read-only**, existing Wings volume root. |
| Container tmpfs | `/tmp` | Temporary, 32 MiB, noexec/nosuid. |

Both persistent bind mounts use `create_host_path: false`. No empty substitute
directory is created if the configured source is wrong. Existing Wings data are
not copied, initialized, renamed, recursively chowned or chmodded. The SFTPGo
process has read access to the mounted volume root; its account boundary confines
each viewer credential to one verified server UUID. This is not filesystem
isolation from the SFTPGo process itself, so the host root must be reviewed before
approval. No existing servers are imported or issued viewer accounts automatically.

The startup command directly executes `sftpgo serve`, bypassing any shell
entrypoint. It uses `/var/lib/sftpgo` as its configuration directory and the
image-baked `/etc/sftpgo/sftpgo.json` as its defaults. Database, backups and generated
host keys therefore stay in dedicated state. No restore/import flags or startup
hooks are supplied. FTP, WebDAV, WebClient, WebAdmin, SSH commands and telemetry
listeners are disabled. Only private SSH and authenticated REST remain.

Viewer users use a separate `nhv_` namespace and ownership marker, permit only
`list` and `download`, and have no groups, virtual folders or public keys.
`disable_fs_checks: true` avoids SFTPGo's login-time home initialization. The
read-only bind mount independently prevents writes even if a remote account were
misconfigured. File editing, uploads and archive extraction continue through
the existing authorized Wings path.

## Preflight and private values

Before activation, recheck the exact branch/HEAD, existing Compose project labels,
selected overlay files, the two new container names below, network identity,
available disk/RAM, the actual Wings bind source, symlinks and filesystem owners.
Read-only inspection found that the configured Wings user and the observed data
owner differ on this installation. **Do not derive the reader UID/GID from the
Wings YAML alone.** Verify the volume root and a managed server's files, then set
explicit numeric values; exact installation paths and IDs remain private.

Keep new values in ignored `.env.dev.viewer.local` with mode `0600`. This is a
proposed new file; preparation has not created it. Supply:

```dotenv
NH_VIEWER_SFTPGO_UID=VERIFIED_NONROOT_DATA_READER_UID
NH_VIEWER_SFTPGO_GID=VERIFIED_DATA_READER_GID
NH_VIEWER_WINGS_DATA_ROOT=/EXACT/EXISTING/WINGS/VOLUMES
NH_VIEWER_SFTPGO_ADMIN=DEDICATED_VIEWER_ADMIN_NAME
NH_VIEWER_SFTPGO_PASSWORD=GENERATE_A_NEW_PRIVATE_RANDOM_SECRET
```

The administrator is dedicated to this SFTPGo instance, not a Pterodactyl account.
Initial creation occurs only when no administrator exists; restarts retain the
same account database. Never put production provider keys in this file, frontend
variables, build arguments or command-line literals.

`deploy/prepare-viewer-state.sh --owner-approved UID GID` creates only the new
empty state directory, then one temporary container
`nickhosting-dev-viewer-prepare` with `--network none`. That helper mounts **only**
the new state directory. It changes ownership and mode `0700` on that directory
itself; it never mounts Wings or other development data and never runs recursive
permission changes. It requires the pinned image to be present and refuses
existing state or a conflicting helper name. If it fails, preserve the directory
and diagnose; do not remove/reset it automatically.

## Exact activation proposal — approval required

The Owner must approve the new service/read-only Wings mount, the private state
preparation helper, required application rebuild/recreation, and the development
migration before any commands below are run. The risk is additional read/disk
activity and private access to the mounted server files; API/Vite recreation can
interrupt browser requests. No Panel, Wings, game process, production service,
external network or public game-port change is proposed.

The following array preserves all currently used development overlays. Recheck
the active container's Compose-file label and amend the proposal if that selection
changes; never omit an existing overlay just to launch the viewer service.

```bash
viewer_compose=(docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local
  -f compose.dev.yaml -f compose.dev.real.yaml -f compose.dev.observer.yaml
  -f compose.dev.gateway.yaml -f compose.dev.gateway-live.yaml
  -f compose.dev.viewers.yaml)

# Read-only validation; do not print interpolated secrets.
"${viewer_compose[@]}" config --quiet
docker network inspect nickhosting-dev-data --format '{{.Name}} internal={{.Internal}}'

# Only after exact Owner approval:
"${viewer_compose[@]}" pull sftpgo-viewer
bash deploy/prepare-viewer-state.sh --owner-approved VERIFIED_UID VERIFIED_GID
"${viewer_compose[@]}" up -d --no-deps --wait sftpgo-viewer
"${viewer_compose[@]}" build api
"${viewer_compose[@]}" run --rm --no-deps migrate
"${viewer_compose[@]}" up -d --no-deps --wait api vite
```

The database migration applies the branch's viewer tables to the **development**
database. It does not reset accounts or review data. API/Vite need recreation for
new dependencies; the worker and Gateway need no restart for this transport.
The helper automatically removes only its own transient container. No orphan
removal, pruning, `down -v`, schema deletion or game-directory cleanup is included.

For subsequent daily Compose use, preserve the current `COMPOSE_FILE` and append
`compose.dev.viewers.yaml`; continue supplying the viewer environment file. Merely
restarting the service never reruns the state-preparation script.

## Pinning and protected NickHosting settings

After the new service is healthy, obtain its **public** Ed25519 key directly from
the container whose Compose identity and mount were verified:

```bash
docker exec nickhosting-dev-sftpgo-viewer-1 cat /var/lib/sftpgo/id_ed25519.pub |
  ssh-keygen -lf /dev/stdin -E sha256
```

Copy the resulting `SHA256:...` fingerprint into the protected Owner configuration.
The service advertises only `ssh-ed25519`; the client refuses a missing or changed
pin. This is explicit host-key pinning from trusted local state, not trust on first
network use. Never print or copy the private key. An unexpected key change is a
configuration incident, not a reason to disable verification.

Create a dedicated SFTPGo management API key through its private authenticated REST
API. Store it using NickHosting's write-only `viewerSftpgoApiKey` secret. Do not
paste it in chat, CLI arguments, logs or this document. Set `fileViewers` in Owner
settings with:

```json
{
  "managementUrl": "http://sftpgo-viewer:8080",
  "dataRoot": "/srv/nickhosting-viewer/servers",
  "instanceId": "NEW_DEDICATED_UUID",
  "host": "sftpgo-viewer",
  "port": 2022,
  "hostFingerprint": "SHA256:VERIFIED_PUBLIC_KEY_FINGERPRINT",
  "cacheRoot": "./mountdata/viewer-cache",
  "cacheBytes": 1073741824,
  "maxSnapshotBytes": 268435456,
  "maxConnections": 16
}
```

The cache path resolves inside the API's existing dedicated development app mount,
not the Wings mount. Settings follow normal defaults → Owner database → explicit
environment precedence. `NH_FILE_VIEWERS` and `NH_VIEWER_SFTPGO_API_KEY` are the
optional environment equivalents; prefer Owner settings for interactive setup.
Existing external-SFTP settings, credentials and availability are unaffected.
No public SFTP endpoint is introduced by this proposal.

## Validation and rollback

Before enabling views, inspect service health/logs without dumping secrets; prove
the exact mount is read-only, no host ports exist, and the only network attachment
is `nickhosting-dev-data`. Check read-only metadata/ranges on an explicitly selected
managed server and compare its existing owner/mode; do not write probe files into
game data. Exercise revocation and write-denial mutations in the already isolated
M2 fixtures, not on pre-existing servers. Verify media seek, cancellation and
private cache behavior through NickHosting's actual authenticated handlers.

If activation fails, preserve logs and state. Disable the `fileViewers` Owner
configuration, then stop only the new service:

```bash
"${viewer_compose[@]}" stop sftpgo-viewer
```

Do not delete its state or SSH keys. Previous application images can be retained
under review-specific local tags before rebuilding; returning to those images
requires a separately reviewed API/Vite recreation. Keep additive viewer database
tables in place during rollback; no destructive down migration is proposed.

The known retained-SSH-transport defect in [issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18)
remains a production-release gate. Browser access is mediated by NickHosting and
its own pooled transport is closed on revocation. This does not fix or waive
upstream revocation for external SFTP clients.
