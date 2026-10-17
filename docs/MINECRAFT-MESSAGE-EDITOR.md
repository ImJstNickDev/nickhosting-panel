# Minecraft Gateway message editor

M5, 2026-10-17. The Minecraft integration supplies an inline editor for the
server-list message and login-disconnect message. The visual reference is Vanilla
26.1 for all server versions; this is an editing preview, not a protocol or
resource-pack compatibility claim. Online traffic still receives the real
server's messages. No network/protocol, lifecycle or permission behavior changes.

## Ownership and behavior

`TrustedGameUiModule.gatewayMessageEditor` names an optional, bundled editor.
The shared application resolves that key through its compiled registry. API JSON
cannot import executable UI. Unregistered modules and unsupported channel sets
retain the generic editor. Minecraft's browser adapter lives under
`apps/web/src/integrations/minecraft/`; its declaration, translations and asset
references belong to `games/minecraft/src/ui/`.

The application owns state selection, drafts, revision-checked saves, inheritance,
errors and authorization. The integration renders the two Minecraft surfaces and
compact formatting tools. Clicking the rendered message edits it directly.
Colors and styles apply to a selection or the insertion point. Variables are
atomic tokens: they display sample values but retain `{server}`, `{state}` or
`{eta}` in the stored template. An empty sample retains its token label while
editing. These values do not represent live player counts or latency.

Text codes provides the exact serialized template when needed. Reset removes the
local override. An empty draft stays empty while editing and inherits defaults
after saving, matching the existing API contract. Undo/redo is local to the
mounted visual field; switching state or source mode starts a new field history.
Paste/drop imports plain text only. The editor preserves Unicode and enforces
serialized template limits, including formatting and variable tokens. No HTML is
stored or rendered from user input. Save disables editing until the revision is
refreshed. Read-only access retains selection/copy but cannot change messages.

## Minecraft reference and optional local assets

The official 26.1 client was inspected with `javap`, specifically
`ServerSelectionList.OnlineServerEntry`, `DisconnectedScreen`, `Screen` and
`BitmapProvider.Definition`; the complete multiplayer frame was checked against
`JoinMultiplayerScreen`. No decompiled Minecraft source is committed.

Client artifact:
https://piston-data.mojang.com/v1/objects/191771837687b766537a8c4607cb6fad79c533a1/client.jar

SHA1: `191771837687b766537a8c4607cb6fad79c533a1`.

Relevant GUI measurements are a 32×32 server icon, text offset35, MOTD offset12,
9-pixel line height and a 10×8 ping sprite. The disconnection screen centers its
vertical stack with10-pixel cell padding and a 200×20 return button. The web
preview uses a readable enlarged scale and responsive sizing. Its return-button
image is contextual, not a navigation action. The editor allows more than the
client's two visible MOTD lines so long messages remain editable; client wrapping
varies with screen size. Both previews now use the authentic 26.1 panorama,
blurred and darkened behind the text. It is a static forward cubemap face, not
the continuously rotating 3D scene. The multiplayer preview includes the title,
list overlay, separators, selection frame and both footer button rows. These
buttons are noninteractive scenery, excluded from the keyboard/accessibility tree;
player counts use unknown markers rather than invented live values.

The client JAR contains one-pixel panorama placeholders. The real images come
from Mojang's external asset index 30, SHA1
`191104515165d806db18f954694a4407a1b0ccd9`; the forward face SHA1 is
`4a8493454b4307e330501892058541ed0bf228da`. The first editor iteration missed
these external resources and displayed only a dark overlay; that omission is
corrected here.

Unobfuscated executables do not change Minecraft's license:
- https://www.minecraft.net/en-us/article/removing-obfuscation-in-java-edition
- https://www.minecraft.net/en-us/eula
- https://www.minecraft.net/en-us/usage-guidelines

Original textures and the derived bitmap font are **not committed or licensed by
this repository**. Optional local preparation accepts an official client jar that
the operator is entitled to use. It is explicit, never a startup/build download:

```bash
python3 -m venv .codex/local/minecraft-ui-font-tools
.codex/local/minecraft-ui-font-tools/bin/pip install fonttools==4.61.1 Pillow==12.1.1
.codex/local/minecraft-ui-font-tools/bin/python \
  scripts/prepare-minecraft-ui-assets.py /path/to/26.1/client.jar \
  --asset-index /path/to/assets/indexes/30.json \
  --asset-objects /path/to/assets/objects
```

The script pins the official jar size and SHA1, extracts only named resources,
and writes source/output SHA256 provenance plus the original license notice to
`games/minecraft/src/ui/assets/local-26.1/` (gitignored). It refuses symlinked or
different existing outputs. It performs no network requests, provider actions or
infrastructure changes. Identical reruns are safe. To extend an existing locally
prepared set, add `--update-provenance`; it permits only an additive manifest
update with the same previously recorded source/output hashes. Existing artwork
cannot be replaced with this flag. Without the two asset-index arguments, only
JAR-contained resources are prepared and the panorama remains unavailable.

The font converts actual bitmap pixels from Vanilla's default providers into
browser-readable WOFF contours, retaining variable advances and accented glyphs.
It contains2,414 glyphs; other characters use the browser fallback. Browser
rasterization and synthetic bold/italic can differ slightly from Minecraft.
No generated artwork or substitute downloaded pixel-font is used.

A checkout without these resources remains editable with browser font/plain
background fallbacks; it does not have the authentic preview assets. Vite uses
locally present resources and includes them in a build when present. **Preparing
assets locally does not grant redistribution rights:** review that boundary before
sharing a built artifact containing them. This change makes no new repository
licensing decision and does not authorize production deployment.

The two editors share an equal-height, side-by-side desktop layout. Narrow
containers stack them vertically; client chrome adapts to each preview width
independently of the browser viewport.

## Verification scope

Model tests cover templates, bounded selection operations and formatting. Browser
journeys use actual NickHosting handlers and isolated database/provider fixtures:
editing, save/reload, EN/IT, desktop/mobile, generic fallback and accessibility.
They do not change real servers or establish additional Minecraft protocol support.
