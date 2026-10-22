# Minecraft Players workspace

The Players section belongs to the Minecraft integration. Cards link to
`/servers/:serverId/game/players/:uuid`; the sibling action menu does not nest a
button inside that link. The server sidebar remains on Players throughout the
detail flow. List filters and action receipts stay in the mounted section when
opening a player and returning to the list.

## Identity and appearance

Known identities come from server-owned lists, `usercache.json`, and UUID-named
player files. A saved UUID without a verified name remains viewable; it is not
replaced with a similarly named Mojang account. File modification time describes
the saved snapshot, not the player's last login. Live presence retains the
existing bounded console observation and its explicit unavailable state.

Cards use full-body previews from the existing MCHeads appearance provider.
Hover or keyboard focus lazily loads an unmodified MIT skin renderer and an
original arm-wave animation. Only one visible preview owns a WebGL renderer at a
time. Leaving the card, changing identity, hiding the document, scrolling it out
of view or enabling reduced motion releases the renderer. A static body remains
available without animation; network/WebGL failures fall back to the original
local illustration. No skin texture or reference-site implementation is copied
into the repository.

## Saved player data

The reader derives the world from validated `server.properties` and considers
both directory layouts:

| Data | Older layout | Recent layout |
| --- | --- | --- |
| Player NBT | `<world>/playerdata/<uuid>.dat` | `<world>/players/data/<uuid>.dat` |
| Statistics | `<world>/stats/<uuid>.json` | `<world>/players/stats/<uuid>.json` |
| Advancements | `<world>/advancements/<uuid>.json` | `<world>/players/advancements/<uuid>.json` |

These are observations of saved files, including while the server is running;
they do not claim to be the player's current live inventory. Missing, malformed,
ambiguous and unsupported data remain distinct from an empty inventory or zero
statistics. Unknown item IDs/components are preserved as descriptive metadata.
Inventory editing and crafting are not offered.

NBT decoding uses the same bounded structural preflight as world inspection,
with a smaller compressed-player-file limit. Both legacy item tags and modern
`count`/`components` are read. Modern `equipment` entries are normalized to the
display's equipment slots rather than incorrectly treating armor as absent.
Item images are optional locally prepared resources; identifiers and counts
remain available without them or for modded items.

To prepare those resources explicitly, use Python 3.11+ with Pillow 12.1.1 and
run `python scripts/prepare-minecraft-player-assets.py /path/to/26.1/client.jar`
with an official client you are entitled to use. The script verifies the pinned
release hash, performs no downloads and writes only to the ignored
`games/minecraft/src/ui/assets/local-26.1/` tree. Its separate
`players-provenance.json` records source/output hashes and omitted model reasons.
The verified release produces 997 icons (637 flat items, 360 cube previews) and
8 HUD sprites; 509 complex, conditional or tinted models retain text fallbacks.
Cube previews use a fixed projection, not the complete game renderer. Existing
differing files and symlink output paths are rejected. Preparation grants no
asset redistribution rights and is not an automatic build hook.

The UI loads one optional atlas and its identifier manifest rather than importing
one module for every available item. An explicit `--update-provenance` permits
only a verified additive preparation upgrade; existing artwork is not replaced.

Static inspection of the official 26.3 client (SHA1
`e877b6a07acd633fb3bb475002175cec036e7b87`, DataVersion 5023) confirmed
`LevelResource`, `Player`, `LivingEntity`, `EntityEquipment`, `ItemStackWithSlot`
and `ItemStack` serialization. No Minecraft class was executed. The artifact is
identified by [Mojang's version metadata](https://piston-meta.mojang.com/v1/packages/11f1aefe473eefba0af62e3286c33b692807b2eb/26.3.json).
See [world formats](MINECRAFT-WORLD-FORMATS.md) for the earlier layout transition.

## Actions and permissions

New additional Players grants are `heal`, `feed`, `starve`, `kill`, `gamemode`,
`teleport` and `reset`, alongside the existing operator, whitelist, kick and ban
grants. Each requires Players READ. A UI capability is explanatory only: the API
checks current authorization, installation, lifecycle and identity again at the
effect boundary. These grants do not expose arbitrary console commands or
general file writes.

Live gameplay actions require a supported release, a running server and a fresh
online observation for the server's UUID/name mapping. Commands target a
validated UUID, never an untrusted selector or a name-only substitution.
Teleport coordinates are finite and bounded; teleport preserves the player's
dimension. The response confirms dispatch, not the in-game result. There is no
automatic replay after an uncertain result. Starve applies a bounded-duration
hunger effect rather than claiming to rewrite live food NBT.

Reset requires the entire server to be offline, selected scopes, explicit
confirmation and the current file revision. Under the lifecycle lock it moves
only that UUID's selected files, including its previous `.dat_old` save, to
adjacent `.nickhosting-reset-<operationId>` recovery names. Original bytes are
verified after the move. Requested, confirmed and uncertain audit records retain
the operation and recovery paths. A partial or unacknowledged remote operation
is uncertain, not reported as a successful rollback. Mixed layouts are blocked.
Recovery is deliberate: while offline, inspect the audit record and restore
the selected original paths after resolving any newly created files. No cleanup
of recovery copies is automatic.

## Validation and deployment scope

Tests use isolated PostgreSQL/Redis and provider fixtures. Browser skin fixtures
are original authored textures. No real player was healed, killed, teleported,
reset or otherwise mutated during this implementation. No Pterodactyl/Wings
patch, database migration or Blueprint update is required. The only new browser
runtime dependency is the lazy skin renderer described in
[dependency provenance](M5-DEPENDENCIES.md).

Validation on 2026-10-22:

- Focused parser, world, permission, controller and API unit suites: 131 passed.
- Real isolated DB/runtime HTTP integration: passed. It covers direct action
  grants without Files/Console authority, revocation immediately before dispatch,
  reset versus power locking, partial failure, durable audit and lock release.
- Activity integration: 12 passed, including grouped reset recovery receipts.
- Players browser suite: 16 passed through real application APIs and isolated
  provider fixtures, including EN/IT desktop, 390px and 320px screenshots,
  accessibility, pending/error/missing data, typed actions and scope-specific reset.
- Body renderer: 5 Chromium cases; atlas crops/cache: 2 cases across Chromium and
  Firefox; offline asset preparer: 10 Python cases.
- Full unit run with four workers: 3,944 passed, 1 skipped and 1 existing HTTP
  transfer RSS assertion failed at 131.7 MiB against 128 MiB. The unchanged transfer
  file passed all 51 tests when rerun alone. Earlier timing-sensitive world,
  Gateway and worker cases also passed all 206 tests together with one worker.
- Root and web TypeScript, lint and production build pass. Existing lint warnings
  and the build's large-chunk advisory remain; the skin renderer is separately
  lazy-loaded. Independent code and UX review findings were corrected.

The authorized dev refresh recreated only the frontend container to install the
new dependency. Its environment, mounts, networks and port bindings were
unchanged. Read-only authenticated Firefox checks on an existing server loaded
real player bodies and saved details, with no script errors, page overflow or
mutating requests. Live screenshots remain private; review evidence below uses
isolated fixture identities. No game test assets were created or cleaned.

Rollback reverts the source and restores the previous frontend image if needed.
There is no migration to reverse. Preserve any user-created reset recovery files
and audit receipts; reverting UI code does not restore player data automatically.

Reviewed fixture screenshots:

- [Player cards and action menu](screenshots/m5/minecraft-players-cards-desktop-en.png)
- [Saved player detail](screenshots/m5/minecraft-player-detail-desktop-en.png)
- [Italian desktop](screenshots/m5/minecraft-player-detail-desktop-it.png)
- [Italian 320px detail](screenshots/m5/minecraft-player-detail-320-mobile-it.png)
- [Reset confirmation](screenshots/m5/minecraft-player-reset-confirm-desktop-en.png)
- [Wave renderer fixture](screenshots/m5/minecraft-player-wave-renderer.png)
