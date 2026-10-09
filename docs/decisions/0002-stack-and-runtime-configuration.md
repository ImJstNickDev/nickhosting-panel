# ADR 0002 — pnpm, TypeScript, PostgreSQL and Redis

**Status:** Accepted

## Decision

Use Node/TypeScript, pnpm workspaces, React frontend, Hono backend and Better Auth, PostgreSQL authoritative data, Redis + BullMQ for durable-processing transport and job scheduling; single process Game Gateway for v1. Config layering: defaults < Owner database settings < explicit `.env` overrides. Sensitive wizard-provided credentials stored separately and encrypted with environment-provided master key. Never hardcode specific node IPs/domains/egg IDs.

## Consequences

One primary language and shared types. Redis AOF plus DB idempotency/reconciliation are required; Redis queue state is not enough alone. No database seeding for initial Owner; protected first-run wizard creates live settings. Optional tooling (e.g. monorepo task runners) requires demonstrated need.
