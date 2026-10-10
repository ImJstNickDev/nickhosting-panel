import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Role = 'web' | 'api' | 'worker';
type Supervisor = {
  start(): Promise<void>;
  notify(file: string): boolean;
  close(): Promise<void>;
};
// Dynamic import keeps the directly executable .mjs independent of TS build tooling.
const moduleUrl = new URL('./dev-watch.mjs', import.meta.url).href;
const { watchAction, childCommand, createSupervisor, sourceWatchRoots } = (await import(
  moduleUrl
)) as {
  watchAction(role: Role, file: string): 'catalogs' | 'restart' | null;
  childCommand(
    role: Role | 'catalogs',
    root?: string,
  ): {
    command: string;
    args: string[];
    cwd: string;
  };
  createSupervisor(options: {
    role: Role;
    launch(kind: Role | 'catalogs'): ChildProcess;
    debounceMs?: number;
    shutdownWarningMs?: number;
    log?(message: string): void;
  }): Supervisor;
  sourceWatchRoots(root: string, role: Role): Array<{ path: string; recursive: boolean }>;
};

class FakeChild extends EventEmitter {
  signals: string[] = [];
  closed = false;
  kill(signal: string) {
    this.signals.push(signal);
    return true;
  }
  finish(code = 0) {
    this.closed = true;
    this.emit('close', code, null);
  }
}

const supervisors: Array<{ supervisor: Supervisor; children: FakeChild[] }> = [];
function fixture(role: Role) {
  const children: FakeChild[] = [];
  const kinds: string[] = [];
  const messages: string[] = [];
  const supervisor = createSupervisor({
    role,
    debounceMs: 20,
    shutdownWarningMs: 100,
    log: (message) => messages.push(message),
    launch(kind) {
      const child = new FakeChild();
      children.push(child);
      kinds.push(kind);
      return child as unknown as ChildProcess;
    },
  });
  supervisors.push({ supervisor, children });
  return { supervisor, children, kinds, messages };
}

afterEach(async () => {
  for (const { supervisor, children } of supervisors.splice(0)) {
    const closed = supervisor.close();
    for (const child of children) if (!child.closed) child.finish();
    await closed;
  }
  vi.useRealTimers();
});

describe('development source selection', () => {
  it('keeps backend restarts scoped to its application and shared server code', () => {
    expect(watchAction('api', 'apps/api/src/servers.ts')).toBe('restart');
    expect(watchAction('worker', 'apps/worker/src/schedules.ts')).toBe('restart');
    expect(watchAction('worker', 'apps/api/src/servers.ts')).toBeNull();
    expect(watchAction('api', 'apps/worker/src/schedules.ts')).toBeNull();
    for (const role of ['api', 'worker'] as const) {
      for (const path of [
        'packages/jobs/src/index.ts',
        'packages/i18n/src/catalogs.ts',
        'games/minecraft/src/management.ts',
        'packages/jobs/package.json',
        'tsconfig.json',
      ])
        expect(watchAction(role, path)).toBe('restart');
      for (const path of [
        'apps/web/src/app/styles.css',
        'apps/web/src/features/account.tsx',
        'games/minecraft/src/ui/index.ts',
        'games/minecraft/src/ui/assets/art.svg',
        'packages/game-sdk/src/ui.ts',
        'packages/i18n/src/web.ts',
        'packages/i18n/src/game-ui-web.ts',
        'packages/jobs/src/job.integration.test.ts',
        'packages/jobs/src/fixtures/provider.ts',
        'packages/jobs/node_modules/lib/index.js',
        'packages/jobs/dist/index.js',
        '.env',
        '.codex/local/INFRASTRUCTURE.md',
        'mountdata/credentials.json',
        '../packages/jobs/src/index.ts',
      ])
        expect(watchAction(role, path)).toBeNull();
    }
  });

  it('recompiles source catalogs without reacting to its own output or presentation changes', () => {
    for (const path of [
      'packages/i18n/src/web.ts',
      'packages/i18n/src/catalogs.ts',
      'games/minecraft/src/ui/index.ts',
      'scripts/compile-web-i18n.ts',
    ])
      expect(watchAction('web', path)).toBe('catalogs');
    for (const path of [
      'apps/web/src/app/messages.json',
      'apps/web/src/app/styles.css',
      'games/minecraft/src/ui/assets/art.svg',
      'apps/web/src/features/account.tsx',
      'packages/i18n/src/index.test.ts',
    ])
      expect(watchAction('web', path)).toBeNull();
  });

  it('runs direct child processes without a shell, tsx watcher, host flag or implicit env file', () => {
    expect(childCommand('worker').args).toEqual([
      '--import',
      'tsx',
      resolve('apps/worker/src/main.ts'),
    ]);
    expect(childCommand('api').args).toEqual(['--import', 'tsx', resolve('apps/api/src/main.ts')]);
    expect(childCommand('catalogs').args).toContain(resolve('scripts/compile-web-i18n.ts'));
    const web = childCommand('web');
    expect(web.command).toBe(process.execPath);
    expect(web.args[0]).toMatch(/vite\/bin\/vite\.js$/);
    expect(web.args).not.toContain('--host');
    expect(web.args.slice(-2)).toEqual(['--configLoader', 'runner']);
    expect(web.cwd).toBe(resolve('apps/web'));
  });

  it('never recursively watches dependency directories or persistent/local test data', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'nickhosting-watch-'));
    try {
      for (const directory of [
        'apps/worker/src',
        'packages/jobs/src',
        'packages/jobs/node_modules',
        'games/minecraft/src',
        'mountdata',
        '.codex/local',
        'node_modules',
      ])
        await mkdir(resolve(root, directory), { recursive: true });
      expect(sourceWatchRoots(root, 'worker')).toEqual([
        { path: root, recursive: false },
        { path: resolve(root, 'apps/worker/src'), recursive: true },
        { path: resolve(root, 'packages/jobs'), recursive: false },
        { path: resolve(root, 'packages/jobs/src'), recursive: true },
        { path: resolve(root, 'games/minecraft'), recursive: false },
        { path: resolve(root, 'games/minecraft/src'), recursive: true },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('development child lifecycle', () => {
  it('debounces a burst and waits for SIGTERM close before replacing a worker', async () => {
    vi.useFakeTimers();
    const { supervisor, children, messages } = fixture('worker');
    await supervisor.start();
    const first = children[0];
    expect(first).toBeDefined();
    supervisor.notify('packages/jobs/src/index.ts');
    await vi.advanceTimersByTimeAsync(10);
    supervisor.notify('apps/worker/src/main.ts');
    await vi.advanceTimersByTimeAsync(19);
    expect(first?.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(first?.signals).toEqual(['SIGTERM']);
    expect(children).toHaveLength(1);
    supervisor.notify('apps/worker/src/schedules.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(children).toHaveLength(1);
    expect(messages).toContain(
      'Still waiting for graceful shutdown; no replacement process has been started.',
    );
    first?.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);
    expect(children[1]?.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(2);
  });

  it('keeps the worker alive for CSS, UI and unrelated application edits', async () => {
    vi.useFakeTimers();
    const { supervisor, children } = fixture('worker');
    await supervisor.start();
    expect(supervisor.notify('apps/web/src/styles.css')).toBe(false);
    expect(supervisor.notify('games/minecraft/src/ui/index.ts')).toBe(false);
    expect(supervisor.notify('apps/api/src/main.ts')).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(1);
    expect(children[0]?.signals).toEqual([]);
  });

  it('compiles catalogs before Vite and refreshes them without restarting Vite', async () => {
    vi.useFakeTimers();
    const { supervisor, children, kinds } = fixture('web');
    const started = supervisor.start();
    expect(kinds).toEqual(['catalogs']);
    children[0]?.finish();
    await started;
    expect(kinds).toEqual(['catalogs', 'web']);
    supervisor.notify('packages/i18n/src/web.ts');
    supervisor.notify('games/minecraft/src/ui/index.ts');
    await vi.advanceTimersByTimeAsync(20);
    expect(kinds).toEqual(['catalogs', 'web', 'catalogs']);
    children[2]?.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(children[1]?.signals).toEqual([]);
    expect(kinds).toEqual(['catalogs', 'web', 'catalogs']);
  });

  it('does not serve on an initial compilation failure and retries after a source fix', async () => {
    vi.useFakeTimers();
    const { supervisor, children, kinds, messages } = fixture('web');
    const started = supervisor.start();
    children[0]?.finish(1);
    await started;
    expect(kinds).toEqual(['catalogs']);
    expect(messages.join(' ')).toMatch(/Catalog compilation failed/);
    supervisor.notify('packages/i18n/src/web.ts');
    await vi.advanceTimersByTimeAsync(20);
    children[1]?.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(kinds).toEqual(['catalogs', 'catalogs', 'web']);
  });

  it('cancels pending restarts and waits for a compiler during parent shutdown', async () => {
    vi.useFakeTimers();
    const { supervisor, children, kinds } = fixture('web');
    const started = supervisor.start();
    supervisor.notify('packages/i18n/src/web.ts');
    const closing = supervisor.close();
    expect(supervisor.close()).toBe(closing);
    expect(children[0]?.signals).toEqual(['SIGTERM']);
    children[0]?.finish();
    await closing;
    await started;
    await vi.advanceTimersByTimeAsync(1000);
    expect(kinds).toEqual(['catalogs']);
    expect(supervisor.notify('packages/i18n/src/web.ts')).toBe(false);
  });

  it('recovers a crashed API only after a source change without a crash loop', async () => {
    vi.useFakeTimers();
    const { supervisor, children, messages } = fixture('api');
    await supervisor.start();
    children[0]?.finish(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(1);
    expect(messages.join(' ')).toMatch(/waiting for a source change/);
    supervisor.notify('apps/api/src/main.ts');
    await vi.advanceTimersByTimeAsync(20);
    expect(children).toHaveLength(2);
  });

  it('delivers SIGTERM to a real Node child and launches its replacement only after close', async () => {
    const children: ChildProcess[] = [];
    const ready: Array<Promise<unknown[]>> = [];
    const order: string[] = [];
    const supervisor = createSupervisor({
      role: 'worker',
      debounceMs: 1,
      log: () => {},
      launch() {
        const index = children.length;
        order.push(`start:${index}`);
        const child = spawn(
          process.execPath,
          [
            '-e',
            `setInterval(() => {}, 1000);
             process.on('SIGTERM', () => setTimeout(() => process.exit(0), 30));
             process.send('ready');`,
          ],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], shell: false },
        );
        children.push(child);
        ready.push(once(child, 'message'));
        child.once('close', () => order.push(`close:${index}`));
        return child;
      },
    });
    try {
      await supervisor.start();
      await ready[0];
      supervisor.notify('apps/worker/src/main.ts');
      await vi.waitFor(() => expect(children.length).toBe(2));
      await ready[1];
      expect(order).toEqual(['start:0', 'close:0', 'start:1']);
      expect(children[0]?.exitCode).toBe(0);
      await supervisor.close();
      expect(order).toEqual(['start:0', 'close:0', 'start:1', 'close:1']);
      expect(children[1]?.exitCode).toBe(0);
    } finally {
      await supervisor.close();
    }
  });
});
