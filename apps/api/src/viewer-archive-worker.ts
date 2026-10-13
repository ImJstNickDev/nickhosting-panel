/** Serialized Node worker. No NODEFS mount, network access or shell commands. */
export function sevenZipViewerWorker(): void {
  const { parentPort, workerData } =
    require('node:worker_threads') as typeof import('node:worker_threads');
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const port = parentPort;
  if (!port) return;
  type FileSystem = {
    writeFile(path: string, bytes: Uint8Array): void;
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
  void (async () => {
    const input = readFileSync(workerData.path);
    if (input.length > workerData.maximumInputBytes) throw new Error('viewer_archive_budget');
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
        // Worker V8 resourceLimits do not limit WebAssembly memory.
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
    module.FS.writeFile('/input.archive', input);
    const output = new Uint8Array(workerData.maximumOutputBytes);
    let total = 0;
    let stderr = 0;
    module.FS.init(
      () => null,
      (byte) => {
        total++;
        if (total > workerData.maximumOutputBytes) throw new Error('viewer_archive_budget');
        output[total - 1] = byte;
      },
      () => {
        stderr++;
        if (stderr > 1024 * 1024) throw new Error('viewer_archive_budget');
      },
    );
    const args =
      workerData.entry === undefined
        ? ['l', '-slt', '-ba', '-bd', '-sccUTF-8', '/input.archive']
        : ['e', '-so', '-bd', '-spd', '-y', '/input.archive', '--', workerData.entry];
    const exit = module.callMain(args);
    if (exit !== 0) throw new Error('viewer_archive_invalid');
    if (workerData.entry !== undefined && total !== workerData.maximumOutputBytes)
      throw new Error('viewer_archive_integrity');
    const bytes = output.subarray(0, total);
    port.postMessage({ bytes, heapBytes: instanceMemory?.buffer.byteLength }, [bytes.buffer]);
  })()
    .catch((error: unknown) => {
      const code =
        error instanceof Error && error.message.startsWith('viewer_')
          ? error.message
          : 'viewer_archive_invalid';
      port.postMessage({ error: code });
    })
    .finally(() => port.close());
}
