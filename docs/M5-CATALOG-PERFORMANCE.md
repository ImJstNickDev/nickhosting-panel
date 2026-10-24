# Catalog loading measurements — 2026-10-10

Measurement-only checkpoint against source HEAD
`9dd7e1cc8b90277e8cc5fbffdcfb30123403a657`, M5 PR #21. No optimization,
cache policy, catalog ordering or Owner configuration was changed.

## Method and boundaries

A disposable Node process ran inside the existing development API container,
using the current application route handlers and current development PostgreSQL
data: **693 registered and enabled combinations**, with public rollout. It used
one connection with `default_transaction_read_only=on` (verified) and a 15-second
statement timeout. It did not query auth/session tables or secrets, start a
listener, register a user, run migrations or invoke a provider. The development
container environment remained private and was never printed.

The handler principal was a synthetic Owner/user role input, so **session
authentication, authorization middleware latency, reverse proxy, browser network
and rendering are excluded**. Domain rollout/eligibility checks did run on actual
data. This is a service-path replay, not an authenticated browser benchmark.

Three sequential rounds reused one process/connection and the same route-local
metadata cache. Each round replayed all seven Owner pages, then games/runtime/
version requests for Owner and ordinary-user role inputs. Only the first Owner
request had an empty in-process metadata cache; database/OS caches were not
flushed. No restart or load-generating parallel benchmark was performed.

Kysely query logging recorded counts and client-observed query durations grouped
by table, without SQL parameters or row contents. Fetch instrumentation permitted
only the existing official Mojang manifest GET and measured through body EOF,
not just response headers. Total elapsed includes handler serialization and local
response consumption; JSON byte counts are uncompressed. The remainder is local
processing/orchestration/scheduling, **not an isolated CPU measurement**. CPU time
overlaps these intervals and is deliberately not added to them. Instrumentation
and concurrent development workloads affect timings; three samples give a useful
diagnostic range, not a p95 or a production capacity claim.

The private harness and raw numeric results remain under ignored `.codex/local/`:
`catalog-profile.mjs` and `catalog-profile-results.jsonl`. Executed command:

```sh
docker exec -i nickhosting-dev-api-1 node --import tsx --input-type=module \
  < .codex/local/catalog-profile.mjs > .codex/local/catalog-profile-results.jsonl
```

## Results

Each row is an individual replay. Durations below are rounded milliseconds;
independently rounded categories may differ from the rounded total by 1 ms.

| Request | Run | Total ms | DB client ms | Mojang ms | Other ms | SQL count |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Owner catalog, all pages | 1 | 1220 | 674 | 149 | 396 | 2093 |
| Owner: games | 1 | 845 | 634 | 0 | 211 | 2774 |
| Owner: runtime choices | 1 | 838 | 636 | 0 | 202 | 2773 |
| Owner: version choices | 1 | 877 | 667 | 0 | 210 | 2773 |
| User: games | 1 | 742 | 575 | 0 | 166 | 2774 |
| User: runtime choices | 1 | 840 | 652 | 0 | 188 | 2773 |
| User: version choices | 1 | 975 | 761 | 0 | 214 | 2773 |
| Owner catalog, all pages | 2 | 957 | 735 | 0 | 222 | 2093 |
| Owner: games | 2 | 1584 | 1252 | 0 | 332 | 2774 |
| Owner: runtime choices | 2 | 843 | 653 | 0 | 190 | 2773 |
| Owner: version choices | 2 | 694 | 535 | 0 | 160 | 2773 |
| User: games | 2 | 709 | 554 | 0 | 155 | 2774 |
| User: runtime choices | 2 | 673 | 523 | 0 | 150 | 2773 |
| User: version choices | 2 | 745 | 584 | 0 | 161 | 2773 |
| Owner catalog, all pages | 3 | 640 | 498 | 0 | 143 | 2093 |
| Owner: games | 3 | 739 | 575 | 0 | 164 | 2774 |
| Owner: runtime choices | 3 | 676 | 529 | 0 | 147 | 2773 |
| Owner: version choices | 3 | 887 | 674 | 0 | 212 | 2773 |
| User: games | 3 | 780 | 618 | 0 | 162 | 2774 |
| User: runtime choices | 3 | 958 | 753 | 0 | 204 | 2773 |
| User: version choices | 3 | 727 | 569 | 0 | 158 | 2773 |

### Owner catalog

- **2,093 SQL queries**, seven 100-entry-or-smaller pages, **1,513,551 JSON bytes**
  in total (1.51 MB decimal). The UI currently waits for every page before showing
  the list, even though its viewport displays only 25 entries.
- First replay: **1,219.94 ms**, including **149.14 ms Mojang** (12.23%),
  674.30 ms DB client time and 396.50 ms remaining local work/wait.
- Cached-manifest replays: **957.50 ms** and **640.38 ms**, with **zero external
  requests**. Differences also reflect runtime warm-up and scheduling; the whole
  improvement must not be attributed to caching.
- Exactly one external request across the entire experiment: official manifest,
  HTTP 200, 277,504 body bytes. No Pterodactyl request.
- SQL breakdown per complete list: 700 combination reads (seven page queries
  plus 693 individual inspections), 693 mapping reads, 693 evidence reads and
  seven settings reads.

### Creation wizard

- Ordinary-user medians: **741.95 ms** games, **840.33 ms** runtime choices and
  **744.62 ms** version choices. Ranges: 709–780, 673–958 and 727–975 ms.
- **Zero Mojang/external calls** in every games/runtime/version replay.
- Games: **2,774 queries**. Each choices request: **2,773 queries**, returning
  the same 693 choices and **185,859 JSON bytes**.
- Each choices request reads 694 combination queries, 693 mappings, 693 evidence
  sets and the same rollout 693 times. This confirms repeated sequential local
  work rather than external metadata waiting.
- Replaying the three user steps costs **8,320 queries** and **2.13–2.56 seconds**
  of aggregate sequential backend time (median 2.47 s). This is not an observed
  click-to-screen duration and excludes user interaction and browser/network time.
- Source inspection confirms runtime and version handlers independently fetch
  `/v1/minecraft/choices` under different frontend query keys. The replay explicitly
  reproduces those calls; their occurrence/timing in the Owner's browser has not
  yet been captured. The configured frontend query freshness window is five seconds.

## Interpretation for the next decision

Persisting Mojang metadata and syncing it periodically would remove cold external
metadata waits from Owner list reads. **That change alone does not address the
measured wizard delays**, since those paths made no external request.

The strongest measured candidates are bulk local reads instead of per-version
queries, one rollout read per catalog, a lighter Owner list with details fetched
on demand, and reuse/prefetch of the authorized catalog across wizard steps.
Server-side pagination/filtering/date ordering would also avoid sending the whole
Owner catalog before displaying one page. These are recommendations only;
implementation awaits discussion with the Owner.

A browser Resource Timing capture was requested as an optional follow-up to add
real request TTFB/download timelines without disclosing cookies or response data.
No authenticated browser timing is currently claimed. Rendering, authentication,
proxy overhead and client network latency remain **unmeasured**, not zero. No
synthetic timing or older fixture screenshot is substituted for those categories.

## Review and safety

Independent read-only review confirmed the harness restrictions, query counts,
category interpretation and distinction between replay and browser evidence;
no must-fix finding. No application code changed, so no unit/full historical
suite was rerun. No production or provider resource was read or mutated, no
settings or availability changed, no containers restarted and no test asset was
created. The disposable profiling process exited and closed its DB connection.
SFTPGo #18 and Docker-socket #22 remain unchanged. PR #21 stays open/unmerged.

## Follow-up — Implemented optimization and repeat measurement

After Owner authorization, repeated the same read-only service-path replay on
**the same 693 enabled combinations**, plus the new 25-row Owner summary request.
Three sequential rounds, identical instrumentation and exclusions; raw evidence is
ignored `catalog-profile-after-results.jsonl` with `catalog-profile-after.mjs`.
The persistent manifest had completed its first worker sync before measurement.
No external calls occurred in any measured request.

| Path | Before SQL | After SQL | Before median ms | After median ms |
| --- | ---: | ---: | ---: | ---: |
| Owner complete catalog, all 693 rows | 2,093 | 21 | 957.50 | 149.47 |
| User games | 2,774 | 4 | 741.95 | 29.37 |
| User runtime choices, all 693 | 2,773 | 3 | 840.33 | 44.62 |
| User version choices, all 693 | 2,773 | 3 | 744.62 | 44.45 |

The current Owner UI instead requests a **25-row summary**: four queries,
**30.33 ms median** (15.89–89.49 ms), **21,721 JSON bytes**, compared with the old
1,513,551-byte full response. This is a deliberately smaller response, not a
like-for-like full-payload speedup. Equivalent complete-catalog after samples were
227.71, 149.47 and 62.10 ms. User games samples: 29.37/28.32/50.87 ms; runtime:
92.91/44.62/26.25 ms; version: 44.45/100.89/26.92 ms. Small samples and host scheduling
still apply; no p95 or real browser click-to-display duration is claimed.

A real Chromium test now separately confirms one games request prefetched from
Servers and **one shared choices request** across Runtime → Name → Version,
Show all and Back. Consequently the normal fresh-cache wizard avoids the third
backend request altogether. Its requests use real isolated application handlers
and database data, with external metadata/provider fixtures; this establishes
request reuse, not production latency. The public development login returned HTTPS
200 with an actual Vite connected frame over WSS after the source updates.
