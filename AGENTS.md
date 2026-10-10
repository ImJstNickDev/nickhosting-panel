# Agent operating contract — NickHosting Panel

This file applies to the coordinating Codex agent **and every subagent**. Read it before touching code or calling infrastructure APIs. Do not replace it with verbose generic rules.

## Mission and repository boundaries

Develop `nickhosting-panel`, a standalone pnpm/TypeScript monorepo for an invite-only, free game server platform. The site `nickhost.ing` has its own separate repository; never modify it as part of this project. Pterodactyl/Wings already run in production and must not be patched or forked without specific Owner approval.

Follow [`docs/MILESTONES.md`](docs/MILESTONES.md). Finish **only the assigned milestone**. Open a PR and report its URL and HEAD SHA; **do not merge it**, even if tests pass.

**Prepping exception:** follow [`PREPPING.md`](PREPPING.md) before M0. Do not initialize the project Git repository, create GitHub resources or a PR, begin implementation, or access production during Prepping. Stop after reporting readiness for Owner review; the milestone PR workflow below starts at M0.

## Production safety — highest priority

**Allowed without additional permission**:
- Read relevant Pterodactyl API metadata and inspect source/configuration read-only where access is granted.
- Use the real Pterodactyl API for isolated integration tests.
- Create new, explicitly test-owned Pterodactyl game servers; edit, start, stop, reinstall, wipe, or delete **only these proven test-owned servers and their data**.
- Develop and test the project's own code locally, with mocks or isolated test services.

**Requires explicit, operation-specific Owner approval**:
- Any mutation to **pre-existing or ambiguously owned** Pterodactyl servers, volumes, users, databases, egg/nest configurations, or existing game data.
- Any edit, restart, or reconfiguration of live Pterodactyl/Wings, host Docker networks, existing Compose stacks, Docker daemon, firewall/NAT/router, bind9, reverse proxy, real Cloudflare DNS, or external services.
- Deployment of NickHosting containers that alters current live host ports, routes, volumes, services, or infrastructure configuration.
- Accessing or changing any live persistent state whose ownership is uncertain.

**Proof of test ownership** is mandatory before destructive or mutating test-server operations: a durable test-asset ledger containing the Pterodactyl UUID/ID, creator run/PR, creation timestamp and associated external ID if available, corroborated against the live API. The server's name/prefix alone is insufficient. If the ledger is absent, mismatched or ambiguous, **stop and ask**. Persist that ledger only in untracked project test state (`./mountdata/test-assets/`) or a controlled DB table; never leak credentials or private data to git.

Create test servers conservatively to avoid exhausting real RAM, disk, or ports. Do not modify or delete a pre-existing server even if it appears idle. No unattended destructive cleanup outside the proven test-owned scope.

Before authorized infrastructure investigation, read `.codex/local/INFRASTRUCTURE.md` if present. This gitignored local document preserves the Owner-supplied installation and extension paths, stale-directory exclusions, host/network/resolver details and deployment hostnames. Use only the identified current installation; never guess a path or substitute a stale copy. If relevant local context is absent or ambiguous, obtain it from the Owner before access. Do **not** copy closed-source extension files into the public repository without explicit license/permission review. Never publish local infrastructure notes.

When an operation requires approval, give: exact proposed change, why necessary, affected resources, risks, rollback plan, and commands/config diff; wait for approval. Do not infer approval from permission to create test servers.

## Architecture boundaries

- Site and web app remain separate repositories.
- Pterodactyl adapter is the single integration boundary; no Pterodactyl keys in browsers.
- Public gateway traffic is limited to servers created/imported explicitly into NickHosting; unrelated Pterodactyl servers are untouched.
- Per-game plugin declares wizard, runtime/egg mappings, protocol variations, idle/wake/readiness, screens, and domain modes.
- Runtime settings resolve as defaults < Owner DB settings < `.env` override. Secrets use a dedicated protected store or environment variables.
- Use pnpm and TypeScript. PostgreSQL is authoritative; Redis/BullMQ are job/coordination infrastructure.
- New persistent bind mounts live under `./mountdata/` (gitignored). The existing frontend Docker network identified in local notes is **external** and must not be re-created by the project.
- Internal Docker hostnames preferred for in-network Pterodactyl access; if resolving its external FQDN from project containers, configure the Owner-specified resolver from local notes and verify resolution, without changing bind9.
- No hardcoded host IP, domain, Pterodactyl URL, node ID, port ranges or infrastructure paths in product code.
- The complete app (including Owner UI, game-specific UI, jobs, emails and errors) must be internationalizable; English and Italian shipped initially.

## Agent workflow

1. Read the task and relevant docs; identify dependencies and safety boundaries.
2. Delegate **independent, bounded** work to subagents (ideally 1–3). Assign non-overlapping files. Establish shared contracts first.
3. Require evidence, tests, and an independent reviewer subagent for substantial work. Parent agent owns integration.
4. Run local checks (`pnpm` lint, types, unit/integration tests as available) and report results honestly.
5. Update docs/ADRs when behavior changes; keep changes within the milestone.
6. Push to a milestone branch, open a **draft PR** while work is ongoing, then mark ready for review when finished; **never merge**.
7. PR must contain requirements checklist, test outcomes, affected APIs/config, safety statement, unresolved issues, rollback instructions and screenshots for M5 and later UI changes.

No GitHub Actions are required. Do not create CI workflows or enable external automation unless specifically requested.

## Quality bar

Do not substitute mock screens for finished M5 UI. Before M5, exercise backend behavior with test clients and fixtures. M5 delivers the complete WebPanel and common backend/API integration needed by its supported capabilities; M6 adds Satisfactory and evidence-dependent game/runtime expansion. Satisfactory is not an M5 prerequisite. In M5, deliver complete user and Owner flows, take real browser screenshots across desktop/mobile, loading/empty/error/blocked/uncertain and supported game-specific screens; iterate on visual defects. No hardcoded user-facing text, silent API errors, unverified success claims, or invented progress percentages.

NickHosting is an application, not a marketing landing page. Follow [M5 UX/content standards](docs/FRONTEND-I18N.md): task flows before visuals, factual compact English/Italian copy, WCAG 2.2 AA and keyboard/focus checks, meaningful information density, reviewed screenshots, and independent UX/content review. No promotional copy, automatic heading subtitles, decorative statistics, generic dashboard templates, gratuitous gradients/glass, filler or unsupported choices. Use capability descriptors rather than scattered game-specific checks. Trust compiled integration capability declarations for installation and optional Gateway features; local signed reports remain honest Owner diagnostics, not a per-mapping Vanilla creation prerequisite. Keep undeclared runtimes behind their existing evidence/rollout controls. Direct connections require explicit Owner endpoints and retain admission/identity checks; never claim their external reachability without a test. Issue #18 remains a separate production-release gate.

## Work-report format

At the end of each work session: milestone, branch, HEAD, PR URL/status, implementation highlights, commands/test evidence, production interactions/approval status, test assets created/cleaned, risks, unresolved blockers, and precise review requests.
