import { expect, it } from 'vitest';
import { mergeOfflineSnapshots, readOfflineSnapshots } from './offline-snapshots.js';

const options = { data: { serverOptions: { Visible: 'yes' }, pendingServerOptions: {} } };
const cache = (body: unknown, observedAt: number, operation = 'GetServerOptions') => [
  {
    key: 'a'.repeat(64),
    tokenKey: 'b'.repeat(64),
    expiresAt: observedAt + 300000,
    responses: { [operation]: JSON.stringify(body) },
  },
];
it('retains genuine read observations beyond bearer cache expiry, without token authority', () => {
  const old = mergeOfflineSnapshots({}, cache(options, 10000));
  expect(old).toEqual({ GetServerOptions: { observedAt: 10000, body: options } });
  expect(mergeOfflineSnapshots(old, [])).toEqual(old);
  expect(mergeOfflineSnapshots(old, cache({ errorCode: 'invalid_token' }, 20000))).toEqual(old);
  expect(JSON.stringify(old)).not.toContain('tokenKey');
});
it('selects newest schema-valid global Client observations and strips unrelated data', () => {
  const old = mergeOfflineSnapshots({}, cache(options, 10000));
  const next = {
    data: { serverOptions: {}, pendingServerOptions: {}, secret: 'not-native-schema' },
    extra: 'private',
  };
  expect(mergeOfflineSnapshots(old, cache(next, 20000))).toEqual({
    GetServerOptions: {
      observedAt: 20000,
      body: { data: { serverOptions: {}, pendingServerOptions: {} } },
    },
  });
  expect(mergeOfflineSnapshots(old, cache(next, 5000))).toEqual(old);
  expect(mergeOfflineSnapshots({}, cache(options, Date.now() + 60000))).toEqual({});
  expect(mergeOfflineSnapshots({}, cache(options, 20000, 'EnumerateSessions'))).toEqual({});
  expect(
    readOfflineSnapshots({
      QueryServerState: { observedAt: 1, body: { data: { serverGameState: {} } } },
    }),
  ).toEqual({});
});
it('uses the response observation time instead of another function refreshing its bearer entry', () => {
  const old = mergeOfflineSnapshots({}, cache(options, 20000));
  const entry = cache(
    { data: { serverOptions: { Older: 'yes' }, pendingServerOptions: {} } },
    30000,
  )[0];
  expect(
    mergeOfflineSnapshots(old, [{ ...entry, observedAt: { GetServerOptions: 10000 } }]),
  ).toEqual(old);
});
