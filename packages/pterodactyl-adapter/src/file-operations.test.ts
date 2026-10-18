import { describe, expect, it, vi } from 'vitest';
import { createPterodactylAdapter } from './adapter.js';

const options = {
  baseURL: 'https://panel.example.test',
  applicationKey: 'fixture-app',
  clientKey: 'fixture-client',
};
const identity = {
  providerId: 7,
  providerUuid: '11111111-1111-4111-8111-111111111111',
  identifier: '11111111',
  externalId: 'nh-fixture',
  nodeId: 2,
};
const observation = 'a'.repeat(64);
const sha256 = 'b'.repeat(64);
const input = {
  operationId: '22222222-2222-4222-8222-222222222222',
  identity,
  target: { path: 'unused', observation },
  guard: { path: 'server.properties', sha256 },
};
const receipt = {
  operationId: input.operationId,
  identity,
  target: input.target,
  state: 'confirmed',
};
const archive = {
  operationId: input.operationId,
  identity,
  destinationRoot: 'imported',
  archiveSha256: sha256,
  files: [{ path: 'imported/level.dat', size: 123 }],
};
const archiveReceipt = {
  operationId: archive.operationId,
  identity,
  destinationRoot: archive.destinationRoot,
  archiveSha256: sha256,
  state: 'confirmed',
};

describe('Blueprint scoped file operations', () => {
  it('inspects guard bytes and directory observation with a single private Client request', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toContain(
        '/api/client/extensions/nickhosting/servers/11111111/file-inspection',
      );
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-client');
      expect(JSON.parse(String(init?.body))).toEqual({
        target: 'unused',
        guardFile: 'server.properties',
      });
      return Response.json({
        identity,
        target: input.target,
        guard: { ...input.guard, contents: 'level-name=active' },
      });
    });
    const result = await createPterodactylAdapter({ ...options, fetcher }).inspectFileOperation(
      '11111111',
      { target: 'unused', guardFile: 'server.properties' },
    );
    expect(result.guard.contents).toBe('level-name=active');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns a durable deletion receipt without a separate Application identity call', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return Response.json(receipt);
    });
    expect(
      await createPterodactylAdapter({ ...options, fetcher }).guardedDeleteDirectory(
        '11111111',
        input,
      ),
    ).toEqual(receipt);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps uncertain receipts uncertain without retry or stock delete fallback', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ...receipt, state: 'uncertain' }),
    );
    expect(
      (
        await createPterodactylAdapter({ ...options, fetcher }).guardedDeleteDirectory(
          '11111111',
          input,
        )
      ).state,
    ).toBe('uncertain');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...receipt, operationId: '33333333-3333-4333-8333-333333333333' },
    { ...receipt, target: { ...input.target, path: 'other' } },
    { ...receipt, identity: { ...identity, providerId: 8 } },
  ])('rejects a receipt not bound to this operation as an uncertain mutation', async (body) => {
    const adapter = createPterodactylAdapter({
      ...options,
      fetcher: async () => Response.json(body),
    });
    await expect(adapter.guardedDeleteDirectory('11111111', input)).rejects.toMatchObject({
      outcome: 'unknown',
      reason: 'invalid_response',
    });
  });
  it.each(['../world', '/world', 'world/', 'a//b', 'world\\bad', 'x%2fworld', 'a\nb'])(
    'rejects malformed target %s before dispatch',
    async (path) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        createPterodactylAdapter({ ...options, fetcher }).guardedDeleteDirectory('11111111', {
          ...input,
          target: { path, observation },
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('rejects a guard inside the deleted subtree', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createPterodactylAdapter({ ...options, fetcher }).guardedDeleteDirectory('11111111', {
        ...input,
        guard: { path: 'unused/guard.txt', sha256 },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('discovers optional capability and preserves missing-extension 404', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));
    await expect(
      createPterodactylAdapter({ ...options, fetcher }).getFileOperationCapabilities('11111111'),
    ).rejects.toMatchObject({ reason: 'not_found', outcome: 'rejected' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('classifies lost inspection response as read-only failure', async () => {
    await expect(
      createPterodactylAdapter({
        ...options,
        fetcher: async () => {
          throw new TypeError('offline');
        },
      }).inspectFileOperation('11111111', { target: 'unused', guardFile: 'server.properties' }),
    ).rejects.toMatchObject({ outcome: 'rejected' });
  });
  it('commits the complete archive using one bound Blueprint request', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toContain('/archive-commit');
      expect(JSON.parse(String(init?.body))).toEqual(archive);
      return Response.json(archiveReceipt);
    });
    expect(
      await createPterodactylAdapter({ ...options, fetcher }).commitFileArchive(
        '11111111',
        archive,
      ),
    ).toEqual(archiveReceipt);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...archive, destinationRoot: 'nested/world' },
    { ...archive, files: [{ path: 'other/level.dat', size: 3 }] },
    { ...archive, files: [...archive.files, ...archive.files] },
  ])('rejects incompatible archive manifests before dispatch', async (body) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createPterodactylAdapter({ ...options, fetcher }).commitFileArchive('11111111', body),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses an operation-specific archive deadline without increasing ordinary request timeouts', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const adapter = createPterodactylAdapter({
        ...options,
        fetcher: async (url) => {
          if (String(url).endsWith('/archive-commit')) return Response.json(archiveReceipt);
          return Response.json({ inspection: true, guardedDelete: true, archiveCommit: true });
        },
      });
      await adapter.commitFileArchive('11111111', archive);
      await adapter.getFileOperationCapabilities('11111111');
      expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([90000, 10000]);
    } finally {
      timeout.mockRestore();
    }
  });
  it('exposes native extraction without pretending it has a recovery receipt', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toContain('/servers/11111111/files/decompress');
      expect(JSON.parse(String(init?.body))).toEqual({ root: '/stage', file: 'payload.zip' });
      return new Response(null, { status: 204 });
    });
    await createPterodactylAdapter({ ...options, fetcher }).extractArchive(
      '11111111',
      'stage',
      'payload.zip',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
