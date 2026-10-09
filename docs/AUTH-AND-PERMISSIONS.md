# Authentication, invitations, permissions, support sessions

## Login methods

- Email + password (strong password hashing via Better Auth library, verified email).
- Discord OAuth login; no forced linkage to a pre-existing account by matching email.
- For either registration origin, later **explicitly link** the other method to the same NickHosting identity. Accounts created through Discord can add verified email + password.
- Optional passkeys and optional TOTP with recovery codes; do not require either for ordinary users.
- On linking conflicts, make user authenticate to the existing target account or contact Owner; never silently merge accounts.
- Preserve identity and resources if the user changes primary email or Discord display name.

**Implementation note:** Better Auth supports `account.accountLinking.disableImplicitLinking: true`; review current docs in M1 to ensure account linking only happens explicitly. Discord accounts without an email require a supported no-email OAuth flow and later email addition. Test TOTP across login routes: default 2FA challenges may differ for social/passkey flows; choose and implement a coherent policy for Owner step-up authentication.

## Invitations

- Registration is **not available** without a valid invitation token embedded in a unique URL (e.g. `/invite/{opaque-token}`). Opening an invalid/used/expired link displays an appropriate localized state, not registration.
- Owner issues invite with expiry and usage policy (default single-use), can revoke, see pending/used invitations and optionally bind email, role or resource defaults.
- Both email/password and Discord sign-up paths must preserve invitation claim through redirects, with server-side verification at creation. No way to bypass the invite gate through direct Better Auth endpoints.
- Store **hash** of invitation tokens and consume atomically to prevent concurrent uses; avoid logging raw invite values.
- Existing users never need an invite to sign back in.

## First-run Owner setup (no seed)

- Empty migrated DB triggers a one-time setup wizard on the app. It asks for first Owner account, instance name/basic configuration and required Pterodactyl API connection details, with connection validation.
- **No seeded default user/admin**, hardcoded credential or instance URL. DB schema migrations are not user-data seeding.
- Protect completion with a **one-time bootstrap token** in environment/startup generated secret; users can view the setup page but cannot claim Owner without the code. First-completion transaction is race-safe and permanently disables setup once the Owner is created.
- Set Owner authentication before collecting long-lived Pterodactyl credentials. Pterodactyl URL and non-secret settings live in Owner settings; secrets encrypted using a key delivered via `.env` or dedicated secret mechanism.
- Never display/log submitted tokens after initial save. Resetting setup is a deliberate administrative recovery operation requiring direct server access, not a public endpoint.

## RBAC and resource scope

Roles: Owner, optional platform operator, ordinary user; per-project/server roles such as owner/manager/operator/viewer where needed. Every API and operation handler checks the **subject resource** and the **actual actor**; UI visibility is not enforcement.

A collaborating user can act on a server owned by someone else, but budgets are charged to the defined server/project owner, never implicitly the person clicking Start. Every job records both the requesting actor and resource owner.

## Owner-assisted session (temporary 'hijack')

This is **controlled impersonation**, not theft/reuse of another user's cookie. Session stores:

- `actor_user_id` = real Owner performing action.
- `subject_user_id` = account context being viewed.
- `session_type = support` and explicit `owner_elevation = true` attached ONLY to this session.
- Origin/reason, `started_at`, `expires_at`, `last_activity_at`, `revoked_at` and audit correlation ID.

Require Owner reauthentication/step-up, short idle and absolute TTL, constant visual banner and easy Exit. Existing ordinary user sessions remain untouched and gain **zero** new rights. All actions report both actor and subject; risky actions still require confirmation. Do not silently override resource quotas—use an explicit Owner override with audit record.

## Security baseline, no unnecessary enterprise system

Secure/HttpOnly/SameSite cookies, CSRF protections as appropriate, password/reset/email verification, login throttling, rate limits, safe OAuth state/PKCE, strong secrets, minimal privileged tokens, scoped SFTP credentials, central backend authz, audit on destructive changes. Don't create sandboxing/marketplace complexity for trusted built-in game modules.

## Test cases

- Invite missing, expired, reused, raced; OAuth callback without invite cannot create account.
- Email signup → link Discord → login both ways; Discord signup → add verified email+password → login both ways; collision cases.
- TOTP/passkey enrollment and recovery; revoke a session.
- User cannot access another user's server or job by changing an ID.
- Owner assisted session succeeds only for that session and expires; ordinary target session retains original permissions.
- One-time setup race yields exactly one Owner and cannot be re-run remotely.
