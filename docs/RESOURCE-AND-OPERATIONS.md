# Resource budgets, server lifecycle, job engine

## Active compute quota

**Core invariant:** configured RAM/CPU of a stopped server does not consume that user's active compute budget. Creating many offline servers is allowed subject to persistent storage, IP/port allocations and reasonable platform abuse safeguards.

Illustration: 16 GiB active RAM allowance, three 4 GiB servers running, one other 4 GiB offline, and an additional 16 GiB offline server. User can create and retain both offline servers. Starting the 16 GiB server requires freeing all 12 GiB currently reserved first.

Reservations count servers in `starting`, `running`, `restarting`, `stopping` (until stop *confirmed*). Restart **retains** reserved compute. Reserve atomically under PostgreSQL locking/transactions; idempotency on start requests avoids double reservation. Pterodactyl/Wings actual state is reconciled; do not free resources on merely receiving stop request.

Per-user budget is a limit; physical node admission separately verifies an Owner-configured safe compute capacity and headroom. CPU limits require a documented mapping from Pterodactyl percentages to a meaningful NickHosting quota; avoid claiming guaranteed physical-core reservations if underlying mechanism only enforces a CPU percentage.

**Important Pterodactyl incompatibility:** some Pterodactyl capacity paths count the configured memory of all servers. Do not quietly assume that NickHosting's active-only policy works just by choosing a node explicitly. Investigate Pterodactyl API creation, node capacity, server limits updates and allocation eligibility on the installed version. Design/tests must demonstrate many stopped high-RAM instances can be created/started under the chosen safe policy **without changing core Pterodactyl/Wings code**; otherwise raise a blocker and propose alternatives for Owner approval.

## Storage policy

- Owner setting chooses `GLOBAL_POOL` (default) or `PER_USER_BUDGET`; allow switching policy with validation of existing use.
- Persistently occupied bytes count when server stopped, including backups according to configured storage policy. Distinguish observed usage and reserved/maximum disk allowance. Provide safe capacity margin and alert when node space becomes scarce.
- Enforce per-server hard disk limits where Wings/Pterodactyl supports them; aggregate consumption may require monitoring and throttling. No false claim of strict instant global aggregate filesystem quota without implementing actual enforcement.
- Owners may grant temporary exceptions with an audit trail. Do not delete user content to recover quota without explicit consent.

## Ports and addresses

- Each game/runtime profile declares required `port roles`, protocol TCP/UDP and optional additional ports. Stable public endpoint(s) owned by gateway; separate private backend bind IP, usually **same numeric port** when IP differs.
- Pterodactyl direct Owner-created servers use their normal public allocations, outside gateway namespace/routes.
- Allocations remain owned/reserved while a server is offline. Detect allocation exhaustion against verified inventory; historical host capacity observations belong only in local infrastructure notes.
- For Gateway routing, require a verified public bind vs backend bind matrix; no accidental wildcard IP binds that conflict with existing Docker published ports.

## Lifecycle state dimensions

Represent **distinct** independent dimensions:

- Runtime/process: `offline | starting | running | stopping | unknown` (external actual state).
- Game readiness: `unknown | loading | ready | degraded` (game-specific probe).
- Intent/policy: `manually_stopped | sleeping | auto_wake_enabled | maintenance` as appropriate (never conflate manual stop with sleep).
- Operation: `queued | running | waiting | succeeded | failed | cancelled` plus meaningful steps and error codes.

A server can be *process running* but *game loading*. A sleeping server can be *process offline* but *gateway online*. User-facing state derives from this model.

## Redis + BullMQ and PostgreSQL

- Redis is used for BullMQ job dispatch, rate limits/cache where useful, and lightweight coordination. Enable Redis persistence (AOF) for the project stack; mount Redis data under `./mountdata/redis/`.
- PostgreSQL is the source of truth for jobs, resource reservations, server state, access controls, owner settings and audit. Do not rely solely on Redis for durable business facts.
- Worker jobs: named typed operations, idempotency keys, explicit steps, bounded retries with jitter, timeouts, reconciliation after crash. Treat BullMQ delivery as **at least once**.
- Persist a ledger before side effects when feasible; external API results recorded with idempotency correlation, and uncertain results reconciled before re-execution.
- Progress must be real/step-based (no invented percentage); expose event stream + queryable history.

## Operation flows

1. **Create**: validation → admission for persistent resources → external server provisioning → initial configuration → first start if RAM/node budget allows → readiness; no start if insufficient RAM, but keep created server.
2. **Start**: reserve compute atomically → power API → readiness; failure handling must identify whether process is actually running before releasing reservation.
3. **Stop**: graceful stop; release only after confirmed stopped. Distinguish intentional/manual stop from game sleep.
4. **Idle sleep**: game handler confirms no players/activity for configurable interval → save/graceful stop → turn on gateway sleeping behavior; disabled by per-server setting.
5. **Wake**: actual join recognized (not routine status ping unless game's protocol requires it) → quota admission → if denied reply immediately where possible → if admitted start, report estimated time based on verified recent *ready* durations → switch to routing/handshake behavior.
6. **Install/update mod**: select compatible package/version/dependencies → stage download → apply → mark restart needed or safely restart; UI differentiates downloaded/installed/loaded states.
7. **Replace modpack**: explicit wipe warning, backup-before-wipe selection. If selected backup fails, **do not wipe**. No fake rollback promises.
8. **Backup/restore**: durable operations, confirmation for destructive restore, progress and verification; quota/backup retention policy.
9. **External drift**: read reconciliation discovers admin-created starts/changes; never automatically import or mutate existing unrelated servers.

## Server ownership during live tests

Codex may create, mutate and destroy **only** explicitly proven new test servers. Track Pterodactyl UUID, operation/PR ID and creation timestamp in durable untracked provenance. A matching naming convention is insufficient. Any uncertainty → stop and ask. Do not degrade production node resources.

## Required concurrency/failure tests

- Two concurrent start attempts over shared last available RAM.
- Restart reservation retained during transient stop.
- Power API times out *after* remote server started (uncertain external effect).
- Worker crashes after Pterodactyl server creation but before DB confirmation.
- Manual stop of sleeping server suppresses wake.
- Backend marked running before game ready; gateway stays in waiting mode.
- Gateway/API/Redis restart and reconciliation without duplicate servers or leaked reservations.
- Port collision and failure recovery; shared resource ownership and Owner quota override audit.
