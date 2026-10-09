# M1 backend contracts

All routes return JSON, except Better Auth redirects and successful empty `204`
responses. Errors contain a stable message key and localized en/it message;
unrecognized internal/provider errors never expose their raw details. Request
IDs support correlation. Responses use `Cache-Control: no-store`.

Mutations require an exact configured `Origin` and JSON content type. Browser
CORS permits only configured origins with credentials. HTTPS deployments use
Secure, HttpOnly, SameSite cookies. No auth token belongs in browser local storage.
An invitation token is supplied in **`X-Invitation-Token`** for both email signup
and the initial Discord redirect request. OAuth state carries its server-owned
digest to the callback; never put it in arbitrary OAuth `additionalData`.

## First run and authentication

| Method/path | Contract |
| --- | --- |
| GET `/healthz`, `/readyz` | Liveness and database readiness; not a worker/provider health claim. |
| GET `/v1/setup` | `{ ownerClaimed, completed }`; no identity or secrets. |
| POST `/v1/setup/owner` | `{token,name,email,password,locale?}`; exactly one protected claim. Returns user ID and verification requirement. |
| POST `/v1/setup/complete` | Verified ordinary Owner session; `{instanceName,pterodactylBaseURL,pterodactylApplicationKey,pterodactylClientKey?}`. Read-only adapter validation then encrypted transactional save. |
| GET `/v1/invitations/:token` | Validity/expiry or localized invalid/revoked/expired/exhausted state. |
| GET `/v1/me` | Verified identity context, including separate actor/subject and temporary support metadata. |
| POST `/v1/identity/link-email` | Recent regular session; `{email,password}` starts a verified email/password link for a social-only account. |
| POST `/v1/identity/confirm-email` | Same session plus `{token}` from email; atomic link, no identity merge. |
| POST `/v1/identity/step-up` | Verified Owner; `{password,totpCode?,recoveryCode?}` creates one-use support grant. |
| GET `/api/auth/error` | Localized safe OAuth failure; raw `error_description` is discarded. |

Better Auth lives under `/api/auth/*`: `sign-up/email`, `sign-in/email`,
`sign-in/social`, `callback/discord`, `link-social`, `list-accounts`,
`unlink-account`, `send-verification-email`, `verify-email`,
`request-password-reset`, `reset-password`, `change-password`, `change-email`,
`update-user` (including locale), `get-session`, `list-sessions`, `revoke-session`,
`revoke-other-sessions` and `sign-out`. See the pinned library's contracts for
exact payloads. Auth failures are translated by the API wrapper.

Optional two-factor endpoints include `two-factor/enable`, `verify-totp`,
`verify-backup-code`, `generate-backup-codes` and `disable`; the verification
routes are under `two-factor/`. Optional WebAuthn endpoints under `passkey/`
generate registration/authentication options, verify their responses, list,
rename and delete passkeys. These are real library ceremonies tested with signed
fixtures; M1 does not supply graphical registration/login screens.

## Owner, support and platform

| Method/path | Contract |
| --- | --- |
| GET/POST `/v1/owner/invitations` | Owner listing or issue `{email?,role?,maxUses?,expiresAt?}`. Default role user, one use, configured TTL. Raw token returned once at issue. |
| DELETE `/v1/owner/invitations/:id` | Revokes future claims. |
| PATCH `/v1/owner/roles` | `{userId,role:'user'|'operator'}`; cannot overwrite Owner role. |
| GET `/v1/owner/audit` | Owner/operator audit view, latest 200 events. |
| GET/PATCH `/v1/owner/settings` | Resolved settings/provenance/locks plus secret presence, or validated partial settings update. |
| PUT `/v1/owner/secrets/:name` | `{value}`; allowed provider secret names only; no readback. |
| PUT `/v1/owner/games` | `{manifest,rollout}` validated against SDK. Registers metadata and rollout only, never executes arbitrary code. |
| GET `/v1/games` | Catalog filtered by canonical rollout/access policy. |
| POST `/v1/support` | `{stepUpToken,subjectUserId,reason}` returns a distinct temporary token. |
| POST `/v1/support/exit` | `{token}` revokes the support context; parent Owner identity is retained. |
| POST `/v1/jobs` | `{idempotencyKey,command}`; current authorized subject owns the request. |
| GET `/v1/jobs/:id` | Authorized durable status, localized state key, safe failure code and timestamps. |

Use `X-NH-Support-Token` together with the initiating Owner cookie only on
supported subject-context routes (`me`, games, jobs). It cannot be used on
Better Auth, Owner settings, invitations, role changes or account-security routes.
The future UI must display actor/subject, expiry, a persistent banner and Exit.
All support request audit events correlate with the support session ID.

M1 job command is exactly:

```json
{"type":"foundation.record-activity","version":1,"payload":{"source":"user_request"}}
```

`system_check` is the other allowed source. The worker actually records the
localized activity in PostgreSQL. Payloads cannot contain arbitrary credentials
or free text. Reusing an idempotency key with a different command is a conflict.
Game server lifecycle, resource admission and external provisioning belong to M2.

## Operational constraints

Configure working SMTP before the initial verified email/password Owner flow.
SMTP uses TLS/STARTTLS; no console-mail fallback prints verification/reset links.
A failed send leaves the Owner claimed and can be retried through resend
verification after fixing SMTP. Discord client ID/secret may be configured in
either order; the optional provider remains disabled until both exist.

Master-key rotation requires preserving the old key until existing rows are
re-encrypted using the codec's keyring support in an explicitly reviewed local
maintenance operation. Replacing the environment key alone cannot decrypt old
rows. No public reset-bootstrap, decrypt-secret or key-rotation endpoint exists.
