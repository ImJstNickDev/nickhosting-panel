# M2 implementation and validation record

M2 is **paused and incomplete**, by Owner decision, on
`milestone/m2-server-management`. Draft [PR #17](https://github.com/ImJstNickDev/nickhosting-panel/pull/17)
must remain a draft. Acceptance is tracked by
[issue #6](https://github.com/ImJstNickDev/nickhosting-panel/issues/6) and
[issue #7](https://github.com/ImJstNickDev/nickhosting-panel/issues/7).

## Reviewed baseline

The Owner authorized the one-time squash merge of PR #16 at exactly
`9077006d73e6184fd9ba14c0f4efd15a03e8ece5`. Authentication, open state,
mergeability, base and clean local workspace were verified. The resulting
`main` commit is `b1a71ef52721e413e861d410954d06fd743b883c`; issues #4 and #5
are closed. Local main was fast-forwarded and its tree matched the approved
M1 tree. Ignored notes and environment files were preserved.

## Acceptance evidence pending

- Installed Pterodactyl source and API compatibility, explicit allocation
  provisioning under intentional aggregate over-allocation.
- Managed registry, lifecycle operations, authorization and private console
  mediation; files, backups, metrics and historical activity.
- Atomic active RAM/CPU admission, storage and multiport ownership.
- Durable jobs and uncertain-effect recovery without unrelated imports.
- Isolated SFTPGo filesystem tests and mocked Cloudflare DNS lifecycle.
- Provenance for every live test server, verified cleanup, independent review.
- Lint, formatting, types, unit/integration and governance checks.

No M2 completion claim is made until the above evidence is recorded. M3,
game-specific integrations and graphical frontend work remain outside scope.

## Infrastructure boundary

Production Panel, Wings, existing networks, services, direct servers and DNS
remain unchanged. New test infrastructure requires exact Owner approval.
Live mutations are restricted to conservatively sized servers with durable,
corroborated Codex provenance. Private credentials and infrastructure evidence
stay in ignored local files; public evidence is sanitized.


## Pause decision and blocking evidence

The Owner selected **“Pause M2 pending an upstream/provider decision”** after
reviewing the SFTPGo revocation defect. Implementation stopped immediately.
No SSH intermediary, provider patch, replacement provider or production
configuration change was implemented. The WIP is preserved for review; it is
not a deployment candidate or a completed milestone.

The pinned isolated SFTPGo 2.7.6 service accepts a new SFTP channel on a retained,
already-authenticated SSH transport after each of:

1. Explicit `DELETE /api/v2/connections/{id}`.
2. Password rotation with `disconnect=1`.
3. Account disable/disconnect followed by deletion.

Existing channels close and fresh logins with the old password are refused,
but the retained transport still reads its original directory. Thus account
revocation alone does not meet M2's access-revocation requirement. The strict
regressions intentionally fail. The isolated filesystem test passed normal
read/write and rejected traversal, cross-server access and symlink escapes.

An independent reviewer corroborated the cached-user/channel-only disconnect
behavior in official [SFTPGo server code](https://raw.githubusercontent.com/drakkan/sftpgo/v2.7.6/internal/sftpd/server.go)
and [SFTP handler](https://raw.githubusercontent.com/drakkan/sftpgo/v2.7.6/internal/sftpd/handler.go).
No supported transport-level disconnect API remedy was found. The proposed
backend SSH mediation alternative was not authorized; an upstream/provider
choice remains with the Owner.

## Installed Pterodactyl investigation

Read-only inspection identified Panel **1.11.11**, Blueprint **beta-2025-09**
and running Wings **1.11.13**. The seven relevant installed PHP files matched
upstream Panel v1.11.11 byte-for-byte. No closed-source extension was copied.

- `FindViableNodesService::handle`, lines 74–86, sums all configured server RAM
  and disk, including stopped servers.
- `ServerCreationService::handle`, lines 52–99, invokes automatic selection only
  for a deployment object. Explicit allocation provisioning bypasses this
  aggregate-capacity selector.
- `BuildModificationService`, lines 33–74, updates limits independently. Wings
  synchronization failure can be logged while the Panel update succeeds.
- Creation allocation assignment lacks a conditional free/same-node update;
  the proposed registry serializes its own claims and verifies remote identity,
  but cannot make unrelated direct Panel writes atomic with NickHosting.
- Resource responses are cached for 20 seconds. Reservation release must wait
  for trustworthy final state after the mutation/cache boundary.
- Unique external IDs and the exact external-ID lookup support uncertain-create
  recovery. Reinstall does not itself wipe all server files.

The live API confirmed 49,152 MiB configured / 186,368 MiB allocated RAM and
524,288 MiB configured / 534,528 MiB allocated disk, with zero configured
over-allocation percentages. It returned 24 existing servers, four running,
366 unassigned allocations and readable resources for all 24. These configured
aggregates are not physical consumption. Host read-only observations showed
64,302 MiB total RAM, approximately 23,708 MiB available, 14 logical CPUs and
approximately 82 GiB filesystem space available before testing. These are
point-in-time observations, not product defaults or safe admission guarantees.

Application-node and Client-list connection probes passed. Typed adapter
reads of nodes, nests/eggs, allocations, servers/resources and user discovery
also passed. No write permission claim is made: no live provisioning, build,
power, file, backup or deletion test was performed before the pause. End-to-end
active-resource feasibility remains unproven despite the supporting source evidence.

## Work preserved, with integration still pending

- Typed Pterodactyl Application/Client adapters, explicit stopped provisioning,
  safe errors, bounded files/download proxy and backend WebSocket mediation.
- Schema-only migration 004 for registry/projects, resource policies,
  reservations, allocations, operations/events/metrics and provider ledgers.
- WIP registry, resource admission, Owner mapping/policies, lifecycle state
  machine, durable effect checkpoints and jobs processor extension.
- SFTPGo adapter and Cloudflare A/AAAA/CNAME/SRV planning with mocked writes.
- M2 configuration/error/i18n additions and approved isolated Compose harness.

API routes, worker runtime wiring, execution-time authorization callbacks,
external-service persistence orchestration and full admission tests are not
complete. A migration file existing and being exercised in isolated schemas
is not evidence that the full M2 application is integrated.

## Validation actually performed

Commands run from the workspace using the user-local Node 24 toolchain:

| Command/scope | Actual result |
| --- | --- |
| `scripts/dev.sh pnpm install --no-frozen-lockfile` | Workspace dependencies installed; build scripts remained disabled. |
| `docker compose --env-file .env.m2-test.local -f compose.m2-test.yaml config --quiet` | Passed before execution. |
| Adapter unit tests | 42 passed, including a real loopback WebSocket fixture. |
| External-service unit tests | 15 passed before the final unvalidated DNS hardening edit. |
| Lifecycle PostgreSQL integration tests | Last completed run: 23 passed, including concurrent distinct operations with a two-connection pool. |
| SFTPGo integration tests | 4 total: filesystem isolation passed; three retained-transport revocation regressions failed. |
| `scripts/dev.sh pnpm typecheck` at pause | Passed on the preserved WIP. |
| `scripts/dev.sh pnpm lint` at pause | Failed: formatting/export-order errors and one optional-chain warning. No fixes applied after pause. |
| `scripts/dev.sh pnpm format:check` at pause | Failed on two WIP files. |
| `python3 scripts/check-governance.py` | Passed: 140 indexed text files, 28 relative links, 4 TOML files, 44 ignore cases. |
| `git diff --cached --check` | Passed. |

Exact scoped integration commands:

```bash
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/lifecycle.integration.test.ts
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/external-services/src/sftpgo.integration.test.ts
```

After the last lifecycle run, authorization and safe rejected-provision cleanup
changes were added and typechecked, but the resulting 24-test suite was not
rerun. The external-service final DNS hardening edit was not unit-tested.
Root registry/admission/policy changes lack their planned regression coverage.
Full unit/integration suites, live Pterodactyl tests, admission stress tests,
service restart recovery and final functional review remain outstanding.

## Independent review findings

The early reviewer identified premature build-limit publication, nested pool
acquisition, policy-switch validation gaps, failed-install recovery gates,
queued-operation authorization and the SFTPGo defect. Conservative limit
handling, shared-connection lifecycle processing, policy validation and
recovery/authentication hooks were being added when work stopped. Only the
pool regression was included in the last completed 23-test lifecycle run;
remaining changes require integration and independent re-review.

Additional open review points include trustworthy host/managed usage sampling,
restore-result success detection, explicit recovery for ambiguous destructive
outcomes, policy override behavior and all API authorization boundaries.
There is **no final reviewer approval**.

## Approved test resources and cleanup scope

The Owner separately approved the exact M2 Compose stack and a temporary
network-disabled directory-preparation container because the existing
`mountdata/` parent was root-owned. Only new `mountdata/m2-tests/` and
`mountdata/test-assets/` paths were prepared; the parent and M1 data were not
changed. The helper removed itself.

The stack used pinned PostgreSQL 18.6, Redis 8 and SFTPGo 2.7.6 images; memory
limits were 384/192/256 MiB and each service had a 1-CPU limit. Its sole network
was the new internal `nickhosting-m2-tests_default`; all declared published
ports were loopback-only. No existing network or Wings directory was attached.

Each suite removed its generated PostgreSQL schema, SFTP accounts and UUID
fixture directories. Scoped Compose `down` is the approved pause cleanup;
ignored bind-mounted test data and protected environment files are retained.
Before removal, checks found zero generated PostgreSQL schemas, zero Redis keys,
zero SFTP fixture directories and zero Pterodactyl ledger entries. The PR
records the verified final container/network removal result: all three M2
containers and the sole M2 network were removed, and follow-up Docker queries
returned no matching resources. No Pterodactyl test server
was created: the server provenance ledger has no entries or UUIDs to report.

## Resume and rollback

Do not deploy or mark the draft ready. An Owner decision on a supported SFTPGo
remedy/provider or explicit architecture authorization is required to resume.
Then finish the listed integration, test the latest edits, perform controlled
ledger-backed live tests, and obtain independent final review.

Main remains the reviewed M1 baseline. The WIP has not been deployed and has
not migrated a production database. Its rollback is to leave the draft
unmerged and remove only the approved test containers/network. Preserve the
ignored data until the Owner decides its disposition. Never reset production,
remove unrelated resources, merge M2, or start M3 as part of this pause.
