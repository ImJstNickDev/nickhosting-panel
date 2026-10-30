# ADR 0018 — Minecraft identity and protocol-family support

**Status:** Accepted by the Owner, 2026-10-14; M5 implementation.

The game integration's canonical ID and display name become `minecraft` / Minecraft.
Java remains the existing `minecraft-java` TCP protocol handler, independently of the
integration identity. A future Bedrock or combined-edition runtime does not require a
second game integration; no Bedrock implementation is included in this amendment.

Migration 031 changes mutable identity references transactionally. Mapping digests
retain the explicit historical Java preimage alias; signed evidence, immutable job
commands and historical records are never rewritten. Existing v1 Gateway declarations
remain readable only for their original exact 26.1/775 pair. New routes carry the v2
`minecraft/vanilla` declaration.

The compiled integration declares protocol-family capabilities. Original-client tests
are not a per-release availability gate: automated framing/encoding tests and an
independent headless client cover shared behavior. Owner diagnostics distinguish
real-client evidence, independent library tests, synthetic fixtures and best effort.

The fake endpoint supports status and initial login/disconnect only. It mirrors modern
client protocol IDs and 1.6 ping IDs, using the configured target version when the
client does not identify itself. A modern unknown ID is not by itself an error.
Client/backend incompatibility still is not translated into compatible gameplay.

Gateway/wake/readiness and automatic player-idle sleep are separate. Provider-running
readiness remains as in ADR 0016. Historical backends without a known player-count
query retain unknown counts and cannot automatically sleep. Missing data is not zero.

A bounded session quiet-finalization hook disambiguates unframed FE/FE01 requests.
It preserves the absolute deadline, route leases, response/input bounds and no-wake
status behavior. Modern parsing/forwarding has no new deliberate delay or remote
lookup. See [protocol specification and evidence](../MINECRAFT-MULTIPROTOCOL.md).
