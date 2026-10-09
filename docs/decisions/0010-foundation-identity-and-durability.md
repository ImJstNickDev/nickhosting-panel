# ADR 0010 — M1 identity, configuration and job boundaries

**Status:** Implemented in M1; pending Owner review

## Decision

Use Node 24 LTS, Hono, Better Auth 1.7.7, PostgreSQL 18, Kysely with `pg`,
and BullMQ with Redis. Exact development versions are pinned in manifests and
the pnpm lockfile. Kysely provides typed SQL and explicit transactions without
an additional ORM mapping layer. Ordered, checksummed SQL migrations are
transactional and serialized with a database advisory lock. They create no
Owner, users, games, instance settings or other seeded application data.

Better Auth uses its native PostgreSQL Pool adapter. Its email and OAuth user
creation transactions include the guarded invitation decrement through
`getCurrentAdapter().incrementOne()`. Ordinary pool writes in a hook would be
outside that transaction. A custom invitation schema exposes the same table to
the transaction-aware adapter. OAuth state contains a server-owned invitation
digest; client `additionalData` cannot supply admission. Email-bound OAuth
invitations additionally require a verified provider address. Direct auth
endpoints share these checks. Explicit account linking is enabled; implicit
matching-email linking is disabled. Provider tokens are encrypted by Better Auth.

First run has two stages: the environment bootstrap token authorizes an atomic,
unique Owner claim; verified Owner authentication then authorizes connection
validation and encrypted Pterodactyl settings. The initial password is hashed
with Better Auth's implementation. Email delivery must be configured before
the verified email/password bootstrap. Delivery failure never reopens the
Owner claim: resend verification recovers it. Server access is required for
deliberate administrative recovery. M1 never contacts live Pterodactyl in tests.

Discord accounts without email use the provider's stable ID in an unverified
`.invalid` placeholder. No mail is sent there. Reverse email/password linking
requires a recent authenticated session, a session-bound emailed proof, an
atomic unique-email/account update, and revocation of other sessions. Linking
conflicts never merge identities. Passkeys and TOTP/recovery are optional.
WebAuthn verifies the configured **browser** origin, including when API origin
differs, and rejects authentication without verified user presence/verification.

Owner support requires password reauthentication and, when enrolled, TOTP or a
single-use recovery code. This policy is independent of the login method:
Better Auth's automatic TOTP login challenge applies to password login. Passkey
login does not itself grant support elevation. One-use, short-lived grants
create separate hashed support tokens bound to the Owner's ordinary session.
Support tokens cannot authorize identity/settings changes. The target's ordinary
session remains unchanged; actor, subject and support correlation remain separate.

The Node ingress replaces untrusted address headers with the actual socket
peer for authentication rate limits. M1 does not trust arbitrary proxy headers.
Behind a reverse proxy, limits conservatively share that peer's bucket until a
separately reviewed deployment trust policy is supplied. In-process test clients
without a socket use the library's shared per-path bucket.

Configuration is defaults < stored Owner settings < explicit environment.
Environment-locked fields cannot be changed through the settings API. Optional
Discord stays disabled while only one of its ID/secret pair is configured;
partial setup never disables Owner access. Database-backed settings are resolved
per request. Listener host/port changes require process restart. AES-256-GCM
stores provider secrets in a separate table with key ID and record-bound AAD;
HTTP clients see only presence/source, never secret values. Auth secrets and
encryption keys remain external to the database.

PostgreSQL owns job state, idempotency and an outbox. Redis transports only job
IDs and may lose or repeat deliveries. Repeated publication and row locks
provide recovery. M1's real `foundation.record-activity` handler commits its DB
effect, step and completion atomically; failed attempts roll back their effects.
This does not claim exactly-once external effects. M2 handlers must add explicit
external-effect reconciliation before provisioning infrastructure.

Game rollout uses one enum: `development`, `private-testing`, `public`,
`disabled-for-new-servers`. Visibility never grants resource authority. En/it
catalogs cover backend errors, jobs, mail and auth wrappers; M6 will integrate
the same message IDs with its React localization framework.

## Evidence and limits

Local tests use real isolated PostgreSQL/Redis and fixture-only Discord,
Pterodactyl connection checks and email capture. A software authenticator signs
WebAuthn ceremonies; physical authenticator/browser UX remains M6 validation.
The optional integrations require actual credentials and delivery/reachability
validation before deployment. No application deployment or production topology
is included in M1. Application APIs currently run from TypeScript with the pinned
`tsx` tool; frontend/bundling and production deployment are separate work.

Better Auth lifecycle audit hooks run after its committed auth transactions;
they are not an atomic compliance ledger. Application settings, setup, invitation,
role, support and job audit/state changes share their own database transactions.
Logs use fixed events and redaction; raw request bodies and provider responses
are not logged. Secret scanning is heuristic and accompanies manual staged review.

Sources used for implementation: [Better Auth PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql),
[OAuth state](https://better-auth.com/docs/concepts/oauth),
[Discord](https://better-auth.com/docs/authentication/discord),
[two-factor authentication](https://better-auth.com/docs/plugins/2fa),
[passkeys](https://better-auth.com/docs/plugins/passkey),
[rate limiting](https://better-auth.com/docs/concepts/rate-limit),
[BullMQ persistence guidance](https://docs.bullmq.io/guide/going-to-production).
