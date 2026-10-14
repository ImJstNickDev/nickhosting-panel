import {
  type DelimitedEdit,
  type DelimitedEditResult,
  DelimitedError,
  type DelimitedOptions,
  type DelimitedPage,
  type DelimitedRequest,
  type DelimitedResponse,
  type DelimitedView,
  delimitedLimits,
} from './delimited-protocol.js';

export { DelimitedError } from './delimited-protocol.js';

type Result = DelimitedPage | DelimitedEditResult | string;
interface Pending {
  resolve: (value: Result) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface DelimitedWorker {
  onmessage: ((event: MessageEvent<DelimitedResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: DelimitedRequest & { requestId: number }): void;
  terminate(): void;
}

/** One retained worker per source revision. No provider or network access belongs here. */
export class DelimitedClient {
  private worker?: DelimitedWorker;
  private readonly pending = new Map<number, Pending>();
  private requestId = 0;
  private disposed = false;
  private readonly onAbort = () => this.dispose();

  constructor(
    private readonly signal?: AbortSignal,
    private readonly createWorker: () => DelimitedWorker = () =>
      new Worker(new URL('./delimited-worker.ts', import.meta.url), { type: 'module' }),
  ) {
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (signal?.aborted) this.dispose();
  }

  private terminate(error: DelimitedError): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private request<T extends Result>(request: DelimitedRequest): Promise<T> {
    if (this.disposed) return Promise.reject(new DelimitedError('disposed'));
    if (!this.worker) return Promise.reject(new DelimitedError('invalid'));
    const worker = this.worker;
    const requestId = ++this.requestId;
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(
        () => this.terminate(new DelimitedError('timeout')),
        delimitedLimits.deadlineMs,
      );
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        worker.postMessage({ ...request, requestId });
      } catch {
        this.terminate(new DelimitedError('invalid'));
      }
    }) as Promise<T>;
  }

  load(
    text: string,
    extension: string,
    options: DelimitedOptions = { delimiter: 'auto', header: 'auto' },
  ): Promise<DelimitedPage> {
    if (this.disposed) return Promise.reject(new DelimitedError('disposed'));
    this.terminate(new DelimitedError('stale'));
    let worker: DelimitedWorker;
    try {
      worker = this.createWorker();
    } catch {
      return Promise.reject(new DelimitedError('invalid'));
    }
    this.worker = worker;
    worker.onmessage = (event) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(event.data.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(event.data.requestId);
      if ('error' in event.data) pending.reject(new DelimitedError(event.data.error));
      else pending.resolve(event.data.result);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.worker === worker) this.terminate(new DelimitedError('invalid'));
    };
    worker.onmessageerror = () => {
      if (this.worker === worker) this.terminate(new DelimitedError('invalid'));
    };
    return this.request({ type: 'load', text, extension, options });
  }
  view(view: DelimitedView = {}): Promise<DelimitedPage> {
    return this.request({ type: 'view', view });
  }
  detail(rowId: number, column: number, revision?: number): Promise<string> {
    return this.request({ type: 'detail', rowId, column, revision });
  }
  edit(op: DelimitedEdit, revision: number, view?: DelimitedView): Promise<DelimitedEditResult> {
    return this.request({ type: 'edit', op, revision, view });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    this.terminate(new DelimitedError('disposed'));
  }
}
