# ADR 0003 — Invite-only identity with optional authenticators

**Status:** Accepted

## Decision

Only unique invite links can create accounts, with a registration page valid for that invitation; email+password or Discord. Users can later link Discord to an email identity or add verified email/password to Discord-created identity. No implicit account linking based solely on matching email. Passkeys and TOTP optional; account recovery supported. Owner created through protected first-run wizard when DB has no Owner; never seed Owner.

## Consequences

Apply invite checks at actual server-side Better Auth signup/OAuth callback boundaries. First-run wizard needs one-time bootstrap secret + race-safe completion. Owner assisted sessions preserve `actor` and `subject` separately; no change to target user's other sessions/permissions.
