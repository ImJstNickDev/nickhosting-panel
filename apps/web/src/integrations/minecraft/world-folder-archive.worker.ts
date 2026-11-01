import type {
  WorldFolderArchiveInput,
  WorldFolderArchiveProgress,
} from './world-folder-archive.js';

// PKWARE APPNOTE 6.3.10 §4.3/4.5.3: stored entries, UTF-8 names, ZIP64 sizes/offsets.
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// Always using ZIP64 keeps aggregate archives above 4 GiB correct without a second
// read. Minecraft region files are already compressed; no recompression needed.
const maxArchiveBytes = 8 * 1024 ** 3;
const chunkSize = 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const record = (length: number) => new DataView(new ArrayBuffer(length));
const u16 = (data: DataView, offset: number, value: number) => data.setUint16(offset, value, true);
const u32 = (data: DataView, offset: number, value: number) => data.setUint32(offset, value, true);
const u64 = (data: DataView, offset: number, value: number) =>
  data.setBigUint64(offset, BigInt(value), true);

/** Header construction is separate from I/O so ZIP64 offsets can be tested without GiB allocations. */
export function worldFolderZipLayout(entries: readonly { path: string; size: number }[]) {
  if (entries.length === 0 || entries.length > 10000) throw new Error('limit_exceeded');
  let offset = 0;
  let directorySize = 0;
  const layout = entries.map(({ path, size }) => {
    const name = new TextEncoder().encode(path);
    if (!Number.isSafeInteger(size) || size < 0 || name.length > 65535)
      throw new Error('limit_exceeded');
    const start = offset;
    offset += 50 + name.length + size;
    directorySize += 74 + name.length;
    return { name, size, offset: start };
  });
  const archiveSize = offset + directorySize + 98;
  if (!Number.isSafeInteger(archiveSize) || archiveSize > maxArchiveBytes)
    throw new Error('limit_exceeded');
  return { entries: layout, directoryOffset: offset, directorySize, archiveSize };
}
function entryHeaders(
  entry: ReturnType<typeof worldFolderZipLayout>['entries'][number],
  crc: number,
) {
  const local = record(50 + entry.name.length);
  u32(local, 0, 0x04034b50);
  u16(local, 4, 45);
  u16(local, 6, 0x800);
  u16(local, 12, 0x21); // DOS date 1980-01-01; time 00:00.
  u32(local, 14, crc);
  u32(local, 18, 0xffffffff);
  u32(local, 22, 0xffffffff);
  u16(local, 26, entry.name.length);
  u16(local, 28, 20);
  new Uint8Array(local.buffer).set(entry.name, 30);
  const extra = 30 + entry.name.length;
  u16(local, extra, 1);
  u16(local, extra + 2, 16);
  u64(local, extra + 4, entry.size);
  u64(local, extra + 12, entry.size);
  const central = record(74 + entry.name.length);
  u32(central, 0, 0x02014b50);
  u16(central, 4, 45);
  u16(central, 6, 45);
  u16(central, 8, 0x800);
  u16(central, 14, 0x21);
  u32(central, 16, crc);
  u32(central, 20, 0xffffffff);
  u32(central, 24, 0xffffffff);
  u16(central, 28, entry.name.length);
  u16(central, 30, 28);
  u32(central, 42, 0xffffffff);
  new Uint8Array(central.buffer).set(entry.name, 46);
  const centralExtra = 46 + entry.name.length;
  u16(central, centralExtra, 1);
  u16(central, centralExtra + 2, 24);
  u64(central, centralExtra + 4, entry.size);
  u64(central, centralExtra + 12, entry.size);
  u64(central, centralExtra + 20, entry.offset);
  return { local: local.buffer, central: central.buffer };
}
export function worldFolderZipEnd(layout: ReturnType<typeof worldFolderZipLayout>): ArrayBuffer {
  const end = record(98);
  u32(end, 0, 0x06064b50);
  u64(end, 4, 44);
  u16(end, 12, 45);
  u16(end, 14, 45);
  u64(end, 24, layout.entries.length);
  u64(end, 32, layout.entries.length);
  u64(end, 40, layout.directorySize);
  u64(end, 48, layout.directoryOffset);
  u32(end, 56, 0x07064b50);
  u64(end, 64, layout.directoryOffset + layout.directorySize);
  u32(end, 72, 1);
  u32(end, 76, 0x06054b50);
  u16(end, 84, 0xffff);
  u16(end, 86, 0xffff);
  u32(end, 88, 0xffffffff);
  u32(end, 92, 0xffffffff);
  return end.buffer;
}
export async function createWorldFolderZip(
  input: WorldFolderArchiveInput,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: WorldFolderArchiveProgress) => void;
  } = {},
): Promise<File> {
  const layout = worldFolderZipLayout(
    input.entries.map(({ path, file }) => ({ path, size: file.size })),
  );
  const totalBytes = input.entries.reduce((sum, { file }) => sum + file.size, 0);
  let processedBytes = 0;
  let lastProgress = -Infinity;
  const progress = (force = false) => {
    const now = performance.now();
    if (force || now - lastProgress >= 50) {
      options.onProgress?.({ processedBytes, totalBytes });
      lastProgress = now;
    }
  };
  const checkCancelled = () => {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  checkCancelled();
  progress(true);
  for (let index = 0; index < input.entries.length; index++) {
    const source = input.entries[index];
    const entry = layout.entries[index];
    if (!source || !entry) throw new Error('preparation_failed');
    let crc = 0xffffffff;
    for (let offset = 0; offset < source.file.size; offset += chunkSize) {
      checkCancelled();
      const chunk = new Uint8Array(
        await source.file.slice(offset, offset + chunkSize).arrayBuffer(),
      );
      checkCancelled();
      if (chunk.length !== Math.min(chunkSize, source.file.size - offset))
        throw new Error('preparation_failed');
      for (const byte of chunk) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
      processedBytes += chunk.length;
      progress();
    }
    const headers = entryHeaders(entry, (crc ^ 0xffffffff) >>> 0);
    // Blob construction references File storage; file payloads are never retained
    // as ArrayBuffers and only the current 1 MiB checksum chunk is materialized.
    parts.push(headers.local, source.file);
    central.push(headers.central);
  }
  checkCancelled();
  const archive = new File([...parts, ...central, worldFolderZipEnd(layout)], `${input.root}.zip`, {
    type: 'application/zip',
  });
  if (archive.size !== layout.archiveSize) throw new Error('preparation_failed');
  progress(true);
  return archive;
}

// The same pure writer is imported by Node unit tests without installing handlers.
if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = async (event: MessageEvent<WorldFolderArchiveInput>) => {
    try {
      const archive = await createWorldFolderZip(event.data, {
        onProgress: (progress) => self.postMessage({ progress }),
      });
      self.postMessage({ archive });
    } catch (error) {
      self.postMessage({
        error:
          error instanceof Error && error.message === 'limit_exceeded'
            ? 'limit_exceeded'
            : 'preparation_failed',
      });
    }
  };
}
