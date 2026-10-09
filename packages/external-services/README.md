# External services

This package contains the SFTPGo REST adapter and Cloudflare DNS planner/provider. It has no database, HTTP routes, deployment side effects, or implicit background work. Core must authorize each server operation, serialize changes and persist the intent and results. Credentials stay on the backend except for a newly issued server-scoped SFTP password returned once to its authorized recipient.

## SFTPGo contract and temporary compatibility exception

`SftpGoAdapter` uses an explicitly configured origin, admin API key or access token, instance UUID and absolute data root. `ensureCredential` accepts NickHosting server UUID, external server UUID, credential UUID, random password, expiration timestamp and byte quota. Its only filesystem mapping is `dataRoot/externalServerUuid`; arbitrary paths, root mappings, virtual folders, groups, symlink creation, API-key login, HTTP, FTP and WebDAV are excluded. Passwords use 256 bits of random entropy. Expiration is required and limited to 30 days. Files created outside SFTPGo require separate quota reconciliation; this is not a claim of instant shared filesystem quota enforcement.

Persist the identifiers, requested expiry/quota and encrypted password **before** calling the provider. Keep the same password on retries. The remote account carries the instance/server/credential identifiers in `additional_info`. The response provides the numeric provider user ID; future changes verify both this ID and the metadata/home mapping. Username prefixes alone never establish ownership. `rotateCredential` updates the password with `disconnect=1`. `revokeCredential` disables with `disconnect=1`, then deletes the account; it never removes the server directory. A provider timeout is an uncertain result; retry against the persisted identity before treating issuance, rotation or revocation as complete.

**The Owner temporarily accepted only the existing-SSH-transport revocation limitation in SFTPGo 2.7.6 so M2 can continue.** Rotation and disable/delete close the existing SFTP channel and reject new SSH logins, but an already authenticated SSH transport can open a new SFTP channel and retain access to its original directory. Explicit `DELETE /connections/{id}` has the same limitation. This is not full active-session revocation. The upstream implementation closes the channel in `Connection.Disconnect`, and creates subsequent channels using the user captured at SSH authentication. No proxy, fork or compensating transport workaround is implemented.

The regression suite keeps three strict security assertions as **expected failures**, separately from normal prerequisite/protocol tests. Failed setup, incorrect credentials, broken isolation, failed API calls or failed new-login revocation still fail the suite. The unwaived command below makes all three assertions ordinary failures. If a provider fix makes an expected failure pass, Vitest flags that change for review. Track verified transport-level revocation as a production-release follow-up; re-evaluate the exception with the Owner before exposure or real Wings volume mounts. This exception authorizes no additional infrastructure, production mounts or DNS writes.

Directory isolation was verified against the real service: server A cannot read server B via virtual absolute paths, parent traversal, backslash traversal or an existing symlink planted inside A; SFTP clients cannot create symlinks. Both directories retain their files after credential deletion. Home roots must still be explicitly approved, mounted and protected against untrusted host-side root replacement; do not infer deployment safety from string validation alone.

API scopes needed: view/add/edit/delete users. REST responses/errors are bounded and sanitized. This adapter does not broaden provider privileges or silently fall back to another administrator. SFTPGo expiry prevents new logins; do not assume it terminates an existing SSH transport.

## DNS contract

`planConnection` consumes the plugin-declared mode resolved with Owner configuration. Static hostname + port returns no DNS records. A custom subdomain creates an unproxied A, AAAA or CNAME and optional `_service._tcp`/`_service._udp` SRV record. For CNAME mode the SRV points at the configured canonical target rather than the CNAME alias; the Owner must ensure that target is an address-bearing canonical hostname. All addresses, zones, subdomains and ports come from input.

`CloudflareDnsProvider.plan` discovers all record types at desired and previously owned names. `planDnsChanges` is also exposed as a pure function. Names are exclusive to the assignment; a foreign record, duplicate identity, CNAME conflict, changed ownership marker or record-ID replacement causes `conflict`. `apply` checks ownership again immediately before update/delete. Replacing record type deletes the old record before creating the new one and can temporarily leave the name absent.

Core must persist a cryptographically random assignment UUID and desired plan before provider effects, and hold a PostgreSQL lock/unique constraint for each zone/name while applying. The marker combines instance UUID, server UUID and assignment UUID; the remote ID and record are then persisted by `onRecordCreated`. `onRecordDeleted` removes only that proven row. An exact matching marker/content permits recovery of a create whose response was lost; a naming prefix or content match alone does not. Retrying the stored changes invokes persistence callbacks after an uncertain create/delete response. No raw Cloudflare token appears in records, returned plans or errors.

Cloudflare has no record-create idempotency key or compare-and-swap ownership condition. Application locking prevents races among NickHosting workers; an independent administrator changing the same DNS records concurrently remains an external race. Use an explicitly dedicated managed namespace and reconcile conflicts, never silently adopt unrelated records. The integration's mocked tests do not authorize real Cloudflare writes. API token requires DNS read/edit on the configured zone; no zone-wide permission escalation is performed.

## Isolated tests

Unit tests use injected fetch functions and never contact Cloudflare:

```sh
scripts/dev.sh pnpm exec vitest run packages/external-services/src/external-services.test.ts
```

The real SFTPGo suite uses only the already-approved M2 test services; this command does not create or restart containers:

```sh
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/external-services/src/sftpgo.integration.test.ts
```

The wrapper supplies `NH_TEST_SFTPGO_URL`, `NH_TEST_SFTPGO_HOST`, `NH_TEST_SFTPGO_PORT`, `NH_TEST_SFTPGO_ADMIN_USERNAME`, `NH_TEST_SFTPGO_ADMIN_PASSWORD`, `NH_TEST_SFTPGO_DATA_ROOT` and `NH_TEST_SFTPGO_LOCAL_DATA_ROOT`. A missing URL skips this optional integration suite; partial configuration fails. Its root guard requires the project's `mountdata/m2-tests/sftpgo/data` and container `/srv/sftpgo/data`. It creates two fresh UUID directories and two random test accounts, exercises actual SSH/SFTP through the test-only `ssh2` dependency, and cleans exactly those accounts/directories. No real Wings directory is used.

Verified test image: `drakkan/sftpgo:v2.7.6@sha256:1edd28d80de2a008863fbfc58c8ff7db47b1b410bae48d4e6076192337809b11`. Proposed/approved isolated resources are defined by the coordinator's project Compose file: 256 MiB, one CPU, internal test network, random loopback HTTP/SFTP port declarations, project-local state/data binds, generated ignored administrator credentials and `sftpgo ping` health check. New deployments or real volume mappings still need exact Owner approval.

Database-backed orchestration lives in `packages/server-management/src/external.ts`. It commits encrypted SFTP intent before provider calls, scopes encrypted data to the credential UUID, verifies the current actor's DB role and server membership before new access, and pins a configuration fingerprint so changed provider roots/origins cannot redirect an old credential. SFTP issuance/rotation requires a regular session; temporary support sessions cannot mint persistent external access. Creation UUIDs and rotation UUIDs are idempotency keys. Delivery is committed before the password is returned once; a lost HTTP response requires a new rotation. Metadata endpoints never return envelopes, passwords, ownership tokens or numeric provider user IDs. Up to eight non-revoked credentials per server prevents unbounded issuance.

DNS orchestration resolves the plugin connection mode and declared port role against assigned allocations and resolved Owner/environment settings. Static mode creates no DNS assignment. Custom names are unique in PostgreSQL, intents and random ownership tokens are committed before writes, and callbacks persist each remote ID before subsequent steps. Serialized operations use the same per-server advisory lock as lifecycle plus a DNS lock; the lifecycle cleanup callback reuses its already pinned connection. Cleanup can recover existing records after a lost create response without creating missing records. Old provider configuration changes fail closed. A bounded periodic worker pass retries pending/uncertain changes and revokes expired SFTP credentials or credentials whose issuer has lost server-management permission. Permission revocation is rechecked under the server lock and audited; still-authorized server owners and the current platform Owner retain their credentials. New SSH logins stop after provider revocation; the existing-transport exception above still applies. Failures retain their durable state and are counted.

The strict, deliberately failing provider diagnostic command is:

```sh
NH_TEST_SFTPGO_STRICT_REVOCATION=1 scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/external-services/src/sftpgo.integration.test.ts
```

The PostgreSQL orchestration integration suite uses isolated provider fixtures and mocked Cloudflare writes:

```sh
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/external.integration.test.ts
```

Provider references: [SFTPGo 2.7.6 OpenAPI](https://github.com/drakkan/sftpgo/blob/v2.7.6/openapi/openapi.yaml), [SFTPGo channel disconnect implementation](https://github.com/drakkan/sftpgo/blob/v2.7.6/internal/sftpd/handler.go), [SFTPGo channel creation](https://github.com/drakkan/sftpgo/blob/v2.7.6/internal/sftpd/server.go), [Cloudflare DNS API](https://developers.cloudflare.com/api/resources/dns/subresources/records/), [SSH2 client API](https://github.com/mscdex/ssh2).
