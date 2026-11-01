import { describe, expect, it, vi } from 'vitest';
import { createPterodactylAdapter } from './adapter.js';

function fixture(rejection: number, alwaysReject = false) {
  const panel = 'https://panel.example.test';
  const wings = 'https://wings.example.test';
  let sequence = 0;
  const reads: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith('/transfer-settings'))
      return Response.json({
        downloadBatchLimit: 2500,
        uploadBatchLimit: 500,
        signedUrlTtlSeconds: 900,
      });
    if (target.pathname.endsWith('/download-urls'))
      return Response.json({
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        urls: [`${wings}/download/file?token=private-${++sequence}`],
      });
    if (target.origin === wings) {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      reads.push(target.searchParams.get('token') as string);
      return reads.length === 1 || alwaysReject
        ? new Response(null, { status: rejection })
        : new Response('fresh bytes');
    }
    throw new Error('Unexpected fixture request');
  });
  return {
    reads,
    adapter: createPterodactylAdapter({
      baseURL: panel,
      applicationKey: 'app',
      clientKey: 'client',
      downloadOrigins: [wings],
      fetcher,
    }),
  };
}

describe('prepared download token revocation', () => {
  it.each([401, 403, 404])('reissues once for an editor read rejected with %s', async (status) => {
    const f = fixture(status);
    await f.adapter.prefetchDownloads('server', ['file.txt']);
    expect(Buffer.from(await f.adapter.readFileForEditor('server', 'file.txt')).toString()).toBe(
      'fresh bytes',
    );
    expect(f.reads).toHaveLength(2);
    expect(new Set(f.reads).size).toBe(2);
  });
  it('reissues a streamed download before exposing any body to the caller', async () => {
    const f = fixture(404);
    await f.adapter.prefetchDownloads('server', ['file.txt']);
    const downloaded = await f.adapter.downloadFile('server', 'file.txt', {});
    expect(await new Response(downloaded.body).text()).toBe('fresh bytes');
    expect(f.reads).toHaveLength(2);
  });
  it('bounds a persistent denial to one replacement credential', async () => {
    const f = fixture(404, true);
    await expect(f.adapter.readFileForEditor('server', 'file.txt')).rejects.toMatchObject({
      upstreamStatus: 404,
    });
    expect(f.reads).toHaveLength(2);
  });
  it('does not loop or replace credentials for provider failures unrelated to authentication', async () => {
    const f = fixture(500);
    await expect(f.adapter.readFileForEditor('server', 'file.txt')).rejects.toMatchObject({
      upstreamStatus: 500,
    });
    expect(f.reads).toHaveLength(1);
  });
});
