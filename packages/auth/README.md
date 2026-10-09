# Identity security contracts

Mount `createIdentity(...).handler` through the Core API boundary. Better Auth uses only
`X-NH-Client-IP` for its database-backed request limits. The public API must remove any
client-supplied value and derive this header from its server-owned socket peer address.
M1 does not trust forwarded IP headers. A deployment behind a proxy therefore shares
the proxy's request limits until an explicit trusted-proxy policy is implemented.
When no peer address exists, Better Auth uses its shared fallback bucket; limits remain
enabled. In-process auth fixtures provide the internal header to represent this boundary.

Better Auth's built-in CSRF checks protect its endpoints. The application must also
check the browser Origin on custom identity mutations. Support tokens are accepted only
by the explicit support-aware application authentication method, never by Better Auth
or identity-management routes. They require their original active Owner session.

Email/password signup remains pending until email verification. Owner bootstrap claims
the identity durably before sending verification mail, so mail failure requires restoring
delivery and resending verification, rather than reopening setup. Discord accounts without
email use an unverified reserved `.invalid` address; no mail is sent to it. Reverse linking
requires a fresh session and proof sent to the new email address. Email-bound invitations
require verified provider email for OAuth signup.

Passkeys use the configured public browser origin and RP ID. Both enrollment and login
check the signed user-verification flag after cryptographic verification; requesting
verification in browser options alone is insufficient. They provide ordinary login,
not Owner support elevation. Support elevation requires the Owner password and, when
enabled, TOTP or a recovery code, regardless of how the session was authenticated.
Better Auth challenges TOTP on password login; Discord and passkey login retain their
upstream authentication behavior. Better Auth lifecycle audit hooks run after its
committed transactions; custom identity changes and their audit records share transactions.

New invitations use `registrationInviteTtlSeconds` when no explicit expiry is supplied.
Both configured and explicit lifetimes are bounded by the platform's one-year maximum.
New identities and the first Owner inherit `defaultLocale` unless they provide an explicit
locale. Authenticated requests use the account's stored locale; a support session uses
the subject's locale without changing the Owner's own preference.
