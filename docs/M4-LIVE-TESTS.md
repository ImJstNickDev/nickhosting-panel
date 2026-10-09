# M4 controlled Minecraft live-test proposal

**The Owner approved the exact endpoint/exposure scope and accepted the Minecraft
EULA for M4 tests on 2026-10-09. The approval is recorded in the private plan.
Execution results are separate; this proposal records no passing live Minecraft test.**

The exact machine values are in the mode-0600, gitignored
`.codex/local/m4-live-plan.json`. Review that file together with this proposal;
never copy its addresses, credentials, infrastructure paths or API identity into
public evidence. The current plan targets PR #20. `scripts/m4-live.ts` provides
read-only preflight, provenance verification, a real protocol probe, the explicitly
gated nonce responder, and a provenance guard for composition into the existing
M2/M3 Core runner. `scripts/m4-live-scenario.ts` now prepares an executable
Vanilla scenario using the actual Core, Gateway and an independent Minecraft
protocol client. Its preparation/typecheck is not live acceptance evidence.

## Exact proposed changes and approval

1. Temporarily select the single existing, unassigned allocation named by the
   private plan as the isolated test database's only allowed backend allocation.
   The proposal does not create/edit a Panel allocation or production mapping.
   Fresh node UUID, allocation identity, assignment state and both transports
   must match before use. Each new test server is created with
   `start_on_completion=false`; Core admission controls every start.
2. Run one temporary current-user Node nonce responder on the **exact effective
   backend address** and selected high port in that plan, TCP and UDP. The port
   was absent from the preparation-time host socket and Docker publication
   inventory; execution must repeat the check. The responder uses the M3 bounded
   nonce protocol, a 16-connection TCP limit and one-second TCP timeout. It is a
   foreground test process, not an installed service or another Docker container.
3. Run the existing Gateway data plane only on the plan's exact loopback address,
   using the same numerical game port as the separate backend address. Real
   M3 collision validation, leases, forwarding fences and readiness proofs remain
   mandatory. No public Gateway listener is proposed.
4. Accept the [Minecraft EULA](https://www.minecraft.net/en-us/eula) for these
   test servers before any server download/installation or `eula=true` write.
   The coordinator records the Owner's actual approval reference in the private
   plan; the script does not infer acceptance from an image becoming available.

**Exposure decision:** the candidate allocation uses the host's LAN address and
has a public alias in Panel metadata. An RFC1918 address is not proof that router
forwarding cannot expose it. Approval must explicitly cover use of that exact
allocation and the nonce endpoint, including any existing external reachability,
or the Owner must supply a different already-existing safe allocation. No firewall,
router, allocation, network or address change will be made to solve this.

The new Pterodactyl servers themselves are within the Owner's existing controlled
test authorization. The additional approval is for the concrete endpoint/pool
selection, nonce listener and EULA acceptance above. Any uncertainty about
ownership, endpoint exposure or changed inventory stops execution.

## Resource and runtime envelope

Only **one undeleted test server at a time**, processed sequentially:

| Limit | Maximum / minimum |
| --- | --- |
| Server RAM | 2,048 MiB |
| Server CPU | 100% |
| Server disk | 4,096 MiB |
| Available host RAM retained | 12 GiB plus twice the requested server RAM |
| Available host disk retained | 16 GiB plus twice the requested server disk |
| Observed CPU headroom | At least two currently idle logical CPUs |

The extra allowances account conservatively for installer/runtime overhead and
downloads. They supplement M2's actual atomic admission; configured RAM totals
across stopped servers are not treated as physical consumption. Resource
observations repeat before creation, start/restart and reinstallation. Failure
does not trigger retries that create more servers or shut down other workloads.

These are **metadata-resolved candidates**, not verified compatibility claims:

| Profile | Exact candidate | Required Java |
| --- | --- | --- |
| Vanilla | 26.1 | 25 |
| Paper | 1.21.4, build 232 | 21 |
| Folia | 1.21.4, build 6 | 21 |
| Fabric | 26.1, loader 0.19.5, installer 1.1.2 | 25 |
| Forge | 1.21.4, loader 54.1.16 | 21 |

See [runtime research](M4-RUNTIMES.md) for upstream sources and support caveats.
The plan selects existing Owner-provided eggs/images; labels are not used to
reject newer releases. Folia can use the existing server-JAR egg's explicit
download-URL variable without editing that egg. The actual installed artifact
must match the official selected Folia hash before launch. Fabric/Forge generated
files and actual Java/runtime behavior require independent installation evidence.
An installer download alone does not pass that check. Image digests, Java output,
exact files and runtime status must be recorded; system Java is never changed.

## Available commands and runner stages

Read-only preflight, after the coordinator reviews the implementation:

```sh
scripts/dev.sh pnpm exec tsx scripts/m4-live.ts --plan .codex/local/m4-live-plan.json --phase preflight
```

This rechecks API identity, actual host resources, all provider allocations,
host/Docker listeners, node/network identity, installed egg images, exact upstream
runtime metadata and the pinned protocol registry. It does not bind, create a
server, seed a user, or run a game. A metadata success remains metadata evidence.

After the exact endpoint approval is recorded, start the responder in a dedicated
foreground terminal **before** creating the test server:

```sh
NODE_OPTIONS=--max-old-space-size=128 timeout --signal=TERM 90m scripts/dev.sh pnpm exec tsx scripts/m4-live.ts --plan .codex/local/m4-live-plan.json --phase responder --owner-approved
```

After coordinator and independent code review, run the two separate stages below.
Both require the approved M2 test database and the nonce responder above. The
first command creates a fresh isolated schema and prints the actual protected
ledger filename. Pass that exact filename to later commands.

```sh
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec tsx scripts/m4-live-scenario.ts --plan .codex/local/m4-live-plan.json --profile vanilla --phase bootstrap --owner-approved
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec tsx scripts/m4-live-scenario.ts --plan .codex/local/m4-live-plan.json --profile vanilla --phase minecraft --ledger mountdata/test-assets/m4-live-RUN_UUID.json --owner-approved
```

`bootstrap` creates an explicitly separate M2 validation mapping and server. It
uses the exact resolved Vanilla artifact and approved image, with a fixture
startup prefix that records actual `java -version` output. It verifies the
downloaded artifact against upstream hashes, the Docker image configuration
digest, real status/ping readiness and actual generated property keys. Only
installation/status/readiness are marked true in a signed
`installation-bootstrap` report. This admits private validation as experimental;
it does not establish full Minecraft or client compatibility. The bootstrap
server must be stopped and conclusively deleted before the next stage.

`minecraft` then uses `createManagedServer` and `createManagementRuntime` with
the real M4 configuration hook, immutable combination and actual signed bootstrap
evidence. It registers routes through Core and starts `createGatewayRuntime`.
The Gateway's control client calls the actual authenticated application HTTP
handlers in process, so there is no extra Core host listener. Production collision,
route membership, observation, nonce, lease and forwarding checks remain active.

The independent `minecraft-protocol` client uses a randomly named, whitelisted
**offline test identity**. Only that stopped, ownership-verified fixture gets
`online-mode=false` and `enforce-secure-profile=false`; these are not permitted
product property changes. This tests real PLAY/configuration packets through the
transparent Gateway, but does not prove Microsoft authentication, encrypted
online sessions or signed chat. It also tests real player-count non-idleness,
empty-player sleep, passive status without wake, twelve simultaneous intentional
joins producing one durable wake, readiness and manual-stop suppression.

The resource-refusal case reduces only the isolated database's Owner-configured
physical host allowance, then restores it. It does not consume real host RAM or
change node limits. It requires an immediate blocked response, no queued start
and no reservation. This is actual admission against a restrictive policy, not
evidence of deliberately exhausted production resources.

Both stages retain an auditable isolated schema and ledger. The optional trusted
`afterProtocol` callback exported by the runner permits a separately reviewed
content/world/backup scenario on the same stopped asset. It is a local function,
never a JSON/configuration input. The standalone command does not claim those
content checks passed. Current executable scope is deliberately gated to Vanilla;
the other four mappings are resolved and registered but not yet executed.

Explicit cleanup, after inspecting any failure and its complete provenance:

```sh
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec tsx scripts/m4-live-scenario.ts --plan .codex/local/m4-live-plan.json --profile vanilla --phase cleanup --ledger mountdata/test-assets/m4-live-RUN_UUID.json --owner-approved
```

Cleanup runs Core stop/delete only for conclusively proven assets and drops only
that ledger's generated test schema after all deletions are confirmed. It never
adopts a lost create response, deletes an uncertain asset or automatically runs
after failure. Signing/encryption test keys stay in the mode-0600 ignored ledger.

For an existing run produced by that runner, replace the placeholder below with
its actual generated ledger filename:

```sh
scripts/dev.sh pnpm exec tsx scripts/m4-live.ts --plan .codex/local/m4-live-plan.json --phase prove --ledger mountdata/test-assets/m4-live-RUN_UUID.json --owner-approved
scripts/dev.sh pnpm exec tsx scripts/m4-live.ts --plan .codex/local/m4-live-plan.json --phase probe --ledger mountdata/test-assets/m4-live-RUN_UUID.json --owner-approved
```

`probe` requires the actual Core-minted route stored in the ledger. It exercises
Minecraft status plus a random ping echo directly against the proven backend.
It records missing player counts as unknown and never labels this as an
authenticated client, successful join, completed wake or full compatibility.

## Provenance, scenarios and stop conditions

Before creation, the runner persists its run UUID, PR, branch/HEAD, plan digest,
API identity/origin digest, pre-existing server UUID set, exact local server ID,
external ID and creation intent. `saveMinecraftLiveLedger` fsyncs the file and
parent directory. The guard records an attempted effect before calling the
adapter, then persists returned UUID, numeric ID, identifier and creation time.
Every later mutation rechecks those values, the current API account, node and
selected egg against the live API. Names are never proof. A lost create response
leaves an uncertain intent and **stops**; no automatic replay or adoption occurs.
Unresolved previous M4 assets prevent a new run.

Execution and extensions still need to demonstrate:

- M2-created/configured servers, actual installed artifacts and Java/loader output;
  admission-controlled startup and real readiness durations.
- Status polling with zero wake; intentional joins with one durable wake during a
  burst; manual-stop suppression; idle timeout/disabled sleep; missing-player
  observations remaining unknown; immediate resource rejection.
- Real Gateway forwarding and lease/restart recovery, with the complete real
  allocation inventory and same-address nonce responder while the game sleeps.
- Actual matching Minecraft client/server behavior where available; fixture
  handshakes or status clients must remain identified as such.
- Content/world/property/player workflows, verified optional backup before
  replacement, partial-failure handling, stop/reinstall/wipe and confirmed deletion
  restricted to the recorded asset. DNS remains mocked.

Do not promote candidate combinations to `verified` until their complete required
evidence exists. The experimental tester allowlist is not a substitute for it.
The M2 SFTPGo exception and issue #18 are unchanged.

## Cleanup and rollback

Close the test Gateway, withdraw its routes and respect the last issued route
lease before freeing allocations. Through the existing M2 lifecycle and guarded
adapter, stop and delete only the exact provenance-verified test server; confirm
its API absence and allocation release before another profile. Preserve any
uncertain server/operation and ask for review rather than forcing cleanup.

Stop only the known foreground nonce process with its terminal interrupt or the
90-minute scoped timeout. Its SIGINT/SIGTERM handler closes its own sockets.
Verify those exact listeners disappeared. Do not kill a process merely because
it occupies the planned port. Keep ledgers and sanitized evidence; clean only
the exact isolated test schema/generated project staging after active work has
ended. No global Docker cleanup, existing-network change, production volume
access or system Java change is included.

Preparation inspected current-user network namespace metadata only. Independent
host namespace attestation remains a production-deployment prerequisite; the
fixture does not claim production Gateway deployment approval or readiness.
