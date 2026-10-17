# SFTP filesystem activity

The API accepts authenticated SFTPGo filesystem notifications at
`POST /v1/provider-events/sftpgo`. It records completed uploads, downloads, deletes,
renames, directory creation/removal and copies in the existing `audit_events`
table. There is no filesystem polling, upload proxy or synchronous pre-upload hook.

## Identity and authentication

Configure the dedicated `sftpgoEventSecret` through the Owner's protected secrets
store, or `NH_SFTPGO_EVENT_SECRET` in supported standalone/production environments.
Use a random 32-byte hex or base64url secret, independently of the SFTPGo API key.
The receiver is disabled (503) without this secret. Development deployments use
the protected DB secret: their existing container environment policy intentionally
rejects unscoped external environment overrides.

The action sends `Authorization: Bearer <secret>`. Cookie/session authentication
cannot authorize this route. Requests have a 64 KiB limit and strict schema. The
configured `sftpgoInstanceId` must match. Only canonical virtual paths are accepted;
physical paths, error strings, IP addresses and file contents are never accepted.
Use HTTPS for a callback crossing an untrusted network. HTTP is suitable only for
the existing private application network, with an explicitly reviewed endpoint.

Attribution requires one unambiguous owner/server identity from durable
`external_sftp_credentials` bindings:
username, instance, credential ID, managed server ID and provider server UUID must
match. Events before credential creation are ignored. Primary regrants may reuse
a username with a new credential row; matching bindings for the same owner/server
are collapsed. Pending rotation, expired and revoked bindings remain attributable:
existing SSH transports can still produce real events (issue #18). Retained
bindings also allow delayed notifications to retain their original identity;
notifications grant no login authority. Unknown usernames and technical viewer
accounts produce a 200 ignored acknowledgment and no audit row. This avoids retry
storms without creating an association from a username prefix. Auxiliary accounts
retain their issuing panel actor; their login appears only in activity details.

The SHA-256-derived audit UUID incorporates instance ID, SFTPGo UID, original
nanosecond timestamp, username, event and virtual source/target paths. A primary-key
conflict is acknowledged without modifying the original event. Parallel deliveries
therefore create one immutable row. Activity time is the filesystem event time, not
the HTTP receipt time. SQL execution is a short insert independent of the transfer.

## SFTPGo 2.7.6 transport contract

This configuration targets the pinned community **2.7.6** implementation, not the
newer Enterprise Go-template syntax. Its `Content-Type: application/json` handling
escapes string substitutions automatically. `{{.Timestamp}}` is Unix nanoseconds
and is enclosed in JSON quotes to preserve precision; `{{.UID}}` identifies the
original event. `{{.Status}}` is 1 for success and 2/3 for failure. Only virtual path
placeholders are used.

The filesystem rule executes asynchronously (`relation_options.execute_sync:
false`). One normal HTTP action is followed by one **failure action** with the same
body, URL, authentication and 10-second timeout. The second action runs only when
the first fails. Filesystem status and UID remain unchanged when notification
delivery fails; a failed webhook does not become a failed file upload.

There is **no durable upstream outbox**. The pinned Event Manager HTTP action uses
one ordinary HTTP client request and does not inherit global `http.retry_max`.
The explicit failure action adds one bounded immediate re-delivery, without backoff.
An outage lasting through both attempts, or an SFTPGo restart before delivery,
can lose activity notifications. The panel must not claim a complete filesystem
history during these gaps. SFTPGo's Event Manager logs report HTTP action failures;
monitor both action names and the rule name below. There is no automatic replay of
those logs. Successful duplicate acknowledgments return 200; database failures
remain errors so the failure action can retry.

Pinned upstream references:

- [Filesystem dispatch, JSON replacements, HTTP execution and failure actions](https://github.com/drakkan/sftpgo/blob/v2.7.6/internal/common/eventmanager.go)
- [Action schema, relation options and ordinary HTTP client](https://github.com/drakkan/sftpgo/blob/v2.7.6/internal/dataprovider/eventrule.go)
- [Separate retryable HTTP client used by other hooks](https://github.com/drakkan/sftpgo/blob/v2.7.6/internal/httpclient/httpclient.go)

## Offline preparation

Set `NH_SFTPGO_EVENT_CALLBACK` to the exact reachable API URL including
`/v1/provider-events/sftpgo`, `NH_SFTPGO_INSTANCE_ID` to the existing Owner-configured
user-SFTP instance UUID and `NH_SFTPGO_EVENT_SECRET` to the same dedicated secret
stored in the panel. Supply secrets through a protected environment, not command
arguments or tracked files. Then run:

```sh
scripts/dev.sh pnpm exec tsx deploy/sftp-activity-config.ts
```

This makes **no network requests**. It creates three private, untracked JSON files
(mode 0600) under `mountdata/sftp-activity-config/`, refusing to overwrite existing
files:

- `nickhosting-activity-http-v1.json`: normal HTTP action.
- `nickhosting-activity-retry-v1.json`: identical HTTP failure action.
- `nickhosting-activity-v1.json`: asynchronous filesystem rule.

The configuration captures SFTP events on the dedicated user-SFTP instance;
NickHosting's durable credential bindings remain the authoritative filter. No
SFTPGo users, filesystem roots, mounts or permissions change. Never commit or
publish generated action JSON: it contains the dedicated webhook secret.

## Exact activation proposal — requires Owner approval

Preparation is complete without activation. Activating this rule mutates the
existing SFTPGo service configuration, which the repository safety contract requires
an operation-specific Owner approval for. Before approval, resolve the exact
existing user-SFTP management endpoint and callback using private local context,
verify the configured instance, and check that the following three names are absent.
Do not overwrite an existing action or rule with a matching name.

The proposed changes are two `POST /api/v2/eventactions` requests with the generated
action JSON, then one `POST /api/v2/eventrules` request with the rule JSON. Use the
existing protected admin token/API key; avoid echoing payloads or headers. The
reviewable commands below assume `SFTPGO_ADMIN_CURL_CONFIG` points to a mode-0600
curl config containing the existing admin authentication header and
`SFTPGO_MANAGEMENT_URL` contains the verified existing management origin:

```sh
curl --fail --silent --show-error --config "$SFTPGO_ADMIN_CURL_CONFIG" \
  --header 'Content-Type: application/json' --request POST \
  --data-binary @mountdata/sftp-activity-config/nickhosting-activity-http-v1.json \
  "$SFTPGO_MANAGEMENT_URL/api/v2/eventactions"
curl --fail --silent --show-error --config "$SFTPGO_ADMIN_CURL_CONFIG" \
  --header 'Content-Type: application/json' --request POST \
  --data-binary @mountdata/sftp-activity-config/nickhosting-activity-retry-v1.json \
  "$SFTPGO_MANAGEMENT_URL/api/v2/eventactions"
curl --fail --silent --show-error --config "$SFTPGO_ADMIN_CURL_CONFIG" \
  --header 'Content-Type: application/json' --request POST \
  --data-binary @mountdata/sftp-activity-config/nickhosting-activity-v1.json \
  "$SFTPGO_MANAGEMENT_URL/api/v2/eventrules"
```

Purpose: report external SFTP activity with panel actor attribution. Affected
resources: only the two new named actions, the one new named rule and the panel's
dedicated encrypted secret. Risks: missed events during outages, additional bounded
background HTTP traffic and secret exposure to SFTPGo administrators. No existing
users, game data, live ports/routes, networks, mounts, Pterodactyl or Wings changes
are part of this proposal. No restart is required for database-backed event rules.

Rollback, limited to resources proven created by this activation: delete
`/api/v2/eventrules/nickhosting-activity-v1`, then
`/api/v2/eventactions/nickhosting-activity-retry-v1` and
`/api/v2/eventactions/nickhosting-activity-http-v1` using authenticated DELETE.
Remove the dedicated panel secret if it was created solely for this activation.
Retain recorded audit events. If only the action creation succeeds, remove those
new actions; do not proceed by overwriting or repurposing existing resources.

End-to-end live verification remains pending until this activation is approved.
Use only a proven test-owned server and credential ledger for any real filesystem
writes; verify its primary and auxiliary logins and confirm viewer operations do
not appear. Local API fixtures cover authentication, duplicate and concurrent
delivery, outcomes, virtual paths, ownership, auxiliary attribution, ignored viewer
identities and absence of physical paths/secrets without production mutations.
