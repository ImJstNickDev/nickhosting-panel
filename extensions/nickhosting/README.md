# NickHosting Blueprint bridge

Version **1.0.0**, targeting Pterodactyl **1.11.11** and Blueprint
**beta-2025-09**. The monorepo is the source of truth; `.blueprint/dev` is optional
Blueprint build staging. Do not use `-build` on production as a development loop.
Actual deployment evidence is recorded in [the extension report](../../docs/BLUEPRINT-EXTENSION.md).

## API contract

All paths below are relative to `/api/application/extensions/nickhosting`.
Every request requires an Application token; browser sessions and Client tokens
are rejected. Blueprint's existing Application rate limiter remains in force.
All responses use `Cache-Control: no-store`.

| Method/path | Permission | Behavior |
| --- | --- | --- |
| GET `/capabilities` | servers READ | Schema/version/features |
| POST `/instances/{instance}` | servers WRITE | Register or rotate callback secret for exact instance UUID |
| GET `/instances/{instance}/health` | servers READ | Pending delivery count, last delivery and checked time |
| PUT `/instances/{instance}/servers/{uuid}` | servers WRITE | Explicit exact-identity link and authoritative snapshot |
| GET `/instances/{instance}/servers/{uuid}` | servers READ | Fresh authoritative snapshot, detect bypassed model events |
| PUT `/instances/{instance}/users/{nickUser}` | users WRITE | Explicit nonadministrator account link |
| POST `/instances/{instance}/users/{nickUser}/keys` | users WRITE | Idempotent native Client key issuance |
| POST `/instances/{instance}/users/{nickUser}/keys/{identifier}/rotate` | users WRITE | Issue replacement, retain original until explicit acknowledgement/revoke |
| DELETE `/instances/{instance}/users/{nickUser}/keys/{identifier}` | users WRITE | Revoke only this extension's exact linked-account key |

Instance UUIDs must be unique per NickHosting environment/provider. An instance
is pinned to the registering Application token's database ID. Changing that
Application key requires a deliberate bridge migration, not silent takeover.
Registration body: `{callbackUrl, webhookSecret}`; secret is 64 lowercase hex
characters, used as its **literal string** in HMAC (not hex-decoded). Only HTTPS
origins explicitly listed in the deployment-owned `config/nickhosting_bridge.php`
`callback_origins` array are accepted. No userinfo, query, fragment or redirects.
No origin is allowed by default. The config file is not shipped in the archive
and install never overwrites an existing copy. A permitted origin remains a
trusted administrative destination; this is not arbitrary-user URL fetching.

Server link identity: `{providerId, providerUuid, identifier, externalId, nodeId}`.
Every field must match the live Panel model. A name/prefix is never proof.
One server cannot be linked to another instance. Identity drift invalidates the
link permanently until a deliberate administrative migration; retrying PUT does
not silently repair or retarget it. Only limits are synchronized; allocation
inventory, ownership/admission and Gateway topology checks remain independent.

Events/snapshots: `{schemaVersion:1,eventId,instanceId,server,revision,type,limits,occurredAt}`.
Types are `snapshot`, `limits.updated`, `identity.invalidated`. Limits contain
`memory,swap,disk,io,cpu,threads` (threads nullable). Revisions are per linked server;
invalidation retains the originally registered identity so the receiver can revoke
its exact projection. Snapshot reads set `occurredAt` to the actual read time.
Linking queues an initial `limits.updated` delivery as well as returning a snapshot.

Webhook headers: `X-NickHosting-Timestamp` Unix seconds,
`X-NickHosting-Event-Id`, `X-NickHosting-Signature` = HMAC-SHA256 of
`timestamp + '.' + exact JSON bytes`. Receiver must bound body size, verify the
signature/timestamp/event ID, persist before acknowledgement, deduplicate and
reject stale revisions. A 2xx response acknowledges delivery. No credentials,
startup environment or game files are serialized in events.

## Delivery and recovery

The global Laravel service provider listens synchronously to server Updated and
Deleted events. Relevant changes write an extension outbox in the existing Panel
transaction. After commit, a normal `standard` queue job attempts delivery.
Queue publication failure leaves the outbox intact. The existing Panel scheduler
queues recovery every minute. Each job handles at most ten events, with bounded
connect/response timeouts and retry backoff up to 15 minutes. Claims expire after
120 seconds; crashes can duplicate delivery but cannot erase an unacknowledged
event. Events can arrive out of order: consumers must use revisions and resnapshot.

Normal transactional Panel edits share commit/rollback with the outbox. Direct
SQL, bulk updates, disabled model events or custom nontransactional writes can
bypass that guarantee. Periodic authoritative snapshots are mandatory recovery;
no claim of instantaneous consistency is made. Delivered events and audit rows
are retained; operators must plan explicit retention before high-volume deployment.

## Account keys

Link body `{providerId,providerUuid,externalId}` identifies an account explicitly
selected by authorized NickHosting administration. No email matching, account
creation, ownership reassignment or migration occurs automatically. Root admins,
identity changes and cross-instance reuse are rejected. Mint/rotate bodies use
`{operationId,allowedIps?}` (UUID idempotency key, optional IP/CIDR restrictions).
Responses `{operationId,identifier,key}` are backend-only. Native Pterodactyl
`User::createToken` is used. An encrypted issuance response permits recovery after
a lost response; reuse with changed parameters or after revocation is rejected.
Rotation intentionally overlaps: store/verify the replacement, then explicitly
revoke the old key. Existing tokens not created by this extension are untouched.
Revocation deletes the exact key and encrypted recovery value, not users/servers.
It does not promise immediate termination of previously issued Wings WebSockets.
NickHosting account migration/credential selection must be enabled separately.

## Installation, update and removal

The standard Blueprint install command also updates an existing extension. The
new package's `private/install.sh` runs on install/update. It migrates **only** the
extension-owned migration path, then adds a marked provider entry in `config/app.php`.
The hook refuses unknown layouts and keeps a permission-restricted source backup
under `storage/app`. Installation creates an empty callback allowlist only if none
exists. No Panel core migration, account mutation or server operation is invoked.

The provider must load in HTTP, CLI and queue contexts even with route caching.
Standard Blueprint finalization rebuilds config/cache and signals queue restart;
its ordinary ownership/permission changes still apply. Verify those effects and
back up the Panel before an approved install. Hook exit failures must be checked
in output: do not assume Blueprint's final success banner proves migration success.

Uninstall removes only the exact marked provider entry. It deliberately retains
outbox, audit, instance links, callback config and issued keys for recovery and
accountability. Revoke keys explicitly before uninstall if intended. The migration
refuses destructive down: data retirement requires a separately reviewed backup
and scoped operation. Rolling back code is not rollback of Panel permissions or
extension data; restore the original config/metadata snapshot where necessary.

## Local checks and packaging

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s extensions/nickhosting/tests -v
python3 extensions/nickhosting/tests/run_php_tests.py --container <existing-panel-container>
python3 extensions/nickhosting/package.py
```

The PHP harness loads only Composer libraries and extension source via stdin;
it does not bootstrap the Panel. Database writes use SQLite `:memory:`, and HTTP
uses Laravel fakes. It exercises transaction rollback, idempotency, encryption,
authorization, identity invalidation, delivery retry and configuration transforms.
It is not a MySQL lock-concurrency or real HTTP middleware test. Packaging uses
an explicit file allowlist, excludes secrets/tests/docs, rejects symlinks and
existing output, and defaults to ignored `build/blueprint/1.0.0/nickhosting.blueprint`.

## Upstream reference / licensing

- [Blueprint manifest](https://blueprint.zip/docs/configs/confyml)
- [Pinned installer](https://github.com/BlueprintFramework/framework/blob/beta-2025-09/scripts/commands/extensions/install.sh)
- [Pterodactyl token API](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Models/Traits/HasAccessTokens.php)
- [Pterodactyl events](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Observers/ServerObserver.php)

Implementation independently uses existing public framework/model contracts.
No Blueprint/PteroCA/closed-source implementation is copied or bundled; no new
repository license decision is introduced.
