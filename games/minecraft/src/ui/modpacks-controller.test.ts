import type { GameUiClient } from '@nickhosting/game-sdk/ui';
import { describe, expect, it, vi } from 'vitest';
import {
  createMinecraftModpacksController,
  type MinecraftModpackOperation,
} from './modpacks-controller.js';

const server = '10000000-0000-4000-8000-000000000001';
const operationId = '20000000-0000-4000-8000-000000000001';
const failed: MinecraftModpackOperation = {
  id: operationId,
  selection: {
    provider: 'curseforge',
    projectId: '318032',
    versionId: '5871978',
    mode: 'replace',
    worldPolicy: 'reset',
    fileDecisions: { 'config/custom.cfg': 'keep-local' },
    idempotencyKey: 'original',
  },
  state: 'failed',
  phase: 'downloading',
  pack: null,
  progress: null,
  target: null,
  runtimeSupported: false,
  planDigest: null,
  changes: null,
  deletePaths: [],
  blockers: [],
  error: 'validation_failed',
  backupId: null,
  restartRequired: false,
  createdAt: '2026-10-21T12:00:00Z',
  updatedAt: '2026-10-21T12:00:00Z',
};
function setup(result: unknown = { installed: null, operation: null }) {
  const request = vi.fn(async () => result);
  return {
    request,
    controller: createMinecraftModpacksController({ request } as unknown as GameUiClient),
  };
}
describe('Modpack UI controller', () => {
  it('reads the isolated server snapshot without mutations', async () => {
    const { controller, request } = setup();
    await controller.snapshot(server);
    expect(request).toHaveBeenCalledWith(`/v1/servers/${server}/minecraft/modpacks`, {
      signal: undefined,
    });
  });
  it('encodes opaque provider identities and preserves abort signals', async () => {
    const { controller, request } = setup({
      id: 'a pack+1',
      provider: 'technic',
      name: 'Pack',
      summary: '',
      websiteUrl: 'https://example.test',
      authors: [],
      description: '',
      descriptionFormat: 'text',
    });
    const signal = new AbortController().signal;
    await controller.details(server, 'technic', 'a pack+1', signal);
    expect(request).toHaveBeenCalledWith(
      `/v1/servers/${server}/minecraft/modpacks/catalog/technic/a%20pack%2B1`,
      { signal },
    );
  });
  it('rejects traversal before any transport', async () => {
    const { controller, request } = setup();
    await expect(controller.details(server, 'ftb', '../bad')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('prepares only explicit complete selection intent', async () => {
    const { controller, request } = setup();
    const body = {
      provider: 'modrinth' as const,
      projectId: 'pack',
      versionId: 'v1',
      mode: 'install' as const,
      worldPolicy: 'preserve' as const,
      fileDecisions: {},
      idempotencyKey: 'intent1',
    };
    await controller.prepare(server, body);
    expect(request).toHaveBeenCalledWith(`/v1/servers/${server}/minecraft/modpacks/prepare`, {
      method: 'POST',
      body,
    });
  });
  it('forbids world reset for an update before transport', () => {
    const { controller, request } = setup();
    expect(() =>
      controller.prepare(server, {
        provider: 'ftb',
        projectId: '42',
        versionId: '3',
        mode: 'update',
        worldPolicy: 'reset',
        fileDecisions: {},
        idempotencyKey: 'intent',
      }),
    ).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('retries an unresolved failed pack with every original choice and a new intent', async () => {
    const { controller, request } = setup();
    await controller.retry(server, failed, 'retry1');
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `/v1/servers/${server}/minecraft/modpacks/prepare`,
      {
        method: 'POST',
        body: { ...failed.selection, idempotencyKey: 'retry1' },
      },
    );
    expect(failed.selection.idempotencyKey).toBe('original');
  });
  it('reuses the retry intent after a transport failure without discarding the failed operation', async () => {
    const { controller, request } = setup();
    request.mockRejectedValueOnce(new Error('Connection lost'));
    await expect(controller.retry(server, failed, 'retry1')).rejects.toThrow('Connection lost');
    await controller.retry(server, failed, 'retry1');
    expect(request.mock.calls).toHaveLength(2);
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
  });
  it('rejects replaying the failed intent or retrying an uncertain operation', () => {
    const { controller, request } = setup();
    expect(() => controller.retry(server, failed, 'original')).toThrow();
    expect(() => controller.retry(server, { ...failed, state: 'uncertain' }, 'retry1')).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('binds apply to exact reviewed operation, digest, and deletions', async () => {
    const { controller, request } = setup();
    const body = {
      operationId,
      planDigest: 'a'.repeat(64),
      confirm: true as const,
      backupBefore: true,
      expectedDeletePaths: ['mods/old.jar'],
      idempotencyKey: 'apply1',
    };
    await controller.apply(server, body);
    expect(request).toHaveBeenCalledWith(`/v1/servers/${server}/minecraft/modpacks/apply`, {
      method: 'POST',
      body,
    });
  });
  it('recovery targets an existing operation without replaying apply', async () => {
    const { controller, request } = setup();
    await controller.recover(server, operationId);
    expect(request).toHaveBeenCalledWith(
      `/v1/servers/${server}/minecraft/modpacks/operations/${operationId}/recover`,
      { method: 'POST', body: {} },
    );
  });
  it('rejects invalid mutation responses', async () => {
    const { controller } = setup({ success: true });
    await expect(controller.discard(server, operationId)).rejects.toThrow();
  });
});
