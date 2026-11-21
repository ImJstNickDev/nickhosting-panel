# Openworld dedicated server

The first-party Openworld module lives in `games/openworld`. The wizard creates a Linux x64
dedicated server and pins the chosen version, ZIP size and SHA-256 in its server profile.
Accounts are verified online by the game by default.

## Runtime setup

In Pterodactyl Admin, create an Openworld nest and import
[the PTDL v2 egg](../games/openworld/egg/egg-openworld.json). The egg runs on Debian Bookworm.
In the NickHosting Owner workspace, register Openworld, enable the runtime mapping for the
target node, use the integration's image, and retain the imported egg's startup command.
The mapping has two allocations:

| Role | Transport | Visibility | Egg variable |
| --- | --- | --- | --- |
| game (primary) | UDP | Advertised IP or hostname with its allocated port | SERVER_PORT |
| dashboard | TCP | Private backend only | OW_WEB_PORT |

The allocator must be able to reserve **different port numbers** for the two roles.
The node needs a private backend pool even when gameplay uses direct delivery. Direct mode
also needs an explicitly configured advertised endpoint. Openworld uses an address and
port. No SRV or hostname-based multiplexing is declared.

The version step lists releases from the synchronized Linux x64 catalog. The selected
node determines which releases the user can install. A Gateway-only node can install
releases with verified UDP support. A node with direct delivery can also install
other releases supported by the egg. NickHosting checks available allocations when
the user submits the request.

For standalone installations, the egg can retrieve the requested release from the publisher.
NickHosting issues a short-lived URL for the pinned ZIP during provider handoff.
The upstream bearer stays in NickHosting. The installer verifies the package, stages its
contents, and preserves instance configuration, identity and saved worlds on reinstall.
After changing the installer or launch helper, regenerate the JSON using
`scripts/dev.sh pnpm exec tsx games/openworld/egg/export.ts`.

## Catalog and credentials

Open **Owner → Integrations → Openworld → Versions** to see the catalog used by
the creation wizard. Use **Sync versions** to fetch the current releases. A successful sync
replaces the saved catalog. An upstream failure leaves the last successful sync intact.

Under **Owner → Settings → Credentials**, set the global Metiva access token.
Under **Owner → Integrations → Openworld → General**, an integration token overrides it.
Removing the override restores inheritance. The fields are write-only. Container overrides use the
`NH_DEV_` or `NH_PROD_` prefix for their deployment. Both scopes are listed in
[.env.example](../.env.example).

The Linux x64 catalog comes from Metiva first. If unavailable, NickHosting reads the
publisher's paginated manifests. Downloads from either source must match the selected
release's size and SHA-256. If another source has different bytes for that version, the
install fails. The signature field in the publisher's catalog is outside this verification.
The mirror and publisher can expose different lists of releases.

Run `node games/openworld/prepare-artwork.mjs` to cache the two official graphics locally.
The web UI serves those local files; the public Git repository contains the retrieval
script and pinned checksums. The game and wizard remain usable without the graphics.

## Dashboard and gameplay

Openworld uses one custom DNS name per server. Players enter the name and the assigned UDP
port. Browsers use the same hostname over HTTPS. The advertised IP must deliver the game
port to the game endpoint and TCP 80/443 to Nginx Proxy Manager (NPM). A server that
previously used the shared name can select a personal subdomain from Network.

The private HTTP service starts with the game. Each new instance receives a random native
credential. Existing managed instances prepare a private credential at their next managed
start. The panel can read server metrics while web publication is disabled. The public toggle
operates independently of the game process. Opening the website leaves a sleeping server asleep.

In **Owner → Settings → Credentials**, save the NPM API URL and the Let's Encrypt contact
email, then enter the NPM bearer token. The NPM account needs access to manage its proxy hosts
and certificates. Saving the token queues existing active personal Openworld names. New DNS
assignments queue automatically. The worker prepares an individual certificate even while the
dashboard is private. Unpublishing removes the web route and retains its certificate while
the name is assigned. HTTP-01 validation requires public DNS and TCP 80 for each name.
Each published name has its own Proxy Host, certificate, forced HTTPS, HTTP/2, HSTS, common
exploit protection and WebSockets support in NPM. The forward destination is the deployment's
web ingress on port 8081. Its dedicated internal API listener uses port 3002.

**Publish web dashboard** defaults to off. The server owner can publish the assigned hostname
and grant a subuser **Access the Openworld administrative dashboard**. This gives full native
administration for that instance, including console commands. Project roles do not inherit it.
The dashboard and Seed Inspector check the active NickPanel session and the instance grant.
Signing out, revoking the grant, and unpublishing the hostname deny subsequent requests.
The browser uses a separate, host-only dashboard cookie. Native credentials stay on the
private side of the proxy.

The verified Linux builds are a1.0.11–a1.0.13, a1.1.0–a1.1.3, a1.2.0–a1.2.9 and
pre-a1.2.0-1. The a1.0.10 package requires glibc 2.38 and cannot run on the Debian
Bookworm image used by this egg. When that release is present in the catalog, the
wizard shows the runtime requirement beside its disabled option.

For supported releases, the Openworld Gateway module verifies readiness using a correlated UDP
server-information response from the assigned backend, checks the release and reads player
counts. Once ready, the existing UDP data plane forwards traffic. Other releases use
direct delivery when configured. Wake is manual.

With an idle timeout enabled, a Gateway-routed server can sleep after fresh status samples
report zero players throughout that interval. Active UDP sessions and recent join or
gameplay traffic interrupt the timer. Opening the game’s server list leaves the timer running.
Missing or invalid samples clear the interval. The Gateway checks again before requesting
a stop. Idle detection uses the game protocol independently of web publication.

The a1.2.0–a1.2.9 and pre-a1.2.0-1 servers exited cleanly on the egg's `stop` command
in isolated tests. Some a1.0.x and a1.1.x servers began saving on shutdown but
remained running past the test deadline. The a1.1.3 process was still alive after
55 seconds with its saved world files on disk.
