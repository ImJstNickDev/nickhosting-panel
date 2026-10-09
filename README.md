# NickHosting Panel — Codex project specification

**Status:** M4 merged with explicit Owner authorization; M5 WebPanel is on [PR #21](https://github.com/ImJstNickDev/nickhosting-panel/pull/21) for Owner/ChatGPT review. See [M5 validation](docs/M5-VALIDATION.md) and the preserved [M4 evidence](docs/M4-VALIDATION.md). No production deployment is authorized.

**Repository:** [ImJstNickDev/nickhosting-panel](https://github.com/ImJstNickDev/nickhosting-panel) (public, independently versioned).

**Web application:** deployment URL configured through `NH_PUBLIC_URL`; actual hostnames remain in local infrastructure notes.

**Existing Pterodactyl Panel:** separate, configurable backend; unchanged.

**Public website:** `nickhost.ing` — separate existing repository, out of scope.

M0 governance and M1 are merged. M1 adds executable Hono API/worker foundations, PostgreSQL migrations, durable jobs, configuration and identity contracts with isolated integration tests. See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) and [`docs/M1-API.md`](docs/M1-API.md). The complete graphical frontend and common platform readiness belong to M5. **No pre-existing server, DNS record or infrastructure configuration has been changed.** The separately approved, project-owned PostgreSQL/Redis/SFTPGo test services are isolated from production. See the M2 validation record for current controlled-test evidence.

## Read in this order

1. [`PREPPING.md`](PREPPING.md) — set up Codex subagents in the project workspace.
2. [`AGENTS.md`](AGENTS.md) — non-negotiable agent rules, especially production safety.
3. [`docs/PRODUCT.md`](docs/PRODUCT.md) — requirements and user/Owner behavior.
4. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components and interfaces.
5. [`docs/MILESTONES.md`](docs/MILESTONES.md) — **M0–M6**, acceptance criteria and PR gates.
6. [`docs/GITHUB-WORKFLOW.md`](docs/GITHUB-WORKFLOW.md) — GitHub-native tracking/review, no GitHub Actions.
7. [`docs/CODEX-PROMPTS.md`](docs/CODEX-PROMPTS.md) — reusable milestone launch prompts.

The remaining documents detail authentication, resource accounting, game SDK, gateway, deployment, and UX/i18n. The [`docs/decisions`](docs/decisions/) directory contains the architecture decision records (ADRs).

M2's backend contracts are documented in [`docs/M2-API.md`](docs/M2-API.md), with lifecycle/resource/service decisions in [ADR 0011](docs/decisions/0011-server-lifecycle-and-service-boundaries.md). Validation results, accepted limitations and verified test cleanup are recorded in [`docs/M2-VALIDATION.md`](docs/M2-VALIDATION.md); this review delivery is not deployment approval. The temporarily accepted SFTPGo 2.7.6 existing-SSH-transport revocation limitation remains a production-release follow-up.

M3 contracts and deployment prerequisites are in [`docs/M3-API.md`](docs/M3-API.md).
The standalone Gateway is tested through synthetic protocols; no real game codec
or public production listener is included in this milestone.

## Non-negotiable project shape

- **Self-hosted free game hosting for invited friends**; no shopping cart, billing, or plan sales.
- End users see only NickHosting Panel; Pterodactyl + Wings are an existing backend, not a replacement target.
- Single physical server for now; one permanent Game Gateway colocated with the panel deployment.
- Only **NickHosting-managed** game servers traverse that gateway; Owner-created Pterodactyl servers remain direct and untouched.
- Invited users can create many stopped servers within persistent-storage policy; RAM/CPU are charged to *starting/running/stopping* servers.
- Separate game integrations with runtime profiles, configurable Pterodactyl nest/egg mappings, protocol handlers, wizards, sleep/wake and management screens.
- Minecraft Vanilla is the first verified integration for the M5 WebPanel; Satisfactory and further game/runtime certifications belong to M6 and do not block M5.
- Complete frontend and common platform readiness **in M5**, implemented and reviewed using real screenshots, not a throwaway MVP.
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

The current M2 correction round is documented in [`docs/M2-REVIEW-REVISIONS.md`](docs/M2-REVIEW-REVISIONS.md).
The final Wings loopback compatibility correction and M3 collision gate are
documented in [`docs/M2-LOOPBACK-REVIEW.md`](docs/M2-LOOPBACK-REVIEW.md).

M4 Minecraft backend work is tracked in [`docs/M4-VALIDATION.md`](docs/M4-VALIDATION.md).
Its [API contracts](docs/M4-API.md), [Owner-only protocol evidence](docs/M4-PROTOCOL.md),
[runtime resolution](docs/M4-RUNTIMES.md) and [content research/licensing](docs/M4-CONTENT-RESEARCH.md)
separate implementation, fixtures and real-server verification. The graphical app
belongs to M5; a listed upstream version is not by itself a compatibility claim.

## Approved roadmap

The Owner-approved 2026-10-09 [ADR 0008 amendment](docs/decisions/0008-complete-frontend.md) moves the complete WebPanel and common API integration to **M5**, followed by **M6 Satisfactory and game integration expansion**. [M5 common integration acceptance](docs/M5-COMMON-INTEGRATION.md) preserves the original gap audit and current implementation traceability. M5 uses `milestone/m5-webpanel`; the future `milestone/m6-game-integrations` branch requires separate authorization. Exactly M0–M6 remain. The [SFTPGo production-release gate #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18) remains open independently of milestone implementation.

### M5 WebPanel development

The React application is in `apps/web`. Use `scripts/dev.sh pnpm dev:web` for
loopback development, `scripts/dev.sh pnpm build` for static assets, and
`scripts/dev.sh pnpm test:browser` for isolated real-handler browser journeys.
See [WebPanel contracts](docs/M5-API-CONTRACTS.md),
[common acceptance traceability](docs/M5-COMMON-INTEGRATION.md) and
[deployment prerequisites](docs/CONFIGURATION-AND-DEPLOYMENT.md).
The WebPanel does not authorize production deployment; SFTPGo issue #18 remains
a production-release gate. M5 does not certify additional Minecraft runtimes or
implement Satisfactory.

[Reviewed browser screenshots](docs/M5-SCREENSHOTS.md) cover the actual application;
[validation](docs/M5-VALIDATION.md) distinguishes real handlers, external fixtures,
full-suite results and targeted review corrections.
