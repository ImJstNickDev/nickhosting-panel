import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { createServerEventStream } from './server-events-stream.js';

const channel = `nh_server_events_${'a'.repeat(32)}`;
function fixture() {
  const connection = Object.assign(new EventEmitter(), {
    query: vi.fn(async () => ({ rows: [{ channel }] })),
    release: vi.fn(),
  });
  const connect = vi.fn(async () => connection as unknown as PoolClient);
  const stream = createServerEventStream({ connect } as unknown as Pick<Pool, 'connect'>);
  return { stream, connection, connect };
}
it('shares one listener and wakes only subscribers for the notified server', async () => {
  const { stream, connection, connect } = fixture();
  const first = vi.fn(),
    second = vi.fn(),
    other = vi.fn();
  const [releaseFirst, releaseSecond, releaseOther] = await Promise.all([
    stream.subscribe('server', first, vi.fn()),
    stream.subscribe('server', second, vi.fn()),
    stream.subscribe('other', other, vi.fn()),
  ]);
  expect(connect).toHaveBeenCalledTimes(1);
  connection.emit('notification', { channel: 'unrelated', payload: 'server' });
  expect(first).not.toHaveBeenCalled();
  connection.emit('notification', { channel, payload: 'server' });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(other).not.toHaveBeenCalled();
  releaseFirst();
  releaseSecond();
  expect(connection.release).not.toHaveBeenCalled();
  releaseOther();
  expect(connection.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(connection.listenerCount('notification')).toBe(0);
});
it('ends subscriptions after listener failure and discards the LISTEN connection', async () => {
  const { stream, connection } = fixture();
  const changed = vi.fn(),
    lost = vi.fn();
  const release = await stream.subscribe('server', changed, lost);
  connection.emit('error', new Error('connection lost'));
  expect(lost).toHaveBeenCalledTimes(1);
  expect(connection.release).toHaveBeenCalledExactlyOnceWith(true);
  connection.emit('notification', { channel, payload: 'server' });
  expect(changed).not.toHaveBeenCalled();
  release();
  expect(connection.release).toHaveBeenCalledTimes(1);
});
it('cleans up a rejected LISTEN setup', async () => {
  const { stream, connection } = fixture();
  connection.query.mockRejectedValueOnce(new Error('unavailable'));
  await expect(stream.subscribe('server', vi.fn(), vi.fn())).rejects.toThrow('unavailable');
  expect(connection.release).toHaveBeenCalledExactlyOnceWith(true);
});
