import { describe, expect, it, vi } from 'vitest';
import type { ConsoleRelayOptions } from './console.js';
import { stopWithConfirmation, supportsStopConfirmation } from './power.js';
import { PterodactylError } from './transport.js';
import type { ApplicationServer, Egg } from './types.js';

function fixture(stop = 'end') {
  let stream!: ConsoleRelayOptions;
  const close = vi.fn();
  const adapter = {
    getApplicationServer: vi.fn(
      async () =>
        ({
          identifier: 'fixture',
          uuid: 'f729c8a1-6773-467a-af3f-a7ea8704f0bd',
          nest: 1,
          egg: 1,
        }) as ApplicationServer,
    ),
    getEgg: vi.fn(async () => ({ config: { stop } }) as Egg),
    relayConsole: vi.fn(async (_id: string, options: ConsoleRelayOptions) => {
      stream = options;
      // Initial offline snapshot must not count.
      stream.onEvent({ type: 'status', data: 'offline' });
      return {
        close,
        sendCommand: async () => {},
        requestLogs: async () => {},
        requestStats: async () => {},
      };
    }),
    power: vi.fn(async () => {
      stream.onEvent({ type: 'status', data: 'stopping' });
      stream.onEvent({ type: 'status', data: 'offline' });
    }),
  };
  const options = { authorize: vi.fn(async () => true), onConfirmed: vi.fn(async () => {}) };
  const observer = { preflight: vi.fn(async () => {}), stopped: vi.fn(async () => true) };
  return {
    adapter,
    observer,
    options,
    close,
    emit: (state: 'offline' | 'stopping' | 'running') =>
      stream.onEvent({ type: 'status', data: state }),
  };
}
describe('stop confirmation from verified stop semantics', () => {
  it('runs the final handoff fence after setup and before any stop power', async () => {
    const f = fixture();
    const beforePower = vi.fn(async () => {
      expect(f.adapter.relayConsole).toHaveBeenCalledTimes(1);
      expect(f.options.authorize).toHaveBeenCalled();
      expect(f.adapter.power).not.toHaveBeenCalled();
    });
    expect(
      await stopWithConfirmation(
        f.adapter,
        1,
        'fixture',
        { ...f.options, beforePower },
        20,
        f.observer,
      ),
    ).toEqual({ confirmed: true });
    expect(beforePower).toHaveBeenCalledTimes(1);
    expect(f.adapter.power).toHaveBeenCalledTimes(1);
  });
  it('does not send power when the final handoff fence rejects after relay setup', async () => {
    const f = fixture();
    await expect(
      stopWithConfirmation(
        f.adapter,
        1,
        'fixture',
        {
          ...f.options,
          beforePower: async () => {
            throw new PterodactylError('permission_denied', 'client', 'rejected');
          },
        },
        20,
        f.observer,
      ),
    ).rejects.toMatchObject({ outcome: 'rejected' });
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('retains capacity when Wings reports offline but the actual container still runs', async () => {
    const f = fixture();
    f.observer.stopped.mockResolvedValue(false);
    expect(await stopWithConfirmation(f.adapter, 1, 'fixture', f.options, 20, f.observer)).toEqual({
      confirmed: false,
    });
    expect(f.options.onConfirmed).not.toHaveBeenCalled();
  });
  it('requires a trusted observer before sending power', async () => {
    const f = fixture();
    await expect(
      stopWithConfirmation(f.adapter, 1, 'fixture', f.options, 20),
    ).rejects.toMatchObject({ outcome: 'rejected' });
    expect(f.adapter.power).not.toHaveBeenCalled();
  });
  it.each(['end', 'stop', '^C', '^c'])(
    'requires and persists a new ordered transition for %s',
    async (stop) => {
      const f = fixture(stop);
      expect(
        await stopWithConfirmation(f.adapter, 1, 'fixture', f.options, 20, f.observer),
      ).toEqual({
        confirmed: true,
      });
      expect(f.options.onConfirmed).toHaveBeenCalledTimes(1);
      expect(f.close).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['^SIGTERM', '^SIGINT', '^KILL', ''])(
    'rejects unsupported mode %s before mutation',
    async (stop) => {
      const f = fixture(stop);
      await expect(
        stopWithConfirmation(f.adapter, 1, 'fixture', f.options, 20, f.observer),
      ).rejects.toMatchObject({ outcome: 'rejected' });
      expect(f.adapter.power).not.toHaveBeenCalled();
    },
  );
  it('accepts the effective inherited stop config and rejects missing metadata', () => {
    expect(
      supportsStopConfirmation({
        config: { stop: null },
        relationships: { config: { attributes: { stop: 'end' } } },
      }),
    ).toBe(true);
    expect(supportsStopConfirmation({})).toBe(false);
  });
  it('does not infer terminal stop from offline alone', async () => {
    const f = fixture();
    f.adapter.power.mockImplementation(async () => {
      f.emit('offline');
    });
    expect(await stopWithConfirmation(f.adapter, 1, 'fixture', f.options, 10, f.observer)).toEqual({
      confirmed: false,
    });
    expect(f.options.onConfirmed).not.toHaveBeenCalled();
  });
  it('does not combine disconnected or interrupted transitions', async () => {
    const f = fixture();
    f.adapter.power.mockImplementation(async () => {
      f.emit('stopping');
      f.emit('running');
      f.emit('offline');
    });
    expect(await stopWithConfirmation(f.adapter, 1, 'fixture', f.options, 10, f.observer)).toEqual({
      confirmed: false,
    });
  });
  it('reconciles lost power acknowledgement only with new terminal proof', async () => {
    const f = fixture();
    f.adapter.power.mockImplementation(async () => {
      f.emit('stopping');
      f.emit('offline');
      throw new PterodactylError('unavailable', 'client', 'unknown');
    });
    expect(await stopWithConfirmation(f.adapter, 1, 'fixture', f.options, 20, f.observer)).toEqual({
      confirmed: true,
    });
  });
  it('never claims confirmation when durable proof persistence fails', async () => {
    const f = fixture();
    f.options.onConfirmed.mockRejectedValue(new Error('isolated persistence failure'));
    await expect(
      stopWithConfirmation(f.adapter, 1, 'fixture', f.options, 20, f.observer),
    ).rejects.toThrow('isolated persistence failure');
  });
});
