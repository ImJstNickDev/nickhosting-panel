import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DomainError, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type {
  ViewerSftpConnection,
  ViewerSftpCredentialRequest,
  ViewerSftpFile,
} from '@nickhosting/external-services';
import type { ManagementRuntime } from '@nickhosting/server-management';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { FileViewerService } from './viewer-service.js';

const transport = vi.hoisted(() => ({
  ensure: vi.fn(),
  open: vi.fn(),
  revoke: vi.fn(),
  disposed: vi.fn(),
}));

// PostgreSQL, settings, encryption, durable credential intents and the shared access
// watcher are real. Only the external SFTPGo/SSH boundaries are isolated fixtures.
vi.mock('@nickhosting/external-services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nickhosting/external-services')>();
  return {
    ...actual,
    SftpGoViewerAdapter: class {
      ensureCredential(request: ViewerSftpCredentialRequest) {
        return transport.ensure(request);
      }
    },
    ViewerSftpPool: class {
      disposed = false;
      async openFile(
        connection: ViewerSftpConnection,
        path: string,
        options: { signal?: AbortSignal },
      ) {
        options.signal?.throwIfAborted();
        if (this.disposed) throw new Error('fixture_disposed_pool');
        return transport.open(connection, path, options);
      }
      revokeCredential(id: string) {
        transport.revoke(id);
      }
      dispose() {
        this.disposed = true;
        transport.disposed();
      }
    },
  };
});

describe('private viewer service with persisted credentials and isolated SFTP boundaries', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let fixture: Awaited<ReturnType<typeof managementFixture>>;
  let service: FileViewerService;
  let serverId: string;
  let env: Record<string, string>;
  let management: ManagementRuntime;
  const instances: FileViewerService[] = [];
  const closeFiles: Array<() => Promise<void>> = [];
  const codec = new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } });
  const authorize = vi.fn();
  const bytes = Buffer.from('isolated viewer file');

  function makeService() {
    const created = new FileViewerService({ db: database.db, codec, env });
    instances.push(created);
    return created;
  }
  async function open(source = service, signal = new AbortController().signal, path = 'image.png') {
    const result = await source.open(fixture.context, management, serverId, path, signal);
    closeFiles.push(result.close);
    return result;
  }
  function credentials() {
    return database.db
      .selectFrom('viewer_sftp_credentials')
      .selectAll()
      .where('server_id', '=', serverId)
      .orderBy('created_at')
      .execute();
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    fixture = await managementFixture(database.db, { interactive: true });
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    serverId = await fixture.server();
    env = {
      NH_FILE_VIEWERS: JSON.stringify({
        managementUrl: 'http://viewer-sftp.example.test:8080',
        dataRoot: '/isolated/servers',
        instanceId: randomUUID(),
        host: 'viewer-sftp.example.test',
        port: 2022,
        hostFingerprint: `SHA256:${'A'.repeat(43)}`,
        cacheRoot: './mountdata/test-assets/viewer-service-fixtures',
      }),
      NH_VIEWER_SFTPGO_API_KEY: 'isolated-fixture-api-key',
    };
    authorize.mockReset().mockResolvedValue(undefined);
    management = {
      fileReadAccess: vi.fn<ManagementRuntime['fileReadAccess']>(async (_context, id, work) => {
        const server = await database.db
          .selectFrom('managed_servers')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        if (!server.pterodactyl_identifier) throw new Error('fixture_provider_identifier');
        return work(server.pterodactyl_identifier, database.db, fixture.context, server);
      }),
      uploadBatchBinding: vi.fn<ManagementRuntime['uploadBatchBinding']>(
        (server) => `${server.id}:${server.pterodactyl_uuid}`,
      ),
      authorizeTransfer: authorize,
    } as unknown as ManagementRuntime;
    transport.ensure
      .mockReset()
      .mockImplementation(async (request: ViewerSftpCredentialRequest) => ({
        ...request,
        username: `nhv_${request.credentialId.replaceAll('-', '')}`,
        externalUserId: 42,
      }));
    transport.open.mockReset().mockImplementation(
      async (_connection, _path, options: { signal: AbortSignal }): Promise<ViewerSftpFile> => ({
        stat: { size: bytes.length, mtimeMs: 1000, mode: 0o100644 },
        read: async (offset, length, readOptions) => {
          options.signal.throwIfAborted();
          readOptions?.signal?.throwIfAborted();
          return bytes.subarray(offset, offset + length);
        },
        stream: ({ start = 0, endExclusive = bytes.length, signal } = {}) =>
          Readable.from([bytes.subarray(start, endExclusive)], { signal }),
        close: vi.fn(async () => {}),
      }),
    );
    service = makeService();
  });
  afterEach(async () => {
    await Promise.all(closeFiles.splice(0).map((close) => close()));
    await Promise.all(instances.splice(0).map((instance) => instance.close()));
  });
  afterAll(async () => {
    await database?.destroy();
  });

  it('persists encrypted intent before issuance and retries a lost response with the same credential', async () => {
    let beforeIssue: Awaited<ReturnType<typeof credentials>> = [];
    transport.ensure.mockImplementationOnce(async () => {
      beforeIssue = await credentials();
      throw new DomainError('integration_unavailable');
    });
    await expect(open()).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(beforeIssue).toHaveLength(1);
    expect(beforeIssue[0]?.status).toBe('pending');
    expect(transport.open).not.toHaveBeenCalled();
    const first = transport.ensure.mock.calls[0]?.[0] as ViewerSftpCredentialRequest;
    expect(JSON.stringify(beforeIssue[0])).not.toContain(first.password);
    expect(
      JSON.parse(codec.decrypt(beforeIssue[0]?.envelope, `viewer:${first.credentialId}`)),
    ).toEqual(first);

    // A separate service instance also models an API restart after the remote response was lost.
    const reopened = await open(makeService());
    expect(await reopened.source.read(0, bytes.length)).toEqual(bytes);
    expect(transport.ensure.mock.calls[1]?.[0]).toEqual(first);
    expect(await credentials()).toEqual([
      expect.objectContaining({ id: first.credentialId, status: 'ready', external_user_id: 42 }),
    ]);
  });

  it('shares first credential issuance across concurrent opens and avoids warm duplicate authorization', async () => {
    const gate = Promise.withResolvers<void>();
    transport.ensure.mockImplementationOnce(async (request: ViewerSftpCredentialRequest) => {
      await gate.promise;
      return { ...request, externalUserId: 42 };
    });
    const first = open();
    const second = open();
    await vi.waitFor(() => expect(transport.ensure).toHaveBeenCalledTimes(1));
    gate.resolve();
    await Promise.all([first, second]);
    expect(await credentials()).toHaveLength(1);
    const initialChecks = authorize.mock.calls.length;
    expect(initialChecks).toBe(2);
    const warm = await open();
    for (let index = 0; index < 20; index++)
      expect(await warm.source.read(0, 3)).toEqual(bytes.subarray(0, 3));
    expect(authorize).toHaveBeenCalledTimes(initialChecks);
    expect(management.fileReadAccess).toHaveBeenCalledTimes(3);
    expect(transport.ensure).toHaveBeenCalledTimes(1);
  });

  it('does not recreate a durably revoked credential after an API restart', async () => {
    await (await open()).close();
    const [credential] = await credentials();
    if (!credential) throw new Error('fixture_missing_credential');
    await database.db
      .updateTable('viewer_sftp_credentials')
      .set({ status: 'revoked' })
      .where('id', '=', credential.id)
      .execute();
    const opens = transport.open.mock.calls.length;
    await expect(open(makeService())).rejects.toMatchObject({ code: 'forbidden' });
    expect(transport.open).toHaveBeenCalledTimes(opens);
    expect(transport.ensure).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a pending credential revoked while remote issuance is in flight', async () => {
    const gate = Promise.withResolvers<void>();
    transport.ensure.mockImplementationOnce(async (request: ViewerSftpCredentialRequest) => {
      await gate.promise;
      return { ...request, externalUserId: 42 };
    });
    const pending = open();
    const denied = expect(pending).rejects.toMatchObject({ code: 'forbidden' });
    await vi.waitFor(() => expect(transport.ensure).toHaveBeenCalledTimes(1));
    const [credential] = await credentials();
    if (!credential) throw new Error('fixture_missing_credential');
    expect(credential.status).toBe('pending');
    await database.db
      .updateTable('viewer_sftp_credentials')
      .set({ status: 'revoked' })
      .where('id', '=', credential.id)
      .execute();
    gate.resolve();
    await denied;
    expect(transport.open).not.toHaveBeenCalled();
    expect((await credentials())[0]?.status).toBe('revoked');
  });

  it('rechecks authorization after slow first issuance before exposing any bytes', async () => {
    authorize.mockRejectedValue(new DomainError('forbidden'));
    await expect(open()).rejects.toMatchObject({ code: 'forbidden' });
    expect(transport.ensure).toHaveBeenCalledTimes(1);
    expect(transport.open).not.toHaveBeenCalled();
    expect((await credentials())[0]?.status).toBe('ready');
  });

  it('retains retired identity and encrypted secret when a near-expiry credential rotates', async () => {
    await (await open()).close();
    const [original] = await credentials();
    if (!original) throw new Error('fixture_missing_credential');
    await database.db
      .updateTable('viewer_sftp_credentials')
      .set({ expires_at: new Date(Date.now() + 30_000) })
      .where('id', '=', original.id)
      .execute();
    await open(makeService());
    const rows = await credentials();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === original.id)).toMatchObject({
      status: 'retired',
      envelope: original.envelope,
      external_user_id: 42,
    });
    expect(rows.filter((row) => row.status === 'ready')).toHaveLength(1);
    expect(transport.revoke).toHaveBeenCalledWith(original.id);
    expect(transport.ensure.mock.calls[1]?.[0].credentialId).not.toBe(original.id);
  });

  it('fails a delayed old-generation open after provider settings change', async () => {
    const gate = Promise.withResolvers<void>();
    transport.ensure.mockImplementationOnce(async (request: ViewerSftpCredentialRequest) => {
      await gate.promise;
      return { ...request, externalUserId: 42 };
    });
    const stale = open();
    // Attach the rejection assertion before releasing the pending provider call.
    const staleRejected = expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(transport.ensure).toHaveBeenCalledTimes(1));
    const previous = JSON.parse(env.NH_FILE_VIEWERS ?? '{}');
    env.NH_FILE_VIEWERS = JSON.stringify({ ...previous, host: 'replacement.example.test' });
    await open();
    gate.resolve();
    await staleRejected;
    expect(transport.open).toHaveBeenCalledTimes(1);
    expect(transport.open.mock.calls[0]?.[0].host).toBe('replacement.example.test');
  });

  it('revokes all active same-session file sources through one shared authorization check', async () => {
    const first = await open();
    const second = await open();
    const before = authorize.mock.calls.length;
    authorize.mockRejectedValue(new DomainError('forbidden'));
    await vi.waitFor(
      () => {
        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(true);
      },
      { timeout: 2000, interval: 20 },
    );
    expect(authorize).toHaveBeenCalledTimes(before + 1);
    await expect(first.source.read(0, 1)).rejects.toThrow('viewer_access_revoked');
    await expect(second.source.read(0, 1)).rejects.toThrow('viewer_access_revoked');
  });

  it('invalidates active sources when the persisted credential is revoked', async () => {
    const current = await open();
    const [credential] = await credentials();
    if (!credential) throw new Error('fixture_missing_credential');
    await database.db
      .updateTable('viewer_sftp_credentials')
      .set({ status: 'revoked' })
      .where('id', '=', credential.id)
      .execute();
    await vi.waitFor(() => expect(current.signal.aborted).toBe(true), { timeout: 2000 });
    expect(transport.revoke).toHaveBeenCalledWith(credential.id);
    await expect(current.source.read(0, 1)).rejects.toThrow('viewer_access_revoked');
  });

  it('rejects unavailable configuration and unsafe paths before any provider access', async () => {
    await expect(open(service, undefined, '/../../other-server/private.key')).rejects.toThrow();
    delete env.NH_VIEWER_SFTPGO_API_KEY;
    await expect(open()).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(transport.ensure).not.toHaveBeenCalled();
    expect(transport.open).not.toHaveBeenCalled();
  });
});
