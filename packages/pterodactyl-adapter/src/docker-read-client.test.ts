import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { dockerReadCommand } from './docker-read-client.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(handler: RequestListener) {
  const directory = await mkdtemp(join(tmpdir(), 'nh-docker-read-'));
  const socket = join(directory, 'docker.sock');
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  });
  return socket;
}
const native = (id: string) => ({
  Id: id,
  Name: '/owned',
  Config: {
    Env: ['SECRET=value'],
    Labels: { Service: 'Pterodactyl', ContainerType: 'server_process' },
  },
  State: { Running: false, Status: 'exited' },
  HostConfig: {
    NetworkMode: 'bridge',
    PortBindings: { '25565/tcp': [{ HostIp: '0.0.0.0', HostPort: '25565' }] },
  },
  NetworkSettings: { Ports: {}, Networks: { bridge: {} } },
});

it('uses bounded pooled GETs and preserves stopped reservations without private container fields', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
  let active = 0,
    maximum = 0,
    requests = 0;
  const socket = await fixture((req, res) => {
    expect(req.method).toBe('GET');
    requests++;
    active++;
    maximum = Math.max(maximum, active);
    setTimeout(() => {
      active--;
      res.end(JSON.stringify(native(req.url?.split('/')[2] ?? '')));
    }, 3);
  });
  const output = await dockerReadCommand(
    ['container', 'inspect', '--format', '', ...ids],
    socket,
    2000,
  );
  expect(output.split('\n')).toHaveLength(20);
  expect(requests).toBe(20);
  expect(maximum).toBeLessThanOrEqual(8);
  expect(maximum).toBeGreaterThan(1);
  expect(output).toContain('configuredBindings');
  expect(output).toContain('25565');
  expect(output).not.toContain('SECRET');
  expect(output).not.toContain('Env');
});

it('aggregates exact 404 targets but malformed surviving evidence takes precedence', async () => {
  const ids = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
  let malformed = false;
  const socket = await fixture((req, res) => {
    const target = req.url?.split('/')[2] ?? '';
    if (target !== ids[2]) {
      res.statusCode = 404;
      res.end('private error');
    } else res.end(JSON.stringify(malformed ? { private: 'SECRET' } : native(target)));
  });
  await expect(
    dockerReadCommand(['container', 'inspect', '--format', '', ...ids], socket),
  ).rejects.toMatchObject({ ids: ids.slice(0, 2) });
  malformed = true;
  await expect(
    dockerReadCommand(['container', 'inspect', '--format', '', ...ids], socket),
  ).rejects.toThrow('docker_read_invalid');
});

it('enforces an overall deadline including queued reads and refuses non-success bodies', async () => {
  const socket = await fixture((_req, _res) => {});
  await expect(dockerReadCommand(['info'], socket, 30)).rejects.toThrow('docker_read_timeout');
  const refused = await fixture((_req, res) => {
    res.statusCode = 403;
    res.end('SECRET');
  });
  await expect(dockerReadCommand(['info'], refused, 1000)).rejects.toThrow('docker_read_failed');
});

it('reads complete network metadata once for a chunk and rejects missing identities', async () => {
  const ids = ['a'.repeat(64), 'b'.repeat(64)];
  let requests = 0;
  const socket = await fixture((req, res) => {
    requests++;
    expect(req.url).toBe('/networks');
    res.end(
      JSON.stringify(
        ids.map((Id) => ({
          Id,
          Name: Id,
          Driver: 'bridge',
          Scope: 'local',
          Internal: false,
          EnableIPv6: false,
          Options: {},
        })),
      ),
    );
  });
  expect(
    (await dockerReadCommand(['network', 'inspect', '--format', '', ...ids], socket)).split('\n'),
  ).toHaveLength(2);
  expect(requests).toBe(1);
  await expect(
    dockerReadCommand(['network', 'inspect', '--format', '', 'c'.repeat(64)], socket),
  ).rejects.toThrow('docker_read_identity');
});

it('rejects a successful inspect for another container and duplicate network identities', async () => {
  const id = 'a'.repeat(64);
  const socket = await fixture((req, res) => {
    if (req.url === '/networks') {
      const entry = {
        Id: id,
        Name: 'bridge',
        Driver: 'bridge',
        Scope: 'local',
        Internal: false,
        EnableIPv6: false,
        Options: {},
      };
      res.end(JSON.stringify([entry, entry]));
    } else res.end(JSON.stringify(native('b'.repeat(64))));
  });
  await expect(
    dockerReadCommand(['container', 'inspect', '--format', '', id], socket),
  ).rejects.toThrow('docker_read_invalid');
  await expect(
    dockerReadCommand(['network', 'inspect', '--format', '', id], socket),
  ).rejects.toThrow('docker_read_identity');
});
