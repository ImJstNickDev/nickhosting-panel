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
          id: 1,
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
  it('starts independent stop prerequisites together and waits for all before power', async () => {
    const f = fixture();
    const observerGate = Promise.withResolvers<void>();
    const relayGate = Promise.withResolvers<void>();
    const observerStarted = Promise.withResolvers<void>();
    const relayStarted = Promise.withResolvers<void>();
    const openRelay = f.adapter.relayConsole.getMockImplementation();
    if (!openRelay) throw new Error('Missing fixture relay');
    f.observer.preflight.mockImplementation(async () => {
      observerStarted.resolve();
      await observerGate.promise;
    });
    f.adapter.relayConsole.mockImplementation(async (id, options) => {
      relayStarted.resolve();
      await relayGate.promise;
      return openRelay(id, options);
    });
    const beforePower = vi.fn(async () => {});
    const result = stopWithConfirmation(
      f.adapter,
      1,
      'fixture',
      { ...f.options, beforePower },
      1000,
      f.observer,
    );
    await Promise.all([observerStarted.promise, relayStarted.promise]);
    expect(f.adapter.power).not.toHaveBeenCalled();
    observerGate.resolve();
    expect(beforePower).not.toHaveBeenCalled();
    relayGate.resolve();
    await expect(result).resolves.toEqual({ confirmed: true });
    expect(beforePower).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('closes a late-opened relay after an independent preparation failure', async () => {
    const f = fixture();
    const relayGate = Promise.withResolvers<void>();
    const relayStarted = Promise.withResolvers<void>();
    const openRelay = f.adapter.relayConsole.getMockImplementation();
    if (!openRelay) throw new Error('Missing fixture relay');
    f.observer.preflight.mockRejectedValue(new Error('observer unavailable'));
    f.adapter.relayConsole.mockImplementation(async (id, options) => {
      relayStarted.resolve();
      await relayGate.promise;
      return openRelay(id, options);
    });
    const beforePower = vi.fn(async () => {});
    const result = stopWithConfirmation(
      f.adapter,
      1,
      'fixture',
      { ...f.options, beforePower },
      1000,
      f.observer,
    );
    const rejected = expect(result).rejects.toThrow('observer unavailable');
    await relayStarted.promise;
    expect(f.adapter.power).not.toHaveBeenCalled();
    relayGate.resolve();
    await rejected;
    expect(beforePower).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.options.onConfirmed).not.toHaveBeenCalled();
  });
  it('does not send power after console preparation fails', async () => {
    const f = fixture();
    f.adapter.relayConsole.mockRejectedValue(new Error('console unavailable'));
    await expect(
      stopWithConfirmation(f.adapter, 1, 'fixture', f.options, 20, f.observer),
    ).rejects.toThrow('console unavailable');
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(f.options.onConfirmed).not.toHaveBeenCalled();
  });
  it('does not send power if the console closes during final authorization', async () => {
    const f = fixture();
    await expect(
      stopWithConfirmation(
        f.adapter,
        1,
        'fixture',
        {
          ...f.options,
          beforePower: async () => {
            const options = f.adapter.relayConsole.mock.calls[0]?.[1];
            if (!options) throw new Error('Missing fixture relay options');
            options.onEvent({ type: 'closed' });
          },
        },
        20,
        f.observer,
      ),
    ).rejects.toMatchObject({ outcome: 'rejected' });
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('reuses only the supplied attempt identity and keeps phase logging non-authoritative', async () => {
    const f = fixture();
    const verifiedServer = await f.adapter.getApplicationServer();
    f.adapter.getApplicationServer.mockClear();
    const stages: string[] = [];
    expect(
      await stopWithConfirmation(
        f.adapter,
        1,
        'fixture',
        {
          ...f.options,
          verifiedServer,
          onStage: (stage) => {
            stages.push(stage);
            throw new Error('private-log-failure');
          },
        },
        20,
        f.observer,
      ),
    ).toEqual({ confirmed: true });
    expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
    expect(f.adapter.getEgg).not.toHaveBeenCalled();
    expect(f.adapter.relayConsole).toHaveBeenCalledWith(
      'fixture',
      expect.any(Object),
      verifiedServer.uuid,
    );
    expect(stages).toContain('console_session');
    expect(stages).toContain('power_request');
    expect(stages).toContain('terminal_confirmation');
  });
  it.each([{ id: 2 }, { identifier: 'foreign' }])(
    'rejects a mismatched shared stop identity %j',
    async (patch) => {
      const f = fixture();
      const verifiedServer = { ...(await f.adapter.getApplicationServer()), ...patch };
      await expect(
        stopWithConfirmation(
          f.adapter,
          1,
          'fixture',
          { ...f.options, verifiedServer },
          20,
          f.observer,
        ),
      ).rejects.toMatchObject({ outcome: 'rejected' });
      expect(f.adapter.power).not.toHaveBeenCalled();
      expect(f.adapter.relayConsole).not.toHaveBeenCalled();
    },
  );
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
  it.each(['end', 'stop', '^C', '^c', '^SIGTERM', '^SIGINT', '^KILL', ''])(
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
    'does not infer completion from stop delivery for egg mode %s',
    async (stop) => {
      const f = fixture(stop);
      f.adapter.power.mockImplementation(async () => {
        f.emit('stopping');
        f.emit('running');
      });
      await expect(
        stopWithConfirmation(f.adapter, 1, 'fixture', f.options, 10, f.observer),
      ).resolves.toEqual({ confirmed: false });
      expect(f.adapter.getEgg).not.toHaveBeenCalled();
      expect(f.adapter.power).toHaveBeenCalledTimes(1);
      expect(f.observer.stopped).not.toHaveBeenCalled();
      expect(f.options.onConfirmed).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledTimes(1);
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

describe('cooperative stop escalation', () => {
  it('waits for the stop response, serializes callbacks and drains before confirming', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const power = Promise.withResolvers<void>();
      const work = Promise.withResolvers<void>();
      f.adapter.power.mockImplementation(async () => {
        f.emit('stopping');
        await power.promise;
      });
      const onStoppingWait = vi.fn(async () => work.promise);
      const result = stopWithConfirmation(
        f.adapter,
        1,
        'fixture',
        { ...f.options, onStoppingWait },
        10000,
        f.observer,
      );
      await vi.advanceTimersByTimeAsync(1500);
      expect(onStoppingWait).not.toHaveBeenCalled();
      power.resolve();
      await vi.advanceTimersByTimeAsync(500);
      expect(onStoppingWait).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(onStoppingWait).toHaveBeenCalledTimes(1);
      f.emit('offline');
      await vi.advanceTimersByTimeAsync(0);
      expect(f.options.onConfirmed).not.toHaveBeenCalled();
      work.resolve();
      await expect(result).resolves.toEqual({ confirmed: true });
      await vi.advanceTimersByTimeAsync(10000);
      expect(onStoppingWait).toHaveBeenCalledTimes(1);
      expect(f.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('drains even when a callback synchronously reports offline before its work finishes', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const work = Promise.withResolvers<void>();
      f.adapter.power.mockImplementation(async () => {
        f.emit('stopping');
      });
      const result = stopWithConfirmation(
        f.adapter,
        1,
        'fixture',
        {
          ...f.options,
          onStoppingWait: async () => {
            f.emit('offline');
            await work.promise;
          },
        },
        2000,
        f.observer,
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(f.observer.stopped).not.toHaveBeenCalled();
      work.resolve();
      await expect(result).resolves.toEqual({ confirmed: true });
      expect(f.options.onConfirmed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['running', 'offline'] as const)('does not escalate a %s server', async (state) => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.adapter.power.mockImplementation(async () => {
        f.emit(state);
      });
      const onStoppingWait = vi.fn(async () => {});
      const result = stopWithConfirmation(
        f.adapter,
        1,
        'fixture',
        { ...f.options, onStoppingWait },
        2000,
        f.observer,
      );
      await vi.advanceTimersByTimeAsync(2000);
      await expect(result).resolves.toEqual({ confirmed: false });
      expect(onStoppingWait).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('continues after unknown power response and callback failures without losing stop proof', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.adapter.power.mockImplementation(async () => {
        f.emit('stopping');
        throw new PterodactylError('unavailable', 'client', 'unknown');
      });
      const onStoppingWait = vi.fn(async () => {
        throw new Error('journal unavailable');
      });
      const result = stopWithConfirmation(
        f.adapter,
        1,
        'fixture',
        { ...f.options, onStoppingWait },
        3000,
        f.observer,
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(onStoppingWait).toHaveBeenCalledTimes(2);
      f.emit('offline');
      await expect(result).resolves.toEqual({ confirmed: true });
      await vi.advanceTimersByTimeAsync(3000);
      expect(onStoppingWait).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not run callbacks after a rejected stop', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.adapter.power.mockImplementation(async () => {
        f.emit('stopping');
        throw new PterodactylError('permission_denied', 'client', 'rejected');
      });
      const onStoppingWait = vi.fn(async () => {});
      const result = stopWithConfirmation(
        f.adapter,
        1,
        'fixture',
        { ...f.options, onStoppingWait },
        3000,
        f.observer,
      );
      await expect(result).rejects.toMatchObject({ outcome: 'rejected' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(onStoppingWait).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['timeout', 'closed'] as const)(
    'drains active callbacks on %s and never schedules late work',
    async (end) => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const work = Promise.withResolvers<void>();
        f.adapter.power.mockImplementation(async () => {
          f.emit('stopping');
        });
        const onStoppingWait = vi.fn(async () => work.promise);
        let settled = false;
        const result = stopWithConfirmation(
          f.adapter,
          1,
          'fixture',
          { ...f.options, onStoppingWait },
          2000,
          f.observer,
        ).then((value) => {
          settled = true;
          return value;
        });
        await vi.advanceTimersByTimeAsync(500);
        expect(onStoppingWait).toHaveBeenCalledTimes(1);
        if (end === 'closed') f.adapter.relayConsole.mock.calls[0]?.[1].onEvent({ type: 'closed' });
        await vi.advanceTimersByTimeAsync(2000);
        expect(settled).toBe(false);
        work.resolve();
        await expect(result).resolves.toEqual({ confirmed: false });
        await vi.advanceTimersByTimeAsync(2000);
        expect(onStoppingWait).toHaveBeenCalledTimes(1);
        expect(f.options.onConfirmed).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe('stop escalation final stream fence', () => {
  it.each(['offline', 'running', 'closed', 'timeout'] as const)(
    'invalidates a pending callback when the stream becomes %s',
    async (end) => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        f.adapter.power.mockImplementation(async () => {
          f.emit('stopping');
        });
        const gate = Promise.withResolvers<void>();
        let stillStopping: (() => boolean) | undefined;
        const result = stopWithConfirmation(
          f.adapter,
          1,
          'fixture',
          {
            ...f.options,
            onStoppingWait: async (guard) => {
              stillStopping = guard;
              await gate.promise;
            },
          },
          2000,
          f.observer,
        );
        await vi.advanceTimersByTimeAsync(500);
        expect(stillStopping?.()).toBe(true);
        if (end === 'timeout') await vi.advanceTimersByTimeAsync(2000);
        else if (end === 'closed')
          f.adapter.relayConsole.mock.calls[0]?.[1].onEvent({ type: 'closed' });
        else f.emit(end);
        expect(stillStopping?.()).toBe(false);
        gate.resolve();
        await vi.advanceTimersByTimeAsync(2500);
        await result;
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
