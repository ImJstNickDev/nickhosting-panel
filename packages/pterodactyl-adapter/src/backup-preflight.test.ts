import { expect, it, vi } from 'vitest';
import { createPterodactylAdapter } from './adapter.js';

const config = {
  baseURL: 'https://panel.example.test',
  applicationKey: 'fixture-application-key',
  clientKey: 'fixture-client-key',
};
const backup = {
  uuid: 'f729c8a1-6773-467a-af3f-a7ea8704f0bd',
  is_successful: false,
  is_locked: false,
  name: 'fixture',
  ignored_files: [],
  checksum: null,
  bytes: 0,
  created_at: '2026-10-19T00:00:00Z',
  completed_at: null,
};

it('pins validated .pteroignore content without extra directory listings', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('cache/**\n*.log'))
    .mockResolvedValueOnce(Response.json({ attributes: backup }));
  await createPterodactylAdapter({ ...config, fetcher }).createBackup('f729c8a1', {
    name: 'fixture',
  });
  expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('file')).toBe(
    '/.pteroignore',
  );
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).ignored).toBe('cache/**\n*.log');
});

it('does not let Wings silently discard invalid .pteroignore exclusions', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('*a'.repeat(17)));
  await expect(
    createPterodactylAdapter({ ...config, fetcher }).createBackup('f729c8a1', { name: 'fixture' }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('uses an explicit empty snapshot when .pteroignore is absent', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ attributes: backup }));
  await createPterodactylAdapter({ ...config, fetcher }).createBackup('f729c8a1', {
    name: 'fixture',
  });
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).ignored).toBe(
    '# No exclusion patterns',
  );
});

it('never dispatches backup when the exclusion snapshot could not be read', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
  await expect(
    createPterodactylAdapter({ ...config, fetcher }).createBackup('f729c8a1', { name: 'fixture' }),
  ).rejects.toMatchObject({ upstreamStatus: 403 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
