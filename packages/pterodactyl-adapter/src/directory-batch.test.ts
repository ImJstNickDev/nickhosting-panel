import { describe, expect, it, vi } from 'vitest';
import { createPterodactylAdapter, type FileReadTiming } from './adapter.js';

const options = {
  baseURL: 'https://panel.example.test',
  applicationKey: 'fixture-app',
  clientKey: 'fixture-managed-client',
};
const file = {
  name: 'server.properties',
  mode: '-rw-r--r--',
  size: 12,
  is_file: true,
  is_symlink: false,
  mimetype: 'text/plain',
  created_at: '2026-10-13T12:00:00+00:00',
  modified_at: '2026-10-13T12:00:00+00:00',
};
const settings = {
  directoryBatchLimit: 32,
  directoryConcurrency: 2,
  directoryTimeoutSeconds: 5,
};

describe('experimental Blueprint directory batches', () => {
  it.each([200, 403, 500])(
    'times directory settings and ordered listing without changing requests or errors (%s)',
    async (status) => {
      let now = 0;
      const durations: Record<string, number> = {};
      const timing: FileReadTiming = {
        async measure(name, work) {
          const start = now;
          try {
            return await work();
          } finally {
            durations[name] = now - start;
          }
        },
        measureSync: (_name, work) => work(),
      };
      const results = [{ directory: 'private-world', files: [file] }];
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        const isSettings = String(url).endsWith('/directory-settings');
        now += isSettings ? 13 : 27;
        return status === 200
          ? Response.json(isSettings ? settings : { results })
          : new Response(null, { status });
      });
      const adapter = createPterodactylAdapter({ ...options, fetcher });
      const settingsRead = adapter.getDirectoryBatchSettings('fixture', timing);
      if (status === 200) await expect(settingsRead).resolves.toEqual(settings);
      else
        await expect(settingsRead).rejects.toMatchObject({
          upstreamStatus: status,
          outcome: 'rejected',
        });
      const listed = adapter.listDirectoriesBatch('fixture', ['private-world'], timing);
      if (status === 200) await expect(listed).resolves.toEqual(results);
      else
        await expect(listed).rejects.toMatchObject({ upstreamStatus: status, outcome: 'rejected' });
      expect(durations).toEqual({
        'directoryBatch.settings.http': 13,
        'directoryBatch.list.http': 27,
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
      expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
        method: 'POST',
        body: JSON.stringify({ directories: ['private-world'] }),
      });
      for (const value of ['private-world', options.baseURL, options.clientKey, file.name])
        expect(JSON.stringify(durations)).not.toContain(value);
    },
  );

  it('uses one managed Client request and returns ordered partial results without retries or tokens', async () => {
    const results = [
      { directory: '', files: [file] },
      { directory: 'mondo/giocatori', files: [] },
      { directory: 'absent', error: 'not_found' },
      { directory: 'denied', error: 'forbidden' },
      { directory: 'offline', error: 'unavailable' },
      { directory: 'large', error: 'too_large' },
      { directory: 'late', error: 'deadline_exceeded' },
    ];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(
        'https://panel.example.test/api/client/extensions/nickhosting/servers/fixture/directory-list',
      );
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-managed-client');
      expect(JSON.parse(String(init?.body))).toEqual({
        directories: results.map((result) => result.directory),
      });
      return Response.json({ results });
    });
    const adapter = createPterodactylAdapter({ ...options, fetcher });
    expect(
      await adapter.listDirectoriesBatch(
        'fixture',
        results.map((r) => r.directory),
      ),
    ).toEqual(results);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('discovers bounded settings only when requested and does not change the normal listing route', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-managed-client');
      if (String(url).endsWith('/directory-settings')) return Response.json(settings);
      expect(new URL(String(url)).pathname).toBe('/api/client/servers/fixture/files/list');
      return Response.json({ object: 'list', data: [{ attributes: file }] });
    });
    const adapter = createPterodactylAdapter({ ...options, fetcher });
    expect(await adapter.getDirectoryBatchSettings('fixture')).toEqual(settings);
    expect(await adapter.listFiles('fixture', 'world')).toEqual([file]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(
    [
      [],
      ['', ''],
      ['world', 'world'],
      ['/'],
      ['/world'],
      ['world/'],
      ['world//region'],
      ['.'],
      ['world/../region'],
      ['world/./region'],
      ['world\\region'],
      ['world%2fregion'],
      ['world%252fregion'],
      ['world\nregion'],
      ['world\u007fregion'],
      ['world\u202eregion'],
      ['world\ud800'],
      ['é'.repeat(2049)],
      Array.from({ length: 65 }, (_, index) => `d${index}`),
    ].map((directories) => ({ directories })),
  )(
    'rejects invalid or duplicate paths before any provider request (%#)',
    async ({ directories }) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        createPterodactylAdapter({ ...options, fetcher }).listDirectoriesBatch(
          'fixture',
          directories,
        ),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('accepts unique UTF-8 paths including root without normalizing them', async () => {
    const directories = ['', 'cartella con spazi', 'mondo/日本語', 'é'.repeat(2048)];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ directories });
      return Response.json({ results: directories.map((directory) => ({ directory, files: [] })) });
    });
    await createPterodactylAdapter({ ...options, fetcher }).listDirectoriesBatch(
      'fixture',
      directories,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { results: [] },
    { results: [{ directory: '', files: [] }] },
    {
      results: [
        { directory: '', files: [] },
        { directory: '', files: [] },
      ],
    },
    {
      results: [
        { directory: 'world', files: [] },
        { directory: '', files: [] },
      ],
    },
    {
      results: [
        { directory: '', files: [] },
        { directory: 'foreign', files: [] },
      ],
    },
    {
      results: [
        { directory: '', files: [] },
        { directory: 'world', error: 'raw private detail' },
      ],
    },
    {
      results: [
        { directory: '', files: [file] },
        { directory: 'world', files: [], error: 'not_found' },
      ],
    },
    {
      results: [
        { directory: '', files: [{ ...file, size: -1 }] },
        { directory: 'world', files: [] },
      ],
    },
    {
      results: [
        { directory: '', files: [] },
        { directory: 'world', files: [] },
      ],
      extra: 'secret',
    },
  ])('rejects incomplete, reordered or malformed results as a whole (%#)', async (payload) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload));
    await expect(
      createPterodactylAdapter({ ...options, fetcher }).listDirectoriesBatch('fixture', [
        '',
        'world',
      ]),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 409, 429, 500])(
    'preserves HTTP %s without native fallback or retries',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(async () => new Response('private error', { status }));
      await expect(
        createPterodactylAdapter({ ...options, fetcher }).listDirectoriesBatch('fixture', ['']),
      ).rejects.toMatchObject({ upstreamStatus: status, outcome: 'rejected' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('does not report an uncertain filesystem mutation after a lost query response', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('connection lost');
    });
    await expect(
      createPterodactylAdapter({ ...options, fetcher }).listDirectoriesBatch('fixture', ['']),
    ).rejects.toMatchObject({ reason: 'unavailable', scope: 'client', outcome: 'rejected' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never substitutes the Application key when no Client key is present', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createPterodactylAdapter({ ...options, clientKey: undefined, fetcher }).listDirectoriesBatch(
        'fixture',
        [''],
      ),
    ).rejects.toMatchObject({ reason: 'credential_missing', scope: 'client' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { ...settings, directoryBatchLimit: 65 },
    { ...settings, directoryConcurrency: 0 },
    { ...settings, directoryConcurrency: 5 },
    { ...settings, directoryTimeoutSeconds: 11 },
    { ...settings, directoryTimeoutSeconds: 0 },
    { ...settings, extra: 'private detail' },
  ])('rejects invalid settings without silently replacing them (%#)', async (payload) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload));
    await expect(
      createPterodactylAdapter({ ...options, fetcher }).getDirectoryBatchSettings('fixture'),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('accepts a batch above the ordinary 4 MiB JSON limit, below the dedicated 8 MiB limit', async () => {
    const files = Array.from({ length: 1200 }, (_, index) => ({
      ...file,
      name: `${index}-${'a'.repeat(4000)}`,
    }));
    const payload = JSON.stringify({ results: [{ directory: '', files }] });
    expect(Buffer.byteLength(payload)).toBeGreaterThan(4 * 1024 * 1024);
    expect(Buffer.byteLength(payload)).toBeLessThan(8 * 1024 * 1024);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(payload));
    const result = await createPterodactylAdapter({ ...options, fetcher }).listDirectoriesBatch(
      'fixture',
      [''],
    );
    expect(result).toEqual([{ directory: '', files }]);
  });

  it.each([true, false])('cancels oversized responses with Content-Length=%s', async (declared) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(body, {
          headers: declared ? { 'content-length': String(8 * 1024 * 1024 + 1) } : {},
        }),
    );
    await expect(
      createPterodactylAdapter({ ...options, fetcher }).listDirectoriesBatch('fixture', ['']),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
