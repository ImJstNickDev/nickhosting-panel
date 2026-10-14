import type { QuillModel } from './model.js';

/** A document and its inclusions share one bounded parser worker. */
export class QuillClient {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve(value: QuillModel): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private cache = new Map<string, { promise: Promise<QuillModel>; bytes: number }>();
  private disposed = false;
  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (
      event: MessageEvent<{ id: number; model?: QuillModel; error?: string }>,
    ) => {
      const item = this.pending.get(event.data.id);
      if (!item) return;
      clearTimeout(item.timeout);
      this.pending.delete(event.data.id);
      if (event.data.model) item.resolve(event.data.model);
      else item.reject(new Error(event.data.error || 'Markdown parsing failed'));
    };
    this.worker.onerror = () => this.dispose();
  }
  parse(source: string): Promise<QuillModel> {
    if (this.disposed) return Promise.reject(new Error('Parser closed'));
    const cached = this.cache.get(source);
    if (cached) return cached.promise;
    const id = ++this.sequence;
    const result = new Promise<QuillModel>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.dispose();
      }, 12_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.worker.postMessage({ id, source });
    });
    const entry = { promise: result, bytes: source.length * 2 };
    this.cache.set(source, entry);
    this.trim();
    void result.then(
      (model) => {
        if (this.cache.get(source) !== entry) return;
        const nodes = [...model.children];
        let bytes = source.length * 2;
        while (nodes.length) {
          const node = nodes.pop();
          if (!node) continue;
          bytes += 128;
          if (node.type === 'text') bytes += node.value.length * 2;
          else {
            bytes += JSON.stringify(node.properties).length * 2;
            nodes.push(...node.children);
          }
        }
        entry.bytes = bytes;
        this.trim();
      },
      () => {
        if (this.cache.get(source) === entry) this.cache.delete(source);
      },
    );
    return result;
  }
  private trim() {
    let bytes = [...this.cache.values()].reduce((total, entry) => total + entry.bytes, 0);
    while (this.cache.size > 8 || bytes > 32 * 1024 * 1024) {
      const first = this.cache.entries().next().value;
      if (!first) break;
      bytes -= first[1].bytes;
      this.cache.delete(first[0]);
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    for (const item of this.pending.values()) {
      clearTimeout(item.timeout);
      item.reject(new Error('Markdown parser unavailable'));
    }
    this.pending.clear();
    this.cache.clear();
  }
}
