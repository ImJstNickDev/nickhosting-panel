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
