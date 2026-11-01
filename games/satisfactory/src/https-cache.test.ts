import { expect, it } from 'vitest';
import { SatisfactoryHttpsCache, satisfactoryPlayerCredential } from './https-cache.js';

const authorization = `Bearer ${Buffer.from(JSON.stringify({ pl: 'Client' })).toString('base64')}.${'ab'.repeat(64)}`;
it('persists only credential hashes and read envelopes, scoped by player where available', () => {
  const cache = new SatisfactoryHttpsCache(() => 1000);
  cache.remember('QueryServerState', authorization, '060102', '{"data":{"serverGameState":{}}}');
  expect(cache.authorize(authorization, '060102')).toBe(true);
  expect(cache.authorize(authorization, '060103')).toBe(false);
  expect(JSON.stringify(cache.snapshot())).not.toContain(authorization.slice(7));
  cache.remember('JoinGameRequest', authorization, '060102', '{"data":{"encryptionKey":"secret"}}');
  expect(JSON.stringify(cache.snapshot())).not.toContain('secret');
  const restored = new SatisfactoryHttpsCache(() => 2000);
  restored.restore(cache.snapshot());
  expect(restored.authorize(authorization, '060102')).toBe(true);
});
it('expires authorization without extending it on read or restore', () => {
  let now = 0;
  const cache = new SatisfactoryHttpsCache(() => now);
  cache.remember('QueryServerState', authorization, undefined, '{"data":{"serverGameState":{}}}');
  expect(cache.authorize(authorization, '060102')).toBe(true);
  now = 300001;
  expect(cache.authorize(authorization, undefined)).toBe(false);
  expect(cache.snapshot()).toEqual([]);
});
it('retains each function observation time when another response refreshes the entry', () => {
  let now = 1000;
  const cache = new SatisfactoryHttpsCache(() => now);
  cache.remember('QueryServerState', authorization, undefined, '{"data":{"serverGameState":{}}}');
  now = 2000;
  cache.remember('GetServerOptions', authorization, undefined, '{"data":{"serverOptions":{}}}');
  expect(cache.snapshot()[0]?.observedAt).toEqual({
    QueryServerState: 1000,
    GetServerOptions: 2000,
  });
  const restored = new SatisfactoryHttpsCache(() => now);
  restored.restore(cache.snapshot());
  now = 3000;
  restored.remember('GetServerOptions', authorization, undefined, '{"data":{"serverOptions":{}}}');
  expect(restored.snapshot()[0]?.observedAt).toEqual({
    QueryServerState: 1000,
    GetServerOptions: 3000,
  });
  expect(restored.snapshot()[0]?.expiresAt).toBe(303000);
  const detached = restored.snapshot();
  const observedAt = detached[0]?.observedAt;
  if (!observedAt) throw new Error('Missing fixture observation times');
  observedAt.QueryServerState = 3000;
  expect(restored.snapshot()[0]?.observedAt?.QueryServerState).toBe(1000);
});
it('restores legacy entries and preserves their inferred age on the first refresh', () => {
  let now = 1000;
  const original = new SatisfactoryHttpsCache(() => now);
  original.remember(
    'QueryServerState',
    authorization,
    undefined,
    '{"data":{"serverGameState":{}}}',
  );
  const legacy = original.snapshot().map(({ observedAt: _observedAt, ...entry }) => entry);
  now = 2000;
  const cache = new SatisfactoryHttpsCache(() => now);
  cache.restore(legacy);
  expect(cache.snapshot()[0]?.observedAt).toBeUndefined();
  expect(cache.read('QueryServerState', authorization, undefined)).toBeDefined();
  now = 3000;
  cache.remember('GetServerOptions', authorization, undefined, '{"data":{"serverOptions":{}}}');
  expect(cache.snapshot()[0]?.observedAt).toEqual({
    QueryServerState: 1000,
    GetServerOptions: 3000,
  });
});
it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  'rejects nonfinite per-function observation times: %s',
  (observedAt) => {
    const original = new SatisfactoryHttpsCache(() => 1000);
    original.remember('QueryServerState', authorization, undefined, '{"data":{}}');
    const snapshot = original.snapshot();
    const entry = snapshot[0];
    if (!entry) throw new Error('Missing fixture entry');
    entry.observedAt = { QueryServerState: observedAt };
    const restored = new SatisfactoryHttpsCache(() => 2000);
    expect(() => restored.restore(snapshot)).toThrow();
    expect(restored.snapshot()).toEqual([]);
  },
);
it.each([{ QueryServerState: 2001 }, { JoinGameRequest: 1000 }, { GetServerOptions: 1000 }])(
  'rejects future or unmatched observation timestamps',
  (observedAt) => {
    const original = new SatisfactoryHttpsCache(() => 1000);
    original.remember('QueryServerState', authorization, undefined, '{"data":{}}');
    const snapshot = original.snapshot().map((entry) => ({ ...entry, observedAt }));
    const restored = new SatisfactoryHttpsCache(() => 2000);
    restored.restore(snapshot);
    expect(restored.snapshot()).toEqual([]);
  },
);
it('does not authenticate rejected responses, application tokens cannot request game wake', () => {
  const cache = new SatisfactoryHttpsCache();
  cache.remember('QueryServerState', authorization, undefined, '{"errorCode":"not_authorized"}');
  expect(cache.authorize(authorization, undefined)).toBe(false);
  expect(satisfactoryPlayerCredential(authorization)).toBe(true);
  expect(
    satisfactoryPlayerCredential(
      `Bearer ${Buffer.from('{"pl":"APIToken"}').toString('base64')}.${'ab'.repeat(64)}`,
    ),
  ).toBe(false);
});

it.each([
  undefined,
  'Bearer invalid',
  `Bearer ${Buffer.from('{"pl":"Client"}').toString('base64')}.abcd`,
  `${authorization}.extra`,
  authorization.replace('Bearer ', 'Basic '),
  authorization.replace('.', '!.'),
  `Bearer ${Buffer.from('{"pl":"InitialAdmin"}').toString('base64')}.${'ab'.repeat(64)}`,
  `Bearer ${Buffer.from('{"pl":"APIToken"}').toString('base64')}.${'ab'.repeat(64)}`,
  `Bearer ${Buffer.from('null').toString('base64')}.${'ab'.repeat(64)}`,
  `Bearer ${Buffer.from('{"pl":"Client"}').toString('base64')}.${'zz'.repeat(64)}`,
])('rejects malformed or non-player credential syntax: %s', (value) => {
  expect(satisfactoryPlayerCredential(value)).toBe(false);
});

it('accepts canonical player token syntax without claiming fingerprint validity', () => {
  const administrator = `Bearer ${Buffer.from('{"pl":"Administrator"}').toString('base64')}.${'00'.repeat(64)}`;
  expect(satisfactoryPlayerCredential(authorization)).toBe(true);
  expect(satisfactoryPlayerCredential(administrator)).toBe(true);
  expect(satisfactoryPlayerCredential(administrator.replace(/=+\./, '.'))).toBe(true);
});
it('rejecting one credential cannot erase another client snapshot', () => {
  const cache = new SatisfactoryHttpsCache();
  cache.remember('QueryServerState', 'Bearer first', undefined, '{"data":{"session":"one"}}');
  cache.remember('QueryServerState', 'Bearer second', undefined, '{"data":{"session":"two"}}');
  cache.reject('Bearer first', undefined);
  expect(cache.read('QueryServerState', 'Bearer first', undefined)).toBeUndefined();
  expect(cache.read('QueryServerState', 'Bearer second', undefined)).toContain('two');
});

it('rejects all player variants including a token-only fallback', () => {
  const cache = new SatisfactoryHttpsCache();
  cache.remember('QueryServerState', 'Bearer same', undefined, '{"data":{}}');
  cache.remember('QueryServerState', 'Bearer same', '060102', '{"data":{}}');
  cache.reject('Bearer same', '060103');
  expect(cache.authorize('Bearer same', '060102')).toBe(false);
  expect(cache.authorize('Bearer same', '060103')).toBe(false);
});
