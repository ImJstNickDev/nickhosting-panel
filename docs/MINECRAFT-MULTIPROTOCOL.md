# Minecraft multiprotocol responder — M5, 2026-10-14

Scope: the existing Java TCP Gateway responder, not gameplay, authentication,
translation, encryption, limbo or Bedrock. No provider, networking or allocation
change is required. `minecraft` is the integration; `minecraft-java` remains the
Java wire handler. Existing server IDs, mappings, credentials and files are retained.
Historical Alpha installation/catalog/egg availability is a separate future task:
the responder can use their configured server version without advertising them as
currently installable.

## Wire behavior

| Family | Status | Initial login response | Backend idle observation |
| --- | --- | --- | --- |
| Alpha 1.0.15/16 | Not present in client | Initial 01: int32 protocol, Modified UTF-8 username/password; FF Modified UTF-8 kick | Unknown |
| Later Alpha through Beta 1.4 | Not present in client | 02 Modified UTF-8 handshake/kick | Unknown |
| Beta 1.5–1.7 | Not present in client | 02 UTF-16BE handshake/kick | Unknown |
| Beta 1.8, releases 1.0–1.3 | FE → MOTD§online§max | UTF-16BE; old clients receive one-line text | Original status count |
| 1.4–1.5 | FE01 → §1 NUL-separated fields | UTF-16BE | Extended status count |
| 1.6 | FE01FA MC\|PingHost with client protocol | UTF-16BE | Extended status count |
| 1.7.2 onward | VarInt frames, mirrored client protocol, exact nonce pong | Login Start followed by JSON-string Disconnect | Modern status count |
| Legacy snapshots/pre-releases | Recognized legacy wire formats | Corresponding legacy codec | Unknown unless target has a known status profile |
| Future modern wire IDs | Structural best effort | Structural best effort; mismatched target rejected | Depends on backend still speaking the supported status format |

Modern login requires bounded Login Start (including username); the handshake alone
does not wake. The suffix is opaque because its fields vary by release and are not
needed for a disconnect. Transfers remain disabled by normal route policy. Passive
status never wakes. Modern version -1 uses the configured fallback or target ID;
FE01 uses the configured legacy override or target ID. The client may use a different
version than the configured backend: the known server version is a fallback, not
proof of the client's encoding.

Old unversioned handshakes use the known target release for newline presentation;
Modified UTF-8 and identified pre-1.3 clients remain single-line. Alpha protocol IDs
are not compared across eras to select an encoder. In particular initial Alpha13/14
has **no** later seed/dimension trailer. This was caught in independent review and
corrected before activation.

FE and FE01 are ambiguous prefixes: sessions allow a 50 ms quiet interval before
finalizing those complete legacy requests. Incomplete modern/longer legacy packets
continue waiting within the original absolute Gateway deadline. TCP chunk boundaries
never define packets. Full modern requests do not wait for this interval. Replies
flush through socket.end; trailing client bytes drain within the same absolute and
byte limits. Online traffic keeps the existing raw bidirectional TCP forwarding.

Protocol code performs no database, Mojang or provider lookup per client. Existing
Core admission, authenticated provider readiness, manual stops, leases and recovery
fences are unchanged. Fake player counters are presentation only, never idle evidence.

## Owner configuration

Optional platform setting `minecraftGatewayResponses` (Owner Settings, Gateway),
or JSON environment override `NH_MINECRAFT_GATEWAY_RESPONSES`, uses ordinary
protected setting precedence. Omitted values preserve localized lifecycle messages.

- `fallbackProtocol`: protocol for modern queries announcing -1; default target ID.
- `legacyProtocol`: optional 0–255 override for unversioned FE01; default target ID.
- `versionName`: announced label; default configured target release.
- `onlinePlayers`, `maximumPlayers`: fake counters; defaults 0/0.
- `motd`, `disconnect`, `legacyDisconnect`: optional per-state `{ en, it }` text.
  States: sleeping, waking, stopping, blocked, maintenance, manually_stopped, online.
- `legacyLineSeparator`: default ` | ` for flattened old-client messages.

Example:

```json
{"maximumPlayers":20,"motd":{"sleeping":{"en":"§aSleeping. Join to start.","it":"§aSospeso. Entra per avviare."}}}
```

Section-sign colors/styles are converted into modern JSON components; original FE
status strips formatting to preserve its separators. UTF-16 counts code units;
Java Modified UTF-8 counts encoded bytes and handles NUL and surrogate pairs.
Debug-only `gateway.protocol_response` records route, detected codec, received/
announced protocol and response action, never usernames or requested hostnames.

## Verification and honest boundaries

`protocol-registry.fixture.json` is trimmed metadata from the production-pinned
PrismarineJS commit `33a0f3e7323e124a81960a6d6c62df797d69cd85`; original SHA-256
`ec1186190718bd975bbe364920a7ca590fbd9de4fba83ffb29c0f098e1ea938f`.
It contains **839 entries: 771 modern, 20 stable legacy, 48 legacy snapshots**.
The offline sweep exercises status/login framing for every row. This is synthetic
wire coverage, not 839 original clients or server installations. The registry lacks
Alpha/Beta rows; 24 explicit historical tuples supplement it.

Independent `minecraft-protocol` 1.68.0 headless **status** clients cover 1.7.10,
1.8.9, 1.12.2, 1.16.5, 1.20.4 and 26.1 over real localhost TCP. The library resolves
requested 1.7.2 to wire5 rather than wire4 and lacks 26.2/26.3 serializers: those
limits are asserted rather than reported as passing original-client coverage.
Separate wire fixtures exercise IDs4/5/47/340/754/765/775/776/777 and unknown IDs.

The Owner reported independent Python/original-client experiments; this change
neither reruns nor invents a per-version real-client certification from that report.
Existing M4 real-server evidence stays intact. No new real game servers are created.

Tests include all packet prefixes, multiple coalesced packets, signed VarInts,
Unicode/color/newline regressions, malformed lengths, concurrent sessions, legacy
backend probes, missing counts, manual stop, no-wake status, lease expiry and races.
See the final validation entry below for actual command results and activation.

## References and reuse

- [PrismarineJS protocol metadata](https://github.com/PrismarineJS/minecraft-data)
- [ViaLegacy historical wire packet tables](https://github.com/ViaVersion/ViaLegacy)
- [Java Modified UTF-8](https://docs.oracle.com/en/java/javase/16/docs/api/java.base/java/io/DataInput.html)
- [Historical server list ping specification](https://c4k3.github.io/wiki.vg/Server_List_Ping.html)

Historical upstream code was consulted for field layouts, not copied. No dependency
or repository license change. The small codecs are independently implemented.

## Validation — 2026-10-14

Commands use `scripts/dev.sh` (pinned Node24.21.0/pnpm); the system Node20 is
not the supported test runtime.

- `pnpm exec vitest run games/minecraft/src packages/game-sdk/src packages/core/src
  apps/game-gateway/src apps/web/src/features/game-ui.test.ts --exclude
  '**/*.integration.test.ts'`: **36 files, 651 tests passed**. Includes 113 codec/
  multiprotocol/protocol tests and 154 Gateway data-plane tests.
- Isolated database runs via `pnpm exec tsx scripts/test-env.ts --m2 pnpm exec
  vitest run --config vitest.integration.config.ts …`: identity migration4,
  registry8, runtime images5, catalog3, platform queries33, API Minecraft/platform26,
  Gateway Minecraft7 passed. Content/orchestration also passed in the broader run.
  The first Gateway run had a stale exact-26.1-only assertion; it now asserts that
  an unknown family/null protocol is rejected, and all seven cases pass.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm i18n:check`,
  `pnpm build`: passed. Lint reported37 warnings and2 informational diagnostics;
  production build retained existing large-chunk warnings. No dependencies changed.
- Targeted browser command: `pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest
  run --config vitest.browser.config.ts apps/web/tests/vanilla-catalog.browser.test.ts
  -t 'discovers declared versions'`: **1 passed, 5 deselected**. Actual app handlers,
  isolated database and provider fixtures; zero automated WCAG2.2AA violations.
  [Reviewed Owner catalog screenshot](screenshots/m5/minecraft-multiprotocol-owner-en.png).
  This is a label/capability regression check, not a new full UI certification.

Independent review caught the Alpha login trailer error before delivery; it was
fixed and covered with an independent byte-level regression. Final protocol,
identity migration and data-plane review found no remaining must-fix issue in
those paths. No original game clients or real game-server power cycles were run.
The full historical M1–M5 matrix and retained-SSH regressions were not rerun; issue
#18 remains unchanged. Existing test services were reused, without new containers
or production provider mutations for tests.

The broader queued-lifecycle run initially had14 failures. Its fixtures mocked the
obsolete `sampleLocalResources` wrapper while the existing runtime already used
`createHostResourceSampler().sample`, attempting a real statfs of the fixture path.
Other assertions still expected ordinary starts to repeat full image/startup proofs
removed in earlier approved latency work. Only test fixtures/expectations were
corrected: actual cached-sampler dependency, admitted lean starts, drift rejection
at explicit readiness, revocation before power handoff and foreign-identity rejection.
No production lifecycle code changed. The final targeted
`minecraft-queued.integration.test.ts` run passed **45/45**; TypeScript and file lint
passed afterward. The initial failures are retained here rather than counted as
successful runs.

### Activation and independent-route recovery

Development migration031 completed with a private pre-migration backup; API/worker
were rebuilt/recreated and Gateway restarted within the Owner's authorization.
Accounts, two managed servers and the existing runtime mapping remain. No real
game-server commands or file writes were issued. Development HTTPS returned200.

Initial passive smoke failed with ECONNREFUSED: an independently configured,
manually stopped second route had no reachability proof, and its refusal prevented
the entire snapshot from binding. Read-only inspection confirmed proof identity
contains no integration ID and migration031 leaves proofs unchanged. The correction
withholds only the affected server's complete set of port roles for the typed
`backend_active_binding` refusal. Other safety failures and stale/expired snapshots
retain their existing behavior. The complete authenticated snapshot still fences
revisions; no fake proof or automatic game start is introduced.

After this final change, the full data-plane test file passed **159/159**, followed
by root/web/test TypeScript, formatting and independent review. Tests cover cold
startup with an independent unproven server, lease renewal past the original lease,
proof recovery, same-revision fencing, all-port withdrawal, pre-bind staged rollback
and generic-error behavior. No must-fix was found. Final index governance passed
952 text files,353 review PNGs,789 links,4 TOML files and44 ignore cases.

After the second authorized Gateway restart and its existing old-lease drain, live
**passive-only** checks passed for modern IDs4/47/775/777 and-1 (fallback775), exact
nonce pong, legacy FE and FE01. A first attempt during the drain was refused; the
post-drain attempt passed all seven queries. No login/join packet was sent. The
proven sleeping server responds; the second server still requires its normal first
Owner-initiated start to establish actual backend reachability. Diagnostics honestly
report `controlAvailable=true`, one admitted route and `ready=false`/HTTP503 while
that second route remains unproven. API, worker and Vite are healthy.

Nonblocking review note: while any route remains withheld, independent fast
readiness/sleep receipts fall back to ordinary snapshot refresh. No new latency
guarantee or complete live sleep/wake cycle is claimed by these passive checks.
