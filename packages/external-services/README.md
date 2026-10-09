# External services

This package contains the SFTPGo REST adapter and Cloudflare DNS planner/provider. It has no database, HTTP routes, deployment side effects, or implicit background work. Core must authorize each server operation, serialize changes and persist the intent and results. Credentials stay on the backend except for a newly issued server-scoped SFTP password returned once to its authorized recipient.

## SFTPGo contract and compatibility blocker

`SftpGoAdapter` uses an explicitly configured origin, admin API key or access token, instance UUID and absolute data root. `ensureCredential` accepts NickHosting server UUID, external server UUID, credential UUID, random password, expiration timestamp and byte quota. Its only filesystem mapping is `dataRoot/externalServerUuid`; arbitrary paths, root mappings, virtual folders, groups, symlink creation, API-key login, HTTP, FTP and WebDAV are excluded. Passwords use 256 bits of random entropy. Expiration is required and limited to 30 days. Files created outside SFTPGo require separate quota reconciliation; this is not a claim of instant shared filesystem quota enforcement.

Persist the identifiers, requested expiry/quota and encrypted password **before** calling the provider. Keep the same password on retries. The remote account carries the instance/server/credential identifiers in `additional_info`. The response provides the numeric provider user ID; future changes verify both this ID and the metadata/home mapping. Username prefixes alone never establish ownership. `rotateCredential` updates the password with `disconnect=1`. `revokeCredential` disables with `disconnect=1`, then deletes the account; it never removes the server directory. A provider timeout is an uncertain result; retry against the persisted identity before treating issuance, rotation or revocation as complete.

**The pinned SFTPGo 2.7.6 image does not currently meet the strict revocation requirement. Do not expose this integration or mount real Wings data until the blocker is resolved and reviewed.** Real isolated tests found that rotation and disable/delete close the existing SFTP channel and reject new SSH logins, but an already authenticated SSH transport can open a new SFTP channel and retain access to its original directory. The failing regression tests intentionally remain failures. Closing a channel is insufficient evidence of revocation. The upstream implementation closes the channel in `Connection.Disconnect`, and creates subsequent channels using the user captured at SSH authentication. No upstream or production configuration was patched, and no mitigation is assumed. A corrected provider or separately reviewed transport-level revocation design needs Owner review and the same regression must pass.

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

Provider references: [SFTPGo 2.7.6 OpenAPI](https://github.com/drakkan/sftpgo/blob/v2.7.6/openapi/openapi.yaml), [SFTPGo channel disconnect implementation](https://github.com/drakkan/sftpgo/blob/v2.7.6/internal/sftpd/handler.go), [SFTPGo channel creation](https://github.com/drakkan/sftpgo/blob/v2.7.6/internal/sftpd/server.go), [Cloudflare DNS API](https://developers.cloudflare.com/api/resources/dns/subresources/records/), [SSH2 client API](https://github.com/mscdex/ssh2).
