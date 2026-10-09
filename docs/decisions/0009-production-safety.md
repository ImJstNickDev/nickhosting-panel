# ADR 0009 — Controlled tests on real Pterodactyl production

**Status:** Accepted; mandatory for all Codex agents

## Decision

Codex may read production and use APIs to create, start, stop, reinstall, wipe and delete only **provably Codex-created** test servers. Never mutate pre-existing or unverified servers; uncertainty means stop and ask. Keep durable asset provenance ledger; names alone are not proof.

Changes to existing Pterodactyl/Wings instances, production Docker networks, Compose, DNS, firewall, routers, bind9, ingress and existing persistent files need separate explicit Owner approval. This restriction applies to all subagents; no inheritance of broad permission from test-server creation.

## Consequences

Production test infrastructure has to be protected from resource starvation and credential leakage. PR reports list test assets, mutations and cleanup. Required infrastructure changes are proposed with diffs/rollback and await approval.
