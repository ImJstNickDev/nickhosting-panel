# M4 content planning, acquisition and staging

`@nickhosting/content-providers` implements provider discovery, dependency resolution, modpack plans and verified local staging. It does not authorize users, retarget eggs, run downloaded scripts, mutate a live server, or report a downloaded pack as installed. Core's durable Minecraft content workflow owns those responsibilities. Research and license decisions are recorded in [M4-CONTENT-RESEARCH.md](M4-CONTENT-RESEARCH.md).

## Contracts

- `ContentTarget` separates Minecraft version, loader identity and loader version.
- `ContentPlan` records target, exact downloadable artifacts, override archive paths and hashes, provider/project/version identities, dependency edges and warning keys.
- `ModrinthProvider` supports search, project/version discovery, compatible version lists, required dependency graphs and exact modpack acquisition metadata. Unknown/client-only side declarations, wrong game/loader, conflicting project versions, incompatible dependency edges and ambiguous primary files fail.
- `CurseForgeProvider` is optional and requires an injected key. The key is not enumerable or returned in plans. It supports search, exact file metadata, version lists and dependency plans, without scraping blocked downloads.
- `inspectModpack` reads `.mrpack` or CurseForge `manifest.json` ZIPs and produces a plan. Minecraft/loader values come from the manifest. Ambiguous or unknown loader dependencies fail.
- `acquireModrinthModpack` resolves exact provider IDs, stages an integrity-checked archive, and returns its inspected plan. It never installs content by URL alone.
- `stageContent` returns a job-owned files directory, plan digest and `{path,size,sha256,source}` manifest after every output verifies.
- `installedContentChange` returns old-file removal paths and expected previous hashes. Core must compare each hash to the live file immediately before destructive operations. Shared dependency updates require dependent re-resolution; retained dependent relationships prevent removal.

Default policy allows content under `mods/`, `plugins/`, `config/` and `defaultconfigs/`. Pack overrides in `kubejs/`, `scripts/`, `resourcepacks/` or the server root are unsupported. Server properties, EULA, operators, whitelist, worlds, startup files and hidden files are controlled by separate authorized management APIs. Shell/JavaScript/Python/native executable override paths are refused. Overrides may not silently replace those protected files. Packs that require arbitrary startup scripts or extra executable behavior are unsupported rather than partially advertised as working.

Modrinth indexed files follow their server environment declarations; client files are skipped and optional server files are omitted with a warning. Embedded Fabric metadata contradicting a provider's server declaration is rejected. JAR overrides and CurseForge files lack sufficient provider-side evidence by default: a recognized embedded Fabric server/both-side environment is required. Unknown Forge/Quilt/Paper override execution side is refused. Merely finding Forge display-test fields or a JAR filename does not establish compatibility.

Common overrides are applied after indexed downloads and server overrides replace common overrides, regardless of ZIP order. Case-alias collisions fail. Client overrides are never selected. A changed archive cannot satisfy a previously approved plan without matching its recorded file hashes.

Replacing an already selected modpack requires explicit wipe consent, the exact
current deletion preview and a backup decision. Changing a Modrinth project,
version or uploaded source identity counts as replacement; it cannot silently
overlay the previous pack and leave its files behind. Preparation records the
existing selection before acquisition. The worker compares that exact selection
again before staging or file effects, so consent prepared against pack A cannot
be reused after another operation selects a different pack. The replacement
deletes only the approved preview paths and publishes the new selection after
the resulting files, removals and requested backup have been verified.
An explicitly consented empty preview is valid for a selected empty pack; fresh
worker validation still rejects any newly appearing paths before replacement.

First installation and retries of the exact same selected pack do not need a new
wipe. Initial provisioning still has to satisfy all configuration and content
completion checks. Selection publication and a receipt for the exact job and
prepared plan commit atomically; this permits recovery after that commit without
treating target equality alone as installation evidence. Legacy queued requests
without a recorded baseline fail closed except for the exact same-pack/no-wipe
case, which still runs the normal verification path. None of these paths promises
rollback of changes already applied to server files.

Player text plans preserve the independently verified identity receipt when the
builder publishes the file plan. A missing historical ADD receipt can be recovered
only from the exact persisted after-image already present remotely, a freshly
cross-verified name/UUID, matching explicit operator privileges and identical
canonical list bytes. Recovery records an audit event before finalization and
does not rewrite the file or replace its original preimage. Missing REMOVE
identity evidence remains uncertain; it cannot be inferred from a list in which
the player is absent. Malformed identity receipts fail before file effects.

## Download and filesystem boundaries

HTTPS origins are explicitly configured by Core. Each DNS result must be public; the validated address is pinned into the TLS socket with the original hostname retained for certificate validation. Redirects, userinfo, IP-literal URLs, compressed HTTP responses and unapproved origins are refused. API keys are never attached to artifact requests. Metadata has a bounded JSON budget; files stream with backpressure and exact size/hash validation. Temporary transport/429/5xx failures have a bounded retry budget, while 404, authorization and integrity failures remain failures. No fallback bypasses provider distribution policy.

ZIP handling is lazy and bounded by entry count, compressed archive size, expanded total, per-file size, compression ratio and metadata size. Paths reject traversal, absolute names, backslashes, control characters, drive/device names and normalization aliases. Symlinks, special files, encryption, unsupported compression and duplicate case-insensitive names fail, including in unselected client entries. Selected data is checked against ZIP CRC and planned SHA-256. Hash algorithms from provider metadata are also verified.

Staging creates private job directories only beneath the supplied project `mountdata` root. Ancestor symlinks and nonregular existing files fail. Destinations are isolated from Wings and Pterodactyl. `statfs.bavail` checks retain the larger of 512 MiB or 10% filesystem capacity by default, configurable through the caller's disk policy, before aggregate staging and each new file. This is a conservative headroom check, not an atomic reservation of unrelated filesystem capacity; Core must bound concurrent staging jobs and retain its storage admission controls.

Each job pins one plan digest. An existing file is rehashed before reuse; corruption or a different plan fails rather than overwriting it. Successful output is published using file renames and a manifest. Partial staged files stay within that job and are never considered live installation evidence. A crash-left lock may be cleared only after the caller proves exclusive ownership of the durable DB job lease; elapsed time/PID alone is insufficient. Core must renew that lease and supply cancellation throughout acquisition/staging. No automatic unrelated-file cleanup occurs.

Default configurable budgets are 20,000 ZIP entries, 8 GiB archive/per-file sizes, 16 GiB expanded output, 500:1 expansion ratio, 8 MiB metadata and 512 resolved projects. These are safety budgets, not a fixed small upload limit. Owners may adjust budgets after considering actual storage; unsupported oversized content receives an explicit failure before publication.

## Evidence and limits

Package checks on 2026-10-09:

```sh
scripts/dev.sh pnpm exec biome check packages/content-providers/src
scripts/dev.sh pnpm exec vitest run packages/content-providers/src
scripts/dev.sh pnpm exec tsc --noEmit
```

The focused suite includes archive traversal/header attacks, symlinks, CRC corruption, expansion limits, duplicate/case paths, override order, client-only rejection, provider identity and dependency conflicts, API-key isolation, DNS pinning, redirects, HTTP/body limits, integrity failure, retries, cancellation, staging recovery, changed archives, removal/update preconditions and disk margins. The coordinator's final validation report records the final suite count.

A real read-only Modrinth API check resolved Fabric API project `P7dR8mSH`, version `Mys3P7lK`, for Minecraft `1.21.1`/Fabric. A real HTTPS download then staged `mods/fabric-api-0.116.17+1.21.1.jar`, 2,452,735 bytes, verified both source hashes and SHA-256 `79ac44b40780acbd884b34c50be1e39af682847e5f5cb3b1fddeeaa768dce800`, and inspected its JAR metadata. The temporary directory beneath `mountdata/test-assets/` was removed after the check. No JAR was executed. This proves provider acquisition/integrity, **not** successful dedicated-server installation or runtime compatibility.

CurseForge tests use isolated responses and fixture keys; no claim of live key approval or live distribution availability is made. Unknown-side CF/override content remains refused. World importing and actual server installation/backup/replacement are separate Core workflows and require their own evidence. Staging cannot promise rollback of already-applied server changes; failures must preserve and report the durable operation's actual stage.
