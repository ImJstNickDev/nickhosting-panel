export function hashFile(
  file: Blob,
  options: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => {
      worker.terminate();
      options.signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    worker.onmessage = (
      event: MessageEvent<{ sha256?: string; error?: string; bytes?: number }>,
    ) => {
      if (event.data.sha256) {
        cleanup();
        resolve(event.data.sha256);
      } else if (event.data.error) {
        cleanup();
        reject(new Error(event.data.error));
      } else if (event.data.bytes !== undefined) options.onProgress?.(event.data.bytes);
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error('web.errors.fileRead'));
    };
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.postMessage(file);
  });
}
