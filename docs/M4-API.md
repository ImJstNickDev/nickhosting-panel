# M4 Minecraft backend contracts

These contracts extend [M2](M2-API.md) and [M3](M3-API.md). They do not introduce
another lifecycle processor or a Minecraft proxy. All browser routes retain the
normal session, invitation, origin/CSRF and scoped support-session requirements.
M5 supplies graphical screens and remaining common API integration.

## Availability and administration

- `GET /v1/owner/minecraft/manifest`: the integration manifest.
- `POST /v1/owner/minecraft/register`: register the integration with `state` and
  `allowedUserIds`; uses existing rollout authorization.
- `GET/POST /v1/owner/minecraft/compatibility`: inspect evidence or resolve an
  exact runtime plus an Owner-configured mapping/binding. The POST accepts
  `mappingId`, `runtime` and `binding`; strict schemas are exported by the service.
- `PUT /v1/owner/minecraft/compatibility/:id/availability`: `{enabled:boolean}`.
  Enabling a choice grants no protocol compatibility.
- `POST /v1/owner/minecraft/compatibility/:id/evidence`: a trusted test runner's
  `{report,signature}`. The HMAC covers the exact runtime combination, Minecraft
  binding and underlying M2 mapping. The signing key is environment-only and is
  never returned through an administration API. Newer matching evidence governs;
  an old passing record cannot overrule a newer failed test. Evidence expires.

Only regular Owner sessions may inspect technical compatibility records. Normal
creation discovery returns simple version/runtime choices. Verified combinations
also require availability and rollout permission. Fixture evidence can permit
explicit private testing, never ordinary public creation. Legacy, unknown and
unverified combinations stay hidden. See [protocol evidence](M4-PROTOCOL.md).

## Creation and discovery

- `GET /v1/minecraft/choices`: eligible opaque choice IDs, versions and runtimes.
- `GET /v1/minecraft/wizard`: four-step translated descriptor.
- `POST /v1/minecraft/wizard` with `{sourceId}`: inspect an authorized, verified
  archive and derive its exact release/loader. Returns only compatible eligible
  choices and removes redundant version/loader questions. No arbitrary path,
  caller-declared compatibility or silent runtime substitution is accepted.
- `GET /v1/minecraft/modpacks/search` and
  `GET /v1/minecraft/modpacks/:projectId/versions`: select a pack before choosing
  a runtime. Discovery is filtered by eligible release/runtime pairs; archive
  inspection still verifies the exact loader before creation.
- `GET /v1/minecraft/content/search`: `choiceId`, `provider`, `query`, `type`,
  `offset`; Modrinth supports mods/plugins/modpacks. Optional CurseForge supports
  its permitted mod search when configured; unsupported filters are rejected.
- `GET /v1/minecraft/content/versions`: `choiceId`, `provider`, `projectId`.
- `GET /v1/minecraft/players/:name`: independently cross-check Mojang name/UUID
  lookups; `avatar=true` adds an optional MCHeads rendering URL.
- `POST /v1/minecraft/servers`: M2 creation fields **except `mappingId`**, plus
  `minecraft:{choiceId,configuration}`. Configuration includes explicit
  `eula:true`, optional controlled properties, operator/whitelist names and
  optionally `modpack:{provider:'modrinth',projectId,versionId}` or `{sourceId}`.

The public catalog/wizard's opaque `choiceId` is sufficient for runtime selection.
Core authorizes that choice and derives its immutable Owner-configured mapping;
the dedicated endpoint rejects a supplied `mappingId`. Users do not need access
to Owner runtime metadata. Creation rechecks current availability, evidence and
rollout permission under the existing M2 resource lock.

The initial content plan is resolved before provisioning and bound atomically to
its new managed server. Workers install/configure only after the egg completes
and a physical stopped observation succeeds. Download completion alone never
marks a server installed. Generic M2 creation cannot omit Minecraft configuration
or bypass prepared pack validation. Names, IDs, artifacts, Java requirements and
versions remain distinct; actual egg IDs and images are Owner configuration.

## Authorized source ingestion

- `POST /v1/minecraft/sources`: reserve `{kind:'world'|'modpack',serverId?,
  idempotencyKey,bytes,sha256}` before an upload.
- `PUT /v1/minecraft/sources/:id/upload`: `application/octet-stream`,
  `X-NH-Upload-Length` equal to the reservation, identity encoding and an exact
  Content-Length if supplied. Bytes stream to a generated private path with
  size/hash verification and repeated authorization.
- `POST /v1/minecraft/sources/modrinth`: acquire an exact `{projectId,versionId,
  serverId?,idempotencyKey}` under the same durable disk budget.
- `GET /v1/minecraft/sources/:id`: authorized safe metadata; never a local path.

Only the exact binary upload route bypasses the JSON body limit and total-body
request deadline; header/inactivity deadlines remain. Source uploads share API
connection-pool headroom with M2 uploads. Archive bytes and expanded staging use
PostgreSQL reservations with global/user budgets and real filesystem margins.
Failed or interrupted work retains claims rather than claiming space was freed.

Regular Owner inventory/recovery routes are
`GET /v1/owner/minecraft/sources`,
`POST /v1/owner/minecraft/sources/:id/recover` and
`POST /v1/owner/minecraft/staging/:jobId/recover`. Recovery requires exact identity,
explicit stopped-transfer/worker evidence, inactive jobs and absence of the exact
owned directory. It records an audit event; it does not delete arbitrary files or
stop workers. Never delete active job directories to make a recovery check pass.

## Existing-server management

- `GET /v1/servers/:id/minecraft`: configuration, runtime/version and recorded
  installed content, after normal resource authorization.
- `GET /v1/servers/:id/minecraft/worlds`: validated worlds and selection.
- `GET /v1/servers/:id/minecraft/wipe-preview`: the exact content/world paths that
  a pack replacement would remove. Runtime binaries/libraries are protected.
- `POST /v1/servers/:id/minecraft/operations`: existing operation idempotency key
  plus `action:'minecraft-content'` and a typed `command`:
  `verify`, `properties`, `player`, `install`, `remove`, `modpack`,
  `modpack-upload`, `world-import`, `world-select` or `world-remove`.
  The same endpoint accepts existing `reinstall`/`wipe` commands, preparing the
  recorded pack before any destructive effect.

Install accepts exact provider/project/version IDs; installing another compatible
version computes an update against recorded provenance and previous hashes.
Removal checks retained dependency references. Archive commands accept opaque
source IDs. Replacement requires `wipeConsent:true`, `expectedDeletePaths` and
`backupBefore`; changed previews fail. A requested pre-wipe backup must complete
successfully before deletion. World removal separately requires `confirm:true`.
All content/world/property/player effects require a confirmed stopped server,
existing job fencing and current resource authorization. Incompatible loader/egg
changes require reprovisioning; the API never retargets an immutable M2 mapping.

Job status and durable events use the existing M1/M2 APIs. Progress reports actual
verified files and milestones rather than percentages. A partial replacement is
not rolled back automatically; retained plans, checkpoints and backups are the
recovery evidence. An incomplete installation must not become playable through
an unrelated successful property edit or a bare runtime-JAR check.

## Configuration and deployment prerequisites

Settings use defaults < Owner database values < explicit environment:

| Setting | Environment | Default |
| --- | --- | --- |
| Metadata identifying/contact user agent | `NH_MINECRAFT_METADATA_USER_AGENT` | Required before external metadata reads |
| Protocol metadata commit/hash | `NH_MINECRAFT_PROTOCOL_SOURCE` | Pinned researched registry |
| Content staging root | `NH_MINECRAFT_CONTENT_ROOT` | `./mountdata/minecraft-content` |
| Source root | `NH_MINECRAFT_SOURCE_ROOT` | `./mountdata/minecraft-sources` |
| Source/staging global byte budget | `NH_MINECRAFT_SOURCE_GLOBAL_BYTES` | 20 GiB |
| Per-user byte budget | `NH_MINECRAFT_SOURCE_USER_BYTES` | 5 GiB |
| Concurrent source transfers | `NH_MINECRAFT_SOURCE_CONCURRENT` | 4 |
| Per-user concurrent transfers | `NH_MINECRAFT_SOURCE_USER_CONCURRENT` | 2 |
| Free disk minimum | `NH_MINECRAFT_SOURCE_FREE_BYTES` | 512 MiB |
| Free disk percentage | `NH_MINECRAFT_SOURCE_FREE_PERCENT` | 10 |
| Approved artifact origins | `NH_MINECRAFT_DOWNLOAD_ORIGINS` | Modrinth/CurseForge CDN origins |

`NH_CURSEFORGE_API_KEY` is optional protected provider configuration.
`NH_MINECRAFT_EVIDENCE_KEY` is a protected 32-byte hexadecimal runner attestation
key, environment-only. It must not be available to browser users. Do not use the
fixture keys from tests. Prepare writable project-owned staging directories as a
separate approved deployment operation; do not change an unrelated mount owner.

Migration 012 adds immutable compatibility evidence, per-server desired state and
content provenance. Migration 013 adds source/staging claims and source bindings.
No users, instance addresses, egg IDs or runtime choices are seeded. Run migrations
against a backed-up database before deploying matching API/worker versions.
Rollback means keeping the prior application deployment and preserving evidence;
never drop these tables while external effects or staging claims remain unresolved.

The [SFTPGo exception](https://github.com/ImJstNickDev/nickhosting-panel/issues/18)
is unchanged. Cloudflare writes remain mocked. Production Gateway topology and
real Minecraft compatibility require their own evidence and approval.

M2 multipart ingestion and M4 source/expanded staging charge the same outstanding
disk-claim total under the shared resource lock. Until separate filesystem
identities are proven, unresolved claims count conservatively across configured
roots and hosts; distinct path strings do not establish separate capacity.

## Runtime launch attestation and generic file management

A Minecraft combination freezes the complete declared egg environment, startup
command, image and bound artifact paths. Remote provider values are rechecked
against that immutable configuration. An omitted default is not inferred later
from a potentially changed egg. Image identity and release labels alone do not
establish which launch inputs actually execute.

Before each admitted start, Core rehashes the actual runtime launch inputs. The
first playable proof for a new process/evidence epoch repeats that verification
and confirms the process did not change during observation. Fabric generated
launchers use exact canonical entry hashes to tolerate only ZIP timestamp
differences; their external Java-properties target still binds the independently
verified Mojang server. Java CR/LF/CRLF and syntactic whitespace rules apply.

Browser binary uploads and write/delete/rename/mkdir operations cannot overwrite
verified runtime files, their ancestors, bound launch paths or protected launcher
configuration. Mods, plugins and worlds retain their separate management paths.
Out-of-band filesystem changes are not assumed impossible: prestart/process
verification fails closed when the attested launch inputs no longer match. This
is separate from the unchanged SFTPGo transport-revocation exception.
