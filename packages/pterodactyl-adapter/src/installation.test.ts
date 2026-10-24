import { describe, expect, it, vi } from 'vitest';
import type { ConsoleRelayOptions } from './console.js';
import { confirmInstallation } from './installation.js';
import { PterodactylError } from './transport.js';
import type { ApplicationServer } from './types.js';

function fixture(status: string | null = null) {
  let stream!: ConsoleRelayOptions;
  const close = vi.fn();
  const adapter = {
    getApplicationServer: vi.fn(
      async () =>
        ({
          identifier: 'fixture',
          uuid: 'f729c8a1-6773-467a-af3f-a7ea8704f0bd',
          status,
          container: { installed: status ? 0 : 1 },
        }) as ApplicationServer,
    ),
    relayConsole: vi.fn(async (_id: string, options: ConsoleRelayOptions) => {
      stream = options;
      return {
        close,
        sendCommand: async () => {},
        requestLogs: async () => {},
        requestStats: async () => {},
      };
    }),
    reinstall: vi.fn(async () => {
      stream.onEvent({ type: 'installation', phase: 'completed' });
    }),
  };
  const options = { authorize: vi.fn(async () => true), onConfirmed: vi.fn(async () => {}) };
  const observer = { preflight: vi.fn(async () => {}), stopped: vi.fn(async () => true) };
  return {
    adapter,
    options,
    close,
    observer,
    disconnect: () => stream.onEvent({ type: 'closed' }),
  };
}
describe('installation terminal evidence', () => {
  it('traces the request separately from terminal wait without adding provider reads', async () => {
    const f = fixture();
    const labels: string[] = [];
    const timing = {
      async measure<T>(name: string, work: () => Promise<T>): Promise<T> {
        try {
          return await work();
        } finally {
          labels.push(name);
        }
      },
      measureSync<T>(_name: string, work: () => T): T {
        return work();
      },
    };
    const result = await confirmInstallation(
      f.adapter,
      1,
      'fixture',
      { ...f.options, timing },
      true,
      30,
      f.observer,
    );
    expect(result).toEqual({ confirmed: true });
    expect(labels).toEqual(
      expect.arrayContaining([
        'observerPreflight',
        'consoleChannel',
        'reinstallRequest',
        'applicationRead',
        'installerStopped',
        'confirmationCommit',
        'terminalWait',
      ]),
    );
    expect(f.adapter.reinstall).toHaveBeenCalledTimes(1);
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('preserves a rejected reinstall and closes the channel with timing enabled', async () => {
    const f = fixture();
    const error = new PterodactylError('permission_denied', 'client', 'rejected');
    f.adapter.reinstall.mockRejectedValue(error);
    const labels: string[] = [];
    const timing = {
      async measure<T>(name: string, work: () => Promise<T>): Promise<T> {
        try {
          return await work();
        } finally {
          labels.push(name);
        }
      },
      measureSync<T>(_name: string, work: () => T): T {
        return work();
      },
    };
    await expect(
      confirmInstallation(f.adapter, 1, 'fixture', { ...f.options, timing }, true, 30, f.observer),
    ).rejects.toBe(error);
    expect(labels).toContain('reinstallRequest');
    expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('prefers the installation-only channel with the known UUID and ignores started notifications', async () => {
    const f = fixture();
    const installationRelay = vi.fn(async (_id: string, options: ConsoleRelayOptions) =>
      f.adapter.relayConsole(_id, options),
    );
    const runtimeRelay = f.adapter.relayConsole;
    const boundary = { ...f.adapter, relayConsole: vi.fn(), relayInstallation: installationRelay };
    f.adapter.reinstall.mockImplementation(async () => {
      installationRelay.mock.calls[0]?.[1].onEvent({ type: 'installation', phase: 'started' });
      expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
      installationRelay.mock.calls[0]?.[1].onEvent({ type: 'installation', phase: 'completed' });
    });
    expect(
      await confirmInstallation(
        boundary,
        1,
        'fixture',
        { ...f.options, serverUUID: 'f729c8a1-6773-467a-af3f-a7ea8704f0bd' },
        true,
        30,
        f.observer,
      ),
    ).toEqual({ confirmed: true });
    expect(boundary.relayConsole).not.toHaveBeenCalled();
    expect(runtimeRelay).toHaveBeenCalledTimes(1); // Only the fixture's shared socket factory.
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(1); // Terminal verification only.
  });
  it.each(['not_found', 'permission_denied'] as const)(
    'falls back to stock console only when extension is missing, not %s denial',
    async (reason) => {
      const f = fixture();
      const boundary = {
        ...f.adapter,
        relayInstallation: vi.fn(async () => {
          throw new PterodactylError(reason, 'client', 'rejected');
        }),
      };
      const result = confirmInstallation(
        boundary,
        1,
        'fixture',
        { ...f.options, serverUUID: 'f729c8a1-6773-467a-af3f-a7ea8704f0bd' },
        true,
        30,
        f.observer,
      );
      if (reason === 'not_found') {
        expect(await result).toEqual({ confirmed: true });
        expect(f.adapter.relayConsole).toHaveBeenCalledTimes(1);
      } else {
        await expect(result).rejects.toMatchObject({ reason });
        expect(f.adapter.relayConsole).not.toHaveBeenCalled();
      }
    },
  );
  it('does not release installation capacity while its exact installer container still runs', async () => {
    const f = fixture();
    f.observer.stopped.mockResolvedValue(false);
    expect(
      await confirmInstallation(f.adapter, 1, 'fixture', f.options, true, 30, f.observer),
    ).toEqual({ confirmed: false });
    expect(f.options.onConfirmed).not.toHaveBeenCalled();
  });
  it('requires fresh completion plus fresh successful Panel callback state', async () => {
    const f = fixture();
    expect(
      await confirmInstallation(f.adapter, 1, 'fixture', f.options, true, 30, f.observer),
    ).toEqual({
      confirmed: true,
    });
    expect(f.options.onConfirmed).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it.each(['install_failed', 'reinstall_failed', 'installing'])(
    'does not claim success on completion with %s',
    async (status) => {
      const f = fixture(status);
      expect(
        await confirmInstallation(f.adapter, 1, 'fixture', f.options, true, 30, f.observer),
      ).toEqual({
        confirmed: false,
      });
      expect(f.options.onConfirmed).not.toHaveBeenCalled();
    },
  );
  it('does not accept reset-to-null or an event missed during a worker crash', async () => {
    const f = fixture();
    expect(
      await confirmInstallation(f.adapter, 1, 'fixture', f.options, false, 10, f.observer),
    ).toEqual({
      confirmed: false,
    });
    expect(f.adapter.reinstall).not.toHaveBeenCalled();
    expect(f.options.onConfirmed).not.toHaveBeenCalled();
  });
  it('rejects the status proof if its authenticated stream disconnects during lookup', async () => {
    const f = fixture();
    f.adapter.getApplicationServer.mockImplementation(async () => {
      f.disconnect();
      return {
        identifier: 'fixture',
        uuid: 'f729c8a1-6773-467a-af3f-a7ea8704f0bd',
        status: null,
        container: { installed: 1 },
      } as ApplicationServer;
    });
    expect(
      await confirmInstallation(f.adapter, 1, 'fixture', f.options, true, 30, f.observer),
    ).toEqual({
      confirmed: false,
    });
  });
  it('does not report success if durable persistence fails', async () => {
    const f = fixture();
    f.options.onConfirmed.mockRejectedValue(new Error('fixture persistence failure'));
    await expect(
      confirmInstallation(f.adapter, 1, 'fixture', f.options, true, 30, f.observer),
    ).rejects.toThrow('fixture persistence failure');
  });
});
