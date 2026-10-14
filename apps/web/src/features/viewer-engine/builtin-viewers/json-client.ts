import { previewLimits } from '../core/limits.js';
import type {
  JsonAction,
  JsonCopyKind,
  JsonDetail,
  JsonFailure,
  JsonRequest,
  JsonResponse,
  JsonView,
} from './json-protocol.js';

export class JsonClientError extends Error {
  readonly code: JsonFailure['code'];
  readonly messageKey: JsonFailure['code'];
  readonly line?: number;
  readonly column?: number;

  constructor(failure: JsonFailure) {
    super(failure.code);
    this.name = 'JsonClientError';
    this.code = failure.code;
    this.messageKey = failure.code;
    this.line = failure.line;
    this.column = failure.column;
  }
}

interface Pending {
  resolve: (value: JsonView | JsonDetail | string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A worker lives for one document; termination drops source, AST/index and all pending work. */
export class JsonTreeClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private requestId = 0;
  private disposed = false;
  private readonly onAbort = () => this.dispose();

  constructor(private readonly signal?: AbortSignal) {
    this.worker = new Worker(new URL('./json-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<JsonResponse>) => {
      const pending = this.pending.get(event.data.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(event.data.requestId);
      if ('error' in event.data) pending.reject(new JsonClientError(event.data.error));
      else pending.resolve(event.data.result);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.dispose(new JsonClientError({ code: 'viewer.jsonUnavailable' }));
    };
    this.worker.onmessageerror = () =>
      this.dispose(new JsonClientError({ code: 'viewer.jsonUnavailable' }));
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (signal?.aborted) this.dispose();
  }

  private request<T extends JsonView | JsonDetail | string>(request: JsonRequest): Promise<T> {
    if (this.disposed) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    const requestId = ++this.requestId;
    return new Promise<JsonView | JsonDetail | string>((resolve, reject) => {
      const timer = setTimeout(
        () => this.dispose(new JsonClientError({ code: 'viewer.jsonTimeout' })),
        previewLimits.jsonParseMs,
      );
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.worker.postMessage({ ...request, requestId });
      } catch {
        this.dispose(new JsonClientError({ code: 'viewer.jsonUnavailable' }));
      }
    }) as Promise<T>;
  }

  load(text: string, extension: string): Promise<JsonView> {
    return this.request({ type: 'load', text, extension });
  }

  view(offset: number, limit = 80): Promise<JsonView> {
    return this.request({ type: 'view', offset, limit });
  }

  action(action: JsonAction): Promise<JsonView> {
    return this.request({ type: 'action', action });
  }

  detail(id: number, offset = 0, limit = 16_384): Promise<JsonDetail> {
    return this.request({ type: 'detail', id, offset, limit });
  }

  copy(id: number, kind: JsonCopyKind): Promise<string> {
    return this.request({ type: 'copy', id, kind });
  }

  dispose(error: Error = new DOMException('Aborted', 'AbortError')): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
