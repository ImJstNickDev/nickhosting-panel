# Minecraft Gateway message editor

M5, 2026-10-17. The Minecraft integration supplies an inline editor for the
server-list message and login-disconnect message. The visual reference is Vanilla
26.1 for all server versions; this is an editing preview, not a protocol or
resource-pack compatibility claim. Online traffic still receives the real
server's messages. No game-wire protocol, lifecycle or permission behavior changes. Message context
is transported through negotiated Gateway snapshot metadata.

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
atomic tokens: they display available values but retain placeholders in the
stored template. An empty sample retains its token label while
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
image is contextual, not a navigation action. The editor keeps the entire MOTD editable in a scrollable region. Vanilla 26.1
wraps its MOTD at a fixed 267 GUI pixels and draws only two lines, without ellipsis;
its MOTD width does not vary with the window. The earlier statement that its MOTD
wrapping varies with screen size was incorrect. Both previews now use the authentic 26.1 panorama,
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


## Variables and client layout guides — 2026-10-17

| Placeholder | Value |
| --- | --- |
| `{server}` | Stored server name |
| `{state}` | Localized default description of the current Gateway message state |
| `{eta}` | Positive historical startup estimate remaining, while starting |
| `{version}` | Configured server release, not the connecting client's version |
| `{runtime}` | Integration runtime display name |
| `{address}` | Confirmed assigned DNS connection address, including port when needed |
| `{elapsed}` | Whole seconds since startup began, while starting, even without an estimate |

Metadata is assembled from local server bindings and batched DNS/route queries.
There are no provider requests per ping. Unavailable values render empty; no
private backend/listener address is substituted. Templates are expanded once;
values containing another placeholder are not recursively interpreted. Editor
metadata leaves dynamic clocks empty for hypothetical states, avoiding invented
live estimates and continuously changing save revisions. Empty values retain
placeholder chips while editing; the layout calculation uses their actual empty
expansion, so future runtime values can change the line count.

Core transports bounded optional string `presentation.variables`; Minecraft owns
their meaning and runtime labels. `presentation-variables-v1` is negotiated on
snapshot/control/startup paths. Older Gateway clients receive the previous strict
presentation shape, including in readiness receipts; `completed-sleep-v1` remains
independent. Restart/update Gateway readers to enable new runtime substitutions.
Do not roll an old Core reader back over templates using new variables without
reverting those templates or retaining compatible metadata definitions.

The client reference was inspected directly in the official 26.1 JAR (hash above):
`ServerSelectionList.getRowWidth()` is305; entry content width is301; MOTD width
is301−32−2=267. `OnlineServerEntry` draws `min(lineCount,2)` at Y+12 andY+21.
`StringSplitter` prefers ASCII spaces, consumes separating spaces/newlines, and
otherwise breaks before the overflowing codepoint. Exact width fits; a trailing
newline contributes an empty final line. Glyph advance includes one extra GUI
pixel for bold; italic does not add advance. These rules are implemented in the
small pure layout helper and tested independently from browser layout.

The guide and wire alignment share scalar default-font advances, measured from
the locally prepared bitmap font at9CSSpx (1GUI pixel). These numeric metrics cover
ASCII, Latin-1 and common EN/IT punctuation; unknown glyphs use an approximate
6-pixel advance. No glyph artwork is part of this metric table. Formatting tokens do not consume
width; bold does. Font fallback, unprovided glyphs, browser shaping/resource packs
and other client releases can differ: guides are advisory, never save validation.
The responsive editable surface stays readable; its browser wrapping and atomic
chips are not used to count client lines. The compact line counter exposes the
267-pixel/two-line rule, and a warning appears when the client would omit text.

For disconnection messages, `DisconnectedScreen` uses window width−50GUI pixels,
no line cap and no ellipsis. Its centered stack has ordinary height73+9×lines:
long messages can extend beyond the game window. The separate guide compares that
height with the fixed preview viewport at its font scale, and marks overflow.
The editor itself remains scrollable so no text becomes inaccessible. This is a
preview-window warning, not a universal disconnect-message length limit.


## MOTD alignment

The Minecraft toolbar offers left (default), center and right alignment for the
whole MOTD. This is integration-specific; the shared Gateway has no alignment
logic. Disconnect messages retain the client's own centered layout, whose width
depends on the player's window. There is no justified mode.

Stored templates use integration controls `[align=center]` or `[align=right]`;
left removes them. The declared controls are hidden by the visual editor and
visible in Text codes. They count toward the existing512-character template limit.
Controls are read/removed from the template **before** variable expansion; variable
values cannot become alignment instructions. Multiple recognized controls use the
last value; toolbar selection normalizes them to one prefix. Color resets do not
change the selected alignment.

After expansion, the integration wraps styled glyphs using the same267GUI-pixel
rule as the guide, then pads each physical line with neutral ASCII spaces. Color
and decoration state are restored after padding, including across automatic wraps;
bold spaces therefore cannot distort positioning. Right alignment leaves under4GUI
pixels of remainder; centering leaves under4GUI pixels of center error because
spaces advance4pixels. Unknown glyphs/resource packs remain approximate. Left
alignment retains the previous text bytes apart from removing explicit controls.
Output retains the existing1024-code-unit/surrogate-safe bound. No font download,
provider call, asset load or new polling occurs on a ping.

The responsive writing surface uses CSS alignment to remain editable and readable;
wire output uses spaces and reference-client widths. Full text remains stored and
editable even when the client will only display two lines. Formatting/alignment
controls are never forwarded as control syntax to the Minecraft client.
