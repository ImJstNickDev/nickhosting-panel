import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  type AuthContext,
  authSessionId,
  DomainError,
  type PlatformConfig,
  type SecretCodec,
} from '@nickhosting/core';
import { type Database, getSecret, getSettings } from '@nickhosting/database';
import {
  generateSftpPassword,
  SftpGoViewerAdapter,
  type ViewerSftpConnection,
  type ViewerSftpCredentialRequest,
  ViewerSftpPool,
} from '@nickhosting/external-services';
import { relativePath } from '@nickhosting/pterodactyl-adapter';
import type { ManagementRuntime } from '@nickhosting/server-management';
import { type Kysely, sql } from 'kysely';
import { ViewerAccessWatch } from './viewer-access-watch.js';
import { ViewerCache, type ViewerReadSource } from './viewer-cache.js';

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Credential = ViewerSftpConnection & { issuedNow: boolean };
type Settings = {
  values: Readonly<PlatformConfig>;
  key: string | null | undefined;
  signature: string;
};
type Generation = {
  pool: ViewerSftpPool;
  watch: ViewerAccessWatch;
  cache: ViewerCache;
  controller: AbortController;
  signature: string;
};

/** One manager per API runtime, not one adapter/cache per HTTP request or viewer. */
export class FileViewerService {
  #pool = new ViewerSftpPool();
  #watch = new ViewerAccessWatch();
  #signature?: string;
  #cache?: ViewerCache;
  #generation?: Generation;
  #settingsRead?: Promise<Settings>;
  #ensures = new Map<string, Promise<Credential>>();
  #credentials = new Map<string, { connection: Credential; checkedAt: number }>();
  #configuring = Promise.resolve();
  constructor(
    readonly options: {
      db: Kysely<Database>;
      codec: SecretCodec;
      env: Readonly<Record<string, string | undefined>>;
    },
  ) {}

  async settings(): Promise<Settings> {
    if (this.#settingsRead) return this.#settingsRead;
    this.#settingsRead = Promise.all([
      getSettings(this.options.db, this.options.env),
      getSecret(this.options.db, this.options.codec, 'viewerSftpgoApiKey', this.options.env),
    ])
      .then(([{ values }, key]) => ({
        values,
        key,
        signature: fingerprint([values.fileViewers, key]),
      }))
      .finally(() => {
        this.#settingsRead = undefined;
      });
    return this.#settingsRead;
  }
  configured(settings: Settings) {
    const { values, key } = settings;
    return !!(values.fileViewers && key);
  }
  async #configure(settings: Settings): Promise<Generation> {
    if (!this.configured(settings)) throw new DomainError('integration_unavailable');
    const config = settings.values.fileViewers!;
    const configure = async () => {
      if (this.#signature !== settings.signature) {
        this.#generation?.controller.abort();
        this.#pool.dispose();
        this.#watch.close();
        await this.#cache?.close();
        this.#pool = new ViewerSftpPool({
          maxConnections: config.maxConnections,
          maxOpenFilesPerConnection: 64,
        });
        this.#watch = new ViewerAccessWatch();
        this.#cache = new ViewerCache({
          root: config.cacheRoot,
          maxBytes: config.cacheBytes,
          maxFileBytes: config.maxSnapshotBytes,
        });
        this.#signature = settings.signature;
        this.#generation = {
          pool: this.#pool,
          watch: this.#watch,
          cache: this.#cache,
          controller: new AbortController(),
          signature: settings.signature,
        };
        this.#credentials.clear();
      }
      if (!this.#generation) throw new DomainError('integration_unavailable');
      return this.#generation;
    };
    const pending = this.#configuring.then(configure, configure);
    this.#configuring = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
  #provider(settings: Settings) {
    return new SftpGoViewerAdapter({
      baseURL: settings.values.fileViewers!.managementUrl,
      dataRoot: settings.values.fileViewers!.dataRoot,
      instanceId: settings.values.fileViewers!.instanceId,
      auth: { apiKey: settings.key! },
    });
  }
  async #credential(
    serverId: string,
    uuid: string,
    identity: string,
    settings: Settings,
  ): Promise<Credential> {
    const binding = fingerprint([settings.signature, identity]);
    const key = `${serverId}:${binding}`;
    const cached = this.#credentials.get(key);
    if (
      cached &&
      cached.checkedAt + 1000 > Date.now() &&
      cached.connection.expiresAt > Date.now() + 60_000
    )
      return { ...cached.connection, issuedNow: false };
    const existing = this.#ensures.get(key);
    if (existing) return existing;
    const work = this.#ensureCredential(serverId, uuid, binding, settings);
    this.#ensures.set(key, work);
    try {
      const connection = await work;
      if (this.#credentials.size >= 256)
        this.#credentials.delete(this.#credentials.keys().next().value!);
      this.#credentials.set(key, { connection, checkedAt: Date.now() });
      return connection;
    } finally {
      if (this.#ensures.get(key) === work) this.#ensures.delete(key);
    }
  }
  async #ensureCredential(
    serverId: string,
    uuid: string,
    binding: string,
    settings: Settings,
  ): Promise<Credential> {
    const { db, codec } = this.options;
    // Persist intent before remote account creation. A lost response retries the
    // same private account; there is no password reset or game-directory write.
    const current = await db
      .selectFrom('viewer_sftp_credentials')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('binding', '=', binding)
      .where('status', '!=', 'retired')
      .executeTakeFirst();
    if (current?.status === 'revoked') throw new DomainError('forbidden');
    const row =
      current && current.expires_at.getTime() > Date.now() + 60_000
        ? current
        : await db.transaction().execute(async (tx) => {
            await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ${`:viewer-credential:${serverId}`},0))`.execute(
              tx,
            );
            const previous = await tx
              .selectFrom('viewer_sftp_credentials')
              .selectAll()
              .where('server_id', '=', serverId)
              .where('binding', '=', binding)
              .where('status', '!=', 'retired')
              .executeTakeFirst();
            if (previous?.status === 'revoked') throw new DomainError('forbidden');
            if (previous && previous.expires_at.getTime() > Date.now() + 60_000) return previous;
            if (previous) {
              this.#pool.revokeCredential(previous.id);
              await tx
                .updateTable('viewer_sftp_credentials')
                .set({ status: 'retired' })
                .where('id', '=', previous.id)
                .execute();
            }
            const id = randomUUID();
            const request: ViewerSftpCredentialRequest = {
              serverId,
              externalServerUuid: uuid,
              credentialId: id,
              password: generateSftpPassword(),
              expiresAt: Date.now() + 86_400_000,
            };
            const envelope = codec.encrypt(JSON.stringify(request), `viewer:${id}`);
            return tx
              .insertInto('viewer_sftp_credentials')
              .values({
                id,
                server_id: serverId,
                binding,
                envelope,
                expires_at: new Date(request.expiresAt),
                status: 'pending',
                external_user_id: null,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
          });
    const request = JSON.parse(
      codec.decrypt(row.envelope, `viewer:${row.id}`),
    ) as ViewerSftpCredentialRequest;
    if (
      request.serverId !== serverId ||
      request.externalServerUuid !== uuid ||
      request.credentialId !== row.id
    )
      throw new DomainError('conflict');
    if (row.status === 'pending') {
      const remote = await this.#provider(settings).ensureCredential(request);
      const saved = await db
        .updateTable('viewer_sftp_credentials')
        .set({ status: 'ready', external_user_id: remote.externalUserId })
        .where('id', '=', row.id)
        .where('status', '=', 'pending')
        .returning('id')
        .executeTakeFirst();
      if (!saved) {
        const latest = await db
          .selectFrom('viewer_sftp_credentials')
          .select('status')
          .where('id', '=', row.id)
          .executeTakeFirst();
        if (latest?.status !== 'ready') throw new DomainError('forbidden');
      }
    }
    const config = settings.values.fileViewers!;
    return {
      ...request,
      issuedNow: row.status === 'pending',
      host: config.host,
      port: config.port,
      hostFingerprint: config.hostFingerprint.replace(/=$/, ''),
      username: `nhv_${row.id.replaceAll('-', '')}`,
    };
  }
  async open(
    context: AuthContext,
    service: ManagementRuntime,
    serverId: string,
    inputPath: string,
    requestSignal: AbortSignal,
  ) {
    const path = relativePath(inputPath).slice(1);
    const settings = await this.settings();
    const generation = await this.#configure(settings);
    const server = await service.fileReadAccess(
      context,
      serverId,
      async (_id, _db, _context, server) => server,
    );
    if (!server.pterodactyl_uuid) throw new DomainError('conflict');
    const identity = service.uploadBatchBinding(server);
    const connection = await this.#credential(
      serverId,
      server.pterodactyl_uuid,
      identity,
      settings,
    );
    generation.controller.signal.throwIfAborted();
    // Issuing a first credential can take longer than a local request; recheck
    // current permission before opening bytes (not once per chunk).
    if (connection.issuedNow)
      await service.authorizeTransfer(context, serverId, false, undefined, undefined, server);
    const watchKey = fingerprint([
      context[authSessionId],
      context.actorUserId,
      context.subjectUserId,
      context.support?.id,
      serverId,
      identity,
      connection.credentialId,
    ]);
    const watch = generation.watch.subscribe(watchKey, async () => {
      const [current, row] = await Promise.all([
        this.settings(),
        this.options.db
          .selectFrom('viewer_sftp_credentials')
          .select(['status', 'expires_at'])
          .where('id', '=', connection.credentialId)
          .executeTakeFirst(),
        service.authorizeTransfer(context, serverId, false, undefined, undefined, server),
      ]);
      if (
        current.signature !== settings.signature ||
        row?.status !== 'ready' ||
        row.expires_at.getTime() <= Date.now()
      ) {
        generation.pool.revokeCredential(connection.credentialId);
        throw new DomainError('forbidden');
      }
    });
    const signal = AbortSignal.any([requestSignal, watch.signal, generation.controller.signal]);
    try {
      const file = await generation.pool.openFile(connection, path, { signal });
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        watch.release();
        await file.close();
      };
      const source: ViewerReadSource = {
        size: file.stat.size,
        mtimeMs: file.stat.mtimeMs,
        read: (offset, length, otherSignal) =>
          file.read(offset, length, {
            signal: otherSignal ? AbortSignal.any([signal, otherSignal]) : signal,
          }),
        stream: (start, endExclusive, otherSignal) => {
          const streamSignal = otherSignal ? AbortSignal.any([signal, otherSignal]) : signal;
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let cancelled = false;
          return new ReadableStream<Uint8Array>({
            start: async () => {
              const bodyFile = await generation.pool.openFile(connection, path, {
                signal: streamSignal,
              });
              if (cancelled) {
                await bodyFile.close();
                return;
              }
              if (
                bodyFile.stat.size !== file.stat.size ||
                bodyFile.stat.mtimeMs !== file.stat.mtimeMs
              ) {
                await bodyFile.close();
                throw new DomainError('conflict');
              }
              reader = (
                Readable.toWeb(
                  bodyFile.stream({ start, endExclusive, signal: streamSignal }),
                ) as ReadableStream<Uint8Array>
              ).getReader();
            },
            async pull(controller) {
              if (!reader) return;
              const item = await reader.read();
              if (item.done) controller.close();
              else controller.enqueue(item.value);
            },
            async cancel() {
              cancelled = true;
              await reader?.cancel();
            },
          });
        },
      };
      return {
        source,
        signal,
        close,
        path,
        cache: generation.cache,
        key: fingerprint([identity, settings.signature, path, file.stat.size, file.stat.mtimeMs]),
        restat: async () => {
          const current = await generation.pool.openFile(connection, path, { signal });
          try {
            return current.stat;
          } finally {
            await current.close();
          }
        },
        siblingExists: async (suffix: string) => {
          try {
            const sibling = await generation.pool.openFile(connection, `${path}${suffix}`, {
              signal,
            });
            await sibling.close();
            return true;
          } catch (error) {
            if (error instanceof DomainError && error.code === 'not_found') return false;
            throw error;
          }
        },
      };
    } catch (error) {
      watch.release();
      throw error;
    }
  }
  async close() {
    this.#generation?.controller.abort();
    this.#pool.dispose();
    this.#watch.close();
    await this.#cache?.close();
  }
}
