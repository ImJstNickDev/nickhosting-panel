# M5 browser dependency and artwork provenance

The project retains its existing repository licensing status. M5 adds no
open-source license for NickHosting and copies no Prism or proprietary game code.

The lockfile pins React/React DOM 19.3.0, React Router 8.4.0, TanStack Query 5.104.1,
Lingui 6.9.1 and Vite 8.3.4. Existing Better Auth/passkey 1.7.7 remains the identity
library. `@noble/hashes` 2.4.0 supplies incremental SHA-256 in a bounded upload
worker. These browser dependencies' installed license metadata/text is MIT.
The production build emits `THIRD-PARTY-NOTICES.md` from the actual main bundle;
`THIRD-PARTY-WORKER-NOTICES.txt` preserves the separate SHA-256 worker's MIT notice.
Deploy/distribute both notice files together with the complete build directory.
No dependency source was patched or vendored into application code.

Playwright 1.64.0 is an Apache-2.0 development/test dependency. Axe tooling 4.13.0
and Lightning CSS 1.33.0 report MPL-2.0 in installed package metadata; they are
unmodified test/build tools, not part of the distributed application bundle.
`scripts/dev.sh pnpm licenses list --json` records the installed dependency graph;
bundle notices record what the browser actually receives. Keep the lockfile and
notices review in future dependency upgrades, including any new worker imports.

The [Minecraft artwork provenance](../games/minecraft/src/ui/assets/PROVENANCE.md)
records the original illustrative landscape. System fonts are used. No stock
image, proprietary logo, remote tracking image, marketing template or copied
Minecraft texture is bundled. Each trusted first-party game module must supply
its artwork/provenance; the shared card renderer supplies cropping, labels,
fallbacks and accessibility.

## Minecraft player bodies

`skinview3d` 3.4.2 is pinned and dynamically imported only for an active body
preview. Its renderer dependencies (`three` and `skinview-utils`) are MIT;
upstream code is unmodified. Preserve their notices in the generated bundle
license report. The arm-wave motion is original application code; no animation
or markup was copied from the reference site. See the
[upstream renderer](https://github.com/bs-community/skinview3d).

The existing MCHeads provider supplies UUID-addressed body PNGs and raw skin
PNGs ([API documentation](https://mcheads.org/docs)). Requests omit credentials
and referrers. This is an external appearance request, not a source of player
identity or permission authority. Static previews and the authored SVG fallback
work without WebGL; reduced motion disables the animated renderer. User skins
and locally prepared Minecraft item textures are not repository-licensed assets
and are not committed to source control.

The integrated production build emits a separate 524.97 kB / 130.80 kB gzip renderer
chunk. Its license inventory includes skinview3d 3.4.2, skinview-utils 0.7.1 and
three 0.156.1. The optional item atlas is fetched by inventory images, not on the
initial Players card list; SVG fragment crops and one-fetch caching are verified
in Chromium and Firefox.

## Wave streaming decoder

`mediabunny` 1.61.4 is pinned for the browser waveform Worker. It supplies parsers
and native WebCodecs decoding; only WAVE, MP3, Ogg, FLAC, MP4/M4A and ADTS inputs
are imported, with no encoder/WASM extension. Its two transitive dependencies
are TypeScript declarations (`@types/dom-webcodecs` and
`@types/dom-mediacapture-transform`), not runtime decoders.
The unmodified library is MPL-2.0. Distribute
`THIRD-PARTY-WORKER-NOTICES.txt`, which contains the full license and exact
[corresponding source](https://github.com/Vanilagy/mediabunny/tree/v1.61.4),
with the app. No upstream source was patched and this does not license the
NickHosting repository. Worker notices are separate because the main Vite bundle
license report does not include modules compiled inside Workers.

## Motion subtitle rendering

Motion pins `jassub` 2.5.20 and `media-captions` 0.0.18. Both load only when a
subtitle track is selected. Text captions use media-captions' MIT tokenizer and
timed-node helpers, **not its HTML serializer**: decoded cue text and attributes
are inserted with DOM text nodes and a small tag allowlist. No subtitle HTML is
assigned to `innerHTML`.

JASSUB's JS wrapper is MIT; its bundled libass/WASM dependency licenses include
LGPL-2.1-or-later, FTL, MIT, ISC, NTP, Zlib and BSL-1.0. Liberation Sans is OFL-1.1.
The IPC helper `abslink` is Apache-2.0; `throughput` and `lfa-ponyfill` declare MIT.
Distribute [THIRD-PARTY-SUBTITLE-NOTICES.txt](../apps/web/public/THIRD-PARTY-SUBTITLE-NOTICES.txt)
with the complete build, including the separately emitted WASM, worker and font
assets. The exact JASSUB source/build revision is
[`dea3d2d398569a591cf0c767d945d84e9f120484`](https://github.com/ThaUnknown/jassub/tree/dea3d2d398569a591cf0c767d945d84e9f120484);
the notice records pinned native-library source revisions. Before binary/public
distribution, release packaging must provide corresponding LGPL source/build
materials or another compliant source-availability mechanism. An upstream link
alone is not presented as a blanket compliance guarantee or a new repository
license decision.

JASSUB's unused `rvfc-polyfill` dependency declares GPL-3.0. An exact Vite alias
replaces that side-effect import with an original empty adapter in development
and builds; none of the polyfill implementation is copied or shipped. Motion
uses canvas/manual rendering and its existing native video frame callback with
RAF fallback, so it needs no global video prototype patch. Preserve this alias
and verify the build license inventory on dependency upgrades.

Remote font lookup is disabled. Only bounded embedded font data and the bundled
default font are used. pnpm's blocked `lfa-ponyfill` postinstall remains blocked;
no Google font-list download or browser font discovery is enabled. No additional
COOP/COEP deployment headers, backend transcoder, Blueprint change or native
dependency is required.

## Profile photo normalization

The API pins `pngjs` 7.0.0 (MIT, unmodified, already present as a transitive test
dependency) and development-only `@types/pngjs` 6.0.5. It decodes and re-encodes
bounded 256×256 PNG thumbnails; no native image processor or new browser library
is introduced. Runtime packaging retains the dependency's license in node_modules.
The source file is resized/cropped using browser
[Canvas drawImage](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage)
and [toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob).
The server validates the restricted PNG structure before using the
[upstream decoder](https://github.com/pngjs/pngjs/tree/v7.0.0), rejecting animation,
interlacing, oversized dimensions and malformed streams rather than processing
arbitrary uploaded originals. Stored thumbnails exclude metadata.

## Authenticator QR encoding

`qrcode.react` 4.2.0 is pinned for the optional, lazy authenticator setup QR.
It supports the installed React 19 peer and introduces no runtime dependency
besides React. Its SVG encoder runs entirely in the browser; no QR service,
remote image, account URI in a request, or camera permission is involved.
The main build measured 16.32 kB minified / 6.07 kB gzip for this separate chunk.
Manual secret entry remains available if the chunk cannot load.

The unmodified wrapper is ISC, with an embedded MIT-licensed Project Nayuki QR
Code generator. The generated main bundle notice includes ISC; distribute
[THIRD-PARTY-QR-NOTICES.txt](../apps/web/public/THIRD-PARTY-QR-NOTICES.txt) as well,
which preserves both complete upstream notices. No repository license change.
