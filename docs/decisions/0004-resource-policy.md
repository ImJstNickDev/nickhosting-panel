# ADR 0004 — RAM/CPU for active servers, persistent storage policy

**Status:** Accepted; technical feasibility gate in M2

## Decision

User compute budget counts RAM/CPU of starting, running, restarting and stopping servers, not stopped servers. Offline servers may exceed concurrent compute allowance in aggregate. First start after creation is automatic if resources are available. Wake without sufficient RAM immediately fails with understandable response, not a queued automatic wake. Default storage policy is a global pool, switchable by Owner to user budgets.

## Consequences

Atomic reservations and reconciliation required. Pterodactyl 1.x's configured-RAM capacity accounting differs from this model; M2 MUST empirically verify legal provisioning/limit handling with the installed version, without modifying Pterodactyl/Wings. If not feasible as scoped, stop and request approval before changing semantics or infrastructure.
