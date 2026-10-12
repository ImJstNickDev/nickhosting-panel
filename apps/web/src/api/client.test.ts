import { afterEach, expect, it, vi } from 'vitest';
import { apiError, consumeEvents, download, readText, safeApiPath } from './client.js';

afterEach(() => vi.unstubAllGlobals());
it('submits a large native POST download and removes its temporary form without fetching ZIP bytes', () => {
  const form = { append: vi.fn(), remove: vi.fn() };
  const append = vi.fn();
  const submit = vi.fn(function (this: unknown) {
    expect(this).toBe(form);
    expect(append).toHaveBeenCalledWith(form);
  });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('HTMLFormElement', { prototype: { submit } });
  vi.stubGlobal('document', {
    createElement: vi.fn((tag) => (tag === 'form' ? form : {})),
    body: { append },
  });
  const fields = {
    root: 'worlds',
    files: JSON.stringify(Array.from({ length: 512 }, (_, index) => `${index}-città.txt`)),
  };
  download('/v1/servers/test/files/archive', fields);
  expect(form).toMatchObject({
    action: '/v1/servers/test/files/archive',
    method: 'POST',
    enctype: 'application/x-www-form-urlencoded',
    acceptCharset: 'UTF-8',
    target: '_blank',
    rel: 'noopener',
    hidden: true,
  });
  expect(form.append.mock.calls).toEqual([
    [{ type: 'hidden', name: 'root', value: fields.root }],
    [{ type: 'hidden', name: 'files', value: fields.files }],
  ]);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(form.remove).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
  expect(() => download('https://provider.invalid/archive', fields)).toThrow('invalid_api_path');
  expect(submit).toHaveBeenCalledTimes(1);
});
function response(chunks: string[], type = 'text/event-stream') {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
              controller.close();
            },
          }),
          { headers: { 'Content-Type': type } },
        ),
    ),
  );
}
it('parses console events split across CRLF boundaries without dropping or joining messages', async () => {
  response([
    'event: console\r',
    '\ndata: {"data":"one"}\r',
    '\n\r',
    '\nevent: console\r\ndata: {"data":"two"}\r\n\r\n',
  ]);
  const events: unknown[] = [];
  await consumeEvents('/v1/servers/test/console', {
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(events).toEqual([
    { type: 'console', data: '{"data":"one"}', id: undefined },
    { type: 'console', data: '{"data":"two"}', id: undefined },
  ]);
});
it('bounds incomplete console frames and text editing, while leaving binary transfers separate', async () => {
  response(['data: ' + 'x'.repeat(262145)]);
  await expect(
    consumeEvents('/v1/servers/test/console', {
      signal: new AbortController().signal,
      onEvent: () => {
        throw new Error('Unexpected unbounded frame');
      },
    }),
  ).rejects.toThrow();
  response(['x'.repeat(60001)], 'text/plain');
  await expect(readText('/v1/servers/test/files/content')).rejects.toMatchObject({
    code: 'text_too_large',
  });
  response(['abc\0def'], 'text/plain');
  await expect(readText('/v1/servers/test/files/content')).rejects.toMatchObject({
    code: 'text_too_large',
  });
});
it('rejects non-API destinations and maps authentication failures without provider prose', () => {
  for (const path of [
    'https://provider.invalid/files',
    '//provider.invalid',
    '/v1/\\x',
    '/api/auth/\rtest',
  ])
    expect(() => safeApiPath(path)).toThrow();
  expect(
    apiError({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'private provider detail' }).messageKey,
  ).toBe('auth.invalid_credentials');
  expect(apiError({ error: { code: 'TOO_MANY_REQUESTS' } }).messageKey).toBe('errors.rate_limited');
});
