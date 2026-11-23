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
outbound traffic, and world generation. Its 24-hour clock plots the observed world time
on a day/night curve. Between status reads the browser advances the clock from the
reported day length and the rate of completed simulation ticks. New readings adjust
its speed gradually. A snapshot shows the recorded time. Openworld a1.2.9 reported a
default day of 1,500 seconds. In an isolated run one real second advanced the game
by about 57.4 seconds at 19.96 ticks/s and 9.2 seconds at 3.20 ticks/s.
**Performance** shows how the latest measured tick time is divided among phases and
how much of the tick budget they used. Select a point in the recent history to compare
metrics at the same instant, or zoom into a shorter interval. A pinned sample stays
available as new readings arrive. The storage bar groups disk usage by category across
worlds. Select a category to see its sizes and file counts by world.
Overview and Performance use the Openworld performance read
permission. **Players** opens a searchable directory with connected players first. The
Online filter shows current connections. Select a player to open a dedicated page
inside the server workspace. A verified account has a permanent profile link. The
browser Back button returns to the directory. Opening a player's detailed statistics,
position and inventory also requires the separate inspection permission. These tabs use
the instance's private HTTP service and work with web publication turned off.

Opening a tab reads its data on demand. Concurrent viewers share native reads. When the
server is offline or its private API is unavailable, each panel shows the time of its
last saved observation when one exists. Opening a tab leaves a sleeping server asleep.
A current player connection provides ping and session controls. NickPanel archives the
native head and body previews while it can verify the connected account. The directory
and profile can show the most recently captured skin after the player disconnects and
when the game is stopped. Viewing saved skins requires player inspection. Openworld
a1.2.9 player saves contain no skin image. A player whose skin has never been captured
gets their first archived preview on a subsequent observed connection.

With inspection permission the same directory also searches saved profiles, including
while the server is stopped. NickPanel joins live and saved records by verified account
identity. Guests and unrelated players with the same display name remain separate.
The directory indexes the last visit reported by the game. A save timestamp identifies
the saved inventory. When a verified player disconnects, their open profile can show
the most recent available save. The character page follows a single verified connection
when that account rejoins. Accounts with multiple simultaneous connections have a
session selector. A prepared command belongs to its original connection. Player
saves can contain the selected hotbar item, equipment and vitals independently.
When a save omits vitals, the profile shows the last observed values for that
verified account on this instance, with their observation time. A player without
either source has no recorded values. The background collector uses the existing
native roster read. Opening a live player profile can also record the values. The inventory uses the configured release's item
catalog where available and retains the native code for unknown saved items.
The catalog covers the 18 Linux releases with verified Gateway support. On a1.2.9
it maps 927 codes. The atlas preserves 326 distinct texture tiles across releases. The
base-color tiles come from the game's default texture pack, licensed CC0-1.0 in
`assets/textures/packs/default/pack.txt`. Items without a matching pack texture use
a category icon. Live names supplied by the game take precedence. The inventory
shows the 36-slot bag and 12-slot hotbar, with armor and gear when reported. The
HUD uses the bundled Nunito and Pixelify Sans fonts under SIL OFL 1.1. In a1.2.9
the hunger gauge includes the saturation reserve on its own 0–50 scale. The air
gauge uses seconds.

The separate **Moderate players** permission enables private messages, kick, game
mode changes, kill, respawn and teleport to coordinates, a connected player or a
checkpoint. The character page keeps each permitted command visible. Commands are
disabled while viewing a save or waiting for an identifiable running session.
NickPanel rechecks the connection
and records the request before sending it. If the game stops responding after dispatch,
the panel reports the uncertain outcome. **Request and view game screenshots** is a
separate grant. It covers requests to the game client and the whole instance's gallery.
A capture can arrive several seconds after the game accepts the request. The gallery
opens private thumbnails on demand. With player inspection, captures also appear in
a player's profile when the worker can match their verified account, connection,
request and written file in the same run. This includes captures requested through
the game's console. The native logger uses local time. The worker uses observations
of the same console stream to reconcile that clock with the file's UTC modification
time before publishing an attribution. Files without sufficient evidence remain in
the server gallery.

**Map** opens the explored terrain of a planetary face in 2D. Isometric and free
flight share the viewport, selected point and terrain cache. Zoom or move toward a
place to see the game's voxel mesh, including overhangs, water and material textures
when provided by the running release. The more distant landscape uses the game's
saved surface at progressively coarser resolutions. In level flight, the renderer
can show recorded terrain out to 8 km. Visible terrain loads first. While the camera
is stationary, a spare request prepares an intermediate surface in every direction
and then the indexed terrain out to the horizon. Areas with only broad survey
bounds are probed locally. A medium or detailed 2D view also prepares voxel
meshes for the nearest confirmed columns. Switching to
3D or turning the camera can use resident geometry on the next draw. The 3D views
join the edges of adjacent recorded surfaces at different heights. Unexplored
gaps remain open. On a device without WebGL 2 the interactive 2D overview remains
available.

Each API process can retain up to 500 MiB of native terrain payloads across all
viewers and servers. Recent reads have 64 MiB and the history has 436 MiB. The
history retains a mesh column and LOD, or a native surface tile spanning multiple
columns, for ten minutes after its last native read or verified reuse. Each entry
expires independently and can be evicted sooner under memory pressure. Reuse
requires a native change cursor covering the entry's entire footprint. An edit
invalidates overlapping assets. A reset or unverifiable history requires fresh data.

In free flight, click the map to capture the mouse. Look around with the mouse
and move with WASD. Hold Shift to fly faster or Space to rise. The map opens in
full screen on browsers that support capturing the flight keys. Hold Ctrl to
descend there, or use Q anywhere. The on-screen hint shows the keys available
in the current session. Esc releases the mouse. Use **Inspect terrain** to
select a point with the cursor, or the on-screen flight controls on a touchscreen.
Right-click the terrain and choose **Stats for nerds** to toggle the map's FPS
counter. With the map focused, Shift+F10 opens the same menu. The counter
reports frames drawn in the last sample and reaches zero when the map is idle.
With WebGL 2, enabling these stats also sends short diagnostic batches to the
NickPanel API. Operators can find a session in the API logs by its trace ID and
the event `openworld.map.renderer`. Samples include the camera column and
orientation, distance-band coverage, render submissions, queue size, and terrain
HTTP outcomes. Closing the stats ends collection.

Layers include checkpoints, live players, creatures by species and active factory
columns with their respective permissions. With both map and Seed Inspector access,
**Seed preview** fills unexplored areas with procedural terrain. Biome colors and
catalogued deposits or structures can be selected separately. Generation starts on
request. A selected location distinguishes recorded ground, indexed columns and
predictions. Predicted locations do not establish the state of a save.

For a sparsely explored face the initial camera fits the main cluster. **Show full
index** includes remote outliers, including coordinates the game can report outside
its playable terrain. Changes from the game's cursor invalidate affected regions.
The map reads a running instance through its private service even when public
dashboard access is off. On a1.2.9 an isolated headless server acknowledged a terrain
edit from its console while its map API continued to return the old geometry after
a save and restart. The panel displays the geometry supplied by that API.

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

**Rules** shows the difficulty, game roles and their permissions, protected zones,
planetary borders and bans on the running server. Access to this list is an
explicit subuser permission. Two additional grants allow changing difficulty and
lifting a ban by account UUID. The panel confirms changes by reading the resulting
game state and keeps a receipt for each request. A repeated request with the same
ID cannot send the command twice. On a1.2.9 the game's ban command identifies a
connected player by name. Operators who can send console commands can use the
server console for that operation.

**Seed Inspector** has its own explicit grant. Inside NickPanel it shows the actual
seed, spawn, world dimensions, planets, biomes, materials, structures and tree
species from the private service. Opening the panel catalog does not generate
terrain. If the dashboard hostname is published, **Open Seed Inspector** opens
the game's native renderer on that host. A subuser with only the seed grant can
explore generated terrain, including unexplored areas, and cannot read the native
player roster or issue administrative commands. The broader native dashboard
permission retains its administrative access. Seed and rules reads leave sleeping
servers asleep.

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
