# Satisfactory integration

This work uses the M5 review baseline on `milestone/m6-game-integrations`, following
the Owner's explicit request to begin Satisfactory. It does not merge or deploy M5.

## Provisioning and identity

The compiled `satisfactory` integration uses runtime `dedicated`. The existing
Owner mapping chooses the Pterodactyl egg and Linux container. SteamCMD remains
owned by that egg; NickHosting binds app 1690800, branch and update selection.
Required roles are `game` (TCP and UDP on one number) and `reliable` (TCP).
Startup explicitly binds `-Port`, `-ReliablePort` and `-ExternalReliablePort`.

Creation generates a per-server self-signed RSA certificate using OpenSSL. The
existing encrypted secret store persists the private identity under the managed
server UUID. It is not part of a route snapshot or browser response. Provisioning
uploads certificate and key into `FactoryGame/Certificates` through the existing
bounded, authorized upload pipeline before start. Private staging and published
files use mode 0600. Restore/reinstall reuses the saved identity. Database backup
and encryption-key recovery are necessary to preserve this identity across hosts.

The authenticated Gateway control endpoint validates the current route revision
before returning identity material with `Cache-Control: no-store`. The Gateway
holds identities in memory while their listener remains valid. Clearing sessions
invalidates the cached identity.

## Gateway

Load the compiled `games/satisfactory/src/gateway-module.js` through the existing
`NH_GATEWAY_PROTOCOL_MODULES` configuration. No separate listener service exists.
Existing allocation ownership, binding checks, leases and connection limits apply.

Lightweight Query implements the documented binary envelope, uint64 cookie and
flags, NetCL, substates and UTF-8 server name. Responses use observed backend data,
with persisted cache in `satisfactory_server_state`. No invented NetCL is sent
when no backend observation exists. Identical state samples do not change route
revisions. Offline/waking responses use the documented Offline/Loading states.

HTTPS uses a stable per-server identity in both Gateway and backend. The Gateway
terminates incoming TLS and creates a separate upstream TLS session, pinning the
exact server certificate before forwarding request bytes. Existing sessions are
not transplanted between TLS endpoints. Online API responses and credentials pass
through unchanged. Offline HealthCheck reports slow; other offline HTTP requests
receive 503, never manufactured authentication tokens or multiplayer tickets.

Reliable TCP remains raw forwarding. Its readiness requires a recent game-query
observation and a successful TCP connection. UDP polling does not request wake.

## Capability limits and acceptance evidence

The public API document does not establish a verified distinction between the
client's intent to join and background authentication/status polling. Therefore
this integration does not declare protocol wake, and does not wake on arbitrary
TLS or UDP traffic. A real-client trace is required to implement that requirement
without unsolicited starts. No real-client wake or multiplayer certification is
claimed by isolated protocol tests.

The typed HTTPS API client implements state/options/save/shutdown, but wiring a
server-scoped application token into lifecycle and management remains necessary
before declaring player/idle/graceful-stop capabilities. Shared console, files,
backups and power operations remain available through the existing platform.

Real-provider creation, first start, claim/authentication, multiplayer join,
reinstall/migration identity continuity and modded-client compatibility have not
been exercised by this change. No production schema, egg, game files, ports or
container configuration were changed. Migration application and deployment remain
separate infrastructure operations.

## References

- [Developer API document mirror (1.0)](https://gist.github.com/alydevs/5148f83d68d3702aabf6819bf5514b83)
- [Lightweight Query](https://satisfactory.wiki.gg/wiki/Dedicated_servers/Lightweight_Query_API)
- [HTTPS API](https://satisfactory.wiki.gg/wiki/Dedicated_servers/HTTPS_API)
- [Dedicated servers](https://satisfactory.wiki.gg/wiki/Dedicated_servers)
- [FICSIT dedicated servers](https://docs.ficsit.app/satisfactory-modding/latest/ForUsers/DedicatedServerSetup.html)

## Rollback

Revert the application commit before activating new integrations. For an activated
installation, stop new Satisfactory admissions, preserve encrypted TLS identities,
server files and database backup, and review active operations before rolling back.
Do not delete certificates or drop durable mod-operation tables as routine rollback.
