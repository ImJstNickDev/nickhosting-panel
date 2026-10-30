# Persistent storage relocation

`NH_MOUNTDATA_ROOT` is a host-only root shared by the Compose bindings and host
tools. Its default is the repository's `mountdata/`. A configured root contains
the same environment subdirectories; application paths inside containers stay
unchanged. Wings storage is a separate root and requires its own approved
configuration changes.

## Copy before cutover

1. Inventory the exact consumers, source and target filesystems, mountpoints,
   ownership and available space. Exclude stale installations. Confirm any other
   service that exposes the target disk.
2. Stop the approved writers and verify clean database shutdown. Keep the
   repository and private environment files in place.
3. Validate a small, bounded copy first. Compare content hashes, names, file
   types, owners, modes and timestamps, plus ACLs, extended attributes, hardlinks,
   symlinks and sparse allocation where present. An absent file type is not a
   tested case.
4. Copy all scoped data while retaining the originals. Preserve numeric ownership
   and metadata. Never use source-removal, deletion or in-place flags. Verify
   checksums and metadata and reject unexpected destination entries.
5. Keep services stopped after copy verification. A verified copy is not yet a
   completed migration.

The copied tree includes databases, SFTP identities and keys, source uploads,
staging, and private test ledgers/evidence. Do not selectively discard directories
because they appear temporary.

## Cutover

Configure the new host root and preserve the container targets. Do not run fresh
preparation against migrated data. Every persistent bind uses
`create_host_path: false`; an absent source must fail instead of initializing an
empty service. The migration preflight verifies the target filesystem UUID.
The activated live consumers also require a sentinel file on that filesystem, bound
read-only with `create_host_path: false`, so an absent disk fails startup rather
than creating replacement state. No systemd mount dependency is installed.
The sentinel is a presence guard; UUID verification remains a preflight check.
The isolated test stack retains `restart: "no"` and rejects missing bind sources;
it does not use the private live-service sentinel overlay.

Review separately any absolute host paths stored in the database, storage
measurements, SFTP game mounts and Wings paths. Preserve symlinks during copying;
review absolute symlink targets before changing them. For the four existing
source seals, rebinding relies on the completed, trusted checksum-copy evidence.
First match each original file and directory's full identity against its old
seal, then compare destination mode, UID, GID, link count, size and modification
time. Update only the destination device, inode and ctime identity fields in one
transaction, preserving the recorded content hashes. This does not repeat the
byte checksum verification. If the trusted copy proof is missing or invalid,
verify content again before rebinding; never replace identity fields blindly.

Record the point at which the destination becomes live and prevent further
old-source copying over it. Recreate only the approved consumers and verify
mounts, database/accounts, SFTP and file reads before controlled lifecycle tests.
Keep production activation boundaries and the SFTP release limitation separate.

## Rollback

Before cutover, original data and configuration remain authoritative. A failed
copy needs no restoration; preserve the partial destination for inspection.
Restarting the original services invalidates the offline-copy snapshot.

Before writes on the destination, rollback can restore the saved configuration
references and use the originals. After new writes, those originals are stale:
stop writers and reconcile the changes before switching back, especially for
databases. Retaining originals does not make a blind rollback safe.

Delete original data only after separate explicit Owner approval. Local paths,
container IDs, disk UUIDs, copy commands and evidence belong in private operational
notes, not this document.

## Development cutover evidence — 2026-10-20

The Owner completed the verified copy; the approved cutover then compared file
counts without repeating checksums: 3,099,480 provider files and 103,808 project
files matched, including directory and symlink counts. No remainder copy was
needed. All original trees remain intact pending separate deletion approval.

The sixteen scoped services were restored, with container paths and network/port
configuration preserved. API/worker received the rebuilt development image;
Panel/Wings versions and the installed Blueprint extension were unchanged.
The development database retains its accounts, sessions, seven managed-server
records and migration 047; the isolated database retains its 220 schemas.

Live checks passed for the existing Owner session, HTTPS, Firefox Fileman/Scribe,
WSS HMR, Blueprint discovery, Wings file reads, viewer range reads, and an existing
personal SFTP credential. A new exclusive-create probe was read back through
Wings with UID/GID 988, then removed; its provenance remains private. All thirty
game containers use the new volumes and remain unstarted.

Three previously proven Gateway routes passed status/ping checks without wake
requests. Global Gateway health still reports the three pre-existing routes
awaiting first-start reachability proofs; the existing MariaDB healthcheck issue
also remains, despite successful DB and Panel requests. Neither was concealed or
weakened to report the migration as successful. No original-data deletion,
production NickHosting deployment or unrelated infrastructure change was made.

### Health follow-up — 2026-10-20

The Owner requested correction of both health conditions after the cutover.
Gateway health now separates eligible listeners from routes withheld for
`backend_active_binding`; it does not relax listener admission or create missing
proofs. The existing dev Gateway was restarted, then reported healthy with three
active and four withheld routes. All three active routes passed status-only
Minecraft checks with no wake requests.

MariaDB's official healthcheck was ignoring its existing credential file because
the file was world-writable. Restoring only that file's mode from `0777` to the
image's intended `0600` restored the original connectivity/InnoDB healthcheck.
Contents, ownership and inode were unchanged; no database restart, account or
data change was needed. Panel and Wings remained healthy without restarts.

The original migration copies remain intact and still require separate deletion
approval. This follow-up did not start any game server.
