import { createHash } from 'node:crypto';
import { PassThrough, Readable, type Writable } from 'node:stream';
import { crc32, createInflateRaw } from 'node:zlib';
import { visitArchive } from './archive.js';
import { type ContentLimits, contentLimits, fail, safeArchivePath } from './contracts.js';
import { type ContentFileVerification, contentFileUnchanged } from './file-verification.js';

export interface ArchiveTransferMapping {
  source: string;
  target: string;
}
export interface ArchiveTransferReceipt {
  files: { path: string; size: number; sha256: string }[];
  /** Validated expanded bytes, not the ZIP's wire length. */
  bytes: number;
}
export interface ArchiveTransfer {
  readonly files: readonly { path: string; size: number }[];
  readonly contentLength: number;
  /** One consumer only. Upload success and completion are both required before extraction. */
  open(): ReadableStream<Uint8Array>;
  readonly completion: Promise<ArchiveTransferReceipt>;
  cancel(reason?: unknown): void;
}
interface Member {
  source: string;
  target: string;
  name: Buffer;
  size: number;
  compressedSize: number;
  method: number;
  checksum: number;
  offset: number;
}

function uint32(value: number): number {
  // All-ones fields are ZIP64 sentinels, not ordinary ZIP32 values.
  if (!Number.isSafeInteger(value) || value < 0 || value >= 0xffffffff) fail('archive_zip64');
  return value;
}

function localHeader(member: Member): Buffer {
  const header = Buffer.alloc(30 + member.name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6); // UTF-8, no data descriptor or encryption.
  header.writeUInt16LE(member.method, 8);
  header.writeUInt16LE(0x21, 12); // 1980-01-01, deterministic metadata.
  header.writeUInt32LE(member.checksum, 14);
  header.writeUInt32LE(member.compressedSize, 18);
  header.writeUInt32LE(member.size, 22);
  header.writeUInt16LE(member.name.length, 26);
  member.name.copy(header, 30);
  return header;
}

function centralHeader(member: Member): Buffer {
  const header = Buffer.alloc(46 + member.name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | 20, 4); // Unix creator.
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x800, 8);
  header.writeUInt16LE(member.method, 10);
  header.writeUInt16LE(0x21, 14);
  header.writeUInt32LE(member.checksum, 16);
  header.writeUInt32LE(member.compressedSize, 20);
  header.writeUInt32LE(member.size, 24);
  header.writeUInt16LE(member.name.length, 28);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(member.offset, 42);
  member.name.copy(header, 46);
  return header;
}

function endRecord(count: number, centralSize: number, offset: number): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(offset, 16);
  return record;
}

const errorFrom = (reason: unknown) =>
  reason instanceof Error ? reason : new Error('archive_transfer_cancelled');
const write = (destination: Writable, bytes: Buffer) =>
  new Promise<void>((resolve, reject) =>
    destination.write(bytes, (error) => (error ? reject(error) : resolve())),
  );

/**
 * Repackages selected ZIP members without re-compression or an expanded staging tree.
 * The trusted, ephemeral source seal is checked before/after inventory and transfer.
 * Raw bytes may reach disposable remote staging before validation finishes; the ZIP's
 * central directory and EOF are withheld until every selected member passes size,
 * CRC32 (including zero) and SHA-256 validation. Native extraction is a later step.
 */
export async function prepareArchiveTransfer(
  path: string,
  mappings: readonly ArchiveTransferMapping[],
  options: {
    verification: ContentFileVerification;
    limits?: Partial<ContentLimits>;
    signal?: AbortSignal;
  },
): Promise<ArchiveTransfer> {
  const limits = contentLimits(options.limits);
  const checkSource = async () => {
    options.signal?.throwIfAborted();
    if (
      options.verification.path !== path ||
      !/^[a-f0-9]{64}$/.test(options.verification.sha256) ||
      !(await contentFileUnchanged(path, options.verification.identity))
    )
      fail('archive_changed');
  };
  await checkSource();
  if (!mappings.length || mappings.length > limits.maxEntries) fail('archive_mapping');
  if (mappings.length >= 0xffff) fail('archive_zip64');
  const wanted = new Map<string, string>();
  const names = new Map<string, string>();
  const targets = new Set<string>();
  for (const { source, target } of mappings) {
    safeArchivePath(source);
    safeArchivePath(target);
    if (source.endsWith('/') || target.endsWith('/') || wanted.has(source)) fail('archive_mapping');
    const key = target.toLowerCase();
    if (targets.has(key)) fail('archive_mapping');
    targets.add(key);
    const parts = target.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      const canonical = names.get(prefix.toLowerCase());
      if (canonical !== undefined && canonical !== prefix) fail('archive_mapping');
      names.set(prefix.toLowerCase(), prefix);
    }
    wanted.set(source, target);
  }
  for (const target of targets) {
    const parts = target.split('/');
    if (parts.some((_, index) => index > 0 && targets.has(parts.slice(0, index).join('/'))))
      fail('archive_mapping');
  }

  const members: Member[] = [];
  let offset = 0;
  let centralSize = 0;
  await visitArchive(
    path,
    async (file) => {
      options.signal?.throwIfAborted();
      const target = wanted.get(file.path);
      if (target === undefined) return;
      const name = Buffer.from(target, 'utf8');
      if (name.length > 0xffff) fail('archive_zip64');
      members.push({
        source: file.path,
        target,
        name,
        size: uint32(file.size),
        compressedSize: uint32(file.entry.compressedSize),
        method: file.entry.compressionMethod,
        checksum: file.entry.crc32,
        offset: uint32(offset),
      });
      offset = uint32(offset + 30 + name.length + file.entry.compressedSize);
      centralSize = uint32(centralSize + 46 + name.length);
    },
    limits,
  );
  if (members.length !== mappings.length) fail('archive_mapping');
  const contentLength = uint32(offset + centralSize + 22);
  await checkSource();

  const internal = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([internal.signal, options.signal])
    : internal.signal;
  let used = false;
  let settled = false;
  let output: PassThrough | undefined;
  const active = new Set<Readable>();
  let resolveCompletion!: (receipt: ArchiveTransferReceipt) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<ArchiveTransferReceipt>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A caller can fail authorization or dispatch before observing completion.
  void completion.catch(() => {});
  const aborted = () => {
    const error = errorFrom(signal.reason);
    for (const source of active) source.destroy(error);
    output?.destroy(error);
    if (!settled) {
      settled = true;
      rejectCompletion(error);
    }
  };
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();

  const run = async (destination: PassThrough): Promise<ArchiveTransferReceipt> => {
    signal.throwIfAborted();
    await checkSource();
    const receipt: ArchiveTransferReceipt = { files: [], bytes: 0 };
    let index = 0;
    await visitArchive(
      path,
      async (file) => {
        signal.throwIfAborted();
        if (!wanted.has(file.path)) return;
        const member = members[index++];
        if (
          !member ||
          member.source !== file.path ||
          member.size !== file.size ||
          member.compressedSize !== file.entry.compressedSize ||
          member.checksum !== file.entry.crc32 ||
          member.method !== file.entry.compressionMethod
        )
          fail('archive_changed');
        const hash = createHash('sha256');
        let expanded = 0;
        let checksum = 0;
        const validate = (chunk: Buffer) => {
          expanded += chunk.length;
          if (expanded > member.size) fail('archive_integrity');
          hash.update(chunk);
          checksum = crc32(chunk, checksum);
        };
        const raw = await file.openRaw();
        // Abort may arrive while the ZIP header is waiting on downstream demand,
        // before the async iterator starts observing this source.
        raw.on('error', () => {});
        active.add(raw);
        const inflater =
          member.method === 8 ? createInflateRaw({ chunkSize: 256 * 1024 }) : undefined;
        if (inflater) active.add(inflater);
        // Attach both consumers before any writes; an inflate failure aborts the
        // output and raw source immediately, including while backpressure waits.
        const validated = inflater
          ? (async () => {
              for await (const chunk of inflater) validate(Buffer.from(chunk));
            })()
          : undefined;
        if (validated) void validated.catch((error) => internal.abort(error));
        try {
          signal.throwIfAborted();
          await write(destination, localHeader(member));
          let compressed = 0;
          for await (const value of raw) {
            signal.throwIfAborted();
            const chunk = Buffer.from(value);
            compressed += chunk.length;
            if (compressed > member.compressedSize) fail('archive_integrity');
            if (inflater) await Promise.all([write(inflater, chunk), write(destination, chunk)]);
            else {
              validate(chunk);
              await write(destination, chunk);
            }
          }
          inflater?.end();
          await validated;
          if (
            compressed !== member.compressedSize ||
            expanded !== member.size ||
            checksum !== member.checksum ||
            (inflater && inflater.bytesWritten !== compressed)
          )
            fail('archive_integrity');
          receipt.files.push({ path: member.target, size: expanded, sha256: hash.digest('hex') });
          receipt.bytes += expanded;
        } finally {
          active.delete(raw);
          raw.destroy();
          if (inflater) {
            active.delete(inflater);
            inflater.destroy();
          }
          // Join the observer even when raw/output failed first.
          await validated?.catch(() => {});
        }
      },
      limits,
    );
    if (index !== members.length) fail('archive_changed');
    signal.throwIfAborted();
    await checkSource();
    // A failing transfer never publishes a complete ZIP or a successful receipt.
    for (const member of members) {
      signal.throwIfAborted();
      await write(destination, centralHeader(member));
    }
    signal.throwIfAborted();
    await write(destination, endRecord(members.length, centralSize, offset));
    return receipt;
  };

  return {
    files: Object.freeze(
      members.map((member) => Object.freeze({ path: member.target, size: member.size })),
    ),
    contentLength,
    completion,
    cancel(reason) {
      internal.abort(errorFrom(reason));
    },
    open() {
      if (used) fail('archive_transfer_consumed');
      used = true;
      signal.throwIfAborted();
      const destination = new PassThrough({ highWaterMark: 64 * 1024 });
      output = destination;
      // Readable.toWeb installs its error handler synchronously, before run starts.
      const stream = Readable.toWeb(destination, {
        strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
      }) as ReadableStream<Uint8Array>;
      destination.once('close', () => {
        if (!settled) internal.abort(new Error('archive_transfer_cancelled'));
      });
      void run(destination).then(
        (receipt) => {
          if (signal.aborted) return;
          settled = true;
          signal.removeEventListener('abort', aborted);
          destination.end();
          resolveCompletion(receipt);
        },
        (error) => {
          internal.abort(error);
          signal.removeEventListener('abort', aborted);
        },
      );
      return stream;
    },
  };
}
