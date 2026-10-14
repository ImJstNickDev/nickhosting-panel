import type { QuillModel } from './model.js';

type PendingParse = {
  source: string;
  resolve(value: QuillModel): void;
  reject(error: Error): void;
  timeout?: ReturnType<typeof setTimeout>;
};
const failure = (messageKey: 'quill.loadFailed' | 'quill.renderFailed') =>
  Object.assign(new Error(messageKey), { messageKey });

/** A document and its inclusions share one bounded parser worker. */
export class QuillClient {
  private worker?: Worker;
  private ready = false;
  private startup?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private pending = new Map<number, PendingParse>();
  private cache = new Map<string, { promise: Promise<QuillModel>; bytes: number }>();
  private disposed = false;

  private start() {
    if (this.worker) return;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    // Network/module initialization is separate from the bounded parsing work.
    this.startup = setTimeout(() => this.fail(failure('quill.loadFailed')), 20_000);
    worker.onmessage = (
      event: MessageEvent<{ ready?: boolean; id: number; model?: QuillModel; error?: string }>,
    ) => {
      if (this.worker !== worker) return;
      if (event.data.ready) {
        if (this.ready) return;
        clearTimeout(this.startup);
        this.ready = true;
        for (const [id, item] of this.pending) this.send(id, item);
        return;
      }
      const item = this.pending.get(event.data.id);
      if (!item) return;
      clearTimeout(item.timeout);
      this.pending.delete(event.data.id);
      if (event.data.model) item.resolve(event.data.model);
      else item.reject(failure('quill.renderFailed'));
    };
    worker.onerror = () => {
      if (this.worker === worker)
        this.fail(failure(this.ready ? 'quill.renderFailed' : 'quill.loadFailed'));
    };
  }

  private send(id: number, item: PendingParse) {
    item.timeout = setTimeout(() => this.fail(failure('quill.renderFailed')), 12_000);
    this.worker?.postMessage({ id, source: item.source });
  }

  parse(source: string): Promise<QuillModel> {
    if (this.disposed) return Promise.reject(failure('quill.loadFailed'));
    const cached = this.cache.get(source);
    if (cached) return cached.promise;
    const id = ++this.sequence;
    const result = new Promise<QuillModel>((resolve, reject) => {
      const item = { source, resolve, reject };
      this.pending.set(id, item);
      try {
        this.start();
        if (this.ready) this.send(id, item);
      } catch {
        this.fail(failure('quill.loadFailed'));
      }
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
  private fail(error: Error) {
    clearTimeout(this.startup);
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = false;
    for (const item of this.pending.values()) {
      clearTimeout(item.timeout);
      item.reject(error);
    }
    this.pending.clear();
    this.cache.clear();
    // A later explicit Retry (also in an inclusion) can create a fresh worker.
    // No automatic retries or surviving requests after document disposal.
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(failure('quill.loadFailed'));
  }
}
