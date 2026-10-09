# M4 Minecraft Java integration — acceptance and review evidence

M3 PR #19 was squash-merged with explicit one-time Owner authorization at
`fdfbb8c730a52a11fb4aff29aa580a1904248e49`, after verifying its exact approved
HEAD `89d3e45b894114b39d2e09287e2396ed7bc87fda`. Issues #8/#9 are closed.
M4 work starts from that tree on `milestone/m4-minecraft`.

M4 acceptance is complete within the Owner-approved Vanilla-only real-server
scope. PR #20 is open for Owner/ChatGPT review and must not be merged by Codex.
The checkpoints below retain failed and partial attempts; only the final evidence
chain establishes the recorded Vanilla combination. No production deployment
or public rollout was performed.

## Current validation summary

Commands run from the repository with the pinned user-local development runtime:

| Command / check | Actual result |
| --- | --- |
| `bash scripts/dev.sh pnpm lint` | Passed; 213 files |
| `bash scripts/dev.sh pnpm format:check` | Passed; 213 files |
| `bash scripts/dev.sh pnpm typecheck` | Passed |
| `bash scripts/dev.sh pnpm test` | Baseline: 814 passed, 44 files; 14.93 seconds, before the final player-receipt correction |
| `bash scripts/dev.sh pnpm test:m3` | Baseline: 567 passed and 3 known expected failures, 31 files; 282.50 seconds, before the final player-receipt correction |
| Focused post-correction content checks | 30 PostgreSQL tests, 20 content unit tests and 6 i18n tests passed; unaffected full suites were not rerun |
| `bash scripts/dev.sh pnpm audit --prod --json` | Zero reported advisories; 216 production dependencies |
| `python3 scripts/check-governance.py` | Passed for the final staged documentation and code |
| Private baseline preservation | All 14 pre-existing private files unchanged |
| Exact local-secret scan | Seven protected environment values, zero tracked matches |
| GitHub governance | Actions disabled; PR #20 remains open for review |
| Complete real Vanilla scenario | Passed on the same retained asset; signed evidence and scoped cleanup confirmed below |

Node 24.21.0 is installed in the current user's local runtime directory; pnpm is
pinned to 10.33.0 and TypeScript to 7.0.2. No system runtime was changed. Database
tests use the already approved M2 isolated PostgreSQL/Redis/SFTPGo stack, with
generated test schemas and project-local persistence. No new Docker test resource
was created for these M4 checks. The three expected failures are exactly the
Owner-accepted SFTPGo transport revocation defect tracked in issue #18.

Only the affected checks were rerun after the final player-plan correction:

```sh
scripts/dev.sh pnpm exec vitest run packages/server-management/src/minecraft-content.test.ts
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/minecraft-content.integration.test.ts
bash scripts/dev.sh pnpm exec vitest run packages/i18n/src/i18n.test.ts
scripts/dev.sh pnpm exec tsc --noEmit
```

Results were 20 unit tests, 30 PostgreSQL tests (35.36 seconds), 6 i18n tests and
a successful typecheck. The focused content/DB outputs were retained in the tool
transcript; no filesystem log is claimed for those runs. Scoped Biome and diff
checks also passed. The independent reviewer repeated only the affected content
tests and inspected the recovery gates.

## Acceptance covered

- Separate release, protocol, loader/build and Java-runtime metadata; Owner-only
  evidence-backed compatibility administration and safe user catalog filtering.
- Bounded status/login handling, passive-query suppression, readiness and truthful
  idle evidence integrated with M3 leases/fences and M2 admission.
- Configurable Vanilla/Paper/Folia/Fabric/Forge mappings and dynamic backend wizard.
- Prism Launcher source/license research before implementing server-side Modrinth
  and optional permitted CurseForge content workflows.
- Durable content install/update/remove, world and property management, independent
  player identity validation, consent/backup-gated replacement and recovery.
- Unit, protocol, database, installation and provenance-verified real-server tests,
  distinguishing fixture evidence from real runtime/client evidence.
- Independent protocol, content-integrity, licensing, authorization and recovery
  review; commands, results, safety, cleanup and rollback recorded below.

## Safety and existing limitations

No production Gateway deployment, network/egg change or real DNS write is
authorized. The Owner separately approved the exact existing test allocation and
its possible exposure, loopback Gateway and scoped nonce endpoint described in
[M4 live tests](M4-LIVE-TESTS.md), and accepted the Minecraft EULA for these tests. Any additional test infrastructure requires
the exact documented approval before execution. Test-server mutations require
durable provenance corroborated with the live API. Secrets, private infrastructure
notes and test ledgers stay ignored. No system Java installation is changed.

The temporary SFTPGo revocation exception and [issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18)
are unchanged. No Minecraft limbo, M5 implementation or M6 frontend is included.

Rollback during development: keep the reviewed M3 baseline in service. Do not
deploy this branch or drop durable state to roll back an uncertain external effect.
Migration/job rollback boundaries are recorded in [M4 APIs](M4-API.md).

## Coverage boundaries and deployment prerequisites

- The Owner accepted Vanilla-only real-server coverage. Paper/Folia/Fabric/Forge
  have metadata, mapping and management contracts with isolated tests; they stay
  unverified and hidden until their exact eggs/runtime combinations are tested.
- The actual client is `minecraft-protocol` 1.68.0 in an offline fixture. Its
  outbound handshake and PLAY state are observed. Microsoft online authentication,
  encryption and secure-chat compatibility are not claimed by this run; the
  Gateway forwards those protocols transparently rather than implementing them.
- The live Vanilla content pack is a self-authored server-only `.mrpack` format
  fixture. Actual Modrinth artifact acquisition and integrity were tested
  separately; installing a third-party modded pack on Vanilla is not claimed.
  CurseForge uses isolated responses because no approved live provider key was
  available. Runtime/loader switching remains explicit reprovisioning.
- A completed pre-wipe backup is verified before replacement. A successful backup
  restore or automatic rollback is not claimed. Partial operations and their
  original intent remain durable; do not delete state to conceal uncertainty.
- Production needs Owner-configured eggs, immutable runtime/image evidence,
  adequate provider API capacity, protected evidence/provider keys and approved
  writable staging. Existing Forge installer availability needs Owner work.
  Production Gateway namespace/topology and listener approval remain separate.
- No production rollout, public availability change, real DNS write, online
  Minecraft account test, additional runtime-profile acceptance, M5 or M6 is
  implied. The SFTPGo exception remains a pre-release follow-up under #18.

## Final evidence, review and cleanup

At **2026-10-09T19:04:41Z**, report
`0b210736-b977-46f3-a931-1b1286bcbb95` established the exact Vanilla combination
as `verified` in the isolated database, with rollout still `private-testing`.
All twelve checks are bound to original successful protocol receipts, the completed
content continuation and fresh artifact, image, startup and environment checks.
The independently reviewed finalizer performed **zero provider writes**.

Final scoped cleanup completed at **2026-10-09T19:05:54Z**: the backup was
conclusively attributed to its original job and deleted through the provider;
its exact lookup returned absence and the server backup inventory was empty.
Core stop/delete confirmed server API absence, allocation release and terminal
container absence. This is provider-confirmed backup deletion, not an independent
claim of physical erasure. The exact known nonce process then exited on SIGTERM;
its TCP/UDP sockets and the loopback Gateway listener were confirmed absent.

All nine created M4 assets were individually recorded and cleaned:

| Provider ID | Test UUID | Result |
| --- | --- | --- |
| 44 | `8afabd34-deb4-4514-95eb-577f1f298e73` | Partial/failed attempt; cleaned |
| 45 | `3d2d3c24-81f8-4262-b79c-53bc48f1ddd4` | Installation bootstrap; cleaned |
| 46 | `00f04de7-96fc-40df-8c29-2cca49adb07a` | Partial/failed attempt; cleaned |
| 47 | `36f1f40e-2019-429e-946a-d9e8d8f56939` | Partial/failed attempt; cleaned |
| 48 | `f252942b-8bff-45b1-b896-c1205d208015` | Partial/failed attempt; cleaned |
| 49 | `3b34d3c6-9298-4887-b689-f1fc7ea51cce` | Partial/failed attempt; cleaned |
| 50 | `5c9f0e4c-3cdb-44e3-b81f-7009df1b71f4` | Partial/failed attempt; cleaned |
| 51 | `16c38459-9ee5-49d0-8a4c-5b94e3aa657e` | Partial/failed attempt; cleaned |
| 52 | `714fd53c-c06d-4e9c-afd8-bc7c52dde966` | Complete continued acceptance; cleaned |

Protected provenance ledgers, retained isolated schemas, original failed jobs,
source/staging claims and fixture data remain under ignored project state for
review. They were not erased to manufacture a clean history. In particular the
initial failed bootstrap job remains quarantined; it is not a successful product
recovery. No owned live server or test listener remains.

Independent review resolved must-fix findings in launch/evidence authority,
ordinary-user creation, wipe consent and exact-job recovery, player receipt
persistence, Gateway revision retry and observation freshness. Final continuation
and attestation were independently cleared. There is no remaining M4 code blocker;
the coverage/deployment limitations above remain explicit.

Actual final execution commands used the pinned development runtime:

```sh
bash scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec tsx .codex/local/m4-resume-player-job.ts --execute-approved --runner-stopped-pid 619823 --expected-head d1cb1aa3613991074b8030dafb926eea1ee868bd
bash scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec tsx .codex/local/m4-continue-content.ts --execute-approved --expected-head d1cb1aa3613991074b8030dafb926eea1ee868bd
bash scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec tsx .codex/local/m4-finalize-evidence.ts --execute-approved --expected-head d1cb1aa3613991074b8030dafb926eea1ee868bd
bash scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec tsx scripts/m4-live-scenario.ts --plan .codex/local/m4-live-plan.json --profile vanilla --phase cleanup --retain-schema --ledger mountdata/test-assets/m4-live-81cd4010-ed8d-4319-99fc-55623735db77.json --owner-approved
```

All four exited successfully. Private continuation/finalization helpers are exact
run recovery tools, not commands to replay on another installation. The committed
[normal live runner](M4-LIVE-TESTS.md) is the documented full-scenario path. Logs
were retained locally; no privileged provider response or credential is published.

## Historical checkpoint — 2026-10-09 (work continued)

- `scripts/dev.sh pnpm test`: 706 passed across 43 files. This checkpoint
  precedes the last Java-properties and launch-input review corrections.
- `scripts/dev.sh pnpm test:m3`: 543 passed and **3 expected failures** across
  31 files. Uses the previously approved M2 isolated PostgreSQL/Redis/SFTPGo
  services. The expected failures are exactly the accepted SFTPGo transport
  revocation defect; they are not passing security assertions.
- `scripts/dev.sh pnpm audit --prod --json`: no reported advisories among
  216 production dependencies. This is a dependency advisory check, not proof
  that application logic has no vulnerabilities.
- Independent review confirmed fixes for persisted content conflicts, scoped
  archive reuse, UUID/OP-level persistence, inventory preservation, shared disk
  claims, queued authorization, runtime-image identity and initial-configuration
  fencing. The live-runner review additionally required positive resource caps
  and cleanup independent of creation capacity/upstream availability; both fixed.
- First bootstrap attempt failed during isolated local mapping validation before
  any provider server creation. Its empty-asset ledger was preserved and its
  exact generated database schema was subsequently cleaned. The fixture manifest
  namespace was corrected and regression-tested. No compatibility evidence was
  issued from that attempt.

Live acceptance, full final checks and independent review remain in progress.
The PR stays draft; there is no completed M4 compatibility claim at this checkpoint.

The second bootstrap created test UUID `8afabd34-deb4-4514-95eb-577f1f298e73`
with a harness startup prefix that interacted incorrectly with the existing
image entrypoint. It did not establish compatibility. Ordinary stop did not
confirm shutdown. After independent review, the scoped recovery helper recorded
an explicit force-stop intent and verified provider offline, exact containers
stopped, then server deletion, allocation release and container absence. The
original queued Core job and isolated schema remain quarantined for diagnosis;
this is confirmed test cleanup, not successful product recovery. The durable
private ledger records full cleanup at 2026-10-09T16:54:04Z. Future bootstrap
uses the unchanged egg startup; no image, egg or production configuration changed.

The corrected Vanilla bootstrap used UUID
`3d2d3c24-81f8-4262-b79c-53bc48f1ddd4`: exact upstream server artifact, actual
Java 25/image identity, real 26.1 status/ping readiness and saved-world DataVersion
were observed. Core stop and deletion completed with API absence confirmed. Its
signed report is `installation-bootstrap`/`experimental`, not a completed client,
wake or content compatibility claim. A separate complete M4 scenario remains
required. One retry before this run failed at module import without creating
any resource; CommonJS interop was corrected and a real tsx import smoke added
to validation.

The next review checkpoint passed `pnpm lint` (213 files), `pnpm format:check`,
`pnpm typecheck` and `pnpm test` (742 tests in 44 files). Final launch-environment
completeness and Forge launch-input attestation follow-ups are still in progress.

## Owner acceptance clarification — 2026-10-09

The Owner explicitly narrowed live M4 acceptance to Vanilla. Paper, Folia, Fabric
and Forge still have runtime/mapping/configuration contracts and isolated tests,
but their installed egg improvements and real runtime validation are deferred.
Those combinations remain unverified and unavailable to ordinary users; this
clarification does not establish compatibility. The unavailable Forge installer
image is a future deployment prerequisite, not an M4 acceptance blocker.

Pterodactyl/Wings remains authoritative for executing egg installation and
reinstall scripts. NickHosting declares and validates the runtime requirement,
selects an Owner-configured mapping, verifies the result, and manages game
configuration and content. Its installation capture helper only reads/verifies
files and metadata; it never executes installer processors. Any future additional
installation work must be gated by explicit egg capabilities and must not
conflict with installation already supplied by the egg.

Additional retained live failures:

- UUID `00f04de7-96fc-40df-8c29-2cca49adb07a`: installation completed, but
  strict launch attestation rejected the standard `P_SERVER_ALLOCATION_LIMIT`
  metadata. The correction checks that field against both the immutable mapping
  and actual provider feature limit. Its terminal failed job stayed unchanged
  while ordinary Core stop/delete and provider/container checks completed.
- UUID `36f1f40e-2019-429e-946a-d9e8d8f56939`: full M4 provision/start and
  Gateway readiness succeeded; an independent client reached backend login but
  disconnected before entering play. No idle-stop job or server authentication,
  whitelist or version rejection was found. The exact cause was not established.
  The harness now requires a current committed Gateway revision at each
  transition instead of a fixed delay. Core cleanup confirmed deletion; this
  failed attempt does not establish client or wake compatibility.

The shared isolated schema preserves original terminal jobs, bootstrap evidence
and failure history during explicit retained-schema cleanup. No job was reset
or relabeled successful to enable a later attempt.

The subsequent UUID `f252942b-8bff-45b1-b896-c1205d208015` also reached real
readiness, but its independent client ended during configuration while Gateway
snapshot/observation errors removed the route. A committed-snapshot wait alone
did not fix this. Independent source review identified a race between normal idle
bookkeeping, route revision changes and in-flight safety checks; the retained
log does not prove which HTTP error caused this particular disconnect. This is
a failed acceptance attempt. Ordinary Core stop/delete, an empty backup inventory,
provider absence, allocation release and terminal-container checks subsequently
confirmed its cleanup at 2026-10-09T17:45:14Z. No client compatibility is inferred
from it.

The correction distinguishes authenticated explicit route-revision preconditions
from actual safety failures and performs one fresh snapshot/full validation retry.
It retains only the original committed lease; unknown ownership/topology, collision,
revocation and expiry still close listeners. Independent review passed 130 focused
tests; the implementer's focused suites passed 89 unit and 83 Core/API integration
tests. A short approved loopback diagnostic on the owned fixture made 98 successful
control requests (maximum observed individual request 1,314 ms) with zero recorded
snapshot/observation errors. This diagnostic carried no player traffic and is not
client acceptance. No timeout or freshness setting was increased.

At this checkpoint `pnpm test` passes 790 tests across 44 files, and lint, formatting
and TypeScript checks pass. The complete corrected live scenario and final full
database suite remain to be recorded below.

The next UUID `3b34d3c6-9298-4887-b689-f1fc7ea51cce` eventually reached Gateway
readiness, then lost its route on HTTP 503 inventory failures during client
configuration. The runner stopped itself and preserved the failure. Earlier HTTP
412 receipts demonstrated the revision-retry path; the 503 upstream cause was not
captured and is not retrospectively labeled rate limiting. Scoped Core cleanup
confirmed deletion at 2026-10-09T17:58:31Z, empty backup inventory, allocation
release and terminal containers.

Review identified and regression-tested a separate observation-starvation bug:
equivalent lease renewals replaced a JavaScript object and could repeatedly discard
a slow probe. The fix compares complete route authority and retains the original
observation time, lease expiry and idle fence. No evidence lifetime was extended.
The updated fixture uses the explicitly documented 5-second polling cadence and
sanitized provider failure receipts. No Panel limit/configuration was changed.

The final workflow review also corrected ordinary-user creation to derive the
immutable mapping from its authorized public choice, and bound modpack replacement
consent to the exact prior selection, preview and backup decision. Workers recheck
that selection and use an atomic exact-plan receipt for recovery. Empty previews
still require consent and are rechecked; initial installation and same-pack retries
remain supported. Independent review reports no remaining code must-fix findings.

At that checkpoint the full unit result was **811 passed in 44 files**, with lint, formatting and
TypeScript checks passing. The full database run including the final replacement
corrections passed **567 tests plus 3 expected failures in 31 files** (282.50 s).
The three expected failures remain the accepted SFTPGo transport limitation.

UUID `5c9f0e4c-3cdb-44e3-b81f-7009df1b71f4` reached the independent client's
actual PLAY event through a healthy Gateway. The harness then failed because it
read `client.protocolVersion`, which the installed library's TypeScript declaration
advertises but its runtime never sets. This proves neither the remaining idle/wake
steps nor content acceptance. The corrected harness must verify the independent
client's actual emitted handshake before a new full run. The failure and original
jobs remain recorded. Explicit Core cleanup confirmed deletion at
2026-10-09T18:06:17Z, empty backup inventory, provider absence, allocation release
and terminal containers. Its isolated evidence schema remains retained.
The fresh live scenario and final cleanup remain in progress.

The corrected client helper captures the installed independent library's outbound
`set_protocol` handshake without modifying serialization. Loopback wire tests
confirm 26.1/775 and 1.21.4/769 and reject missing/duplicate evidence. Initial,
post-wake and signed-report protocol identities use those observed values.
The independent reviewer passed all 48 live-harness tests.

One subsequent full unit run passed 812 tests and failed the staged-listener
fixture's expected fourth safety call. A deterministic occupied-endpoint test
reproduced the three-call pattern with native `EADDRINUSE`; the original run did
not record its errno. Reserving an ephemeral backend port does not reserve the
same number on another address. The positive test now has a distinct loopback
address and exposes native setup errors. All four safety assertions and both
forwarding checks remain; a new collision regression proves the existing listener
stays usable. Production code is unchanged. Independent review passed all 74
Gateway data-plane tests; the final full unit rerun is recorded below.

The full rerun passed **814 tests in 44 files**. UUID
`16c38459-9ee5-49d0-8a4c-5b94e3aa657e` then proved actual independent PLAY,
one reported player for 35.424 seconds against a 30-second idle timeout, empty
sleep, passive status without wake, twelve concurrent joins producing one wake,
post-wake PLAY, a 29.184-second process-to-readiness measurement, and confirmed
save/stop. The estimator correctly remained unavailable with only one sample.
Its manual-stop assertion waited for a pre-stop generation even though Core
intentionally rotates consent on manual stop. The coordinator verified fresh
provider ownership/offline state and zero pending operations, fsynced a separate
stop receipt and terminated only the known foreground test runner during its
read-only wait. This is partial evidence, not complete acceptance. The harness
now pins the actual post-stop generation, retains the same route/lease checks,
and fails immediately on unexpected consent changes.
Ordinary scoped Core cleanup then confirmed deletion at
2026-10-09T18:20:17Z, empty backup inventory, provider absence, allocation release
and terminal containers; the original operations and partial evidence remain.
The corrected full unit rerun again passed **814/814** (14.93 s), with lint,
formatting and TypeScript checks passing. No production behavior changed in
either of these final harness corrections.

The continued Vanilla asset, UUID `714fd53c-c06d-4e9c-afd8-bc7c52dde966`, passed
real PLAY/non-idleness (35.354 seconds), sleep, passive status, twelve joins/one
wake, post-wake PLAY, save/stop and manual-stop suppression. Process-to-readiness
was 29.776 seconds; the estimator remained unavailable with only one sample.
Physical-policy refusal took 424.5 ms with no queued start or reservation; only
the isolated database policy was constrained, never actual host resources.

Its first operator ADD exposed a real durable-plan bug: the caller spread the
old operation plan before awaiting a builder that persisted the verified player
identity. Publishing the text plan then discarded that identity. The actual
`ops.json` write was confirmed, while the original job retained an internal error.
The coordinator stopped only the known test runner under the existing Core server
lock, after fresh ownership/offline and confirmed-effect checks; the job was not
reset or relabeled.

Commit `d1cb1aa3613991074b8030dafb926eea1ee868bd` corrects the ordering and adds
PostgreSQL persist/reload regressions. Missing historical ADD identity can be
recovered only with the exact recorded after-image, independently reverified
name/UUID and matching privileges, followed by a durable audit. Missing REMOVE
identity and malformed authority fail closed. Independent review cleared the fix
and the narrowly scoped private recovery runner.

On 2026-10-09 at 18:40 UTC, original job
`8eaff547-7b0a-4c00-a40c-5eb64c84159e` completed through the real Core processor
with **zero provider writes**, unchanged command/text intent and no new jobs.
The private runner explicitly rejected any provider mutation and confirmed the
resulting identity, level 2 and disabled player-limit bypass. Its fsynced recovery
receipt remains with the ignored test ledger. This is actual same-job recovery,
not a claimed rollback. The same asset's already completed protocol evidence is
retained; remaining content checks continue without repeating it.

The reviewed content continuation completed at **2026-10-09T19:03:48Z** on the
same UUID, without replaying its completed protocol checks. Real Core jobs
verified property change/restoration, independently resolved operator/whitelist
add/remove, and a captured 37-file world (4,621,079 bytes): upload, import,
selection, actual Minecraft status/ping readiness, restoration of the prior
selection and removal. A self-authored server-only `.mrpack` then exercised
common/server override precedence, exclusion of client overrides, explicit wipe
preview/consent and a completed **124,750,157-byte** pre-wipe backup. The replaced
server reached actual readiness and stopped cleanly. This proves the format
workflow; it does not claim a third-party modded pack or a restored backup.

The content continuation and original-job recovery were independently reviewed
private runners, preserving the existing schema, asset, original jobs and source
hashes. The normal committed runner remains the reproducible full scenario;
private continuation avoided recreating the server or repeating already valid
protocol tests after the isolated content correction.
