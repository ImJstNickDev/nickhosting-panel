# 0015 — Per-user provider technical accounts

Status: Accepted (Owner direction, 2026-10-11). Activation requires the explicit
migration checks below; this decision alone is not deployment evidence.

## Decision

Each NickHosting user has a separate non-administrator Pterodactyl technical
account and an encrypted Client API credential, provisioned through the
NickHosting Blueprint extension. Only the provider username uses `nh-`;
NickHosting names, emails and roles remain unchanged. Opaque provider emails
under `accounts.nickhosting.invalid` and nonretained random passwords avoid
exposing personal addresses or establishing a second login experience.

The extension records exact instance/user/provider identities. Prefixes and email
matches never prove ownership. Technical accounts cannot use Panel browser,
login, password-reset or two-factor flows, and their Panel notifications are
suppressed. Existing administrator accounts remain separate and unchanged.
NickHosting Owner/operator permissions do not grant Pterodactyl administration.

Invite-only registration remains authoritative. A PostgreSQL trigger enqueues
enrollment in the same transaction as user creation, including first-run Owner
creation and OAuth registration. A separate bounded worker loop provisions the
account and key using durable operation IDs, leases and retries. External calls
never participate in the authentication transaction. Registration can succeed
while enrollment is pending; provider operations fail unavailable until ready.

Application API authority remains centralized for administrative operations.
Client calls resolve the managed server owner's credential after authorizing the
acting NickHosting user. This preserves project sharing and assisted sessions
without granting provider-wide privileges. No global Client-key fallback exists.
Console reuse is fenced by credential revision. Keys remain encrypted and are
never sent to browsers or logs.

## Migration and consequences

Migration 023 backfills pending enrollment for existing users and pins existing
servers to their previous provider owner. It does not reassign remote servers.
Existing server handoff requires exact verified identities, a reviewed provider
owner change, local pin update and explicit Blueprint relink. Pending provisioning
plans must be inspected before handoff. The existing Pterodactyl administrator
must not be converted to a technical account or silently linked by email.

Apply the extension migration and application migration before activating the new
runtime. Retain private backups and the previous artifact. Enrollment runs apart
from feed health, preventing slow account creation from delaying lifecycle reads.
Legacy encrypted global Client secrets may remain for a reviewed rollback but
are neither advertised in settings nor used by the runtime. User deletion is
restricted while a provider account exists; account/key retirement needs an
explicit workflow rather than silently orphaning remote credentials.

Blueprint removal is not a safe automatic rollback: technical accounts depend on
its browser/mail restrictions. Preserve its guards until accounts are explicitly
retired or another reviewed restriction is active. Do not remove provider users,
keys, servers or application data as an automatic rollback.
