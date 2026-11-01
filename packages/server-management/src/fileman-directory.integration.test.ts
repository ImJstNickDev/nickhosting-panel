import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  type FileOperationInspection,
  type FileOperationReceipt,
  type GuardedDirectoryDelete,
  type PterodactylAdapter,
  PterodactylError,
} from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeFilemanDirectory } from './fileman-directory.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { managementFixture } from './test-fixtures.js';

describe('Fileman guarded directory removal', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.destroy();
  });

  async function fixture() {
    const db = database.db;
    const managed = await managementFixture(db);
    const serverId = await managed.server();
    const server = await db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    let operation = await db
      .selectFrom('server_operations')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    const node = await db
      .selectFrom('managed_nodes')
      .select('pterodactyl_node_id')
      .where('id', '=', server.node_id)
      .executeTakeFirstOrThrow();
    const identity = {
      providerId: server.pterodactyl_id as number,
      providerUuid: server.pterodactyl_uuid as string,
      identifier: server.pterodactyl_identifier as string,
      externalId: server.external_id,
      nodeId: node.pterodactyl_node_id,
    };
    const contents = 'level-name=world\n';
    const snapshot: FileOperationInspection = {
      identity,
      target: { path: 'spare', observation: 'a'.repeat(64) },
      guard: {
        path: 'server.properties',
        sha256: createHash('sha256').update(contents).digest('hex'),
        contents,
      },
    };
    const receipts = new Map<string, FileOperationReceipt>();
    let currentFolder: string | undefined = 'original';
    let deletions = 0;
    const adapter = {
      inspectFileOperation: vi.fn(async () => structuredClone(snapshot)),
      guardedDeleteDirectory: vi.fn(
        async (_identifier: string, request: GuardedDirectoryDelete) => {
          const prior = receipts.get(request.operationId);
          if (prior) return structuredClone(prior);
          deletions++;
          currentFolder = undefined;
          const receipt: FileOperationReceipt = {
            operationId: request.operationId,
            state: 'confirmed',
            identity: request.identity,
            target: request.target,
          };
          receipts.set(request.operationId, structuredClone(receipt));
          return receipt;
        },
      ),
      deleteFiles: vi.fn(),
      listFiles: vi.fn(),
    };
    const authorize = vi.fn(async () => {});
    const context: GameLifecycleContext = {
      db,
      server,
      adapter: adapter as unknown as PterodactylAdapter,
      operation: () => operation,
      authorize,
      assertStopped: async () => {},
      event: async () => {},
      backup: async () => false,
      update: async (patch) => {
        const { plan, ...fields } = patch;
        await db
          .updateTable('server_operations')
          .set({
            ...fields,
            ...(plan ? { plan: JSON.stringify(plan) } : {}),
          })
          .where('job_id', '=', operation.job_id)
          .execute();
        operation = await db
          .selectFrom('server_operations')
          .selectAll()
          .where('job_id', '=', operation.job_id)
          .executeTakeFirstOrThrow();
      },
      effect: async (phase, perform) => {
        await context.update({ phase, effect_state: 'prepared' });
        await authorize();
        await perform();
        await context.update({ effect_state: 'confirmed' });
        return true;
      },
    };
    await context.update({ phase: 'planned', effect_state: 'none', plan: {} });
    const input = {
      target: 'spare',
      guardFile: 'server.properties',
      validateGuard: vi.fn((_value: string) => {}),
    };
    return {
      context,
      adapter,
      input,
      snapshot,
      authorize,
      deletions: () => deletions,
      folder: () => currentFolder,
      recreate: () => {
        currentFolder = 'recreated';
      },
      reload: async () => {
        operation = await db
          .selectFrom('server_operations')
          .selectAll()
          .where('job_id', '=', operation.job_id)
          .executeTakeFirstOrThrow();
      },
    };
  }

  it('pins the exact managed identity, target observation and guard before dispatch', async () => {
    const f = await fixture();
    const send = f.adapter.guardedDeleteDirectory.getMockImplementation();
    if (!send) throw new Error('Missing provider fixture');
    f.adapter.guardedDeleteDirectory.mockImplementation(async (identifier, request) => {
      const persisted = await database.db
        .selectFrom('server_operations')
        .select('plan')
        .where('job_id', '=', f.context.operation().job_id)
        .executeTakeFirstOrThrow();
      expect(persisted.plan.fileDirectoryRemoval).toEqual({ request, completed: false });
      return send(identifier, request);
    });
    await removeFilemanDirectory(f.context, f.input);
    expect(f.input.validateGuard).toHaveBeenCalledExactlyOnceWith('level-name=world\n');
    expect(f.adapter.guardedDeleteDirectory).toHaveBeenCalledExactlyOnceWith(
      f.snapshot.identity.identifier,
      {
        operationId: f.context.operation().job_id,
        identity: f.snapshot.identity,
        target: f.snapshot.target,
        guard: { path: f.snapshot.guard.path, sha256: f.snapshot.guard.sha256 },
      },
    );
    expect(f.context.operation().plan.fileDirectoryRemoval).toMatchObject({ completed: true });
    expect(f.deletions()).toBe(1);
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
    expect(f.adapter.listFiles).not.toHaveBeenCalled();
  });

  it.each(['providerId', 'providerUuid', 'identifier', 'externalId', 'nodeId'] as const)(
    'rejects an inspection with a different %s before preparing an effect',
    async (field) => {
      const f = await fixture();
      Object.assign(f.snapshot.identity, {
        [field]: typeof f.snapshot.identity[field] === 'number' ? 999999 : randomUUID(),
      });
      await expect(removeFilemanDirectory(f.context, f.input)).rejects.toMatchObject({
        code: 'provenance_mismatch',
      });
      expect(f.context.operation().plan.fileDirectoryRemoval).toBeUndefined();
      expect(f.context.operation().effect_state).toBe('none');
      expect(f.adapter.guardedDeleteDirectory).not.toHaveBeenCalled();
    },
  );

  it('does not pin or dispatch a directory rejected by the game guard', async () => {
    const f = await fixture();
    f.input.validateGuard.mockImplementation(() => {
      throw new DomainError('validation_failed');
    });
    await expect(removeFilemanDirectory(f.context, f.input)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(f.context.operation().plan.fileDirectoryRemoval).toBeUndefined();
    expect(f.adapter.guardedDeleteDirectory).not.toHaveBeenCalled();
  });

  it('replays the persisted request after a lost response and preserves a recreated directory', async () => {
    const f = await fixture();
    const send = f.adapter.guardedDeleteDirectory.getMockImplementation();
    if (!send) throw new Error('Missing provider fixture');
    f.adapter.guardedDeleteDirectory.mockImplementationOnce(async (...args) => {
      await send(...args);
      throw new PterodactylError('unavailable', 'client', 'unknown');
    });
    await expect(removeFilemanDirectory(f.context, f.input)).rejects.toMatchObject({
      outcome: 'unknown',
    });
    const originalRequest = structuredClone(f.adapter.guardedDeleteDirectory.mock.calls[0]?.[1]);
    f.recreate();
    f.snapshot.target.observation = 'b'.repeat(64);
    f.snapshot.guard.contents = 'level-name=spare\n';
    await f.reload();
    await removeFilemanDirectory(f.context, f.input);
    expect(f.adapter.inspectFileOperation).toHaveBeenCalledOnce();
    expect(f.input.validateGuard).toHaveBeenCalledOnce();
    expect(f.adapter.guardedDeleteDirectory.mock.calls[1]?.[1]).toEqual(originalRequest);
    expect(f.deletions()).toBe(1);
    expect(f.folder()).toBe('recreated');
    await f.reload();
    await removeFilemanDirectory(f.context, f.input);
    expect(f.adapter.guardedDeleteDirectory).toHaveBeenCalledTimes(2);
  });

  it('does not certify an uncertain provider receipt as a completed removal', async () => {
    const f = await fixture();
    f.adapter.guardedDeleteDirectory.mockImplementation(async (_identifier, request) => ({
      operationId: request.operationId,
      state: 'uncertain',
      identity: request.identity,
      target: request.target,
    }));
    await expect(removeFilemanDirectory(f.context, f.input)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect(f.context.operation().plan.fileDirectoryRemoval).toMatchObject({ completed: false });
    expect(f.context.operation().effect_state).toBe('prepared');
  });

  it('rejects a changed local provider binding instead of reusing a pinned request', async () => {
    const f = await fixture();
    f.adapter.guardedDeleteDirectory.mockRejectedValueOnce(
      new PterodactylError('unavailable', 'client', 'unknown'),
    );
    await expect(removeFilemanDirectory(f.context, f.input)).rejects.toMatchObject({
      outcome: 'unknown',
    });
    await database.db
      .updateTable('managed_nodes')
      .set({ pterodactyl_node_id: 999999 })
      .where('id', '=', f.context.server.node_id)
      .execute();
    await f.reload();
    await expect(removeFilemanDirectory(f.context, f.input)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(f.adapter.inspectFileOperation).toHaveBeenCalledOnce();
    expect(f.adapter.guardedDeleteDirectory).toHaveBeenCalledOnce();
  });

  it('does not fall back to an unguarded delete when a pinned bridge request returns 404', async () => {
    const f = await fixture();
    f.adapter.guardedDeleteDirectory.mockRejectedValue(
      new PterodactylError('not_found', 'client', 'rejected', 404),
    );
    await expect(removeFilemanDirectory(f.context, f.input)).rejects.toMatchObject({
      upstreamStatus: 404,
    });
    await f.reload();
    await expect(removeFilemanDirectory(f.context, f.input)).rejects.toMatchObject({
      upstreamStatus: 404,
    });
    expect(f.adapter.inspectFileOperation).toHaveBeenCalledOnce();
    expect(f.adapter.guardedDeleteDirectory).toHaveBeenCalledTimes(2);
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
    expect(f.context.operation().plan.fileDirectoryRemoval).toMatchObject({ completed: false });
  });

  it.each(['../spare', 'nested/spare', 'nested\\spare', '.', '..', 'spare\u0000'])(
    'rejects unsafe root %s before provider access',
    async (target) => {
      const f = await fixture();
      await expect(removeFilemanDirectory(f.context, { ...f.input, target })).rejects.toMatchObject(
        { code: 'validation_failed' },
      );
      expect(f.adapter.inspectFileOperation).not.toHaveBeenCalled();
      expect(f.adapter.guardedDeleteDirectory).not.toHaveBeenCalled();
    },
  );
});
