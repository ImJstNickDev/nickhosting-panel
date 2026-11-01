import { afterEach, expect, it, vi } from 'vitest';
import { api, apiError, consumeEvents, download, readText, safeApiPath, upload } from './client.js';

afterEach(() => vi.unstubAllGlobals());
it.each([
  {
    status: 200,
    body: '{"id":"source","state":"ready"}',
    expected: { id: 'source', state: 'ready' },
  },
  { status: 204, body: '', expected: undefined },
])(
  'preserves acknowledged upload metadata for HTTP $status',
  async ({ status, body, expected }) => {
    const send = vi.fn();
    vi.stubGlobal(
      'XMLHttpRequest',
      class {
        status = status;
        responseText = body;
        upload = {};
        withCredentials = false;
        onload?: () => void;
        open = vi.fn();
        setRequestHeader = vi.fn();
        send(file: Blob) {
          send(file);
          this.onload?.();
        }
      },
    );
    const file = new Blob(['original bytes']);
    await expect(upload('/v1/minecraft/sources/source/upload', file)).resolves.toEqual(expected);
    expect(send).toHaveBeenCalledExactlyOnceWith(file);
  },
);
it('rejects a malformed successful upload response instead of claiming a ready source', async () => {
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      status = 200;
      responseText = '<html>unexpected proxy response</html>';
      upload = {};
      withCredentials = false;
      onload?: () => void;
      open = vi.fn();
      setRequestHeader = vi.fn();
      send() {
        this.onload?.();
      }
    },
  );
  await expect(
    upload('/v1/minecraft/sources/source/upload', new Blob(['bytes'])),
  ).rejects.toMatchObject({ status: 200 });
});
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
  response([`data: ${'x'.repeat(262145)}`]);
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
it('accepts bounded large provisioning transcripts while preserving the default console cap', async () => {
  const data = JSON.stringify({
    provisioning: {
      logs: Array.from({ length: 32 }, (_, id) => ({
        id: String(id),
        at: '2026-10-19T17:00:00Z',
        text: 'x'.repeat(8192),
      })),
    },
  });
  expect(data.length).toBeGreaterThan(262144);
  const frame = `event: provisioning\ndata: ${data}\n\n`;
  const events: Array<{ type: string; data: string }> = [];
  response([frame.slice(0, 200000), frame.slice(200000)]);
  await consumeEvents('/v1/servers/test/provisioning/stream', {
    signal: new AbortController().signal,
    maxFrameCharacters: 1048576,
    onEvent: (event) => events.push(event),
  });
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]?.data ?? '{}').provisioning.logs).toHaveLength(32);
  response([frame]);
  await expect(
    consumeEvents('/v1/servers/test/console', {
      signal: new AbortController().signal,
      onEvent: () => {},
    }),
  ).rejects.toThrow();
});
it('bounds individual SSE frames, not a network chunk containing several valid frames', async () => {
  const frame = `data: ${'x'.repeat(200000)}\n\n`;
  response([frame + frame]);
  const onEvent = vi.fn();
  await consumeEvents('/v1/servers/test/console', {
    signal: new AbortController().signal,
    onEvent,
  });
  expect(onEvent).toHaveBeenCalledTimes(2);
});
it.each([false, true])(
  'rejects oversized provisioning frames (terminated: %s) and cancels reading',
  async (terminated) => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${'x'.repeat(1048576)}${terminated ? '\n\n' : ''}`,
                  ),
                );
              },
              cancel,
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ),
    );
    const onEvent = vi.fn();
    await expect(
      consumeEvents('/v1/servers/test/provisioning/stream', {
        signal: new AbortController().signal,
        maxFrameCharacters: 1048576,
        onEvent,
      }),
    ).rejects.toThrow();
    expect(onEvent).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  },
);
it.each([0, -1, 1048577, Infinity, NaN])(
  'rejects unsafe SSE limits: %s',
  async (maxFrameCharacters) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      consumeEvents('/v1/servers/test/provisioning/stream', {
        signal: new AbortController().signal,
        maxFrameCharacters,
        onEvent: () => {},
      }),
    ).rejects.toThrow('invalid_event_frame_limit');
    expect(fetch).not.toHaveBeenCalled();
  },
);
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
  expect(apiError({ code: 'SESSION_NOT_FRESH' }).messageKey).toBe('auth.step_up_required');
  expect(apiError({ error: { messageKey: 'auth.step_up_required' } }).messageKey).toBe(
    'auth.step_up_required',
  );
});

it('observes debug response timing only after body consumption', async () => {
  const observer = vi.fn();
  let finish!: () => void;
  const body = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const json = vi.fn(async () => {
    await body;
    return { completed: 1 };
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json,
      headers: new Headers({
        'Server-Timing': 'nh-file;dur=123.45',
        'X-Request-ID': 'fixture-request',
      }),
    })),
  );
  const pending = api('/v1/servers/test/files/copy', { method: 'POST', onDebugTiming: observer });
  await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
  expect(observer).not.toHaveBeenCalled();
  finish();
  await expect(pending).resolves.toEqual({ completed: 1 });
  expect(observer).toHaveBeenCalledExactlyOnceWith({
    requestId: 'fixture-request',
    status: 200,
    serverMs: 123.45,
    httpMs: expect.any(Number),
  });
});
it.each([undefined, 'unrelated;dur=1', 'nh-file;dur=NaN', 'nh-file;dur=-4'])(
  'does not emit browser diagnostics without valid API debug timing: %s',
  async (timing) => {
    const observer = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 204,
            headers: {
              'X-Request-ID': 'fixture-request',
              ...(timing ? { 'Server-Timing': timing } : {}),
            },
          }),
      ),
    );
    await api('/v1/servers/test/files', { method: 'POST', onDebugTiming: observer });
    expect(observer).not.toHaveBeenCalled();
  },
);
it.each([204, 409])(
  'preserves the HTTP result when a debug observer throws: %s',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            status === 204
              ? null
              : JSON.stringify({
                  error: { code: 'conflict' },
                }),
            {
              status,
              headers: { 'Server-Timing': 'nh-file;dur=5', 'X-Request-ID': 'fixture-request' },
            },
          ),
      ),
    );
    const observer = vi.fn(() => {
      throw new Error('diagnostics failed');
    });
    const pending = api('/v1/servers/test/files', { method: 'POST', onDebugTiming: observer });
    if (status === 204) await expect(pending).resolves.toBeUndefined();
    else await expect(pending).rejects.toMatchObject({ code: 'conflict' });
    expect(observer).toHaveBeenCalledOnce();
  },
);
