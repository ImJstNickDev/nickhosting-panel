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
