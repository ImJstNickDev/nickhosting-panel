// Development only: one child per service, no shell, no dependency installation or migrations.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roles = new Set(['web', 'api', 'worker']);
const ignoredSegments = new Set(['node_modules', 'dist', 'coverage', '__tests__', 'fixtures']);

export function parseRole(value) {
  if (!roles.has(value)) throw new Error('Usage: node scripts/dev-watch.mjs web|api|worker');
  return value;
}

/** Classify repository-relative changes without ever inspecting private files. */
export function watchAction(role, file) {
  parseRole(role);
  const path = String(file).replaceAll('\\', '/');
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    segments.some((part) => part.startsWith('.') || ignoredSegments.has(part)) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    !/\.(?:[cm]?[jt]sx?|json)$/.test(path)
  )
    return null;

  if (role === 'web') {
    return path.startsWith('packages/i18n/src/') ||
      /^games\/[^/]+\/src\/ui\//.test(path) ||
      path === 'packages/game-sdk/src/ui.ts' ||
      path === 'scripts/compile-web-i18n.ts'
      ? 'catalogs'
      : null;
  }
  if (path === 'tsconfig.json' || path.startsWith(`apps/${role}/src/`)) return 'restart';
  if (!/^(?:packages|games)\/[^/]+\/(?:src\/|package\.json$)/.test(path)) return null;
  if (
    segments.includes('ui') ||
    segments.includes('assets') ||
    path === 'packages/game-sdk/src/ui.ts' ||
    /^packages\/i18n\/src\/(?:[^/]*-web|web)\.ts$/.test(path)
  )
    return null;
  return 'restart';
}

/** Node executes tsx as an import hook, so SIGTERM reaches the actual application process. */
export function childCommand(role, root = projectRoot) {
  if (role === 'catalogs')
    return {
      command: process.execPath,
      args: ['--import', 'tsx', resolve(root, 'scripts/compile-web-i18n.ts')],
      cwd: root,
    };
  parseRole(role);
  if (role === 'web') {
    const require = createRequire(resolve(root, 'apps/web/package.json'));
    const viteRoot = dirname(require.resolve('vite/package.json'));
    return {
      command: process.execPath,
      args: [
        resolve(viteRoot, 'bin/vite.js'),
        '--config',
        resolve(root, 'apps/web/vite.config.ts'),
        '--configLoader',
        'runner',
      ],
      cwd: resolve(root, 'apps/web'),
    };
  }
  return {
    command: process.execPath,
    args: ['--import', 'tsx', resolve(root, `apps/${role}/src/main.ts`)],
    cwd: root,
  };
}

/**
 * Debounced supervisor with injectable child processes for lifecycle regression tests.
 * A slow shutdown never permits two workers to overlap. After the warning timeout it
 * keeps waiting; Docker/Owner stop policy remains responsible for forced termination.
 */
export function createSupervisor({
  role,
  launch = (kind) => {
    const { command, args, cwd } = childCommand(kind);
    return spawn(command, args, { cwd, env: process.env, stdio: 'inherit', shell: false });
  },
  debounceMs = 200,
  shutdownWarningMs = 30_000,
  log = (message) => process.stderr.write(`[dev:${role}] ${message}\n`),
}) {
  parseRole(role);
  if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > 5000)
    throw new Error('Invalid development debounce interval.');
  if (!Number.isInteger(shutdownWarningMs) || shutdownWarningMs < 1)
    throw new Error('Invalid development shutdown warning interval.');
  let closing = false;
  let closePromise;
  let pending = false;
  let debounce;
  let draining;
  let service;
  const children = new Set();

  function startChild(kind) {
    const child = launch(kind);
    const record = { child, stopping: false, closed: false, finished: undefined };
    children.add(record);
    record.finished = new Promise((resolveFinished) => {
      let spawnFailed = false;
      child.once('error', () => {
        spawnFailed = true;
        log(`${kind} process could not start.`);
      });
      child.once('close', (code, signal) => {
        record.closed = true;
        children.delete(record);
        if (service === record) {
          service = undefined;
          if (!record.stopping && !closing)
            log(`${kind} exited (${code ?? signal ?? 'unknown'}); waiting for a source change.`);
        }
        resolveFinished({ code, signal, spawnFailed });
      });
    });
    return record;
  }

  async function stopChild(record) {
    if (!record || record.closed) return;
    if (!record.stopping) {
      record.stopping = true;
      record.child.kill('SIGTERM');
    }
    const warning = setTimeout(() => {
      log('Still waiting for graceful shutdown; no replacement process has been started.');
    }, shutdownWarningMs);
    warning.unref();
    try {
      await record.finished;
    } finally {
      clearTimeout(warning);
    }
  }

  function drain() {
    if (draining) return draining;
    draining = (async () => {
      while (pending && !closing) {
        pending = false;
        if (role === 'web') {
          const compilation = startChild('catalogs');
          const result = await compilation.finished;
          if (closing) return;
          if (result.spawnFailed || result.code !== 0) {
            log('Catalog compilation failed. Fix the source before relying on translated updates.');
            continue;
          }
          if (pending) continue;
        } else {
          await stopChild(service);
          // Source changes received while the old process was stopping are included
          // in the next launch, so they need no second stop/start cycle.
          pending = false;
        }
        if (!closing && !service) service = startChild(role);
      }
    })()
      .catch(() => {
        log('Development process launch failed; waiting for a source change.');
      })
      .finally(() => {
        draining = undefined;
        if (pending && !closing) void drain();
      });
    return draining;
  }

  return {
    start() {
      if (closing) throw new Error('Development supervisor is closed.');
      pending = true;
      return drain();
    },
    notify(file) {
      if (closing || !watchAction(role, file)) return false;
      pending = true;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = undefined;
        void drain();
      }, debounceMs);
      return true;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      pending = false;
      clearTimeout(debounce);
      closePromise = (async () => {
        await Promise.all([...children].map(stopChild));
        await draining;
      })();
      return closePromise;
    },
  };
}

/** Watch only source trees, never workspace node_modules, persistent data or secrets. */
export function sourceWatchRoots(root, role) {
  parseRole(role);
  const roots = new Map();
  const add = (path, recursive) => {
    const absolute = resolve(root, path);
    if (existsSync(absolute)) roots.set(absolute, recursive);
  };
  add('.', false);
  if (role === 'web') add('scripts', false);
  else add(`apps/${role}/src`, true);
  for (const collection of ['packages', 'games']) {
    const directory = resolve(root, collection);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const module = `${collection}/${entry.name}`;
      add(module, false);
      add(`${module}/src`, true);
    }
  }
  return [...roots].map(([path, recursive]) => ({ path, recursive }));
}

export async function main(argv = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('The development supervisor requires the project Node.js 24 runtime.');
  if (argv.length !== 1) throw new Error('Usage: node scripts/dev-watch.mjs web|api|worker');
  const role = parseRole(argv[0]);
  const supervisor = createSupervisor({ role });
  const watchers = [];
  let stopping;
  const stop = (failed = false) => {
    if (stopping) return stopping;
    for (const watcher of watchers) watcher.close();
    stopping = supervisor.close().finally(() => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      if (failed) process.exitCode = 1;
    });
    return stopping;
  };
  const onSignal = () => void stop();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    for (const { path, recursive } of sourceWatchRoots(projectRoot, role)) {
      const watcher = watch(path, { recursive }, (_event, file) => {
        // fs.watch can omit a name; refresh conservatively rather than miss an edit.
        supervisor.notify(
          file
            ? relative(projectRoot, resolve(path, file.toString()))
            : role === 'web'
              ? 'scripts/compile-web-i18n.ts'
              : `apps/${role}/src/main.ts`,
        );
      });
      watcher.on('error', () => {
        process.stderr.write(
          `[dev:${role}] Source watcher failed; stopping the development service.\n`,
        );
        void stop(true);
      });
      watchers.push(watcher);
    }
    await supervisor.start();
  } catch (error) {
    await stop(true);
    throw error;
  }
  return { stop };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Development supervisor failed.'}\n`,
    );
    process.exitCode = 1;
  });
}
