# Directory prefetch measurements — 2026-10-12

Scope: measurement and design recommendation only, on source commit
`4642e289cae0f7c0a6e0a2f343344f97e574087a`, M5 / PR #21. No recursive prefetch,
new cache policy, provider extension or product behavior was activated.

## Evidence boundaries

Three different measurements separate cache cost, application cost and provider
latency. Their datasets and boundaries are deliberately explicit:

1. **Live read-only adapter sample:** nine sequential native directory listings,
   three directories across three rounds, with 750 ms pauses. Uses the normal
   stored per-owner credential and existing Pterodactyl adapter inside dev API.
   A request guard permits only GET of that managed server's native listing
   endpoint. No file bodies, signed URLs, mutations or recursive production crawl.
2. **Isolated HTTP traversal:** real NickHosting handlers, session authentication,
   authorization and PostgreSQL; fixture provider metadata and no-op URL issuance.
   Existing approved M2 test services, disposable schema. Finite trees have ten
   child directories and ten files at non-leaf nodes; leaves have ten files.
   Traversal discovers children from the responses rather than a prebuilt path list.
3. **Chromium cache microbenchmark:** actual QueryClient, identity-aware directory
   keys and session snapshot implementation, synthetic parsed metadata. Every
   ordinary listing has twenty entries, including the deepest listings. This is
   a different size model from the finite HTTP tree. No React rendering, provider,
   file contents or network fetching. Five timing repetitions; CDP garbage
   collection and heap checkpoints for one retained-memory replicate.

The local benchmark helpers and raw outputs remain gitignored. Commands executed:

```sh
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec tsx .codex/local/directory-api-bench.ts
node --max-old-space-size=256 .codex/local/directory-browser-bench.mjs
docker exec -i nickhosting-dev-api-1 node --import tsx --input-type=module < .codex/local/directory-live-bench.mjs
```

These commands reference private scratch harnesses, not new public maintenance
scripts. No containers were started/restarted, no network configuration changed,
and no historical full test suite was rerun for this measurement-only change.

## Actual provider latency

All nine requests returned HTTP 200. Lists contained 1–14 entries; their parsed
metadata serialized to 213–3,083 bytes (not measured wire bytes).

| Native adapter directory read | Duration |
| --- | ---: |
| Minimum | 222.47 ms |
| Mean | 283.65 ms |
| Median | 294.30 ms |
| Maximum | 353.84 ms |
| Mean time after HTTP response headers | 2.95 ms |

Most time precedes response headers; these measurements do not split Panel PHP,
Wings, network and storage time. They also exclude NickHosting HTTP/auth/database
overhead and browser rendering. The sample is intentionally small and serial;
it does not establish safe production concurrency, sustained throughput or load.
Remaining-rate headers stayed above 700; concurrent application traffic means
changes in that counter cannot all be attributed to this probe.

The existing adapter has one native directory-list operation, not a bulk or
recursive listing operation. Thousands of uncached paths therefore require
thousands of provider calls with the current contract.

## Isolated traversal results

Root counts as depth zero: through depth one means 11 listings; depth two 111;
depth three 1,111; depth five 111,111. Depth alone is not a useful workload cap.

| Traversal | Concurrent requests | Elapsed per traversal |
| --- | ---: | ---: |
| 11 directories, immediate fixture | 1 / 2 / 4 | 104 / 63 / 53 ms |
| 111 directories, immediate fixture | 1 / 2 / 4 | 1,053 / 807 / 620 ms |
| 1,111 directories, immediate fixture | 4 | 5,520 ms |
| Wide root + 12 selected children, immediate fixture | 4 | 54 ms |
| Wide root + all 500 children, immediate fixture | 4 | 1,972–2,124 ms |
| 111 directories, **simulated 200 ms provider delay** | 1 / 2 / 4 | 23,391 / 12,010 / 6,400 ms |

The first, second and selected-child rows are medians of three traversals. The
1,111-directory and delayed cases ran once; the all-500 case ran twice. These are
descriptive observations, not statistically established service percentiles.
Synthetic delayed responses do not reproduce real Panel saturation/rate limiting.
The HTTP harness reuses one injected fixture management runtime; deployed API
constructs its runtime per request and resolves real settings/credentials. Those
construction/secret-resolution/transport costs are excluded here. Do not add these
figures to the live adapter samples as an exact production latency breakdown.

Total: **13 cases, 3,586 HTTP 200 responses, zero errors/429 responses**. Authentication
and application checks remained enabled. Each case was bounded to 1,111 requests,
four concurrent calls, two minutes and a 4 GiB host-available-memory floor, with
timeout/latency/error stops. No stop threshold was reached. Browser, Vite, listener,
provider fixture and disposable schema were closed/disposed afterward.

The no-delay harness used roughly one CPU core in several cases. Its measured
process includes both HTTP client and API/test tooling; peak sampled RSS was
approximately 779 MiB, not a directory-cache measurement or Panel/Wings usage.
Host available memory stayed above 26 GiB. This does not prove the production
provider would tolerate the same request rate.

**Additional work discovered:** 3,586 listings invoked background download
preparation with 35,860 file-path arguments. For one 1,111-directory traversal this
was 1,111 preparation calls covering 11,110 paths, **not 11,110 HTTP signing calls**.
The fixture issued zero actual URLs. In real use the bounded token pool can reuse,
batch or evict entries, so production issuance cost is not measured here. Blindly
reusing the visible-list endpoint for speculative traversal would nonetheless
schedule unnecessary signing work for unvisited files.

## Browser memory and lookup cost

Measured retained JavaScript heap increase after collection, not full browser RSS:

| Cached lists | Metadata entries | Serialized metadata | Retained heap increase |
| --- | ---: | ---: | ---: |
| 11 ordinary | 220 | 0.046 MiB | 0.051 MiB |
| 111 ordinary | 2,220 | 0.464 MiB | 0.517 MiB |
| 1,111 ordinary | 22,220 | 4.642 MiB | 5.187 MiB |
| 2,500 ordinary | 50,000 | 10.445 MiB | 11.677 MiB |
| Wide root + 12 children | 750 | 0.155 MiB | 0.158 MiB |
| Wide root + all 500 children | 10,510 | 2.194 MiB | 2.409 MiB |

Final run: 2,500-list insertion median 49.1 ms; 10,000 warm lookups median 26.3 ms,
about 2.63 microseconds per lookup. Fixture construction and rendering are excluded.
This is why an already cached directory can feel immediate despite slow provider
reads. It does not mean acquiring or displaying thousands of lists is free.

One initial browser startup failed on module interop. After correcting the scratch
harness, two runs completed; the second aligned synthetic path keys with listing
names and warmed measurement code paths. Final values above use that second run.
The first successful run measured 24.2 ms rather than 49.1 ms for 2,500 insertions:
shared-host/JIT variation makes these descriptive microbenchmarks, not stable
latency guarantees. No production code changed to accommodate the benchmark.

The browser run completed in 6.96 seconds without errors or reaching the 64 MiB
added-heap / 256 MiB total-JS-heap guards; browser/Vite were closed. A 111,111-list
tree was **not materialized**. Linear extrapolation of the twenty-entry model
would exceed 500 MiB retained heap; this is an estimate, not a measured finite
depth-five tree or a promise about other browsers/filenames.

The existing snapshot accepts one 926,355-byte metadata payload and rejects one
of 1,232,355 bytes. These boundary cases use artificially long schema-valid names,
not claims that the filesystem supports such filenames. A normal 510-entry
snapshot took median 2.1 ms to write / 1.2 ms to read. Near-limit validation/storage
can be materially slower: the artificial 926,355-byte case took 28.1 / 7.3 ms. Avoid
persisting a large whole index synchronously on every listing change.

## Current cache behavior

- Directory results live in browser QueryClient memory, scoped to actor, subject,
  support session, server and directory. Stale after five seconds; unobserved idle
  queries are garbage-collected after five minutes. Becoming stale alone does
  not fetch. There is currently **no aggregate byte/folder budget**.
- Reload preservation is a separate **one-directory sessionStorage snapshot**, at
  most 1 MiB / 5,000 entries. It is placeholder data while a real listing refreshes,
  not authority for mutation or proof of freshness. No contents or tokens persist.
- Backend identity proofs and signed-transfer pools are separate caches, not a
  directory index. Directory responses themselves are not retained there.
- Mounted offscreen destination-tree observers can remain active. Prefetching by
  mounting hidden observers would retain queries and add focus/invalidation work.
- The native transport currently caps a provider page at 1,000 entries / response
  at 4 MiB. Synthetic HTTP fixtures bypass this adapter validation. The snapshot's
  5,000-entry limit is therefore not proof that native directories of that size
  work end to end. This existing limitation was identified, not changed here.

## Recommended next implementation, not activated

1. Preload immediate visible child folders plus a small scrolling margin, with
   two low-priority requests in flight. Prioritize a hovered/focused folder and
   foreground navigation; deduplicate requests and discard obsolete queued work.
2. Start with a window of roughly 12–24 candidate folders. Do not automatically
   recurse through three complete levels. On entering a child, extend the window
   from its cached listing; deeper lookahead is optional only within the same
   request budget. A 500-folder parent still needs one full parent listing, but
   only likely child destinations need additional requests.
3. Display cached metadata immediately and refresh **only the displayed folder**.
   Keep hidden cached descendants stale until needed; no recursive refresh on
   re-entry and no periodic indexing of unseen folders. Preserve authoritative
   operation checks and current handling of revoked permissions/missing paths.
4. Put explicit least-recently-used budgets around directory metadata, initially
   256 directories / 10,000 entries / 4 MiB serialized metadata, whichever comes
   first. These are proposed starting budgets, not a measured exact JS-heap cap.
   Keep identity boundaries and the existing bounded reload snapshot; a separate
   persisted whole-tree index is unnecessary for this first step.
5. Speculative requests must request **metadata only**, without preparing signed
   URLs for every hidden file. Retain download preparation for the opened folder
   and the existing consume/replenish mechanism.

This targets provider request count first. Bulk HTTP alone would not remove the
cost of listing each directory in Wings; no new Blueprint API is justified by
this measurement alone. Further increases need evidence under the chosen budget,
not a large production stress test. PR #21 remains open/unmerged; production and
SFTPGo issue #18 boundaries are unchanged.

Independent review checked the request guards, counters, cache contracts and
measurement methods. Its findings about fixture-runtime reuse, different tree
populations, synthetic filename limits and statistical uncertainty are reflected
above. No unresolved safety or reporting must-fix remained after integration.

## 2026-10-13 — Owner-authorized real-provider fixture test

The Owner subsequently authorized using their sole managed server and creating
`dirscan-test` at its file root. This supersedes the earlier read-only setup scope
**only for that fixture directory**. It does not make the Owner's server a
Codex-owned disposable asset. Panel/Wings configuration, code, services, game
power state, networking and pre-existing game files were not changed.

Preflight corroborated the Owner role, sole active managed server, Application
ID/UUID/external ID/provider user and Client owner identity. The directory did
not exist; setup refuses any existing same-name entry. A durable private fixture
ledger was written before mutation and updated after completion. A locally
generated, path-validated ZIP with no symlinks or compressed payloads contains:

- A ten-way tree through depth three: 1,111 directories including its subtree root.
- A wide subtree with 500 child folders.
- Two synthetic 128-byte files in every balanced/wide subtree directory, plus a
  fixture marker at `dirscan-test` (which has no data-file pair).
- Including `dirscan-test`: **1,613 directories**, 3,224 data files, marker and
  retained source ZIP. The ZIP is **983,114 bytes**; data-file contents total
  412,672 bytes. Filesystem block/directory overhead is additional, not measured.

Setup used native create-folder, one signed upload, and the installed Panel's
native decompress endpoint through the adapter package transport. The existing
product adapter has no decompression convenience method; no new product method
or Blueprint endpoint was introduced. Installed native FileController and
DaemonFileRepository were inspected read-only, confirming directory listing uses
Panel Client API → Wings `/files/list-directory`. Setup verified the extracted
top level, a deepest leaf and the 500-child folder. It did not recursively read
all generated entries to certify every file.

Preflight made three GETs. Setup made ten requests, including the three scoped
filesystem writes (mkdir/upload/extract) and one upload-credential issuance.
The separate **benchmark made 292 successful GETs: two identity reads and 290
directory listings**, covering **120 distinct paths**. No file-body download or
signed-download issuance occurred. This is real synthetic data on the existing
provider/filesystem, not a mock provider and not an exhaustive 1,613-folder crawl.

| Real provider workload | Concurrency | Elapsed | Per-request p95, each run |
| --- | ---: | ---: | ---: |
| Same 24 distinct directories, two runs | 1 | 6.528 / 5.385 s | 323 / 300 ms |
| Same 24 distinct directories, two runs | 2 | 3.198 / 3.519 s | 336 / 324 ms |
| Same 24 distinct directories, two runs | 4 | 2.032 / 2.113 s | 413 / 441 ms |
| Actual recursive traversal through depth two, 111 directories | 2 | 14.306 s | 350 ms |

The 24-path sample mixes nested folders, the 502-entry wide directory and small
wide children. Each stage has distinct paths, preventing same-path in-flight
coalescing from inflating throughput. Discovery precedes fixed-order 1/2/4 runs,
with eight-second pauses: these are **warm filesystem/provider comparisons**,
not cold-cache tests or randomized saturation experiments. No caches were flushed.
All 290 list responses were HTTP 200; no error, timeout or 429. Overall maximum
latency was 462.30 ms. Final small/wide recovery reads took 230.78 / 276.16 ms.

The real Client quota advertised 720 requests per its current rate-limit window.
The conservatively retained minimum remaining header was **572**; this is not
720 minus our request count because windows reset and other traffic exists.
The harness retains separate Application/Client budgets and never bypasses them.

Read-only resource monitoring sampled the exact Panel, Wings, database and cache
containers approximately every two seconds, with five baseline observations:

| Container | Baseline mean CPU | Whole-run mean CPU, including pauses | Peak CPU |
| --- | ---: | ---: | ---: |
| Panel | 27.79% | 144.17% | 571.64% |
| Wings | 0.91% | 15.76% | 125.45% |
| Provider database | 0.62% | 3.34% | 20.81% |
| Provider cache | 0.36% | 0.92% | 4.41% |

**Docker 100% is one CPU core**, so the Panel briefly used about 5.72 cores.
The two largest samples coincide with the concurrency-four batches. These include
existing workloads and are not a precise causal CPU allocation to our requests.
They are nevertheless evidence that listing through Panel is not cheap. There
were no three consecutive samples over the configured sustained threshold.
Host CPU peaked at 61.08%; available memory stayed above 27.48 GiB. Panel reported
1.251 → 1.286 GiB container memory and Wings 5.009 → 5.006 GiB; these are Docker
usage observations from first baseline to last in-run sample, not isolated
per-request allocation measurements.

Guards: at most four simultaneous requests, 320 list calls / 340 total per run,
five-minute self-deadline and independent monitor, five-second request timeout,
stop dispatch after any error or listing over two seconds, conservative rate
reserve, host-available-memory floor 4 GiB, sustained host CPU >85%, or sustained
Panel/Wings CPU >max(300%, baseline +200 percentage points). No guard fired. The
monitor collected 56 in-run samples and the child exited normally. Existing
Wings/database Docker healthcheck failures were present before the benchmark;
their probe outputs concern the configured probe target/credentials. Those
checks were not repaired or treated as evidence of service health; actual API
responses and resource observations establish this test's narrower result.

Command, using ignored local input/helper files, for each of `preflight`, `setup`
and `provider` (the latter uses `dirscan-bench-input.json`):

```sh
python3 .codex/local/dirscan-monitor.py --script .codex/local/directory-provider-bench.mjs --input .codex/local/dirscan-bench-input.json --output .codex/local/dirscan-provider
```

The fixture remains **only inside `dirscan-test`**, with its archive and provenance
ledger retained for scoped cleanup/retesting. No deletion or power operation was
performed. Temporary benchmark/monitor processes exited; no containers were
created or restarted. Further cleanup must stay within verified fixture ownership.

Conclusion: retain the proposed default of two low-priority prefetches, visible
children plus a small margin, strict queue/cache budgets and foreground-only
revalidation/download preparation. Four improves batch time but raises per-request
latency and coincides with higher Panel CPU peaks. It is not a reason to recurse
through hundreds of hidden folders. No product prefetch behavior was implemented
during this benchmark. Independent review checked the harness before execution;
scope-separated quotas, a self-deadline, extraction samples and baseline CPU guards
were corrected before fixture writes. Final evidence review is recorded in the
validation report and PR.
