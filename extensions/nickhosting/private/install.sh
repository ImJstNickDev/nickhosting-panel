#!/bin/bash
set -euo pipefail
: "${PTERODACTYL_DIRECTORY:?Panel directory required}"
cd "$PTERODACTYL_DIRECTORY"
# Run exactly this extension migration, never the Panel migration directory.
php artisan migrate --force --path=.blueprint/extensions/nickhosting/private/migrations
php .blueprint/extensions/nickhosting/private/configure.php install
php artisan config:clear
