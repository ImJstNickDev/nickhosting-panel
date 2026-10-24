# ADR 0006 — First-party game plugins, mapping and connection modes

**Status:** Accepted

## Decision

Game integrations provide wizard, runtime profiles, configurable Pterodactyl nest/egg mappings, game management screens, protocol-version codecs, readiness, idle/sleep/wake and content providers. Integrations declare their connection strategy: custom subdomain with optional SRV (e.g. Minecraft), or Owner-configured static hostname + actual port (e.g. Satisfactory). DNS records through Cloudflare provider, not scattered plugin credentials.

## Consequences

Minecraft and Satisfactory each get full separately tested integrations. Plugins are trusted first-party packages and can be allowlisted for chosen testers before public availability. Runtime profiles skip redundant wizard questions determined by a modpack. Closed-source Blueprint plugin code can be studied with permission, never copied into a public repo without rights.

## Owner-approved clarification — 2026-10-16

Owner administration is organized by integration, with trusted SDK contributions
for game-specific pages and common tabs for rollout, runtime mappings, connection
policy, sleep and content limits. Physical hosts/nodes/allocations remain in
Infrastructure; it links to the single mapping editor instead of duplicating it.

Temporary content storage, staging budgets, concurrency, disk headroom and
configured download trust belong to Core and apply across all integrations.
Per-integration overrides can restrict that shared budget/trust, never increase
total capacity. Historical Minecraft configuration names remain aliases and
existing storage paths/ledgers remain recoverable. Minecraft protocol metadata
and Gateway response presentation remain game-specific. This clarification adds
no Satisfactory implementation and does not change production approval boundaries.
