# NickHosting Panel — Codex project specification

**Status:** M0 repository and governance bootstrap; application implementation not started.

**Repository:** [ImJstNickDev/nickhosting-panel](https://github.com/ImJstNickDev/nickhosting-panel) (public, independently versioned).

**Web application:** deployment URL configured through `NH_PUBLIC_URL`; actual hostnames remain in local infrastructure notes.

**Existing Pterodactyl Panel:** separate, configurable backend; unchanged.

**Public website:** `nickhost.ing` — separate existing repository, out of scope.

This repository contains the **approved documentation and agent-governance baseline**, not an implemented application. M0 creates repository governance and an open review PR. **No live server, DNS record, Docker deployment or production configuration has been changed.** M1 requires separate authorization after review.

## Read in this order

1. [`PREPPING.md`](PREPPING.md) — set up Codex subagents in the project workspace.
2. [`AGENTS.md`](AGENTS.md) — non-negotiable agent rules, especially production safety.
3. [`docs/PRODUCT.md`](docs/PRODUCT.md) — requirements and user/Owner behavior.
4. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components and interfaces.
5. [`docs/MILESTONES.md`](docs/MILESTONES.md) — **M0–M6**, acceptance criteria and PR gates.
6. [`docs/GITHUB-WORKFLOW.md`](docs/GITHUB-WORKFLOW.md) — GitHub-native tracking/review, no GitHub Actions.
7. [`docs/CODEX-PROMPTS.md`](docs/CODEX-PROMPTS.md) — reusable milestone launch prompts.

The remaining documents detail authentication, resource accounting, game SDK, gateway, deployment, and UX/i18n. The [`docs/decisions`](docs/decisions/) directory contains the architecture decision records (ADRs).

## Non-negotiable project shape

- **Self-hosted free game hosting for invited friends**; no shopping cart, billing, or plan sales.
- End users see only NickHosting Panel; Pterodactyl + Wings are an existing backend, not a replacement target.
- Single physical server for now; one permanent Game Gateway colocated with the panel deployment.
- Only **NickHosting-managed** game servers traverse that gateway; Owner-created Pterodactyl servers remain direct and untouched.
- Invited users can create many stopped servers within persistent-storage policy; RAM/CPU are charged to *starting/running/stopping* servers.
- Separate game integrations with runtime profiles, configurable Pterodactyl nest/egg mappings, protocol handlers, wizards, sleep/wake and management screens.
- First-class Minecraft Java and Satisfactory support before first full user-facing release.
- Complete frontend **only in M6**, implemented and reviewed using real screenshots, not a throwaway MVP.
- Every milestone M0–M6 concludes with an open GitHub PR; Owner/reviewer performs review before merge.

## Public hostnames

The NickHosting web app and existing Pterodactyl Panel use separate, configurable hostnames. Set the web app URL through `NH_PUBLIC_URL` in `.env` (and via Owner settings where supported). Actual deployment hostnames are retained only in `.codex/local/INFRASTRUCTURE.md`, which is gitignored and must be read before authorized infrastructure work. Treat the services as separate applications and ingress targets. **Do not change live DNS, proxy routing, or either service configuration without explicit Owner approval.** Backend-to-backend requests may use an internal Docker hostname instead of the public Pterodactyl URL.

## Change management

Project docs are the source of truth; update the relevant documents and ADRs when decisions change. If a requirement contradicts an existing rule, **stop and ask** rather than quietly reinterpret it.

## External references (verify pinned versions when implementing)

- [Codex subagents](https://developers.openai.com/codex/subagents)
- [Pterodactyl 1.x API overview](https://docs.pterodactyl.io/v1/api)
- [Wings Docker bindings](https://github.com/pterodactyl/wings/blob/develop/environment/allocations.go)
- [Better Auth linking behavior](https://www.better-auth.com/docs/concepts/users-accounts)
- [GitHub PR templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests)
