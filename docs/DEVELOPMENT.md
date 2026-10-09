# M1 development and validation

M1 is authorized and in progress on `milestone/m1-foundation`. M0 PR #1 was
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
random loopback-only published ports, resource caps and gitignored persistence
under `mountdata/m1-tests/`. PostgreSQL 18 uses `/var/lib/postgresql` for its bind
mount. Redis enables AOF and `noeviction`, as required for BullMQ delivery.

Before an approved start, confirm the Compose project name and data directory
are absent or positively identified as this project's existing test resources.
Generate independent random credentials in mode-0600 `.env.test.local`; never
copy actual application/provider credentials into the test environment.

```sh
# Execute only after approval for this exact Compose project.
docker compose --env-file .env.test.local -f compose.test.yaml up -d --wait
docker compose --env-file .env.test.local -f compose.test.yaml port postgres 5432
docker compose --env-file .env.test.local -f compose.test.yaml port redis 6379
# After tests: removes only this project's containers and internal network.
docker compose --env-file .env.test.local -f compose.test.yaml down
```

The integration harness must require explicit test URLs, create a unique database
namespace and Redis key prefix, and clean up only those proven test resources.
It must never fall back to the application's `DATABASE_URL` or `REDIS_URL`.
Persistence/restart checks operate only on these approved containers. Retain
bind-mount data for investigation unless explicitly cleaning proven test data.

No Pterodactyl, Wings, DNS, firewall, existing network, game server or production
state is needed for M1 tests. Provider behavior is exercised through isolated
fixtures. Graphical application flows remain M6 work.
