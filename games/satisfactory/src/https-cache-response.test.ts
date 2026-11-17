import { deflateSync, gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { captureSatisfactoryResponseBody } from './https-cache-response.js';
import { satisfactoryEnumerationMaxBytes } from './response-limits.js';

it('captures large enumeration only, with bounded decompression', async () => {
  const text = JSON.stringify({ data: { sessions: [], padding: 'x'.repeat(128 * 1024) } });
  for (const [bytes, encoding] of [
    [Buffer.from(text), 'identity'],
    [gzipSync(text), 'gzip'],
  ] as const) {
    expect(await captureSatisfactoryResponseBody(bytes, encoding, 'EnumerateSessions')).toBe(text);
    expect(
      await captureSatisfactoryResponseBody(bytes, encoding, 'QueryServerState'),
    ).toBeUndefined();
  }
  expect(
    await captureSatisfactoryResponseBody(
      gzipSync(Buffer.alloc(satisfactoryEnumerationMaxBytes + 1)),
      'gzip',
      'EnumerateSessions',
    ),
  ).toBeUndefined();
});

it('captures unchanged UTF8 native responses using identity, gzip and deflate', async () => {
  const text = JSON.stringify({
    data: { sessions: [{ sessionName: 'Fabbrica è 🔧' }], currentSessionIndex: 0 },
  });
  const bytes = Buffer.from(text);
  for (const [body, encoding] of [
    [bytes, undefined],
    [bytes, 'identity'],
    [gzipSync(bytes), 'gzip'],
    [deflateSync(bytes), 'deflate'],
  ] as const)
    expect(await captureSatisfactoryResponseBody(body, encoding)).toBe(text);
});
it('rejects truncated compression, unsupported codecs, expansion bombs and malformed UTF8', async () => {
  expect(
    await captureSatisfactoryResponseBody(gzipSync(Buffer.alloc(65537)), 'gzip'),
  ).toBeUndefined();
  expect(
    await captureSatisfactoryResponseBody(deflateSync(Buffer.alloc(65537)), 'deflate'),
  ).toBeUndefined();
  expect(await captureSatisfactoryResponseBody(Buffer.alloc(262145), 'identity')).toBeUndefined();
  expect(
    await captureSatisfactoryResponseBody(gzipSync(Buffer.from('ok')).subarray(0, 8), 'gzip'),
  ).toBeUndefined();
  expect(
    await captureSatisfactoryResponseBody(Buffer.from('ok'), 'gzip, identity'),
  ).toBeUndefined();
  expect(await captureSatisfactoryResponseBody(Buffer.from([0xff]), undefined)).toBeUndefined();
});
