# M3 implementation and validation record

**Status: M3 acceptance passed; open for Owner/ChatGPT review.** Branch
`milestone/m3-game-gateway`; [PR #19](https://github.com/ImJstNickDev/nickhosting-panel/pull/19).
Scope is issues [#8](https://github.com/ImJstNickDev/nickhosting-panel/issues/8) and
[#9](https://github.com/ImJstNickDev/nickhosting-panel/issues/9). M4 has not started.
The temporary SFTPGo exception and issue #18 are unchanged.

## Approved M2 merge

The Owner authorized only PR #17 at
`772f37bab0c4a0ca6ec3604e045751f6ae1b5c6d`. Authentication as `ImJstNickDev`,
clean worktree, open/mergeable status and `main` base were verified before
`gh pr merge 17 --squash --match-head-commit 772f37bab0c4a0ca6ec3604e045751f6ae1b5c6d`.
The merge produced main `f67dd5041ac35992ec3b34ae3d928523474d94e8`; issues #6/#7
closed. Local main was fast-forwarded and its complete tree matched approved M2.
All 23 recorded ignored local-file fingerprints were preserved.

## Implemented acceptance

| Requirement | Evidence |
|---|---|
| Permanent separate Gateway | Executable with supervised retry, authenticated leased Core snapshots, durable registry/revisions/proofs, private Unix diagnostics, bounded TCP/UDP sessions and buffers. |
| Same-number, multiport forwarding | Actual approved Docker fixture: four routes/two roles, identical numerical ports on private backend and loopback frontend, 32 concurrent binary clients. |
| Direct-server isolation | Fresh inventory of all 400 real Pterodactyl allocations remains in each fixture gate. No real server imported, created or mutated. Explicit managed UUID/claim/node identity only. |
| Topology safety | Actual socket/interface/namespace/Docker checks, wildcard/mapped/dual-stack conflicts, both transports and stopped assignments; independent protocol and node-nonce reachability. Negative fixtures fail closed. |
| Route recovery | Restart, removal, stale/replayed revisions, partial bind rollback, lease expiry and API outage coverage. Deletion waits persisted issued lease before releasing backend claims. |
| Sleep/wake | Complete-role oldest-timestamp observations, current consent, exact running process and game readiness; passive/manual suppression, bounded quiescence before idle stop. |
| Atomic admission | Forty concurrent joins collapse to one M2 operation and reservation; API burst test also uses actual PostgreSQL admission. Exhaustion immediately blocks; no automatic capacity queue or eviction. |
| Worker/Redis recovery | Actual isolated Redis client interruption/lost queue delivery; durable PostgreSQL outbox recovery and worker loss after remote success, without duplicate power. |
| Startup timing | Actual process-to-game-readiness samples, stale/outlier/runtime filtering, null until five representative measurements. |
| Configuration and i18n | Strict Owner/environment precedence, disabled by default, no inferred production address/node/network; English/Italian state keys. |

[API/configuration](M3-API.md), [Gateway design](GAME-GATEWAY.md) and
[ADR 0012](decisions/0012-gateway-leases-and-sleep.md) describe contracts and rollback.
No Minecraft/Satisfactory protocol or graphical frontend compatibility is claimed.

## Actual commands and results — 2026-10-09

Runtime: Node **24.21.0**, pnpm **10.33.0**, TypeScript **7.0.2**, using the existing
user-local installation via `scripts/dev.sh`. No system/runtime upgrade occurred
in M3. Offline workspace linking reused cached dependencies without downloading
new versions. Before the M3 fixture, available memory was **22,893 MiB**, with
**80 GiB** free disk; the two fixtures are limited to 128 MiB and 0.5 CPU each.

| Command | Result |
|---|---|
| `scripts/dev.sh pnpm lint` | PASS; 150 files. |
| `scripts/dev.sh pnpm format:check` | PASS; 150 files. |
| `scripts/dev.sh pnpm typecheck` | PASS. |
| `scripts/dev.sh pnpm test` | PASS; **481 tests / 26 files** on final code. |
| `scripts/dev.sh pnpm test:m3` | PASS; **484 tests + 3 expected failures / 25 files** (487 total); all M1/M2/M3 integrations. |
| `python3 scripts/check-test-persistence.py --m2 --restart-approved-test-services` | PASS; all 11 migrations, settings, queued job/outbox/checkpoint, immutable allocation identity, upload claim, Gateway consent/wake job, route lease/revision/proof and Redis marker survive scoped restart. |
| `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec tsx .codex/local/m3-isolated-final-audit.ts` | PASS; zero ordinary test schemas, Redis keys, SFTP users/connections/directories. Three historical failed-run schemas retained deliberately. |
| `git diff --check` | PASS. |

The SFTPGo tests use their unchanged expected-failure markers: retained SSH
transports can reopen SFTP after credential rotation, deletion or disconnect.
These are **not security passes**, and remain issue #18 before production release.

The integration run preceded only the final read-only observer parallelization
and removal of redundant online backend validation. The subsequent full unit,
type/lint runs and actual fixture runs cover those final changes. There is no
unreported test skip or mock replacement for production code.

## Actual network fixture and safe resource use

The Owner explicitly approved `compose.m3-test.yaml`: two pinned Node fixture
containers, one separate NAT bridge, exact private bridge-IP bindings and loopback
Gateway endpoints, scoped game stop/start and cleanup. No existing network,
production data mount, provider allocation, firewall policy, resolver or public
listener was changed. Docker's normal rules/routes belonged only to the approved
new project. See [exact proposal/results](M3-TEST-INFRASTRUCTURE.md).

Preflight rechecked host memory/disk, disjoint routes/subnet, Docker bindings, host
sockets and 400 real provider allocations. The creating run and exact container,
image, network, creation timestamp and verified API identity were recorded before
listeners or scoped restart:

`mountdata/test-assets/m3-network-24a0618f-1450-4ae6-a333-28a5ad32bd88.json`

This is a **synthetic fixture container UUID**, not a created Pterodactyl server.
The ledger and actual topology/environment stay ignored. Online, actually-stopped
sleeping, and recovered phases passed. Sleeping restart used unchanged durable
binding proofs plus fresh same-address TCP/UDP node challenges; status caused
zero wakes. Every phase retained real provider allocation inventory.

The initial broad fixture budget was deliberately retested with product limits.
It exposed a three-second timeout and opened zero listeners. Independent reads
were then parallelized with at most four node-inventory requests and no stale
cache; redundant online proofs were removed. Final default-policy run passed with a **15-second lease / three-second probe**:
four-route startup **6,564 ms**, full renewal **2,916 ms**, restart **5,660 ms**,
and two-route reconciliation **1,508 ms**. No production-scale load test
or arbitrary-route-count throughput guarantee is inferred from four fixture routes.

Cleanup completed after rechecking exact container IDs, creation timestamps,
images, Compose labels, configured paths and sole network membership. Both M3
containers and their one network are absent. The three approved M2 test services
and their internal network were also removed after persistence tests and the
clean-state audit. Their bind mounts, three historical failed-run schemas and
all provenance remain intact. No global prune or unrelated cleanup occurred.

## Independent review and resolutions

Bounded agents implemented transport/SDK, network safety and orchestration;
coordinator integrated API/configuration/worker/deployment/testing. An independent
reviewer found and verified fixes for:

- Partial multiport readiness/idle evidence and end-of-batch timestamp freshness.
- Old topology evidence before bind and unbounded offline UDP work/replies.
- Session logout/demotion while route/policy/manual-stop requests wait on locks.
- Cached route survival beyond allocation release; persisted lease drain now
  fences deletion and cascades retired routes/proofs on confirmed cleanup.
- Retired/invalid Gateway state starving other worker reconciliation.
- Blocked intentional joins failing to retry after capacity recovery.
- Equivalent expanded/compressed IPv6 allocation identities.
- New joins crossing idle reports: complete-server ingress quiescence, repeated
  transactional evidence checks and a final durable pre-power handoff. Expiry,
  lost response, worker crash and route disable/re-enable retain conservative
  blocking. Cold runtime quarantine is 31 elapsed seconds.

Late parallel-read and duplicate-check removal changes received independent code
clearance. No remaining must-fix code findings were reported. A separate full-file
publication audit found no secrets, infrastructure notes, forbidden artifacts,
Actions or license additions. Indexed governance and literal-secret checks are required before publication;
results are recorded in the PR alongside its final HEAD.

## Deployment limits and Owner decisions

- Production Gateway has **not** been deployed and no public game port was bound.
- Current-user fixture namespace reachability was measured. Independent production
  host-namespace observation remains unverified because the host PID 1 namespace
  is unreadable to this user. Do not change permissions or treat self-proc as proof.
- Initial deployment supports verified same-host bridge/NAT semantics. Different
  ingress, network modes, actual public IP ownership and every intended public
  endpoint require exact preflight and separate deployment approval.
- The persistent private node responder, Docker/socket access and the unapplied
  user-service template require separate review/approval. No responder exists in
  production. First-ever sleeping registration needs an admitted manual start to
  establish its exact game-protocol proof.
- Measure control-plane latency and provider request limits for the intended route
  count before production. All topology/provider facts are refreshed; large route
  sets have not been load-tested. Expired evidence refuses service, never bypasses
  collision checks to meet a timing budget.
- Real game codecs/save/readiness compatibility remain M4/M5; full UI remains M6.
- Preserve the SFTPGo issue #18 release blocker. No proxy, fork or workaround added.

Rollback stops the Gateway and waits outstanding authority before altering its own
endpoints. Preserve durable jobs, uncertainty/reservations and provenance; do not
blindly reverse provider effects or drop active-state migrations. M3 remains open
for Owner/ChatGPT review and must not be merged by Codex.
