# M2 Owner review corrections

This revision addresses the four findings against PR #17 at
`a6f693986fdfe1624b8e1b06fc4f4ff16b8eee79`. It stays on
`milestone/m2-server-management`; no merge or M3 work is authorized.
Final validation and independent review passed on 2026-10-09. The earlier live
lifecycle evidence and ten-server cleanup remain in [M2 validation](M2-VALIDATION.md).

## 1. Restart admission

An existing same-resource reservation has zero new RAM/CPU demand. Admission no
longer charges that commitment, or other already committed reservations, against
sampled free memory again. It still checks fresh host evidence, actual safety
headroom, enabled node, reservation ownership, user quotas and aggregate hard
physical ceilings. Positive growth and new starts require admission; repeated
worker checks retain the existing reservation and never shrink it.

RAM and CPU deltas are independent. If a reservation predates the host sample,
positive growth charges its delta plus other full commitments. If the reservation
was updated at or after that sample, the full proposed commitment is charged to
avoid repeatedly spending unobserved free capacity. No stale provider telemetry
creates capacity credit. Tests cover high-load restarts, repeated worker checks,
new-start refusal, growth/concurrency, policy/overhead changes and uncertainty.

## 2. Explicit backend allocation pools

Migration 007 adds nullable per-node pool configuration, without selecting or
seeding any live allocations. An Owner must pin provider allocation IDs, exact
private addresses and ports, with disjoint declared gateway bind addresses.
Fresh node inventory is validated at reservation and immediately before a new
remote create. Unconfigured, exhausted, assigned, drifted, public, wildcard,
aliased or colliding allocations cannot become an implicit fallback.

Environment overrides take precedence and lock conflicting Owner edits. Offline
claims remain stable; disabling a pool blocks new creation without preventing
recovery of an already-created, proven owned server. Canonical IPv6 is preserved
through inventory validation, stored claims and later node saves. The live harness
now also requires a reviewed pool in its private plan; historical public-allocation
plans fail closed. No allocation, network, gateway listener or production setting
was created or changed during this revision.

## 3. Optional total server-count policy

`maxServersPerUser` defaults to `null`, meaning no total-count cap. A positive
Owner setting or explicit environment value enables a cap; environment literal
`null` can disable a stored cap. Storage, allocation availability, invite-only
access and idempotency remain enforced.

A separate configurable pending-provision guard defaults to four. It limits
unfinished provisioning, including retained uncertain installer work, rather than
completed offline servers. Atomic regressions create more than 20 stopped servers,
enforce explicit caps, preserve storage limits and reject concurrent excess work.

## 4. Browser binary transfers

The API accepts raw binary uploads with an exact declared byte length and streams
multipart data to the private Wings upload URL. The JSON text-editor endpoint
remains separately bounded. File and backup downloads stream with backpressure,
without the previous 1 MiB/1 GiB caps or a fixed total-duration deadline.

Transfer memory is bounded independently of payload size. Both directions enforce
idle limits, current authorization, cancellation, exact lengths and private token
mediation. Uploads use a separate exact destination allowlist and hold the server
write lock until completion. Interactive contention rejects promptly and uploads
leave database connections available for authentication and logout. Native Node
request handling exempts only the canonical upload route from its total body
deadline; ordinary body, header and inactivity protection remain enforced.

Read-only inspection found a native Wings maximum of **500 MiB per uploaded file**.
The official [Wings v1.11.13 upload handler](https://raw.githubusercontent.com/pterodactyl/wings/v1.11.13/router/router_server_files.go)
parses multipart data before checking that limit. The backend therefore needs a
verified provider bound and an independent temporary-disk policy, not just the
server's final disk allowance. Migration 008 adds disabled-by-default policy and
one durable ingestion claim per physical host. Admission reads the configured
disk-backed staging and destination filesystems and reserves twice the payload
plus bounded framing, because the tempfile and destination copy can coexist.
Existing-file overwrite credit cannot fund temporary spooling.

The claim survives ambiguous results and crashes, blocking further host uploads
and affected-server file/lifecycle mutations until audited Owner recovery confirms
external completion and temporary cleanup. Recovery cannot release an active
transfer. Interrupted uploads may leave partial provider files; they do not
produce a successful response or automatic destructive rollback. Raising the
actual provider limit or changing an observation mount still needs separate
approval. No such change was made.

Real loopback HTTP tests include a generated download larger than 1 GiB with
bounded resident-memory growth and a streamed 32 MiB multipart binary upload.
Additional tests cover Hono/Node streaming, slow consumers, truncation, cancelled
requests, expired sessions, changed permissions, path isolation and provider errors.

## Independent review and final validation

Independent review identified an already-aborted transfer promise rejection,
an IPv6 canonicalization mismatch, upload database-pool starvation, native Node's
total upload deadline and Wings temporary-disk admission. Each received targeted
corrections and regressions. The independent reviewer found no remaining must-fix
issues after the final broad suites, persistence checks and scoped cleanup. A
separate publication reviewer inspected all 48 staged correction files.

Validation uses the pinned user-local Node **24.21.0**, pnpm **10.33.0** and
TypeScript **7.0.2**. No runtime installation or dependency upgrade was needed
for this correction round. Focused and full-suite totals overlap.

| Command or check | Result |
| --- | --- |
| `scripts/dev.sh pnpm test` | 293 unit tests passed across 17 files; 4.49 seconds. |
| `scripts/dev.sh pnpm test:m2` | 361 ordinary tests passed plus 3 known expected failures across 18 files; 160.33 seconds. |
| `scripts/dev.sh pnpm typecheck` | Passed. |
| `scripts/dev.sh pnpm lint` | Passed, 114 files. |
| `scripts/dev.sh pnpm format:check` | Passed, 114 files. |
| `python3 scripts/check-test-persistence.py --m2 --restart-approved-test-services` | All eight migrations, settings, queued job, outbox/checkpoint, ambiguous upload claim and Redis marker survived actual scoped PostgreSQL/Redis restarts; generated fixtures cleaned. |
| `python3 scripts/check-governance.py` | 180 indexed text files, 53 relative links, 4 TOML files and 44 ignore cases passed. |
| Staged diff/whitespace inspection and exact credential comparison | Passed; 7 protected environment literals absent from all 180 indexed files; 3 protected local-file fingerprints unchanged. |
| Final isolated-resource audit | Zero ordinary test schemas, Redis keys, SFTP users/connections or fixture directories; exactly 3 historical failed-run schemas retained. |
| `docker compose --env-file .env.m2-test.local -f compose.m2-test.yaml down` | Approved stack removed; follow-up project-label queries found 0 containers and 0 networks. Ignored bind data retained. |

Focused evidence overlaps the full suites: 29 restart-admission regressions,
16 durable upload-admission tests, 29 Hono server-route tests and 15 real Node
HTTP listener tests passed. Adapter transfer tests generated a download larger
than 1 GiB while keeping measured RSS growth below 128 MiB, plus a 32 MiB binary
multipart upload. A separate 126-test registry/runtime/lifecycle run verifies
that retained uploads cannot race later mutations. These counts must not be
summed as independent total coverage.

The SFTPGo 2.7.6 waiver is unchanged: three retained-SSH-transport assertions remain
known expected failures, not successful revocation tests. [Issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18)
remains a production-release gate. No SSH proxy, fork or workaround is introduced.

## Safety, configuration and rollback

Only the exact previously approved isolated M2 PostgreSQL/Redis/SFTPGo stack was
restarted for these tests. Existing infrastructure, private environment values and
historical provenance ledgers are preserved. No new live Pterodactyl server was
created for this correction round, and no real DNS write or Wings mount occurred.
The three isolated containers and their sole network were removed after validation.
Historical live UUIDs, all five private ledgers and their prior verified cleanup
remain unchanged; the original live harness was not repeated against an
unconfigured backend pool.

Before deployment or a future live fixture run, the Owner must configure a verified
backend pool, trusted transfer destinations and verified upload policy. The
existing 500 MiB provider maximum, observation access and temporary staging
budget must be reviewed before enabling uploads. Interrupted uploads may need
manual Owner recovery; no automatic completion is inferred. Any required production allocation,
network, provider-limit or mount change needs its own approval. These are deployment
prerequisites, not changes silently applied by this PR.

There are no unresolved implementation or review blockers for this M2 revision
under the existing SFTPGo waiver. These prerequisites do not authorize deployment.
The PR stays open and unmerged for another Owner/ChatGPT review. Rollback is to leave it unmerged and retain the
ignored diagnostic evidence. Migrations 007–008 change only the project schema;
they have not been applied to a production database. Do not drop existing data,
delete uncertain upload claims, or rewrite history. Detailed contracts are in [M2 API](M2-API.md) and
[ADR 0011](decisions/0011-server-lifecycle-and-service-boundaries.md).
