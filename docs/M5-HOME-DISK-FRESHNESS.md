# M5 Home disk display freshness

Home disk usage previously reused the four-second safety observation lifetime.
The worker waits five seconds after each full reconciliation pass, which includes
provider and lifecycle work. Reloading during a normal polling gap could therefore
show unavailable even though the database contained a recent valid measurement.
No cache deletion or invalidation was required to reproduce the problem.

`GET /v1/platform/quotas` now gives the display aggregate a separate 30-second
lifetime, consistent with existing server-card and file telemetry displays. All
owned, undeleted servers must have a valid nonnegative safe-integer latest sample.
Missing, future, expired or unsafe samples/totals yield `bytes: null`. Empty
inventory yields zero. The additive `storageUsage.expiresAt` deadline is the oldest
contributing observation plus 30 seconds, or null for an unavailable/empty result.
The exact expiry boundary is unavailable.

Home and the Owner user quota view refresh every 15 seconds. They expire cached
usage even when refresh is stalled. The browser derives remaining validity from
the server response time and anchors it to query receipt, preserving cache age
across remounts without requiring matching client/server clocks. Focus and
visibility changes recheck timers deferred in background tabs. Response transit
can add a small delay to browser expiry; the API deadline is strict. No timestamp,
status badge or new visible control is added.

This is a display policy only. Worker cadence, admission checks, `measured.stale`,
physical capacity checks and storage reconciliation remain unchanged. Provider
resources have a documented 20-second cache, so polling the entire worker more
frequently would not guarantee fresh underlying filesystem measurements.

Validation covers the five-second polling gap on reload, oldest-sample/boundary
expiry, missing/future/unsafe samples, delayed responses and recovery, Owner quota
expiry, and skewed browser clocks. Tests use disposable database/browser fixtures;
no provider servers, migrations or infrastructure changes are required. Rollback
is a code revert. Review the stable Home value during normal polling and honest
unavailability when complete recent measurements cannot be obtained.

Validation results: 30 platform-query integration tests, 4 focused browser tests
and 12 existing platform browser journeys passed. Root/web TypeScript and
production web build passed; targeted Biome has no errors (one pre-existing
non-null assertion warning in Owner event pagination). Independent review passed
following the addition of Owner refresh polling and real stalled-request proof.
[Home quota screenshot](screenshots/m5/home-disk-polling-gap-desktop-en.png).
