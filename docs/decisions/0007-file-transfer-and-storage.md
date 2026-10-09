# ADR 0007 — SFTPGo for external SFTP and project-local bind mounts

**Status:** Accepted; actual host mount mapping needs approval

## Decision

Use SFTPGo for users and compatible applications such as Satisfactory Mod Manager to access per-server files via scoped credentials. Browser file manager uses NickHosting API/Pterodactyl adapter. New project services persist under `./mountdata/`, fully gitignored. Reuse actual server data; do not copy entire worlds into parallel storage for SFTP.

## Consequences

Exact Wings volume paths, UID/GID and SFTPGo mapping are host-specific and require read-only discovery followed by Owner-approved host config changes. Never expose the entire Wings data tree to an ordinary user's credential. The existing frontend network identified in local notes is external; no modification of existing Pterodactyl Compose.
