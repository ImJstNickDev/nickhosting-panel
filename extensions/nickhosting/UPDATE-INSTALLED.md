# Reviewed extension-only updates

`update-installed.py` prepares a bounded update of an **existing, identified**
NickHosting Blueprint installation. Its default is read-only. Applying it requires
operation-specific Owner approval of the printed plan, archive hashes, installed
fingerprint, exact Panel container and backup location. It is not a replacement
for general Blueprint installation or upgrades.

The native installer was unsuitable for the original deployment: its recursive
ownership housekeeping could traverse game volumes below the Panel root. The
Owner-approved [mount separation](../../docs/BLUEPRINT-EXTENSION.md#panelwings-mount-separation--2026-10-18)
removed that exposure on 2026-10-18. The original incident and this bounded update
remain historical evidence; no native installation was rerun to test the separation.
This updater never
invokes Blueprint, extension install/configure hooks, recursive ownership changes,
Panel configuration edits, shared cache clearing or a service restart.

## Exact scope

The tool recognizes the previously inspected Blueprint beta-2025-09 layout with
an already registered NickHosting provider and installed version 1.5.0. Both the
old and new packages must be pinned by SHA-256. Every old managed code file must
match the old package after the framework's `{identifier}` replacement; ownership
and modes are part of the installed fingerprint. Unexpected links, unknown app
code, target collisions, route caching or OPcache require a new review.

Only package-allowlisted extension code, its generated admin page/controller and
its own stored `conf.yml` are eligible targets. Framework links, registry, other
extensions, Panel source/configuration, game data, assets and extension filesystem
storage remain untouched. The generated admin wrapper is preserved, with only
its version replaced. New files inherit the extension's existing owner/group and
mode `0644`; existing file modes and ownership are preserved individually.

For the reviewed 1.6.0 artifact there are twelve changed files:

- Seven new PHP service/request/controller files.
- One new receipt-table migration.
- The extension's Client routes and capabilities controller.
- Its generated admin view and stored version configuration.

Before any write, a new private local directory receives the exact previous file
contents, owner/group/modes, new contents and plan in a `0600` manifest. The
manifest digest is printed for a later rollback. Code is staged first; the tool
then runs only:

```text
php artisan migrate --force --path=.blueprint/extensions/nickhosting/private/migrations/2026_10_18_000005_nickhosting_file_operations.php
```

Only after that succeeds are new routes, capability advertisement and version
published. Writes use individual same-directory temporary files and rename.
A failed intermediate phase stops without a blind automatic retry. Keep the
backup and review the partial result before rolling back or resuming.

Current verified deployment has no CLI/FPM OPcache or route cache. The tool
rechecks those conditions. Blade recompiles this extension's changed view on its
next request because its source modification time advances. No global
`view:clear`, `route:clear`, `config:clear`, queue restart or Composer operation is
needed. A deployment with different caching must be reviewed separately.

## Dry run, activation and rollback

Use the **current installation identity from private infrastructure notes**. The
values below are placeholders; never guess a container or use a stale copy.

```bash
python3 extensions/nickhosting/update-installed.py \
  --container <identified-panel-container> \
  --expected-working-dir <identified-compose-working-directory> \
  --baseline build/blueprint/1.5.0-reviewed/nickhosting.blueprint \
  --baseline-sha256 <reviewed-old-package-sha256> \
  --archive build/blueprint/1.6.0-reviewed/nickhosting.blueprint \
  --archive-sha256 <reviewed-new-package-sha256>
```

After explicit approval, repeat the same command with:

```text
--apply --expected-installed-sha256 <dry-run-installed-fingerprint>
--backup-dir <new-private-directory-under-project-mountdata>
```

The backup's parent must already exist and have no symlink components. The new
backup directory must not exist; the updater creates it with mode `0700` and
never overwrites a prior backup. Do not put the manifest in Git.

Rollback planning is read-only:

```bash
python3 extensions/nickhosting/update-installed.py \
  --container <same-panel-container> \
  --expected-working-dir <same-compose-working-directory> \
  --rollback <private-backup-directory>/manifest.json
```

For the separately approved rollback, add `--apply` and
`--expected-backup-sha256 <digest-printed-during-activation>`. It accepts only
files still matching either the old or new reviewed state, restores routes and
capabilities before removing new classes, and preserves original owners/modes.
Modification times advance so the restored admin view recompiles. It **retains**
the additive operation receipt table and its records; it never runs a down
migration or deletes provider data. A subsequent activation can safely reuse the
already recorded migration.

The rollout is not a multi-file filesystem transaction. A PHP request already in
flight may complete against the previous code. New classes are available before
new routes are published, and requests should be checked after activation. No
claim of production activation is made by a successful dry run.

## Import transport patch: 1.6.0 → 1.6.1

This additional reviewed pair has the same package inventory and changes only
six files: `FileOperationRepository`, `ArchiveCommitController`,
`ArchiveCommitRequest`, capabilities, the generated admin version and stored
`conf.yml`. Other code, migration files and package additions are rejected.
It applies no migration, restarts no service and clears no shared cache.

Use the same procedure with the hash-pinned 1.6.0 baseline and 1.6.1 package,
adding `--expected-installed-version 1.6.0`. A fresh installed fingerprint and
private backup are required for activation. The existing rollback procedure
restores the six previous files and their individual ownership/modes. Do not
reuse the previous 1.5.0 → 1.6.0 approval or backup directory.

The patch reuses one native Wings HTTP client per operation and applies the
existing directory-read concurrency setting (default two) as a rolling window.
Exact extraction verification, destination checks and both rename readbacks
remain. Optional `trace: true` requests return phase timings for the current
attempt only; tracing never changes the durable request fingerprint or replays
an external effect. Ordinary requests emit no additional logs or timings.


## Post-update game-volume verification

After activation, inspect the actual Wings data mount read-only. Confirm Wings'
configured UID/GID against game-container and SFTP process identities, then check
game-directory/file ownership and numeric modes against private inventories.
The updater manifest covers extension files only; it is not a game-volume backup
or proof that every game inode remained unchanged. Keep game paths and inventories
private. Distinguish files created/replaced during normal operation, technical
non-server directories and symbolic links; never follow links outside the roots.
Use read-only write-eligibility checks rather than creating test files. Report
any mismatch before proposing a separately authorized repair. Do not run chmod,
chown or the native installer automatically as part of this verification.
