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

Inside NickPanel, **Overview** shows player counts, TPS, memory, current inbound and
outbound traffic, and world generation. **Performance** adds tick timings, the game's
recent metric history, chunks and storage. Both use the Openworld performance read
permission. **Players** lists the current roster. Opening a player's detailed statistics,
position and inventory also requires the separate inspection permission. These tabs use
the instance's private HTTP service and work with web publication turned off.

Opening a tab reads its data on demand. Concurrent viewers share native reads. When the
server is offline or its private API is unavailable, each panel shows the time of its
last saved observation when one exists. Opening a tab leaves a sleeping server asleep.
Individual player details and skins are available only during a live session.

In **Players → Saved**, users with the inspection permission can search the server's
saved profiles even when the game is stopped. The directory reads the configured
data directory and identifies a record by the account ID stored in the file. It
shows the save time and distinguishes saved inventory from the current live inventory.
A verified account in a live player card links to its saved profile by UUID.

The separate **Moderate players** permission enables private messages, kick, game
mode changes, kill, respawn and teleport to coordinates, a connected player or a
checkpoint. Commands target a running session. NickPanel rechecks the connection
and records the request before sending it. If the game stops responding after dispatch,
the panel reports the uncertain outcome. **Request and view game screenshots** is a
separate grant. It covers requests to the game client and the whole instance's gallery.
A capture can arrive several seconds after the game accepts the request.

**Map** opens the selected world's explored terrain. Select a planetary face to pan or
zoom. The overview uses explored columns, and the detailed view loads just the
surface tiles in view. Water and elevation come from the saved or active terrain.
Unknown ground remains blank. If a sparsely populated face has isolated entries
far from the explored area, the map opens on the main cluster. **Show full index**
includes the distant entries. The game can list a column outside its playable face;
such a column has no surface to draw.
The map follows the game's change cursor while open
and loads a new index if the game resets that cursor. It reads a running instance
through the private API, including when public dashboard access is off.

Map readers can find player-visible checkpoints by world and name. The separate
**Manage checkpoints** grant also reveals administrative checkpoints and the notes on
all checkpoints. It enables
creation, editing and deletion. A checkpoint can be placed at map coordinates or
at the location opened from a live player card. The game stores its note, location
and visibility. NickPanel checks the checkpoint revision before editing or deleting it.

Player markers require both roster and inspection access in addition to map access.
Open a marker to see its current player card, or use **Show on map** on the card to
return to the player's position. A reconnected player's previous marker cannot open
the new session. The existing moderation grant still covers teleport to the game's
checkpoint destinations.

**Factories** uses the performance permission. It shows the factory simulation's
measured and target frequency, step time (including p95), power production and
consumption, battery storage, and items and fluids in transit. The most expensive
columns link to their location when the reader also has map access.

In **Map**, select **Creatures** to see the active population by species and the
number of items on the ground in the selected world. Enable creature positions to
request up to 256 markers. The population totals cover the active simulation even
when the map displays a sample. Creatures stored in a save can be outside this
population.

Select **Space** to explore the celestial system and its checkpoints. A body with a
terrain map can be opened directly. Orbital player positions require roster and
inspection access. Administrative checkpoints require the checkpoint management
permission. The orbital view omits checkpoint notes. Opening the terrain map alone
does not request the factory, creature or orbital feeds.

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
