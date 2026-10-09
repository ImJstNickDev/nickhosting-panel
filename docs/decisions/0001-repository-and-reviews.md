# ADR 0001 — Separate panel repository, seven PR milestones

**Status:** Accepted

## Decision

New public GitHub repository `nickhosting-panel`, independent of the `nickhost.ing` Astro website repository; web URL configurable via `.env`, with actual deployment hostnames kept in local infrastructure notes. Prepping configures Codex subagents without a PR. M0 creates the public GitHub repo via `gh` and opens its own PR; M1–M6 each conclude in separate reviewable PRs. Codex never merges PRs; the Owner reviews and performs merges. GitHub native Issues/Milestones/labels/PR templates and optionally a simple Project board; no GitHub Actions by default.

## Consequences

Separate deployment/lifecycle, docs versioned in code repo, reviewer inspects each integrated milestone. The existing Pterodactyl Panel and NickHosting WebPanel retain separate, configurable ingress targets. No automatic change to existing DNS or ingress.
