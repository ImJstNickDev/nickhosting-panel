import { deflateSync, gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { captureSatisfactoryResponseBody } from './https-cache-response.js';

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
