import { DomainError } from '@nickhosting/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ContainerObserverExec, createContainerObserver } from './container-observer.js';

const socket = '/fixture/docker-observer.sock';
const uuid = 'e92be5b2-f73e-4e66-983f-824d1366bccc';
const containerId = 'a'.repeat(64);
const otherId = 'b'.repeat(64);
const listed = (id = containerId, name = uuid) => JSON.stringify({ id, name });
const inspected = (state: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: containerId,
    name: `/${uuid}`,
    service: 'Pterodactyl',
    containerType: 'server_process',
    state: {
      running: false,
      restarting: false,
      paused: false,
      dead: false,
      status: 'exited',
      ...state,
    },
    ...fields,
  });
function fixture(outputs: (string | Error)[]) {
  const exec = vi.fn<ContainerObserverExec>(async () => {
    const next = outputs.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('unexpected command');
    return { stdout: next };
  });
  return { exec, observer: createContainerObserver(socket, { exec }) };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('explicit read-only Docker container observation', () => {
  it.each([
    '',
    'docker.sock',
    'unix:///fixture/docker.sock',
    '/',
    '/fixture/../docker.sock',
    '/fixture/docker.sock/',
    '/fixture/sock\0',
    '/fixture/sock\n',
    '/fixture/sock?x',
  ])('rejects unsafe socket %j without a CLI call', (value) => {
    const exec = vi.fn<ContainerObserverExec>();
    expect(() => createContainerObserver(value, { exec })).toThrow(DomainError);
    expect(exec).not.toHaveBeenCalled();
  });

  it('preflights only the engine ID and ignores inherited remote Docker settings', async () => {
    vi.stubEnv('DOCKER_HOST', 'tcp://wrong.example.com:2375');
    vi.stubEnv('DOCKER_CONTEXT', 'remote-production');
    vi.stubEnv('DOCKER_TLS_VERIFY', '1');
    vi.stubEnv('DOCKER_API_VERSION', '1.1');
    const { exec, observer } = fixture(['"engine-fixture-123"\n']);
    await observer.preflight();
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      'docker',
      ['--host', `unix://${socket}`, 'info', '--format', '{{json .ID}}'],
      expect.objectContaining({
        timeout: 5000,
        maxBuffer: 65536,
        killSignal: 'SIGKILL',
        shell: false,
        encoding: 'utf8',
      }),
    );
    const env = exec.mock.calls[0]?.[2].env;
    expect(Object.keys(env ?? {}).filter((key) => key.startsWith('DOCKER_'))).toEqual([]);
    expect(process.env.DOCKER_CONTEXT).toBe('remote-production');
  });

  it.each(['', 'null', '[]', '{}', '""', '"wrong\nvalue"', '"ok"\n"second"'])(
    'rejects malformed engine identity %j',
    async (value) => {
      const { observer } = fixture([value]);
      await expect(observer.preflight()).rejects.toMatchObject({ code: 'integration_unavailable' });
    },
  );

  it.each(['not-a-uuid', `${uuid}_installer`, `/${uuid}`, `${uuid}\n`, uuid.toUpperCase()])(
    'rejects noncanonical server identity %j before execution',
    async (value) => {
      const { exec, observer } = fixture([]);
      await expect(observer.stopped(value, 'server')).rejects.toMatchObject({
        code: 'configuration_invalid',
      });
      expect(exec).not.toHaveBeenCalled();
    },
  );

  it('proves absence using an exact all-container query, not a failed inspect', async () => {
    const { exec, observer } = fixture(['\n']);
    await expect(observer.stopped(uuid, 'server')).resolves.toBe(true);
    expect(exec.mock.calls[0]?.[1]).toEqual([
      '--host',
      `unix://${socket}`,
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      `name=^/${uuid}$`,
      '--format',
      '{"id":{{json .ID}},"name":{{json .Names}}}',
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('pins full container ID and rechecks the exact name after inspecting only approved metadata', async () => {
    const { exec, observer } = fixture([listed(), inspected(), listed()]);
    await expect(observer.stopped(uuid, 'server')).resolves.toBe(true);
    expect(exec.mock.calls[1]?.[1].slice(0, 5)).toEqual([
      '--host',
      `unix://${socket}`,
      'container',
      'inspect',
      '--format',
    ]);
    expect(exec.mock.calls[1]?.[1].at(-1)).toBe(containerId);
    const format = exec.mock.calls[1]?.[1][5] ?? '';
    expect(format).not.toContain('.Config.Env');
    expect(format).not.toContain('{{json .Config.Labels}}');
    expect(format).not.toContain('.State.Error');
    expect(format).toContain('index .Config.Labels "Service"');
    expect(format).toContain('index .Config.Labels "ContainerType"');
    expect(exec.mock.calls[2]?.[1]).toEqual(exec.mock.calls[0]?.[1]);
  });

  it('uses the distinct installer name and required installer label', async () => {
    const name = `${uuid}_installer`;
    const { exec, observer } = fixture([
      listed(containerId, name),
      inspected({}, { name: `/${name}`, containerType: 'server_installer' }),
      listed(containerId, name),
    ]);
    await expect(observer.stopped(uuid, 'installer')).resolves.toBe(true);
    expect(exec.mock.calls[0]?.[1]).toContain(`name=^/${name}$`);
  });

  it.each([
    { status: 'running', running: true },
    { status: 'restarting', running: true, restarting: true },
    { status: 'paused', running: true, paused: true },
    { status: 'removing' },
    { status: 'running' },
    { status: 'exited', running: true },
    { status: 'dead', restarting: true, dead: true },
  ])('never proves a running/pending/inconsistent process stopped: %j', async (state) => {
    const { observer } = fixture([listed(), inspected(state), listed()]);
    await expect(observer.stopped(uuid, 'server')).resolves.toBe(false);
  });

  it.each([{ status: 'exited' }, { status: 'created' }, { status: 'dead', dead: true }])(
    'reports only physical non-running state, not future effect quiescence: %j',
    async (state) => {
      const { observer } = fixture([listed(), inspected(state), listed()]);
      await expect(observer.stopped(uuid, 'server')).resolves.toBe(true);
    },
  );

  it.each([
    [listed(containerId, `${uuid}-other`)],
    [listed('short-id')],
    [`${listed()}\n${listed(otherId)}`],
    ['[{"id":"unexpected-array"}]'],
    [listed(), inspected({}, { id: otherId })],
    [listed(), inspected({}, { name: '/unrelated' })],
    [listed(), inspected({}, { service: 'unrelated' })],
    [listed(), inspected({}, { containerType: 'server_installer' })],
    [listed(), inspected({ running: 'false' })],
    [listed(), inspected({ status: 'unknown' })],
    [listed(), `${inspected()}\n${inspected()}`],
    [listed(), inspected(), listed(otherId)],
    [listed(), inspected(), ''],
  ])('fails closed on malformed, unrelated, multiple or replaced metadata', async (...outputs) => {
    const { observer } = fixture(outputs);
    await expect(observer.stopped(uuid, 'server')).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
  });

  it.each([0, 1, 2])(
    'sanitizes CLI failure at phase %i instead of treating it as absence',
    async (phase) => {
      const outputs: (string | Error)[] = [listed(), inspected(), listed()];
      outputs[phase] = new Error('fixture-secret from failed command stderr');
      const { observer } = fixture(outputs);
      const error = await observer.stopped(uuid, 'server').catch((value: unknown) => value);
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: 'integration_unavailable' });
      expect(String(error)).not.toContain('fixture-secret');
      expect(JSON.stringify(error)).not.toContain('fixture-secret');
    },
  );

  it('bounds injected output too and never exposes malformed output content', async () => {
    const { observer } = fixture(['fixture-secret'.repeat(6000)]);
    const error = await observer.stopped(uuid, 'server').catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'integration_unavailable' });
    expect(String(error)).not.toContain('fixture-secret');
  });
});

describe('independent process start identity', () => {
  const startedAt = '2026-10-09T11:59:59.123456789Z';
  const running = (state: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) =>
    inspected({ running: true, status: 'running', startedAt, ...state }, fields);
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-09T12:00:00.123Z'));
  });

  it.each(['2026-10-09T11:59:59Z', '2026-10-09T11:59:59.1Z', startedAt])(
    'preserves the exact verified RFC3339Nano process timestamp %s',
    async (value) => {
      const { exec, observer } = fixture([listed(), running({ startedAt: value }), listed()]);
      await expect(observer.processStartedAt(uuid)).resolves.toBe(value);
      expect(exec.mock.calls[0]?.[1]).toContain(`name=^/${uuid}$`);
      const args = exec.mock.calls[1]?.[1] ?? [];
      expect(args.at(-1)).toBe(containerId);
      expect(args[5]).toContain('{{json .State.StartedAt}}');
      expect(args[5]).not.toContain('.Config.Env');
      expect(exec.mock.calls[2]?.[1]).toEqual(exec.mock.calls[0]?.[1]);
    },
  );

  it('distinguishes fast restarts within one millisecond without rounding provider evidence', async () => {
    const first = '2026-10-09T11:59:59.123456788Z';
    const { observer } = fixture([
      listed(),
      running({ startedAt: first }),
      listed(),
      listed(),
      running({ startedAt }),
      listed(),
    ]);
    expect(Date.parse(first)).toBe(Date.parse(startedAt));
    await expect(observer.processStartedAt(uuid)).resolves.toBe(first);
    await expect(observer.processStartedAt(uuid)).resolves.toBe(startedAt);
  });

  it('returns null for a successfully proven absent process', async () => {
    const { exec, observer } = fixture(['']);
    await expect(observer.processStartedAt(uuid)).resolves.toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.each([
    { running: false, status: 'created', startedAt: '0001-01-01T00:00:00Z' },
    { running: false, status: 'exited' },
    { running: false, status: 'dead', dead: true },
    { status: 'restarting', restarting: true },
    { status: 'paused', paused: true },
    { status: 'running', dead: true },
    { status: 'removing' },
  ])(
    'does not return process identity for a non-running or transitional container: %j',
    async (state) => {
      const { observer } = fixture([listed(), running(state), listed()]);
      await expect(observer.processStartedAt(uuid)).resolves.toBeNull();
    },
  );

  it.each([
    '',
    '0001-01-01T00:00:00Z',
    '1970-01-01T00:00:00Z',
    '2026-10-09T12:00:00.123000001Z',
    '2026-10-09T12:00:01Z',
    '2026-02-30T11:59:59Z',
    '2025-02-29T11:59:59Z',
    '2026-10-09T24:00:00Z',
    '2026-10-09T11:59:60Z',
    '2026-10-09T11:59Z',
    '2026-10-09T11:59:59.1234567890Z',
    '2026-10-09T11:59:59+00:00',
    '2026-10-09T11:59:59Z\n',
    'fixture-secret-not-a-timestamp',
  ])('rejects malformed, zero or future running-process timestamps %j', async (value) => {
    const { observer } = fixture([listed(), running({ startedAt: value }), listed()]);
    const error = await observer.processStartedAt(uuid).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'integration_unavailable' });
    expect(JSON.stringify(error)).not.toContain('fixture-secret');
  });

  it.each([
    [listed(containerId, `${uuid}_installer`)],
    [`${listed()}\n${listed(otherId)}`],
    [listed(), running({}, { id: otherId })],
    [listed(), running({}, { name: '/unrelated' })],
    [listed(), running({}, { service: 'unrelated' })],
    [listed(), running({}, { containerType: 'server_installer' })],
    [listed(), running({ startedAt: null })],
    [listed(), running({ startedAt: undefined })],
    [listed(), running({ running: 'true' })],
    [listed(), running(), listed(otherId)],
    [listed(), running(), ''],
    [new Error('fixture-secret CLI error')],
    [listed(), new Error('fixture-secret CLI error')],
    [listed(), running(), new Error('fixture-secret CLI error')],
  ])(
    'rejects wrong targets, malformed output, replacement races and CLI failures',
    async (...outputs) => {
      const { observer } = fixture(outputs);
      const error = await observer.processStartedAt(uuid).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'integration_unavailable' });
      expect(JSON.stringify(error)).not.toContain('fixture-secret');
    },
  );

  it('validates a canonical UUID before any process observation', async () => {
    const { exec, observer } = fixture([]);
    await expect(observer.processStartedAt(`${uuid}_installer`)).rejects.toMatchObject({
      code: 'configuration_invalid',
    });
    expect(exec).not.toHaveBeenCalled();
  });
});
