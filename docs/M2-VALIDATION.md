# M2 implementation and validation record

The results below describe the original delivery at `a6f693986fdfe1624b8e1b06fc4f4ff16b8eee79`.
The subsequent Owner review corrections, current validation and cleanup are recorded
in [M2 review revisions](M2-REVIEW-REVISIONS.md); its newer contracts supersede the
original count limit, allocation selection and browser transfer restrictions.
The latest [loopback compatibility review](M2-LOOPBACK-REVIEW.md) records the
separate provider/effective address model, final validation and M3 collision gate.

M2 is **complete for Owner/ChatGPT review** on `milestone/m2-server-management`,
subject to the explicit temporary SFTPGo exception below.
[PR #17](https://github.com/ImJstNickDev/nickhosting-panel/pull/17) is the review
delivery and must remain unmerged. Acceptance is tracked by [issue #6](https://github.com/ImJstNickDev/nickhosting-panel/issues/6)
and [issue #7](https://github.com/ImJstNickDev/nickhosting-panel/issues/7).
The Owner's narrow SFTPGo exception permits continued M2 work; it is not a
production-release approval or a waiver of other acceptance requirements.

## Reviewed baseline and toolchain

The Owner authorized the one-time squash merge of PR #16 at exactly
`9077006d73e6184fd9ba14c0f4efd15a03e8ece5`. GitHub authentication as
`ImJstNickDev`, open state, mergeability, base and clean local workspace were
verified. The resulting `main` commit is
`b1a71ef52721e413e861d410954d06fd743b883c`; issues #4 and #5 are closed.
Local main was fast-forwarded and its tree matched the approved M1 tree.
Ignored infrastructure notes and environment files were preserved.

The user-local development toolchain is Node **24.21.0**, pnpm **10.33.0** and
TypeScript **7.0.2**. Node was installed during M1 from the official archive with
its checksum verified; no system runtime was replaced. `scripts/dev.sh` activates
the pinned local release. The package manifests and lockfile pin dependencies;
build scripts remained disabled during dependency installation. See the retained
[M1 development record](DEVELOPMENT.md) for installation and baseline procedures.

## Production and infrastructure boundary

Live mutations are restricted to newly created, conservatively sized servers
with durable Codex provenance corroborated against the Pterodactyl API. Their
IDs and cleanup status are listed below. No pre-existing server or its data,
Panel/Wings configuration, node limits, over-allocation setting, existing Docker
network/stack, firewall, router, proxy, Bind9 or real Cloudflare DNS record was
modified. Private keys, API identity details and infrastructure notes remain in
ignored files; public evidence contains no privileged credentials.

The exact isolated M2 PostgreSQL/Redis/SFTPGo stack, its scoped restarts and
cleanup were separately approved. The three test containers and their sole
project network have been removed after final validation; ignored bind data remain.
A future application deployment or additional resource change still needs the
applicable operation-specific approval. The new Docker observer uses existing
user-authorized read-only CLI access; no socket mount, Docker permission change
or host service was added. Future deployment approval must explicitly address
its privileged socket access, even though the implemented commands are read-only.

## SFTPGo limitation and temporary M2 waiver

The Owner initially paused M2 pending a provider decision after the pinned
SFTPGo **2.7.6** service accepted new SFTP channels on a retained authenticated
SSH transport after each of:

1. Explicit `DELETE /api/v2/connections/{id}`.
2. Password rotation with `disconnect=1`.
3. Account disable/disconnect followed by deletion.

Existing channels close and fresh logins with the old password are refused,
but the retained transport still accesses its original directory. An independent
reviewer corroborated the cached-user/channel-only disconnect behavior in the
[SFTPGo server](https://raw.githubusercontent.com/drakkan/sftpgo/v2.7.6/internal/sftpd/server.go)
and [SFTP handler](https://raw.githubusercontent.com/drakkan/sftpgo/v2.7.6/internal/sftpd/handler.go).
No supported transport-level disconnect API remedy was found.

The Owner subsequently authorized M2 to resume, temporarily accepting only the
lack of immediate revocation for already-authenticated SSH transports. Continue
using SFTPGo with **no SSH proxy, fork or workaround**. The three strict security
assertions remain **known expected failures**, not successful revocation tests.
Setup, new-login rejection, credential isolation and filesystem isolation remain
ordinary tests that must pass. The normal suite keeps these prerequisites
separate so a broken setup cannot masquerade as the accepted failure.

The strict diagnostic below was exercised and the three retained-transport
assertions still failed as expected:

```sh
NH_TEST_SFTPGO_STRICT_REVOCATION=1 scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/external-services/src/sftpgo.integration.test.ts
```

This exception applies only to M2 and must be revisited before production release,
tracked by [issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18).
It authorizes no real Wings mount, DNS write or unrelated requirement change.
The [service contract](../packages/external-services/README.md) and
[ADR 0011](decisions/0011-server-lifecycle-and-service-boundaries.md) retain the
precise limitation and regression procedure.

## Installed Pterodactyl findings

Read-only inspection identified Panel **1.11.11**, Blueprint **beta-2025-09**
and running Wings **1.11.13**. The seven relevant installed PHP files matched
upstream Panel v1.11.11 byte-for-byte. The reviewed running Wings build matched
its official version. No closed-source extension source was copied.

- `FindViableNodesService::handle`, lines 74–86, sums configured RAM and disk
  across all servers, including stopped servers.
- `ServerCreationService::handle`, lines 52–99, invokes automatic capacity
  selection only for a deployment object. Explicit allocation provisioning
  bypasses this aggregate selector; the controlled creations below exercise it.
- `BuildModificationService`, lines 33–74, handles limits independently. A
  Panel update may succeed while Wings synchronization fails, so a Panel PATCH
  acknowledgement alone does not establish effective container limits.
- Creation allocation assignment lacks a conditional free/same-node update.
  NickHosting serializes its own claims, refreshes inventory and verifies
  resulting identity/allocations, but cannot make a direct administrator's
  concurrent Panel writes atomic with NickHosting.
- Resource responses are cached for 20 seconds. Timer expiry or cached offline
  state alone cannot prove that a delayed power request has finished. Terminal
  completion now combines provider event evidence with an independent,
  host-bound Docker observation and durable proof.
- Unique external IDs and exact external-ID lookup support uncertain-create
  recovery. Reinstall does not itself wipe all server files.
- Clearing restore status can represent success or failure. Restore confirmation
  requires a fresh, correlated terminal activity result, excluding baseline or
  ambiguous events.
- The installed Wings memory-overhead tiers are 115% up to and including 2,048
  configured units, 110% through 4,096, and 105% above that. Its Docker limit is
  `round(configured × multiplier × 1,000,000)` bytes, not binary MiB. The live
  256-unit fixture received 294,400,000 bytes. Physical admission now reserves
  295 MiB using the conservative 115% node bound; a 1,024-unit installer reserves
  1,178 MiB. User quotas retain configured limits. No Wings setting was changed.
- Actual authenticated WebSocket control frames may omit `args`; the adapter
  now accepts that real wire shape without accepting malformed data events.

The initial live API survey returned these intentional configured allocations:

| Resource | Configured node capacity | Sum of configured server limits |
| --- | --- | --- |
| RAM | 49,152 MiB | 186,368 MiB |
| Disk | 524,288 MiB | 534,528 MiB |

Configured over-allocation percentages were zero. The initial inventory had
24 existing servers, four running, 366 free allocations and readable resources
for all 24. These aggregates are not actual physical consumption. Before tests,
read-only host observations showed 64,302 MiB total RAM, approximately 23,708 MiB
available, 14 logical CPUs and approximately 82 GiB filesystem space available.
These are point-in-time observations, not product defaults or guarantees. Live
starts and installer admission require fresh observations and safety margins.

Application-node and Client-list connection probes passed, as did typed discovery
of nodes, nests/eggs, allocations, users and server resources. The successful controlled run exercised explicit provisioning, installation
observation, start/restart/stop, console commands and events, file write/read,
backup creation/restore/deletion, build updates, reinstall, wipe and server
deletion. No missing API scope blocked these tested operations. The shell fixture
proved its own command readiness only; game-specific readiness remains outside M2.

## Integrated implementation and resolved review findings

The current tree includes the Hono routes and worker runtime, not just package
scaffolds. [M2 API contracts](M2-API.md) describe the public payloads and limits.
Migrations 004–006 add registry/projects, resource and installation
reservations, allocations, durable operations/events/metrics and provider ledgers;
all six migrations create schema without seeded users or instance values. Migration
006 backfills physical memory commitments for previously stored reservations.

Review-driven fixes now covered by targeted or combined suites include:

- Authoritative PostgreSQL reservations and effect checkpoints, Redis redelivery
  and outbox recovery, per-server serialization and shared pinned connections to
  avoid nested-pool starvation. Lost creation responses reconcile by stable
  external ID; uncertain destructive effects are not blindly repeated.
- Conservative host admission without stale managed-usage credits, atomic user
  and physical-host limits, persistent disk/backup allowances, policy-switch
  validation, audited temporary overrides and stable multiport collision checks.
- Separate installer RAM/CPU reservations using the larger of server limits and
  configured Wings installer floors, with the physical overhead bound applied. Installers share physical capacity with
  game processes without consuming the user's active-game budget.
- Physical memory separated from configured user memory across admission,
  reconciliation and policy changes. Existing commitments are conservatively
  backfilled and never reduced; higher environment overrides immediately affect
  all pending capacity checks. Concurrent raw-RAM-fit/physical-RAM-exhaustion
  regressions and migration backfill tests pass.
- Stop proof from supported egg stop semantics and a fresh ordered authenticated
  transition, corroborated against the exact non-running Docker container and
  persisted before release. Installer completion also needs fresh provider
  completion/state plus exact-container proof. The observer is bound to the
  configured physical host; Docker errors never establish absence.
- An already-offline stop with no reservation completes without a power effect
  only after host/provider/container proof and an atomic recheck of both
  reservation tables. Repeated stops do not strand the server; retained or
  uncertain reservations still require the strict ordered transition proof.
- Current role, project membership, support-parent and ordinary session checks,
  including authorization refreshed after lock acquisition and again before
  interactive side effects. Durable already-accepted jobs retain attribution
  without treating an old privilege snapshot as a permanent grant.
- Physical process-start evidence confirms fast restarts even when cached uptime
  misses the reset. A fresh worker recovered the live completed restart without
  replaying power, retained its physical reservation and subsequently confirmed
  a normal stop. Malformed, missing, unchanged or future process evidence cannot
  fall back to telemetry.
- Verified restore-result activity, conservative build-limit publication,
  failed-install recovery gates and failed-only audited Owner resolution.
- Backend console token mediation, bounded SSE buffering, safe download/file
  responses and actual provider control-frame parsing without privileged token
  exposure.
- Encrypted external credential intents, one-time password delivery, scoped
  provider identity, recovery/revocation, and DNS ownership ledgers with mocked
  writes. The SFTP transport exception remains explicit and narrowly bounded.

Unknown or missed installation/start outcomes **retain capacity and quarantine
further unsafe work**. A missed WebSocket event is not permission to repeat the
remote mutation or infer success from elapsed time. Independent Docker state is
physical evidence, not a guarantee that an earlier unresolved effect cannot start
later. Game readiness and installer artifact/exit-code validation remain distinct
from provider-reported completion; no Minecraft, Satisfactory or M3 gateway
capability is claimed here.

## Completed validation runs

Commands use the pinned user-local toolchain. The final broad suites ran after the
last implementation change. Focused runs overlap broader suites and must not be
added together; the strict SFTP diagnostic remains a deliberate failing result.

| Command or scope | Recorded result |
| --- | --- |
| `scripts/dev.sh pnpm install --no-frozen-lockfile` | Dependencies installed; package build scripts remained disabled. |
| `docker compose --env-file .env.m2-test.local -f compose.m2-test.yaml config --quiet` | Passed before the approved stack was started. |
| `scripts/dev.sh pnpm test` | 250 ordinary unit tests passed in 15 files (final run). |
| `scripts/dev.sh pnpm test:m2` | 15 integration files: **252 ordinary tests passed plus three known expected-failure assertions**, 106.10 seconds (final run). Full transport revocation did not pass. |
| Focused authorization/API suites | 64 passed together; subsequent API/runtime checks passed 42, then the runtime-only suite passed 27 after physical restart wiring. |
| Physical memory and migration regression suites | Six files, 103 passed: admission, installer admission, memory overhead/backfill, lifecycle, Redis delivery and registry. |
| Restart and already-stopped regression suites | Final lifecycle 72/72 and runtime 28/28 passed. Includes 20 restart-proof cases plus no-effect stop, subsequent start/delete, retained reservations, both reservation races and host/identity/authorization failures. |
| Focused adapter suite after the actual control-frame compatibility fix | 125 passed; real relay status/stats were also observed against the test-owned server. |
| `scripts/dev.sh pnpm typecheck` | Passed on the final implementation tree. |
| `scripts/dev.sh pnpm lint` and `scripts/dev.sh pnpm format:check` | Both passed on the final implementation tree, 103 files each. |
| `python3 scripts/check-test-persistence.py --m2 --restart-approved-test-services` | Passed again after migration 006: all six migrations, settings marker, queued job, outbox, checkpoint and Redis marker survived the approved PostgreSQL/Redis restarts; generated restart fixtures were cleaned. |
| Strict SFTPGo diagnostic above | Three retained-SSH-transport assertions failed, matching the documented limitation. |

The integration wrapper validates the approved Compose project/service/network
identity before constructing private test URLs. It does not fall back to an
application database or Redis URL. PostgreSQL suites use isolated schemas; Redis
delivery uses unique prefixes. Cloudflare writes are mocked. SFTPGo tests use
only isolated UUID directories outside Wings volumes, exercise actual SSH/SFTP
read/write, and reject cross-server paths, traversal and symlink escapes.

Admission coverage includes simultaneous starts at user/host limits, CPU-only
exhaustion, unrelated workload pressure, stale observations, restart/stop
retention, storage/backup exhaustion and temporary overrides. Installer tests
cover concurrent installers and game starts under one physical lock. Lifecycle
coverage includes timeout-after-success, crash-after-provisioning, duplicate
Redis delivery, lost Redis delivery recovered from PostgreSQL, new worker
processing, terminal-proof persistence and no import of unrelated servers.
HTTP tests exercise authenticated cross-user/project/support boundaries, logout
and role changes, console/file/backup isolation and safe errors.

Final index governance checks passed for **166 indexed text files, 46 relative
Markdown links, four TOML/profile files and 44 ignore cases**. Staged and worktree
whitespace checks passed. Exact comparison against the seven protected local
credential values found no matches in indexed content. Independent publication
review inspected every staged file and the final delta; no real environment,
persistent state, archive, private address/path, closed-source extension, workflow
or license was introduced. GitHub authentication is `ImJstNickDev`; repository
Actions remain disabled. The M0 Codex/governance files and all three recorded
private-file fingerprints are unchanged. The PR records the final commit SHA.

## Controlled live attempts and provenance

The private durable ledger records each creating run/PR, timestamp, external ID,
Pterodactyl numeric ID/UUID and verified API identity. It remains under ignored
`mountdata/test-assets/`; isolated failed-run schemas and job records are retained
for diagnosis. Every rollback mutation corroborated ledger ownership against the
API first. No naming prefix was treated as ownership proof.

| Attempt | Test-owned assets | Outcome and cleanup |
| --- | --- | --- |
| 1 | None | Fixture validation stopped the harness before server creation. No live asset was created. |
| 2 | ID **34**, UUID `33c84231-5f9e-4a14-862c-d5a454e0b290` | Actual authenticated control frames omitted `args`, so installation proof was missed. The operation was not falsely completed. Parser fixed and adapter regressions passed. Reviewed rollback through normal Pterodactyl API completed; the test server was deleted. Failed ledger/schema retained. |
| 3 | ID **35**, UUID `172a6e6a-70a6-41a7-bfa4-382251a71e64`; ID **36**, UUID `e384a34d-fa46-4042-819d-7bff59c8b656`; ID **37**, UUID `1e8aff25-7dc1-49cf-b05f-92051f0815df`; ID **38**, UUID `299ba0a7-d0c3-492c-9722-ee2f3a8177fa` | All four installed offline under the existing aggregate over-allocation, with zero active-game reservations. The inline fixture shell command was split by the actual entrypoint and exited with code 0; it did not establish the intended running/readiness flow. Capacity correctly remained held. Reviewed normal-API rollback deleted all four; pre-existing servers were unchanged. Original failed jobs/schema and ledger retained. |
| 4 | ID **39**, UUID `fd3c2704-eb50-4220-8af6-3e17a346fed5` | Provisioning completed. An absolute fixture-upload path was locally rejected before a file write or start. Harness corrected to use a relative path and decode returned bytes. Reviewed normal-API cleanup verified server/container absence and unchanged pre-existing servers. Completed provision schema and ledger `m2-live-08530e04-caa2-43e6-ac5a-972544a15a15` retained. |
| Successful final run | ID **40**, UUID `525a69b3-f1aa-4f4b-aee7-7140adc3d0e9`; ID **41**, UUID `4e5cef48-ef1c-4e9e-a167-f89438b698b6`; ID **42**, UUID `01642fcd-9a7a-4965-84f9-5e0fe9b59d1b`; ID **43**, UUID `40c5c32d-6fc8-4a73-9cae-6e3193ef5033` | All four installed offline and passed script write/read-back. Initial start exposed the actual Wings memory overhead, prompting migration 006 and physical admission corrections. A qualified product stop succeeded. The same four fixtures resumed after migration, identity and script checks. Corrected physical limit, simultaneous admission, live console, restart, stop, file round-trip and backup creation passed. Fast-restart evidence was hardened after cached uptime missed a reset; a fresh worker recovered it without replaying power. Restore content, build change to 128 configured units (147,200,000 Docker bytes; 148 MiB reserved), qualified stop, reinstall, wipe, backup cleanup and all four server deletions passed. The final isolated schema was dropped; the durable ledger remains. |

The successful run completed at 2026-10-09 10:13 UTC. It established its own complete
acceptance path using four stopped fixtures, fresh resource admission, exactly one
admitted simultaneous start at the one-server quota, real backend console command
response, restart reservation retention and qualified stop release. The live
harness command was:

```sh
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec tsx scripts/m2-live.ts .codex/local/m2-live-plan.json --owner-authorized --resume-ledger mountdata/test-assets/m2-live-d5d94cf2-a23e-4f19-9f42-01548b557d97.json
```

The plan and ledger are deliberately private. The guarded resume checked all four
identities, the original isolated schema, no active operations/reservations and
fixture contents before continuing; it did not create replacement servers. A
fresh run omits `--resume-ledger`. All mutations used the dedicated adapter and
fresh provenance checks. The earlier failed attempts remain failures with reviewed
rollback; they are not counted as successful lifecycle runs.

A separate read-only final audit at 10:14 UTC checked **all ten test servers**
across the five recorded attempts: every external-ID lookup was absent, every
numeric-ID lookup returned not-found, and no exact normal or installer Docker
container remained. All **24 pre-existing Application server configurations**
matched the original inventory. The final ledger and audit stay under ignored
`mountdata/test-assets/`. No SFTP directory was ever mounted from Wings.

## Approved isolated resources and cleanup status

The Owner approved `compose.m2-test.yaml`: pinned PostgreSQL **18.6** (384 MiB),
Redis **8.10.2** (192 MiB), SFTPGo **2.7.6** (256 MiB), each limited to one CPU, with
only the internal `nickhosting-m2-tests_default` network. Port declarations are
random and loopback-only. Docker may suppress publication on an internal network;
the test wrapper then discovers only verified project-owned container addresses.
No existing network or Wings directory is attached.

A separately approved temporary network-disabled directory-preparation helper
created only new paths under `mountdata/m2-tests/` and `mountdata/test-assets/`,
assigning the necessary new SFTP directory ownership. The root-owned parent and
M1 data were unchanged; the helper removed itself. Approved PostgreSQL/Redis
restarts have passed during resumed testing. Bind-mounted data and local mode-0600
environment files remain gitignored.

**Final cleanup:** a read-only audit after the last full suite verified zero
ordinary test schemas, Redis keys, SFTP users, SSH connections and SFTP fixture
directories. Exactly **three failed-attempt PostgreSQL schemas** remain deliberately
preserved for diagnosis, along with all five live ledgers and the final audit.
The successful live run's schema was dropped. Approved scoped Compose `down`
removed the three test containers and only their new internal network; follow-up
Docker label queries verified zero remaining resources for this project. Ignored
bind data, environments and evidence were retained. Nothing unrelated was removed.

## Historical pause checkpoint

The first pause preserved WIP at `094cdf5132f1dbd1bd14d71f39e710c1a33e57b4`.
At that checkpoint, adapter unit tests were 42 passed, external-service unit tests
15 passed before a later untested DNS edit, and the last lifecycle integration run
23 passed. The SFTPGo suite then had one passing isolation test and three ordinary
failing transport-revocation tests. Typecheck passed; lint and format checks
failed. Authorization/rejected-provision edits and the resulting 24-test lifecycle
suite had not yet been rerun. Those statements are historical, superseded by the
resumed implementation and completed runs above.

The pause publication checks passed for 140 indexed text files, 28 relative links,
four TOML files and 44 ignore cases; `git diff --cached --check` passed. These are
not final checks of the newly integrated tree. At the pause there were no live
Pterodactyl test assets. Zero generated PostgreSQL schemas, Redis keys and SFTP
fixture directories were verified before the approved three test containers and
sole test network were removed. The stack was later restarted under the existing
explicit approval when the Owner authorized resuming M2.

## Remaining review gate and rollback

**Independent functional/safety review is complete with no remaining must-fix.**
The reviewer independently inspected the final source/contracts, regression tests
and sanitized cleanup evidence. Resolved findings included physical overhead
accounting, terminal stop/install evidence, fast-restart recovery without replay,
authorization after waits, bounded streams and the already-stopped Stop deadlock.
The coordinator then completed the full integration suite and scoped cleanup.
Publication review is a separate hygiene check, not a substitute for those tests.

There is no remaining M2 approval blocker under the Owner's explicit waiver.
The SFTP exception and [issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18)
remain a production-release gate. Future deployment, real Wings mounts, Docker
socket access changes and DNS writes still require their own exact approvals;
none were applied. Conservative capacity refusal, quarantine when terminal proof
is unavailable and the independent Panel allocation-writer race remain documented
operational limitations. PR #17 is for review only; M3 has not started.

Main remains the reviewed M1 baseline. NickHosting has not been deployed and no
production database was migrated. Before merge, rollback means leaving M2
unmerged, preserving ignored evidence and using only reviewed normal API cleanup
for ledger-proven test servers. The approved scoped stack cleanup command is:

```sh
docker compose --env-file .env.m2-test.local -f compose.m2-test.yaml down
```

This retains ignored bind-mounted data; it is not approval to delete failed-run
schemas, ledgers, production data or unrelated resources. Future deployment,
real Wings mounts, socket access changes and real DNS writes need their own
approval. **Do not merge M2 or start M3.**
