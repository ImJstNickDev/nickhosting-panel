#!/bin/bash
set -euo pipefail
: "${PTERODACTYL_DIRECTORY:?Panel directory required}"
cd "$PTERODACTYL_DIRECTORY"
php .blueprint/extensions/nickhosting/private/configure.php remove
php artisan config:clear
# Retain our audit/outbox/link/key tables and callback allowlist deliberately.
# Revoke extension-issued keys explicitly before uninstall if desired.
