import { expect, it } from 'vitest';
import { SatisfactoryHttpsCache, satisfactoryPlayerCredential } from './https-cache.js';

const authorization = `Bearer ${Buffer.from(JSON.stringify({ pl: 'Client' })).toString('base64')}.abcd`;
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
it('does not authenticate rejected responses, application tokens cannot request game wake', () => {
  const cache = new SatisfactoryHttpsCache();
  cache.remember('QueryServerState', authorization, undefined, '{"errorCode":"not_authorized"}');
  expect(cache.authorize(authorization, undefined)).toBe(false);
  expect(satisfactoryPlayerCredential(authorization)).toBe(true);
  expect(
    satisfactoryPlayerCredential(
      `Bearer ${Buffer.from('{"pl":"APIToken"}').toString('base64')}.abcd`,
    ),
  ).toBe(false);
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
