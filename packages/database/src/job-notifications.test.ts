import { EventEmitter } from 'node:events';
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenForGatewayChanges, listenForJobOutbox } from './job-notifications.js';

afterEach(() => vi.useRealTimers());
describe('bounded optional outbox listener', () => {
  it('discards a connection that arrives after setup timed out', async () => {
    vi.useFakeTimers();
    let releaseConnection!: (client: PoolClient) => void;
    const connect = new Promise<PoolClient>((resolve) => {
      releaseConnection = resolve;
    });
    const pending = listenForJobOutbox({ connect: () => connect }, vi.fn(), vi.fn());
    const rejected = expect(pending).rejects.toThrow('expired');
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    const release = vi.fn();
    const query = vi.fn();
    releaseConnection({ release, query } as unknown as PoolClient);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledWith(true);
    expect(query).not.toHaveBeenCalled();
  });
  it('destroys an acquired client when LISTEN hangs, without leaving a listener in the pool', async () => {
    vi.useFakeTimers();
    const client = Object.assign(new EventEmitter(), {
      release: vi.fn(),
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ channel: `nh_jobs_${'a'.repeat(32)}` }] })
        .mockImplementationOnce(() => new Promise(() => {})),
    });
    const pending = listenForJobOutbox(
      { connect: async () => client as unknown as PoolClient },
      vi.fn(),
      vi.fn(),
    );
    const rejected = expect(pending).rejects.toThrow('expired');
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.listenerCount('notification')).toBe(0);
  });
});

describe('schema-scoped Gateway commit hints', () => {
  it('uses a separate channel and only dispatches matching notification hints', async () => {
    const channel = `nh_gateway_${'b'.repeat(32)}`;
    const client = Object.assign(new EventEmitter(), {
      release: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows: [{ channel }] }),
    });
    const wake = vi.fn(),
      lost = vi.fn();
    const subscription = await listenForGatewayChanges(
      { connect: async () => client as unknown as PoolClient },
      wake,
      lost,
    );
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      "select 'nh_gateway_' || md5(current_database() || ':' || current_schema()) as channel",
    );
    expect(client.query).toHaveBeenNthCalledWith(2, `LISTEN "${channel}"`);
    client.emit('notification', { channel: `nh_jobs_${'b'.repeat(32)}` });
    expect(wake).not.toHaveBeenCalled();
    client.emit('notification', { channel });
    expect(wake).toHaveBeenCalledOnce();
    client.emit('error', new Error('lost'));
    expect(lost).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(true);
    subscription.close();
    expect(client.release).toHaveBeenCalledOnce();
  });
});
