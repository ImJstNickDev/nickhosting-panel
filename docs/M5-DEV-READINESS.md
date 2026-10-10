# Development operational prerequisites

The real Panel connection is verified; this does not establish provisioning
readiness. The earlier dev and production Compose configurations omitted the
host/container observation bridge required by the existing admission and lifecycle
code. This is a deployment integration gap, not a new development-only policy.
Production remains configuration-only and must not be called operationally ready.

## Prepared host observer — activation pending

[The helper](../packages/pterodactyl-adapter/src/host-observer.ts) runs as the
current host user, using the existing read-only Docker observer implementation.
Its private Unix RPC exposes only host resource samples and exact-UUID container
state, process epoch and image identity. It has no DB credentials, Panel keys,
TCP listener, lifecycle commands or filesystem content operations. Sampling uses
physical host CPU/RAM, including other services and direct Pterodactyl servers;
disk sampling is restricted to configured canonical directories.

[The optional dev overlay](../compose.dev.observer.yaml) mounts only its private
socket directory read-only into API/worker. Neither receives Docker's socket,
host processes, Wings files or a new network. The helper itself runs with the
current user's existing Docker access, which is privileged: the limited RPC is
the application's access boundary, not a claim that Docker access is read-only.

The helper requires the same UID as dev API/worker, private directory `0700`,
socket `0600`, a stable observer identity and an exact disk-path allowlist. A
filesystem probe directory may be project-owned on the **verified same filesystem**
as the game volumes; no game directory mount or read access is necessary. Recheck
this relationship if storage moves. Do not measure the API container overlay.

The source timestamp and observer identity are checked before persisting a sample.
Stale/unavailable/wrong-identity data fail closed; there is no container-local
fallback when the remote observer is configured. Managed resource credits remain
empty/conservative. The existing provider UUID/external-ID checks remain in place.

## Exact activation boundary

No helper, service unit, socket directory or observer mount has been activated by
this change. The reviewed private plan in `.codex/local/m5-observer-activation.md`
contains resolved paths and identity for this machine; never publish that file.
The proposed operations are:

1. Create only `mountdata/dev/observer/` as the development UID, mode `0700`.
   Preserve existing paths; refuse symlinks or unexpected ownership/permissions.
2. Install the rendered [user service](../deploy/dev/host-observer.service.example)
   as `nickhosting-dev-observer.service`, with its separate private environment
   file. Do not overwrite any existing unit. No DB/provider credentials enter it.
3. Enable lingering for this user **only if separately approved**, then enable/start
   this one user service. Lingering currently is disabled; without it the helper
   may stop after logout and is not guaranteed at boot. Enabling it also keeps the
   user's other enabled user services eligible to run after logout.
4. Append `compose.dev.observer.yaml` to private `COMPOSE_FILE`, set the matching
   `NH_DEV_OBSERVER_ID`, build the existing dev application image and recreate only
   dev API/worker. Existing web external-network attachment and all data remain.
5. Verify the helper's read-only preflight and resource sample from the API
   namespace, scoped restart recovery, HTTPS/HMR and unchanged DB configuration
   counts. Do not register any physical host, managed node, mapping, rollout or
   evidence entry. Do not create a game server for this verification.

Proposed lifecycle (after exact approval and private plan preparation):

```sh
systemctl --user daemon-reload
systemctl --user enable --now nickhosting-dev-observer.service
docker compose --env-file .env.dev.local config --quiet
docker compose --env-file .env.dev.local build api
docker compose --env-file .env.dev.local up -d --no-deps --wait api worker
```

No new Docker service/network/host port, NPM/DNS change, production deployment,
Pterodactyl mutation or Wings modification is included. `loginctl enable-linger`
is a separate host-level operation requiring explicit approval; if administrative
authentication is required, the Owner performs it. No automatic privilege escalation.

The unit restarts after failure. Explicit stale-socket recovery removes only the
same owned socket after an `ECONNREFUSED` probe and inode/owner/type recheck. Live
sockets, unknown errors, files and symlinks are preserved. Keep a single systemd
instance; do not launch parallel manual helpers. Private-directory ownership and
single-instance execution are required because unlink is not an atomic conditional
inode operation. Reboot/kill recovery must be distinguished from graceful restart
in actual validation evidence.

Rollback: restore the previous private `COMPOSE_FILE`, remove the scoped observer
identity and recreate only API/worker; stop/disable only this user service. Keep
all DB data, host records, ledgers and keys. With no observer, admission correctly
becomes unavailable. Preserve the helper directory; remove only the exact unit
installed by this operation after stopping it. Restore lingering only with Owner
approval after checking whether other user services now rely on it.

## Owner configuration after activation

The environment supplies observations; **the Owner supplies configuration**:

- Register a physical host using the provided observer identity and approved
  filesystem probe path. Choose RAM/CPU/storage budgets and headroom from actual
  measurements and intended policy, not aggregate configured Pterodactyl limits.
- Register the Pterodactyl node, explicit backend allocation pool and provisioning
  account. That account must be controlled by the Client key; Application API
  users-read permission is necessary for validation. Do not import existing servers.
- Configure Vanilla egg/image/startup/variables and rollout. Set the Minecraft
  metadata user-agent with a real HTTPS contact URL. Public metadata connectivity
  is required; protocol metadata already has a checked-in trusted default.
- Import evidence valid for the **exact** runtime/mapping/binding and configure its
  trusted verification key. Historical M4 evidence is not automatically valid for
  newly created mapping identities. A changed context requires real validation
  after Owner configuration, not a fabricated signature or an admin checkbox.
- Set trusted Wings WebSocket/upload/download origins to enable the corresponding
  console/transfers. Panel connectivity alone does not verify those endpoints.

The helper activation can make configuration and admission infrastructure available;
it cannot pre-certify mappings the Owner has not created. Signed Minecraft evidence
and a separately approved Gateway endpoint/network plan remain prerequisites for
verified game availability and sleep/wake/public gameplay respectively. No Gateway
listener is activated by this change. SFTPGo remains disabled at the Owner's request;
issue #18 remains a production-release gate. Do not claim “Create → Start → Play”
passed until actual Owner configuration and the corresponding checks are complete.
