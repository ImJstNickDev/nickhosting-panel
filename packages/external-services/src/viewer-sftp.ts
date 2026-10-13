import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { DomainError } from '@nickhosting/core';
import { Client, type SFTPWrapper, type Stats } from 'ssh2';

/** Private connection material. The caller owns the encrypted durable credential and live authorization. */
export interface ViewerSftpConnection {
  serverId: string;
  externalServerUuid: string;
  credentialId: string;
  host: string;
  port: number;
  username: string;
  password: string;
  /** OpenSSH SHA256:<base64, without padding>; never trust-on-first-use. */
  hostFingerprint: string;
  expiresAt: number;
}

export interface ViewerSftpStat {
  size: number;
  mtimeMs: number;
  mode: number;
}

export interface ViewerSftpFile {
  /** Metadata from fstat on this open handle, not a preceding path lookup. */
  readonly stat: Readonly<ViewerSftpStat>;
  read(offset: number, length: number, options?: { signal?: AbortSignal }): Promise<Buffer>;
  /** Exclusive end, bounded buffering. Closing/cancelling the stream closes this file handle. */
  stream(options?: { start?: number; endExclusive?: number; signal?: AbortSignal }): Readable;
  close(): Promise<void>;
}

export interface ViewerSftpPoolOptions {
  maxConnections?: number;
  maxOpenFilesPerConnection?: number;
  maxConcurrentPerConnection?: number;
  maxPendingPerConnection?: number;
  idleTimeoutMs?: number;
  operationTimeoutMs?: number;
  maxReadBytes?: number;
  streamChunkBytes?: number;
}

function unavailable(): DomainError {
  return new DomainError('integration_unavailable');
}

function providerError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const code = (error as { code?: unknown } | undefined)?.code;
  return new DomainError(
    code === 2 ? 'not_found' : code === 3 ? 'forbidden' : 'integration_unavailable',
  );
}

/** SFTPGo confines the account to one server root, including symlink resolution. No host paths enter this API. */
export function viewerSftpPath(path: string): string {
  if (
    typeof path !== 'string' ||
    path.length < 1 ||
    path.length > 4096 ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '..' || part === '.') ||
    path.includes('//')
  )
    throw new DomainError('validation_failed');
  return path.startsWith('/') ? path : `/${path}`;
}

function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new DomainError('configuration_invalid');
  return value;
}

function validateConnection(input: ViewerSftpConnection): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !uuid.test(input.serverId) ||
    !uuid.test(input.externalServerUuid) ||
    !uuid.test(input.credentialId) ||
    !input.host ||
    input.host.length > 253 ||
    /[\s/\\]/.test(input.host) ||
    input.host.includes('\0') ||
    !/^nhv_[0-9a-f]{32}$/.test(input.username) ||
    input.username !== `nhv_${input.credentialId.replaceAll('-', '').toLowerCase()}` ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(input.password) ||
    !/^SHA256:[A-Za-z0-9+/]{43}$/.test(input.hostFingerprint) ||
    !Number.isSafeInteger(input.expiresAt)
  )
    throw new DomainError('configuration_invalid');
  integer(input.port, 1, 65535);
  if (input.expiresAt <= Date.now()) throw new DomainError('forbidden');
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(providerError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(providerError(signal.reason));
    };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(providerError(error));
      },
    );
  });
}

/** Small FIFO with a fixed pending bound; cancelled callers never retain a queue slot. */
class Permits {
  active = 0;
  readonly pending = new Set<() => void>();
  constructor(
    readonly limit: number,
    readonly maxPending: number,
  ) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(providerError(signal.reason));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    if (this.pending.size >= this.maxPending) return Promise.reject(new DomainError('conflict'));
    return new Promise((resolve, reject) => {
      const aborted = () => {
        this.pending.delete(grant);
        reject(providerError(signal.reason));
      };
      const grant = () => {
        signal.removeEventListener('abort', aborted);
        this.active++;
        resolve(() => this.release());
      };
      this.pending.add(grant);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  release(): void {
    this.active--;
    const next = this.pending.values().next().value;
    if (next) {
      this.pending.delete(next);
      next();
    }
  }
}

interface Entry {
  key: string;
  serverId: string;
  credentialId: string;
  expiresAt: number;
  client: Client;
  sftp: Promise<SFTPWrapper>;
  controller: AbortController;
  permits: Permits;
  openFiles: number;
  ready: boolean;
  lastUsed: number;
}

/**
 * One private SSH/SFTP session per immutable identity. Authorization belongs to the API's shared
 * access guard; it must also abort open requests when access is revoked. This pool never calls
 * Panel/Wings or logs connection material. revoke* closes retained SSH transports (issue #18).
 */
export class ViewerSftpPool {
  readonly #entries = new Map<string, Entry>();
  readonly #options: Required<ViewerSftpPoolOptions>;
  readonly #timer: ReturnType<typeof setInterval>;
  #disposed = false;

  constructor(options: ViewerSftpPoolOptions = {}) {
    this.#options = {
      maxConnections: integer(options.maxConnections ?? 16, 1, 128),
      maxOpenFilesPerConnection: integer(options.maxOpenFilesPerConnection ?? 16, 1, 128),
      maxConcurrentPerConnection: integer(options.maxConcurrentPerConnection ?? 4, 1, 16),
      maxPendingPerConnection: integer(options.maxPendingPerConnection ?? 32, 0, 256),
      idleTimeoutMs: integer(options.idleTimeoutMs ?? 60_000, 10, 600_000),
      operationTimeoutMs: integer(options.operationTimeoutMs ?? 15_000, 10, 60_000),
      maxReadBytes: integer(options.maxReadBytes ?? 4 * 1024 * 1024, 1, 16 * 1024 * 1024),
      streamChunkBytes: integer(options.streamChunkBytes ?? 256 * 1024, 1024, 1024 * 1024),
    };
    if (this.#options.streamChunkBytes > this.#options.maxReadBytes)
      throw new DomainError('configuration_invalid');
    this.#timer = setInterval(
      () => {
        const now = Date.now();
        for (const entry of this.#entries.values()) {
          if (entry.expiresAt <= now) this.#drop(entry, new DomainError('forbidden'));
          else if (
            entry.ready &&
            !entry.openFiles &&
            !entry.permits.active &&
            now - entry.lastUsed >= this.#options.idleTimeoutMs
          )
            this.#drop(entry, unavailable());
        }
      },
      Math.min(this.#options.idleTimeoutMs, 1000),
    );
    this.#timer.unref();
  }

  #drop(entry: Entry, reason: DomainError): void {
    if (entry.controller.signal.aborted) return;
    this.#entries.delete(entry.key);
    entry.controller.abort(reason);
    entry.client.destroy();
  }

  #entry(input: ViewerSftpConnection): Entry {
    if (this.#disposed) throw unavailable();
    validateConnection(input);
    // Including the private password digest avoids silently retaining an old session after rotation.
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          input.serverId,
          input.externalServerUuid,
          input.credentialId,
          input.host,
          input.port,
          input.username,
          input.password,
          input.hostFingerprint,
          input.expiresAt,
        ]),
      )
      .digest('hex');
    const existing = this.#entries.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (this.#entries.size >= this.#options.maxConnections) {
      const oldest = [...this.#entries.values()]
        .filter(
          (entry) =>
            entry.ready && !entry.openFiles && !entry.permits.active && !entry.permits.pending.size,
        )
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) throw new DomainError('conflict');
      this.#drop(oldest, unavailable());
    }
    const client = new Client();
    const controller = new AbortController();
    let resolveSftp!: (sftp: SFTPWrapper) => void;
    let rejectSftp!: (error: DomainError) => void;
    const sftp = new Promise<SFTPWrapper>((resolve, reject) => {
      resolveSftp = resolve;
      rejectSftp = reject;
    });
    // Disposal can precede a waiting caller attaching; consumers still observe the original rejection.
    void sftp.catch(() => {});
    const entry: Entry = {
      key,
      serverId: input.serverId,
      credentialId: input.credentialId,
      expiresAt: input.expiresAt,
      client,
      sftp,
      controller,
      permits: new Permits(
        this.#options.maxConcurrentPerConnection,
        this.#options.maxPendingPerConnection,
      ),
      openFiles: 0,
      ready: false,
      lastUsed: Date.now(),
    };
    this.#entries.set(key, entry);
    controller.signal.addEventListener(
      'abort',
      () => rejectSftp(providerError(controller.signal.reason)),
      { once: true },
    );
    client.on('error', () => this.#drop(entry, unavailable()));
    client.once('close', () => this.#drop(entry, unavailable()));
    client.once('ready', () =>
      client.sftp((error, channel) => {
        if (error) {
          this.#drop(entry, unavailable());
          return;
        }
        if (controller.signal.aborted) {
          channel.end();
          return;
        }
        channel.on('error', () => this.#drop(entry, unavailable()));
        channel.once('close', () => this.#drop(entry, unavailable()));
        entry.ready = true;
        resolveSftp(channel);
      }),
    );
    const expected = Buffer.from(input.hostFingerprint.slice(7), 'base64');
    try {
      client.connect({
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password,
        readyTimeout: this.#options.operationTimeoutMs,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 2,
        hostVerifier: (key: Buffer) =>
          timingSafeEqual(createHash('sha256').update(key).digest(), expected),
      });
      // OPEN/FSTAT/READ are small request/response exchanges. Avoid Nagle waiting
      // for delayed ACKs between them; ssh2 creates its socket synchronously above.
      client.setNoDelay(true);
    } catch {
      this.#drop(entry, unavailable());
    }
    return entry;
  }

  async #operation<T>(
    entry: Entry,
    signal: AbortSignal | undefined,
    run: (sftp: SFTPWrapper, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (entry.expiresAt <= Date.now()) this.#drop(entry, new DomainError('forbidden'));
    const combined = AbortSignal.any([entry.controller.signal, ...(signal ? [signal] : [])]);
    const release = await entry.permits.acquire(combined);
    const timeout = setTimeout(
      () => this.#drop(entry, unavailable()),
      this.#options.operationTimeoutMs,
    );
    timeout.unref();
    try {
      const channel = await waitFor(entry.sftp, combined);
      return await waitFor(run(channel, combined), combined);
    } finally {
      clearTimeout(timeout);
      entry.lastUsed = Date.now();
      release();
    }
  }

  async openFile(
    input: ViewerSftpConnection,
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ViewerSftpFile> {
    const safePath = viewerSftpPath(path);
    if (options.signal?.aborted) throw providerError(options.signal.reason);
    const entry = this.#entry(input);
    if (entry.openFiles >= this.#options.maxOpenFilesPerConnection)
      throw new DomainError('conflict');
    entry.openFiles++;
    let handle: Buffer | undefined;
    let closed = false;
    const fileController = new AbortController();
    const accessSignal = AbortSignal.any([
      entry.controller.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const signal = AbortSignal.any([accessSignal, fileController.signal]);
    const close = async () => {
      if (closed) return;
      closed = true;
      entry.openFiles--;
      fileController.abort(unavailable());
      if (!handle || entry.controller.signal.aborted) return;
      const current = handle;
      handle = undefined;
      try {
        await this.#operation(
          entry,
          undefined,
          (channel) =>
            new Promise<void>((resolve, reject) => {
              channel.close(current, (error) => (error ? reject(error) : resolve()));
            }),
        );
      } catch {
        /* A failed CLOSE invalidates the connection rather than leaking a remote handle. */
        this.#drop(entry, unavailable());
      }
    };
    signal.addEventListener(
      'abort',
      () => {
        void close();
      },
      { once: true },
    );
    try {
      const stat = await this.#operation(
        entry,
        signal,
        (channel, operationSignal) =>
          new Promise<Stats>((resolve, reject) => {
            channel.open(safePath, 'r', (error, opened) => {
              if (error) {
                reject(error);
                return;
              }
              // An aborted OPEN can complete later: close that handle, never adopt it.
              if (closed || operationSignal.aborted) {
                channel.close(opened, () => {});
                reject(unavailable());
                return;
              }
              handle = opened;
              channel.fstat(opened, (error, value) => (error ? reject(error) : resolve(value)));
            });
          }),
      );
      if (
        !stat.isFile() ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        !Number.isFinite(stat.mtime)
      )
        throw new DomainError('validation_failed');
      const metadata: Readonly<ViewerSftpStat> = Object.freeze({
        size: stat.size,
        mtimeMs: stat.mtime * 1000,
        mode: stat.mode,
      });
      const read = async (
        offset: number,
        length: number,
        readOptions: { signal?: AbortSignal } = {},
      ): Promise<Buffer> => {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > this.#options.maxReadBytes
        )
          throw new DomainError('validation_failed');
        if (closed) throw unavailable();
        const requested = Math.min(length, Math.max(0, metadata.size - offset));
        const readSignal = AbortSignal.any([
          signal,
          ...(readOptions.signal ? [readOptions.signal] : []),
        ]);
        if (readSignal.aborted) throw providerError(readSignal.reason);
        if (!requested) return Buffer.alloc(0);
        const aborted = () => {
          void close();
        };
        readSignal.addEventListener('abort', aborted, { once: true });
        try {
          return await this.#operation(entry, readSignal, async (channel, operationSignal) => {
            const data = Buffer.allocUnsafe(requested);
            let bytes = 0;
            while (bytes < requested) {
              if (operationSignal.aborted || !handle) throw unavailable();
              const count = await waitFor(
                new Promise<number>((resolve, reject) => {
                  channel.read(
                    handle as Buffer,
                    data,
                    bytes,
                    requested - bytes,
                    offset + bytes,
                    (error, count) => (error ? reject(error) : resolve(count)),
                  );
                }),
                operationSignal,
              );
              if (!count) throw new DomainError('conflict'); // Truncation after fstat; don't claim a complete range.
              bytes += count;
            }
            return data;
          });
        } finally {
          readSignal.removeEventListener('abort', aborted);
        }
      };
      const chunkBytes = this.#options.streamChunkBytes;
      return {
        stat: metadata,
        read,
        stream: (streamOptions = {}) => {
          const start = streamOptions.start ?? 0;
          const end = streamOptions.endExclusive ?? metadata.size;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end < start ||
            end > metadata.size
          )
            throw new DomainError('validation_failed');
          const streamController = new AbortController();
          const streamSignal = AbortSignal.any([
            streamController.signal,
            ...(streamOptions.signal ? [streamOptions.signal] : []),
          ]);
          let position = start;
          const stream = new Readable({
            highWaterMark: chunkBytes,
            read() {
              if (position === end) {
                this.push(null);
                return;
              }
              void read(position, Math.min(chunkBytes, end - position), {
                signal: streamSignal,
              }).then(
                (data) => {
                  if (this.destroyed) return;
                  position += data.length;
                  this.push(data);
                },
                (error) => this.destroy(providerError(error)),
              );
            },
            destroy(error, callback) {
              streamController.abort();
              void close().then(
                () => callback(error),
                (failure) => callback(error ?? providerError(failure)),
              );
            },
          });
          const aborted = () => stream.destroy(providerError(accessSignal.reason));
          const requestAborted = () => stream.destroy(providerError(streamOptions.signal?.reason));
          accessSignal.addEventListener('abort', aborted, { once: true });
          streamOptions.signal?.addEventListener('abort', requestAborted, { once: true });
          stream.once('close', () => {
            accessSignal.removeEventListener('abort', aborted);
            streamOptions.signal?.removeEventListener('abort', requestAborted);
            void close();
          });
          if (signal.aborted || streamOptions.signal?.aborted) stream.destroy(unavailable());
          return stream;
        },
        close,
      };
    } catch (error) {
      await close();
      throw providerError(error);
    }
  }

  /** Caller first revokes durable access; invalidation alone is not a durable revocation registry. */
  revokeCredential(credentialId: string): void {
    for (const entry of this.#entries.values())
      if (entry.credentialId === credentialId) this.#drop(entry, new DomainError('forbidden'));
  }

  revokeServer(serverId: string): void {
    for (const entry of this.#entries.values())
      if (entry.serverId === serverId) this.#drop(entry, new DomainError('forbidden'));
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#timer);
    for (const entry of this.#entries.values()) this.#drop(entry, unavailable());
  }
}
