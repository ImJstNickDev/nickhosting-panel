# Modscope — Minecraft's Fileman viewer

Modscope is the first integration-owned ViewerEngine renderer. Its descriptor,
parser, UI, styles and English/Italian messages live in
`games/minecraft/src/viewers/`; Fileman owns the surrounding path, Open with,
download, Escape navigation, preferences and source authorization.

## Selection and presentation

On Minecraft servers, JARs under `mods/` (including version subdirectories and
`.jar.disabled` / `.jar.pending`) suggest Modscope before Atlas. Other JARs keep
their ordinary viewer. Saved server/game/global choices still win. Open with can
explicitly choose either renderer, including inspection outside `mods/` or inside
another archive; the viewer's Open archive action returns to Atlas. Refresh uses
the existing saved Fileman viewer session.

The view displays the embedded icon, name, ID, version, description, authors,
license, declared environment, external links and dependency requirements. A JAR
with multiple descriptors or multiple declared mods exposes a compact selector.
Dependencies retain their version expressions, required/optional/conflict kind,
and Quilt's compound/conditional rules. No provider search, installation status,
installed dependency resolution or gameplay compatibility is inferred from this
metadata. Missing environment declarations remain “Not declared”.

Unsupported or absent metadata keeps Open archive available. Malformed supported
descriptors are identified in File metadata, without discarding other valid
descriptors. Read failures offer retry. There is no editing or Java execution.

## Supported descriptors and primary references

| Family | Embedded file | Interpretation |
| --- | --- | --- |
| Fabric | `fabric.mod.json` | Schema 0 and 1 use their respective fields. |
| Babric / Legacy Fabric | `fabric.mod.json` | Same metadata format; the file alone does not prove which Fabric-derived loader is in use. Displayed as Fabric. |
| Quilt | `quilt.mod.json` | `quilt_loader` metadata, contributor names, environment and structured dependencies. |
| Forge | `META-INF/mods.toml` | Multiple `[[mods]]`, properties and manifest version substitution. |
| NeoForge | `META-INF/neoforge.mods.toml` | Modern descriptor; older versions also used `mods.toml`. |
| Older Forge | `mcmod.info` | Root array or `modList` wrapper; these declarations can be overridden by runtime annotations. |

Sources inspected for this implementation:

- [Fabric descriptor reference](https://docs.fabricmc.net/develop/loader/fabric-mod-json)
  and [historical schema-0 parser](https://github.com/FabricMC/fabric-loader/blob/master/src/main/java/net/fabricmc/loader/impl/metadata/V0ModMetadataParser.java).
- [Babric example descriptor](https://github.com/babric/babric-example-mod/blob/b1.7.3/src/main/resources/fabric.mod.json).
- [Quilt descriptor specification](https://github.com/QuiltMC/rfcs/blob/main/specification/0002-quilt.mod.json.md)
  and [loader implementation](https://github.com/QuiltMC/quilt-loader/blob/develop/src/main/java/org/quiltmc/loader/impl/plugin/quilt/StandardQuiltPlugin.java).
- [Forge mod files](https://docs.minecraftforge.net/en/latest/gettingstarted/modfiles/)
  and [legacy metadata parser](https://github.com/MinecraftForge/MinecraftForge/blob/1.12.x/src/main/java/net/minecraftforge/fml/common/MetadataCollection.java).
- [NeoForge mod files](https://docs.neoforged.net/docs/gettingstarted/modfiles/)
  and [the 1.20.4 descriptor](https://docs.neoforged.net/docs/1.20.4/gettingstarted/modfiles/).

`mods.toml` without an identifying Forge/NeoForge dependency is labeled
“Forge / NeoForge”, since the filename is shared historically. Dependency `side`
and Forge `displayTest` do not establish the whole mod's environment. Quilt's
development-only `quilt.mod.json5` is recognized as an unsupported descriptor,
not presented as ordinary installed-mod support. Other unimplemented loader
formats remain accessible through Atlas.

## Shared transport and bounds

The SDK supplies `GameViewerSource`, `GameViewerProps` and `GameViewerHost`, plus
an optional compiled `matches(source)` suggestion function. These are statically
reviewed modules, not executable descriptors from the API. A generic host supplies
translation, bounded archive listing/member reads and switching to another known
viewer. No game package imports WebPanel internals or creates a provider adapter.

The host reuses Atlas's metadata query cache and the existing authenticated
archive/member endpoints. The backend already retains a ZIP central directory
and reads selected compressed members through its pooled SFTP transport. Only
root/META-INF metadata, an optionally needed manifest, and the selected icon are
requested; embedded JARs and Java classes are not scanned. Partial listing pages
use filtered metadata queries rather than silently concluding a descriptor is
absent. Descriptor reads run together after discovery; manifest reads are lazy.

Metadata is bounded to 256 KiB per descriptor / 1 MiB aggregate, a manifest to
64 KiB, and displayed mod/dependency collections to 256. The generic host caps
individual reads at 8 MiB. Icons use at most 1 MiB, raster signatures and a
4,194,304-pixel / 4096-pixel dimension bound. SVG/HTML icons and external artwork
are not loaded. Description text is inert; links accept HTTP(S) without embedded
credentials and open with `noopener noreferrer`. Closing or switching the viewer
aborts its reads and revokes icon Blob URLs. No game files are extracted or written.

For an explicitly selected archive with an otherwise unknown filename, the
shared archive reader can recognize a ZIP signature and use its existing ZIP
parser. Ordinary recognized formats have no extra signature read. This permits
disabled/staged JAR inspection without Minecraft-specific suffix logic in the
API or a new Blueprint endpoint.

The renderer and parser are lazy browser modules. React and the existing TOML
parser resolve through the WebPanel's shared dependencies. The runtime build also
handles `.tsx` package exports; no database schema or deployment configuration
changes are required. Source revert is the rollback; existing preferences for an
unavailable renderer fall back through the established registry behavior.
