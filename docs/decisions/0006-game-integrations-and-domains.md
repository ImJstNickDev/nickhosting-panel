# ADR 0006 — First-party game plugins, mapping and connection modes

**Status:** Accepted

## Decision

Game integrations provide wizard, runtime profiles, configurable Pterodactyl nest/egg mappings, game management screens, protocol-version codecs, readiness, idle/sleep/wake and content providers. Integrations declare their connection strategy: custom subdomain with optional SRV (e.g. Minecraft), or Owner-configured static hostname + actual port (e.g. Satisfactory). DNS records through Cloudflare provider, not scattered plugin credentials.

## Consequences

Minecraft and Satisfactory each get full separately tested integrations. Plugins are trusted first-party packages and can be allowlisted for chosen testers before public availability. Runtime profiles skip redundant wizard questions determined by a modpack. Closed-source Blueprint plugin code can be studied with permission, never copied into a public repo without rights.
