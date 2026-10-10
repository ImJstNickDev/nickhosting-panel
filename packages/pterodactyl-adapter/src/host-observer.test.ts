import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRemoteHostObserver,
  type HostObservationSample,
  serveHostObserver,
} from './host-observer.js';

const uuid = '11111111-1111-4111-8111-111111111111';
const sample: HostObservationSample = {
  totalMemoryMiB: 8192,
  availableMemoryMiB: 2048,
  cpuCapacityPercent: 400,
  cpuBusyPercent: 120,
  availableDiskMiB: 5000,
  observedAt: new Date().toISOString(),
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nh-observer-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const disk = join(directory, 'disk');
  await mkdir(disk);
  const observer = {
    preflight: vi.fn(async () => {}),
    stopped: vi.fn(async () => true),
    processStartedAt: vi.fn(async () => '2026-10-10T10:00:00.123456789Z'),
    imageIdentity: vi.fn(async () => `sha256:${'a'.repeat(64)}`),
  };
  const socket = join(directory, 'observer.sock');
  const options = {
    socket,
    dockerSocket: '/not-accessed/docker.sock',
    observerId: 'dev-host',
    allowedDiskPaths: [disk],
    containerObserver: observer,
    sample: vi.fn(async () => sample),
  };
  return { directory, disk, socket, observer, options };
}
async function raw(socket: string, value: unknown) {
  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        path: '/observe',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let output = '';
        res.on('data', (chunk) => {
          output += chunk;
        });
        res.on('end', () => resolve(output));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(value));
  });
}

describe('bounded host observer Unix protocol', () => {
  it('returns host-native samples and exact-container evidence without exposing Docker', async () => {
    const f = await fixture();
    const server = await serveHostObserver(f.options);
    cleanups.push(() => server.close());
    expect((await lstat(f.socket)).mode & 0o777).toBe(0o600);
    const client = createRemoteHostObserver(f.socket, 'dev-host');
    await client.preflight();
    expect(await client.sample(f.disk)).toEqual(sample);
    expect(await client.stopped(uuid, 'installer')).toBe(true);
    expect(await client.processStartedAt(uuid)).toBe('2026-10-10T10:00:00.123456789Z');
    expect(await client.imageIdentity(uuid)).toBe(`sha256:${'a'.repeat(64)}`);
    expect(f.observer.stopped).toHaveBeenCalledWith(uuid, 'installer');
  });
  it('fails closed on observer identity mismatch and inaccessible helper', async () => {
    const f = await fixture();
    const server = await serveHostObserver(f.options);
    cleanups.push(() => server.close());
    await expect(createRemoteHostObserver(f.socket, 'other').sample(f.disk)).rejects.toThrow(
      'integration_unavailable',
    );
    await expect(
      createRemoteHostObserver(join(f.directory, 'missing'), 'dev-host').preflight(),
    ).rejects.toThrow('integration_unavailable');
  });
  it('rejects arbitrary methods, extra fields, malformed UUIDs and oversized requests before invoking observers', async () => {
    const f = await fixture();
    const server = await serveHostObserver(f.options);
    cleanups.push(() => server.close());
    for (const input of [
      { method: 'delete', uuid },
      { method: 'stopped', uuid: '../foreign', kind: 'server' },
      { method: 'preflight', command: 'secret' },
      { method: 'sample', path: 'x'.repeat(9000) },
    ])
      expect(await raw(f.socket, input)).toBe('{"error":"integration_unavailable"}');
    expect(f.observer.preflight).not.toHaveBeenCalled();
    expect(f.observer.stopped).not.toHaveBeenCalled();
  });
  it('allows only exact canonical disk paths, including after a path is replaced by a symlink', async () => {
    const f = await fixture();
    const server = await serveHostObserver(f.options);
    cleanups.push(() => server.close());
    const client = createRemoteHostObserver(f.socket, 'dev-host');
    await expect(client.sample(f.directory)).rejects.toThrow('integration_unavailable');
    await rm(f.disk, { recursive: true });
    await symlink(f.directory, f.disk);
    await expect(client.sample(f.disk)).rejects.toThrow('integration_unavailable');
    expect(f.options.sample).not.toHaveBeenCalled();
  });
  it('refuses shared socket directories and never replaces an existing socket path', async () => {
    const f = await fixture();
    await chmod(f.directory, 0o755);
    await expect(serveHostObserver(f.options)).rejects.toThrow('integration_unavailable');
    await chmod(f.directory, 0o700);
    await writeFile(f.socket, 'preserved');
    await expect(serveHostObserver(f.options)).rejects.toThrow();
    expect((await lstat(f.socket)).isFile()).toBe(true);
  });
  it('recovers only a refused owned socket and rejects live or non-socket paths', async () => {
    const f = await fixture();
    const child = spawn(
      process.execPath,
      [
        '-e',
        "require('node:net').createServer().listen(process.argv[1],()=>process.stdout.write('ready'))",
        f.socket,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await once(child.stdout, 'data');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    expect((await lstat(f.socket)).isSocket()).toBe(true);
    await expect(serveHostObserver(f.options)).rejects.toThrow();
    const server = await serveHostObserver({ ...f.options, recoverStaleSocket: true });
    cleanups.push(() => server.close());
    const before = await lstat(f.socket);
    await expect(serveHostObserver({ ...f.options, recoverStaleSocket: true })).rejects.toThrow(
      'integration_unavailable',
    );
    expect((await lstat(f.socket)).ino).toBe(before.ino);
    await createRemoteHostObserver(f.socket, 'dev-host').preflight();
    const other = join(f.directory, 'other');
    await writeFile(other, 'preserved');
    await expect(
      serveHostObserver({ ...f.options, socket: other, recoverStaleSocket: true }),
    ).rejects.toThrow('integration_unavailable');
    const link = join(f.directory, 'link');
    await symlink(f.socket, link);
    await expect(
      serveHostObserver({ ...f.options, socket: link, recoverStaleSocket: true }),
    ).rejects.toThrow('integration_unavailable');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await lstat(other)).isFile()).toBe(true);
  });
  it('sanitizes observation failures and rejects impossible capacity samples', async () => {
    const f = await fixture();
    f.options.sample.mockResolvedValue({ ...sample, availableMemoryMiB: 99999 });
    f.observer.preflight.mockRejectedValue(new Error('private details'));
    const server = await serveHostObserver(f.options);
    cleanups.push(() => server.close());
    const client = createRemoteHostObserver(f.socket, 'dev-host');
    await expect(client.sample(f.disk)).rejects.toThrow('integration_unavailable');
    expect(await raw(f.socket, { method: 'preflight' })).not.toContain('private');
  });
});
