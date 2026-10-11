# NickHosting Blueprint bridge

Initial source foundation, targeting Pterodactyl **1.11.11** and Blueprint
**beta-2025-09**. This is not installed or runtime-certified on the Panel.

The monorepo is the source of truth. Blueprint's `.blueprint/dev/` is a staging
workspace used by its `-build` and `-export` commands, not a required source-code
location. Those commands modify the target Panel: do not run them against a live
installation without operation-specific Owner approval. This directory includes
no deployment, install, uninstall, migration or service-provider hooks.

## Current contract

`GET /api/application/extensions/nickhosting/capabilities` returns:

```json
{
  "schemaVersion": 1,
  "extension": "nickhosting",
  "extensionVersion": "0.1.0-dev",
  "target": { "panel": "1.11.11", "blueprint": "beta-2025-09" },
  "capabilities": {
    "clientKeyManagement": false,
    "serverChangeEvents": false
  }
}
```

The route inherits Blueprint's Application API authentication and throttling.
Its request additionally requires an Application API key with the existing
`servers` READ permission; Client API keys and browser sessions are rejected.
The response contains no credentials or server inventory. Targets are declared
compatibility targets, not a claim of detected installation versions.

Per-user Client API key management and durable server-change notifications remain
unimplemented. Neither is advertised as available. This foundation makes no
change to the current NickHosting Start/admission path.

## Local packaging and checks

From the repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s extensions/nickhosting/tests -v
python3 extensions/nickhosting/package.py
```

The packager writes only an allowlisted ZIP named
`mountdata/build/blueprint/0.1.0-dev/nickhosting.blueprint`. It rejects existing
output and symlinks, excludes tests, documentation and arbitrary additional files,
and never executes PHP, Blueprint or an installation hook. An alternate new
artifact path may be supplied with `--output`; only use private build directories.
Do not commit built archives.

Blueprint beta-2025-09's exporter produces an ordinary ZIP with `conf.yml` at its
root and the `.blueprint` suffix. Its installer unpacks that ZIP, substitutes
`{identifier}` in PHP namespaces, links `requests.app` into
`app/BlueprintFramework/Extensions/nickhosting`, and links the application router.
Our packager reproduces that archive layout; it deliberately does not reproduce
Blueprint's optional export-script execution. Source PHP containing namespace
placeholders must be expanded in a temporary validation copy before PHP linting.

Packaging tests are not a substitute for PHP/Laravel authentication, route-cache,
installation or upgrade tests. No live extension installation has been performed.
Before deployment, review the exact archive, installation effects and rollback;
obtain separate Owner approval for the target Panel operation.

## Upstream references and reuse

- [Blueprint configuration](https://blueprint.zip/docs/configs/confyml)
- [Blueprint custom routes](https://blueprint.zip/docs/concepts/routing)
- [Pinned exporter](https://github.com/BlueprintFramework/framework/blob/beta-2025-09/scripts/commands/developer/export.sh)
- [Pinned installer](https://github.com/BlueprintFramework/framework/blob/beta-2025-09/scripts/commands/extensions/install.sh)
- [Pinned route middleware](https://github.com/BlueprintFramework/framework/blob/beta-2025-09/app/Providers/Blueprint/RouteServiceProvider.php)
- [Panel Application request authorization](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Http/Requests/Api/Application/ApplicationApiRequest.php)

Implementation uses the public routing/request contracts. No closed-source
extension files or vendored upstream implementation are included; no repository
licensing decision is introduced.
