import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * Host tooling only. Container paths stay /app/mountdata; never copy this setting
 * into app content-root settings or assume the external directory may be created.
 */
export function resolveStorageRoot(options = {}) {
  const workspace = resolve(options.workspaceRoot ?? process.cwd());
  const env = options.env ?? process.env;
  let configured = env.NH_MOUNTDATA_ROOT;
  if (configured === undefined && options.envFile !== false) {
    const file = resolve(workspace, options.envFile ?? '.env.dev.local');
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576)
        throw new Error('Invalid private storage configuration');
      configured = parseEnv(readFileSync(file, 'utf8')).NH_MOUNTDATA_ROOT;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (
    configured !== undefined &&
    (!configured || configured !== configured.trim() || /[\0\r\n]/.test(configured))
  )
    throw new Error('Invalid NH_MOUNTDATA_ROOT');
  const root = resolve(workspace, configured ?? './mountdata');
  if (root === dirname(root) || root === workspace)
    throw new Error('Storage must use a dedicated directory');
  return root;
}

/** Read-only guard: do not create a missing mountpoint or follow a symlink. */
export function assertStorageDirectory(directory) {
  const path = resolve(directory);
  let current = path;
  for (;;) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Storage directory must exist without symlink ancestors');
    const parent = dirname(current);
    if (current === parent) return path;
    current = parent;
  }
}

/** Resolve a descendant used by a host tool; its storage root must already exist. */
export function storagePath(path, options = {}) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\0\r\n]/.test(path))
    throw new Error('Invalid relative storage path');
  const root = assertStorageDirectory(resolveStorageRoot(options));
  const target = resolve(root, path);
  const suffix = relative(root, target);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
    throw new Error('Storage path must remain inside the configured root');
  return target;
}

/** Provenance files outside the repository cannot accidentally be committed. */
export function isOutsideWorkspace(path, workspaceRoot = process.cwd()) {
  const suffix = relative(resolve(workspaceRoot), resolve(path));
  return suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix);
}

function main(args) {
  let workspaceRoot;
  let existing = false;
  let path;
  while (args.length) {
    const option = args.shift();
    if (option === '--workspace' && args[0]) workspaceRoot = args.shift();
    else if (option === '--require-existing') existing = true;
    else if (option === '--path' && args[0]) path = args.shift();
    else throw new Error('Unknown storage-root argument');
  }
  const options = { workspaceRoot };
  const root = path ? storagePath(path, options) : resolveStorageRoot(options);
  if (existing) assertStorageDirectory(root);
  process.stdout.write(`${root}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Storage configuration unavailable: ${error.message}\n`);
    process.exitCode = 1;
  }
}
