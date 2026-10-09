# M1 development and validation

M1 PR #16 was squash-merged with explicit, one-time Owner authorization into
`main` at `b1a71ef52721e413e861d410954d06fd743b883c`. Its validation record follows;
current M2 work is tracked in [M2 validation](M2-VALIDATION.md). M0 PR #1 was
squash-merged with an explicit, one-time Owner authorization; this does not change
the standing prohibition on Codex merging milestone PRs. Its reviewed tree is
the M1 baseline (`aabd3817ace560c10fa687136e0360c8437b1f1a`).

## User-scoped runtime

Use Node **24.21.0 LTS** and pnpm **10.33.0**. `.node-version`, `.nvmrc`,
`package.json` and the lockfile define the development toolchain. No system
runtime, OS package or service is replaced. Node 24.21.0 was selected from the
[official release index](https://nodejs.org/dist/index.json); its Linux x64 archive
was downloaded from nodejs.org and checked against the published SHA256 manifest.
The user-local installation lives under `$HOME/.local/share/nickhosting-node/`.
An existing version manager may instead activate the pinned release.

`scripts/dev.sh` activates that local release when present and checks the pin
before executing a command; it does not change shell startup files or services:

```sh
scripts/dev.sh node --version
scripts/dev.sh pnpm --version
scripts/dev.sh pnpm install --frozen-lockfile
scripts/dev.sh pnpm lint
scripts/dev.sh pnpm format:check
scripts/dev.sh pnpm typecheck
scripts/dev.sh pnpm test
```

83 GiB of disk space was available before dependency installation. Never remove
unrelated data to make room. Install dependencies only into this workspace and
the user's package store.

## Isolated integration resources

[`compose.test.yaml`](../compose.test.yaml) describes only project-owned test
PostgreSQL and Redis. It is **not** a production deployment and must not be
started without explicit Owner approval. It uses an isolated internal network,
loopback-only port declarations, resource caps and gitignored persistence
under `mountdata/m1-tests/`. PostgreSQL 18 uses `/var/lib/postgresql` for its bind
mount. Redis enables AOF and `noeviction`, as required for BullMQ delivery.

Before an approved start, confirm the Compose project name and data directory
are absent or positively identified as this project's existing test resources.
Generate independent random credentials in mode-0600 `.env.test.local`; never
copy actual application/provider credentials into the test environment.

```sh
# Execute only after approval for this exact Compose project.
docker compose --env-file .env.test.local -f compose.test.yaml up -d --wait
scripts/dev.sh pnpm test:isolated
# Only with explicit approval for a scoped restart of these test services:
python3 scripts/check-test-persistence.py --restart-approved-test-services
# After tests: removes only this project's containers and internal network.
docker compose --env-file .env.test.local -f compose.test.yaml down
```

`test:isolated` runs `scripts/test-env.ts`, which verifies the Compose project,
service and network labels before constructing test URLs. Docker may suppress
published ports on an internal network; this runner then discovers only the
verified test containers' private, host-reachable addresses. No real address is
hardcoded or published, and the internal network is left unchanged. Passwords
and generated URLs are never printed. Explicit `NH_TEST_DATABASE_URL` and
`NH_TEST_REDIS_URL` are used by suites; they never fall back to application URLs.
Each suite creates a random PostgreSQL schema and Redis key prefix and cleans
up only those resources. The restart check applies all M1 migrations in its own empty schema, stores
a settings marker and a Redis marker, then verifies schema/data and the absence
of seeded users after restarting only these approved services. Retain bind-mount data for
investigation unless explicitly cleaning proven test data.

The Owner explicitly approved creating this exact Compose project, its internal
network and project-owned bind mounts, scoped PostgreSQL/Redis restart checks,
and final `down` cleanup during M1. This session's approval does not authorize
future production deployment or changes to other stacks. No privileged host
ports, external frontend network or existing resources were used.

No Pterodactyl, Wings, DNS, firewall, existing network, game server or production
state is needed for M1 tests. Provider behavior is exercised through isolated
fixtures. Graphical application flows and common integration belong to M5.


## Running the backend locally

Copy `.env.example` into an ignored `.env` and supply actual development settings
privately. The scripts `db:migrate`, `dev:api` and `dev:worker` explicitly load
that file using Node's environment-file support; already-exported environment
values take precedence. `NH_API_BIND_HOST`/`NH_API_PORT` select the internal
listener independently of the external `NH_API_URL`. HTTPS public/API origins
belong behind an approved TLS ingress in production; none is deployed here.

```sh
scripts/dev.sh pnpm db:migrate
scripts/dev.sh pnpm dev:api
# In a second process:
scripts/dev.sh pnpm dev:worker
```

Set `DATABASE_URL`, `REDIS_URL`, `NH_JOB_PREFIX`, `BETTER_AUTH_SECRET`,
`NH_SECRETS_MASTER_KEY` (base64 of 32 random bytes), and the one-time
`NH_SETUP_TOKEN` before first run. Generate each secret independently outside Git.
Configure SMTP with a sender and TLS/STARTTLS before Owner verification; no
verification/reset links are printed to logs. Optional Discord and Pterodactyl
credentials can be stored encrypted through the authenticated Owner contracts.
Read [API contracts](M1-API.md) and [ADR0010](decisions/0010-foundation-identity-and-durability.md).

No lint, type or integration check depends on GitHub Actions. The API and worker
have no import-time network side effects. Production deployment packaging and
all graphical flows remain outside this milestone.

## M3 standalone Gateway

Read [M3 API/configuration](M3-API.md) before supplying a protected, ignored
`.env.gateway.local`. `scripts/dev.sh pnpm dev:gateway` runs the persistent process
separately from API/worker. It has no default game/diagnostic TCP listener and
waits 31 seconds before opening game routes after a cold start. Protocol modules
are trusted local code; M3 includes synthetic fixtures only. Do not start a
configured public deployment without the documented approval and topology proof.

`pnpm test:m3` reuses the **already approved exact M2** isolated PostgreSQL/Redis/
SFTPGo services, applying all migrations and running all integration suites.
Three retained SFTPGo SSH-transport revocation assertions remain expected failures,
not security passes. The separate real-network fixture and its explicit commands
are documented in [M3 test infrastructure](M3-TEST-INFRASTRUCTURE.md).
