# Minecraft card artwork

`minecraft-landscape.svg` is an original voxel landscape drawn for NickHosting
M5 on 2026-10-09. It uses only authored SVG geometry and colors. No Minecraft,
Mojang, Microsoft, texture-pack, stock-art or third-party logo assets were copied.
It is an illustrative game card, not an official Minecraft mark or endorsement.

This records provenance; it does not add or change a repository license. The
application bundles this local asset through the trusted first-party Minecraft
UI module. API responses cannot supply executable modules or remote artwork URLs.

`fabric-workshop.svg` is original SVG geometry authored for the Fabric runtime
card on 2026-10-19: a voxel loom, woven cloth and thread spool. It does not copy
Fabric's logo, Minecraft textures or third-party artwork. The integration supplies
its bundled asset identifier through the common choice-card contract.

`player-placeholder.svg` is original eight-by-eight SVG geometry authored for the
installer on 2026-10-10: a brown-haired voxel face with white eyes, used as the
requested Herobrine-style fallback. No skin texture or remote avatar was copied.
Live player previews use the trusted module's MCHeads URL and send the entered
player name to that service; they are decorative and never identity proof.

`minecraft-properties.svg` is original SVG geometry authored on 2026-10-12:
a small grass-topped voxel block with a configuration gear. It contains no copied
game textures or logos. The integration contributes this decorative file icon
through its trusted UI descriptor; the shared file manager has no Minecraft check.

`player-body-placeholder.svg` is original voxel geometry authored on 2026-10-22:
a neutral full-body figure with a teal shirt and dark trousers. It contains no
copied Minecraft skin or user artwork. Full-body and animated previews use the
trusted module's MCHeads skin URLs and send the player's UUID to that
service. They are decorative, never identity proof. Animation uses skinview3d
3.4.2 (MIT), loaded for visible previews and reused for hover/focus waves; its Three.js and skinview-utils runtime
dependencies are also MIT. No remote player skin is stored in this repository.

Optional player HUD resources are prepared offline by
`scripts/prepare-minecraft-player-assets.py` from the same verified, entitled
Minecraft 26.1 client jar as the optional item artwork. Eight original HUD
sprites retain their native dimensions and pixels. The ten experience-level
digits use the client's `font/include/default.json` character mapping and
`textures/font/ascii.png` 5×7 bitmap glyphs. Each is tinted XP green (`#80ff20`)
and given a one-pixel black outline in the four cardinal directions, producing
a transparent 7×9 PNG. The UI scales these with nearest-neighbor sampling;
adjacent outlined digits can overlap their outline column to retain the native
six-pixel glyph advance. These are derivative local resources, not authored or
redistribution-cleared repository artwork.

Generated PNGs and source/output hashes remain in the gitignored `local-26.1/`
tree. `--update-provenance` permits additive digit metadata and source/output
hashes while rejecting changes to any existing artwork or metadata. No game
font, texture, client jar or prepared digit PNG is committed to this repository;
the optional preparation step grants no redistribution permission.
