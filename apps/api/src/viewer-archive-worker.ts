/** Serialized Node worker. Only one read-only file descriptor is exposed; no NODEFS mount or shell. */
export function sevenZipViewerWorker(): void {
  const { parentPort, workerData } =
    require('node:worker_threads') as typeof import('node:worker_threads');
  const { readFileSync, openSync, closeSync, fstatSync, readSync } =
    require('node:fs') as typeof import('node:fs');
  const port = parentPort;
  if (!port) return;
  type Stream = { position: number; stream_ops: StreamOps };
  type StreamOps = {
    read?(
      stream: Stream,
      bytes: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): number;
    write?(stream: Stream, bytes: Uint8Array, offset: number, length: number): number;
    llseek?(stream: Stream, offset: number, whence: number): number;
  };
  type FileNode = {
    usedBytes: number;
    stream_ops: StreamOps;
    node_ops: { getattr(node: FileNode): Record<string, unknown> };
  };
  type FileSystem = {
    writeFile(path: string, bytes: Uint8Array): void;
    lookupPath(path: string): { node: FileNode };
    getStream(fd: number): Stream;
    init(input: () => null, output: (byte: number) => void, error: (byte: number) => void): void;
  };
  type ArchiveModule = { FS: FileSystem; callMain(args: string[]): number };
  const factory = require(workerData.module) as (options: {
    noFSInit: boolean;
    instantiateWasm(
      imports: WebAssembly.Imports,
      receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ): object;
  }) => Promise<ArchiveModule>;
  let fd: number | undefined;
  void (async () => {
    fd = openSync(workerData.path, 'r');
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > workerData.maximumInputBytes)
      throw new Error('viewer_archive_budget');
    const inputFd = fd;
    const wasm = await WebAssembly.compile(readFileSync(workerData.wasm));
    let instanceMemory: WebAssembly.Memory | undefined;
    const module = await factory({
      noFSInit: true,
      instantiateWasm(imports, receive) {
        const instance = new WebAssembly.Instance(wasm, imports);
        const memory = Object.values(instance.exports).find(
          (value) => value instanceof WebAssembly.Memory,
        );
        if (
          !(memory instanceof WebAssembly.Memory) ||
          memory.buffer.byteLength > workerData.maximumHeapBytes
        )
          throw new Error('viewer_archive_budget');
        instanceMemory = memory;
        // This pinned Emscripten build expands through its JS resize_heap import, which calls grow().
        const grow = memory.grow.bind(memory);
        memory.grow = (pages: number) => {
          if (
            !Number.isSafeInteger(pages) ||
            pages < 0 ||
            memory.buffer.byteLength + pages * 65536 > workerData.maximumHeapBytes
          )
            throw new RangeError('viewer_archive_budget');
          return grow(pages);
        };
        receive(instance, wasm);
        return {};
      },
    });
    // Adapter verified against pinned sevenzip-wasm 26.4.0 / Emscripten 6.0.1 libfs + libmemfs.
    // Keep real fixture tests when upgrading: stream_ops are an Emscripten implementation contract.
    // Use MEMFS metadata only. Reads seek the already-owned cache file directly into decoder buffers.
    module.FS.writeFile('/input.archive', new Uint8Array());
    const input = module.FS.lookupPath('/input.archive').node;
    const getattr = input.node_ops.getattr;
    input.usedBytes = info.size;
    input.node_ops = {
      ...input.node_ops,
      getattr(node) {
        return { ...getattr(node), size: info.size };
      },
    };
    input.stream_ops = {
      read(_stream, bytes, offset, length, position) {
        if (!Number.isSafeInteger(position) || position < 0)
          throw new Error('viewer_archive_invalid');
        return readSync(
          inputFd,
          bytes,
          offset,
          Math.min(length, Math.max(0, info.size - position)),
          position,
        );
      },
      llseek(stream, offset, whence) {
        const position = offset + (whence === 1 ? stream.position : whence === 2 ? info.size : 0);
        if (!Number.isSafeInteger(position) || position < 0)
          throw new Error('viewer_archive_invalid');
        return position;
      },
    };
    const gate = new Int32Array(workerData.gate);
    let total = 0;
    let stderr = 0;
    module.FS.init(
      () => null,
      () => {
        throw new Error('viewer_archive_invalid');
      },
      () => {
        if (++stderr > 1024 * 1024) throw new Error('viewer_archive_budget');
      },
    );
    // Override only this stdout stream, not shared TTY operations. No per-byte JS callback or full output allocation.
    const stdout = module.FS.getStream(1);
    stdout.stream_ops = {
      ...stdout.stream_ops,
      write(_stream, bytes, offset, length) {
        total += length;
        if (total > workerData.maximumOutputBytes) throw new Error('viewer_archive_budget');
        for (let at = 0; at < length; at += 64 * 1024) {
          const chunk = Uint8Array.from(
            bytes.subarray(offset + at, offset + Math.min(length, at + 64 * 1024)),
          );
          Atomics.store(gate, 0, 0);
          port.postMessage({ bytes: chunk }, [chunk.buffer]);
          Atomics.wait(gate, 0, 0);
        }
        return length;
      },
    };
    const args =
      workerData.entry === undefined
        ? ['l', '-slt', '-ba', '-bd', '-sccUTF-8', '/input.archive']
        : ['e', '-so', '-bd', '-spd', '-y', '/input.archive', '--', workerData.entry];
    const exit = module.callMain(args);
    if (exit !== 0) throw new Error('viewer_archive_invalid');
    if (workerData.entry !== undefined && total !== workerData.maximumOutputBytes)
      throw new Error('viewer_archive_integrity');
    port.postMessage({ done: true, heapBytes: instanceMemory?.buffer.byteLength });
  })()
    .catch((error: unknown) => {
      const code =
        error instanceof Error && error.message.startsWith('viewer_')
          ? error.message
          : 'viewer_archive_invalid';
      port.postMessage({ error: code });
    })
    .finally(() => {
      if (fd !== undefined) closeSync(fd);
      port.close();
    });
}
