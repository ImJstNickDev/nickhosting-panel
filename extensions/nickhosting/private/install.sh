#!/bin/bash
set -euo pipefail
: "${PTERODACTYL_DIRECTORY:?Panel directory required}"
cd "$PTERODACTYL_DIRECTORY"
# Run exactly this extension migration, never the Panel migration directory.
php artisan migrate --force --path=.blueprint/extensions/nickhosting/private/migrations
php .blueprint/extensions/nickhosting/private/configure.php install
# Local deployment allowlist is deliberately not bundled or overwritten.
if [[ ! -e config/nickhosting_bridge.php ]]; then
  (set -o noclobber; printf '%s\n' '<?php return ["callback_origins" => []];' > config/nickhosting_bridge.php)
fi
php artisan config:clear
