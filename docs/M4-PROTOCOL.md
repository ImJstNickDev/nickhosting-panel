# Minecraft Java Gateway protocol contract

The `games/minecraft/src/protocol.ts` adapter runs inside the existing M3 Gateway.
It has no provider credentials, database access, public listener of its own,
authentication emulator, protocol translator, limbo or automatic reconnection.
The [M3 safety and lease contracts](M3-API.md) continue to control every listener.

## Recognition and availability

`createMinecraftProtocolAdapter` takes reviewed `versions` entries containing
`release`, `protocolId`, `family` (`netty` or `legacy`) and `transfer`, plus an
explicit `supportedReleases` list. Registry labels, wire IDs, server loaders and
Java versions are different concepts. Shared wire IDs do not establish loader
compatibility or grant a release availability. Unknown IDs and legacy clients
receive no guessed modern packets and never wake a sleeping server. A partial
legacy prefix can also be a modern frame prefix; it receives no response and
expires at the Gateway's classification deadline.

The adapter does not choose public availability. The Owner compatibility and
rollout controls must supply only entries with the required evidence. A codec
fixture passing is recognition evidence, **not real client/server compatibility**.
The Owner matrix records that distinction; ordinary creation responses must not
expose wire IDs or technical matrix states.

## Offline TCP dialogue

The optional SDK `createSession(context)` creates private state for each TCP
connection. `classify` receives unconsumed bytes and returns an intent with an
explicit consumed-byte count. `continue` consumes a handshake without producing
a reply; `need-more` consumes nothing. `response(mode)` returns bounded bytes and
a close/continue decision. Existing stateless adapters remain compatible.

- The codec validates bounded VarInts (including legal padded encodings), packet lengths, strict UTF-8,
  complete handshake fields and intent. The opaque hostname allows bounded
  Forge markers; it never controls routing or backend selection.
- Status intent (`1`) alone does not produce a reply. An exact status request
  receives the configured release/wire ID and a localized state message. The
  connection remains open for one signed 64-bit ping, echoed byte-for-byte before
  closing. Neither handshake, request nor ping can request a wake.
- Known matching login intent (`2`) may request wake through M3. A mismatched
  known wire ID receives a localized version-selection message without waking.
  The handshake declares login intent; the Gateway does not authenticate it or
  promise that it came from an authenticated account.
- Transfer intent (`3`) requires explicit registry support and the adapter's
  `acceptsTransfers: true`, default false. This must match the configured server
  policy. It does not enable transfer packets, authentication skipping or cookie
  handling in NickHosting.
- Responses for sleeping, waking, blocked, maintenance and manual stop are
  English/Italian JSON text components in the login disconnect packet. They
  promise no completion time or automatic reconnect. Status replies omit player
  counts rather than inventing online state.
- Online routes bypass the classifier and preserve every byte transparently,
  including encryption, secure chat, configuration and loader-specific traffic.
  The actual backend remains responsible for authentication and version errors.

The Gateway bounds total input/output for the entire offline conversation,
classification duration and connections. It rejects invalid consumption counts,
rechecks route revision, lease and sleep fence after asynchronous wake work, and
aborts session context when the socket closes. Coalesced/fragmented frames and
concurrent clients never share parser state. Ordinary equivalent lease renewal
does not invalidate an in-flight status exchange.

## Readiness and idleness

`probeMinecraftStatus(context, version, options)` connects only to the route's
effective backend endpoint. It sends the configured protocol's handshake and
status request, validates the response wire ID, then sends a fresh unpredictable
64-bit ping challenge. Readiness requires the exact echoed challenge; a running
container, open socket, arbitrary JSON or mismatched protocol is insufficient.
Probes have an absolute timeout, cancellation, strict framing/UTF-8 and bounded
response memory (256 KiB by default, configurable from 256 bytes to 1 MiB).

Idle detection requires a valid, explicit, nonnegative integer online-player
count from a successful probe. Missing, hidden or invalid information remains
unknown and prevents automatic idle sleep. Positive counts prohibit sleep. No
probe result is cached across calls. M3 still requires all relevant port roles,
zero active sessions, the configured idle period and its forwarding fence before
the lifecycle stop job is authorized.

This protocol measurement cannot establish that a custom status plugin reports
players honestly. Runtime/version evidence must include the actual configured
server behavior. Automatic sleep remains unavailable where reliable player
information cannot be verified.

## Upstream research and licensing

Research checked on 2026-10-09:

- [Mojang's Java 1.20.5 notes](https://feedback.minecraft.net/hc/en-us/articles/26136167989005-Minecraft-Java-Edition-1-20-5-Armored-Paws)
  establish transfer intent `3` and the default disabled incoming-transfer
  policy. A numeric threshold alone never authorizes unknown future IDs.
- [Velocity handshake implementation](https://github.com/PaperMC/Velocity/blob/5e641c6533db6b75a236b5ae79f76e27ad3169a8/proxy/src/main/java/com/velocitypowered/proxy/protocol/packet/HandshakePacket.java)
  corroborates handshake fields and the need to accommodate Forge hostname
  suffixes.
- [Velocity disconnect implementation](https://github.com/PaperMC/Velocity/blob/5e641c6533db6b75a236b5ae79f76e27ad3169a8/proxy/src/main/java/com/velocitypowered/proxy/protocol/packet/DisconnectPacket.java)
  preserves the JSON component form during login even after newer versions
  adopted other component encodings in later connection states.
- [PrismarineJS Minecraft 26.1 schema](https://github.com/PrismarineJS/minecraft-data/blob/33a0f3e7323e124a81960a6d6c62df797d69cd85/data/pc/26.1/protocol.json)
  independently corroborates status JSON, ping payload and login-disconnect
  string fields for that release.

Velocity is GPL-3.0-or-later; it was a protocol research reference only. No
Velocity implementation was copied, translated or incorporated. The small
bounded pre-login codec here is original code based on the wire format. No
protocol dependency or upstream source code is vendored. This avoids pretending
that a comprehensive client library's version list proves server integration.

## Test evidence and limits

`games/minecraft/src/protocol.test.ts` exercises isolated codec and TCP status
fixtures: partial/coalesced packets, malformed/oversized frames, strict strings,
unknown/legacy IDs, mismatch/transfer, localized disconnects, cross-client state,
nonce responses, cancellation and missing player counts.

`apps/game-gateway/src/data-plane.test.ts` additionally drives actual Minecraft
handshake/status/ping bytes through the M3 data plane using ephemeral loopback
listeners. Sixteen simultaneous passive probes generate zero wakes; sixteen
compatible login intents produce one wake request. Mismatches, disabled
transfers and manual stops do not wake. Existing TCP/UDP, lease, collision-fence
and recovery regressions remain applicable.

These tests are fixtures. They do not establish real Vanilla, Paper, Folia,
Fabric or Forge client/server compatibility. Real-server evidence and the
approved supported matrix must be recorded separately before exposing those
combinations to ordinary users.

## Production module contract

Set `NH_GATEWAY_PROTOCOL_MODULES` to the deployment's absolute path to
`games/minecraft/src/gateway-module.ts` when using the TypeScript service entry
point (or its corresponding built JavaScript artifact). This exports the existing
M3 loader's `gatewayProtocols` list; no second proxy/service is created.

Core mints `protocol.minecraft` only from an installed managed Minecraft profile,
its unchanged runtime mapping and current signed evidence. It carries the exact
release, wire ID, transfer capability, choice/evidence identity and expiry.
Gateway never downloads upstream metadata or receives the evidence signing key.
Both route schema and handler reject missing/mismatched/expired metadata. Snapshot
expiry cannot outlive its evidence. Availability disabled for *new* creation does
not revoke otherwise verified existing management; experimental handling still
requires explicit private-testing permission for the actual server owner.

Transfer parsing does not imply permission to accept transferred players. The
initial route contract leaves `acceptsTransfers:false`; direct intentional joins
remain the supported wake path. Authenticated Minecraft protocol behavior stays
with the real server and client. No encryption, secure-chat, configuration-state,
translation, reconnect or limbo behavior is synthesized.

The deployed route module recognizes its attested release only. Unknown or mismatched wire IDs close safely; the broader multi-version factory can return localized mismatch messages only when that other family is independently known. Recognition fixtures do not broaden deployed compatibility.

## Owner-facing acceptance matrix

The Owner approved Vanilla as the real-server acceptance target for M4 on
2026-10-09. Other runtime eggs will be improved and tested separately. These
rows are technical administration evidence, not a normal creation-screen feature.
The ordinary catalog exposes only eligible, Owner-enabled combinations with
current required evidence; it never exposes this table or its wire identifiers.

| Exact combination | Wire ID / family | Java requirement | Current real evidence | Internal state |
| --- | --- | --- | --- | --- |
| Vanilla 26.1 | 775 / Netty | 25 | Official artifact, actual Java/image, independent offline client PLAY, status/sleep/wake/readiness/idle, worlds and content; tested 2026-10-09 | Verified for the recorded combination |
| Paper 1.21.4 build 232 | 769 / Netty | 21 | Metadata and isolated contracts; live egg validation deferred | Unverified |
| Folia 1.21.4 build 6 | 769 / Netty | 21 | Metadata and isolated contracts; live egg validation deferred | Unverified |
| Fabric 26.1, loader 0.19.5, installer 1.1.2 | 775 / Netty | 25 | Metadata, generated-launcher integrity and isolated contracts; live egg validation deferred | Unverified |
| Forge 1.21.4, loader 54.1.16 | 769 / Netty | 21 | Metadata, authoritative output verification and isolated contracts; live egg validation deferred | Unverified |
| Pre-1.7 legacy protocols | Legacy | Per release, unverified | Recognition/rejection fixtures only; no modern response or wake assumed | Unsupported |
| Unregistered snapshots/future protocol IDs | Unknown until resolved | Per release, unverified | No inferred compatibility | Unverified / hidden |

Metadata was checked against the pinned protocol registry on 2026-10-09.
Shared wire IDs do not transfer runtime, loader, installation or client evidence
between rows. Modern transfer intent is recognized only where declared, remains
disabled by default, and has no real transfer acceptance claim here. A successful
fixture does not turn an unverified row into a verified one. The current signed
Owner registry is authoritative for enabled combinations and evidence expiry.

[Validation](M4-VALIDATION.md) records exact real-server identities, commands,
failures and cleanup. Live client tests use an independent protocol client with
explicitly isolated offline authentication; they do not claim testing of
Microsoft authentication, encryption or secure chat. Those bytes remain the
backend's responsibility during transparent forwarding.

The final signed real-server report is `0b210736-b977-46f3-a931-1b1286bcbb95`,
recorded at 2026-10-09T19:04:41Z for UUID
`714fd53c-c06d-4e9c-afd8-bc7c52dde966`. It combines the unchanged original
protocol receipts with the successful reviewed content continuation and fresh
artifact/image/startup/environment verification. All twelve required checks passed;
rollout remained `private-testing` in the isolated database. This is not a production
availability change. Actual client coverage is `minecraft-protocol` 1.68.0 offline
PLAY with observed outbound protocol 775, not Microsoft online authentication,
encryption or secure-chat acceptance. See [full evidence and limitations](M4-VALIDATION.md).
