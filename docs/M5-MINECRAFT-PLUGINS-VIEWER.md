# Plugscope — Minecraft plugin inspection in Fileman

Plugscope is a read-only game viewer owned by `games/minecraft/src/viewers/`,
alongside [Modscope](M5-MINECRAFT-MODS-VIEWER.md). It is not a Fileman builtin.
Minecraft registers its descriptor, contextual suggestion, lazy parser/renderer
and English/Italian messages through the existing ViewerEngine integration API.

## Selection and presentation

JARs below `plugins/`, including `.jar.disabled` and `.jar.pending`, suggest
Plugscope. Other JARs keep their current suggestion, including Modscope under
`mods/`. Personal server/game/global defaults take precedence. Open with can
explicitly select Plugscope outside the plugin directory or for a JAR inside an
archive. Open archive returns to Atlas; Fileman continues to own the path,
download, Escape navigation and refresh restoration.

The view shares Modscope's header, responsive layout, loading/error/retry states,
descriptor selector and source details. It presents name, version, description,
authors, links, declared API/platform, load configuration and dependencies.
Commands and permissions are inspectable without filling the whole page with
rows. Multiple descriptors remain individually selectable; the Paper declaration
is presented first when a JAR also contains a Bukkit declaration.

These are file declarations, not installed-server state or a compatibility test.
An API version is not a complete list of supported Minecraft releases. A Folia
flag is the author's declaration. Commands registered dynamically cannot be
enumerated from metadata; in particular Paper plugins register commands in code.
The formats below have no standard embedded-icon field, so Plugscope uses its
own plug mark rather than guessing artwork or contacting a catalog.

## Descriptor formats

| Format | Root descriptor | Interpretation |
| --- | --- | --- |
| Bukkit / Spigot | `plugin.yml` | Plugin identity, API, authors, required/soft dependencies, load order, commands and permissions. Also used by Paper for Bukkit plugins. |
| Paper | `paper-plugin.yml` | Paper identity, bootstrapper/loader, Folia declaration and bootstrap/server dependency stages. Commands are not inferred from this descriptor. |
| BungeeCord | `bungee.yml` | Proxy identity and `depends` / `softDepends` declarations. |
| Velocity | `velocity-plugin.json` | Generated identity, entry point and required/optional dependencies. |

Recognizing proxy metadata does not enable a proxy runtime in NickHosting.
Historically BungeeCord can also read `plugin.yml`; that filename alone does not
prove a proxy target. Plugscope labels that descriptor Bukkit / Spigot and makes
no gameplay compatibility claim. No bytecode, annotations or nested JARs are
scanned to infer missing declarations.

## Shared transport and limits

Both Minecraft viewers use `jar-descriptors.ts`: one cached root listing, a
filtered lookup only if an indexed page is incomplete, then parallel reads of
the known descriptors that exist. Plugscope never reads class files or downloads
the entire JAR into the browser. Fileman's existing archive index, pooled storage
transport, authorization, byte budgets and cancellation remain authoritative.
There is no new API, provider connection, Blueprint endpoint or database table.

Each descriptor is limited to 256 KiB, with a 1 MiB aggregate read budget. Text
is decoded as UTF-8; malformed descriptors do not hide other valid declarations.
The existing `yaml` package parses YAML without executable tags, with bounded
alias expansion and collections. Displayed text stays inert; external links are
HTTP(S), without embedded credentials, and open with `noopener noreferrer`.
No game files are written or extracted and no plugin code is executed.

The YAML dependency is declared directly in the Minecraft package, using the
same version already present in the WebPanel. An existing dev image needs that
workspace dependency installed; any Vite image update follows the normal scoped
activation approval. No game-server or backend migration is required.

## Primary references

- [Bukkit plugin.yml](https://docs.papermc.io/paper/dev/plugin-yml/)
- [Paper plugins and dependencies](https://docs.papermc.io/paper/dev/getting-started/paper-plugins/)
- [Paper descriptor precedence](https://github.com/PaperMC/Paper/blob/main/paper-server/src/main/java/io/papermc/paper/plugin/provider/type/PluginFileType.java)
- [Folia declaration](https://docs.papermc.io/paper/dev/folia-support/)
- [BungeeCord descriptor](https://github.com/SpigotMC/BungeeCord/blob/master/api/src/main/java/net/md_5/bungee/api/plugin/PluginDescription.java)
- [Velocity serialized descriptor](https://github.com/PaperMC/Velocity/blob/dev/3.0.0/api/src/ap/java/com/velocitypowered/api/plugin/ap/SerializedPluginDescription.java)

## Validation

The focused unit/host/registry suite passes 69 tests, including existing Modscope
metadata/icon regressions, the shared Fileman archive transport and personal
viewer preference precedence. TypeScript checks for the monorepo and WebPanel,
the production frontend build, scoped Biome checks and the compiled EN/IT catalog
check pass. The build retains its existing large-chunk warnings.

```bash
pnpm exec vitest run games/minecraft/src/viewers/plugin-metadata.test.ts games/minecraft/src/viewers/mod-metadata.test.ts games/minecraft/src/viewers/mod-icon.test.ts games/minecraft/src/viewers/index.test.ts apps/web/src/features/viewer-engine/game-viewer-host.test.ts apps/web/src/features/viewer-engine/core/registry.test.ts packages/game-sdk/src/viewers.test.ts
pnpm typecheck
pnpm i18n:check
pnpm build
```

Browser validation uses the actual Fileman and compiled Minecraft viewer with
isolated fixture metadata at the archive HTTP boundary. It does not install
plugins or validate their execution on a real Paper/Spigot/proxy server.

All 11 Plugscope Firefox browser cases and the 9 existing Modscope browser
regressions pass. They cover context selection, refresh, personal defaults,
multiple descriptors without rereads, proxy formats, bounded inventories, nested
archive selection, malformed/absent metadata, retry, cancellation and inert text.
Desktop EN and 320px mobile IT checks have no horizontal overflow or Axe findings.
Independent code/configuration and UX/content review is complete.

```bash
pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/minecraft-plugin-viewer.browser.test.ts apps/web/tests/minecraft-mod-viewer.browser.test.ts
```

Reviewed screenshots:

- [Desktop, commands expanded](screenshots/m5/plugscope-desktop-en.png)
- [Mobile Italian](screenshots/m5/plugscope-mobile-it.png)
- [Paper and Bukkit declarations](screenshots/m5/plugscope-multiple-en.png)
- [Loading](screenshots/m5/plugscope-loading-en.png), [absent metadata](screenshots/m5/plugscope-empty-en.png), [transport error](screenshots/m5/plugscope-error-en.png)

The Owner-approved Vite-only development activation completed on 2026-10-21,
from implementation commit `71bbbec`. Only Vite was recreated; all 11 dev
services and Panel/Wings were healthy afterward, with the other 12 containers'
IDs, images and start times unchanged. Mounts, network attachments and published
ports were preserved. No migration or Blueprint update was needed.

A read-only Firefox smoke test opened an existing WorldEdit plugin through the
actual Fileman archive endpoints: metadata and viewer modules returned HTTP 200,
HTTPS and WSS HMR worked, no JavaScript errors or mobile overflow occurred, and
no mutating application requests were made. No game data was created, changed
or removed. The prior Vite image and prior shared build tag remain available for
the approved scoped rollback; private activation evidence is retained locally.

## Rollback

Revert the Plugscope code/dependency changes while preserving existing file data
and viewer preferences. A saved preference for an unavailable viewer uses the
existing registry fallback. If its dev image was activated, restore the recorded
previous Vite image using the approved scoped rollback. No database downgrade,
game-file cleanup or provider modification is involved.
