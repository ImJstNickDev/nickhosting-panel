import { DomainError } from '@nickhosting/core';

type Asset = Uint8Array<ArrayBuffer> | null;
type Pending = { controller: AbortController; promise: Promise<Asset>; readers: number };
type Options = {
  bytes: number;
  entries: number;
  active: number;
  perServer: number;
  // The native generator can finish an accepted CPU job after its HTTP client
  // disappears. Keep it counted and reusable until the request actually settles.
  finishStarted?: boolean;
};

export class OpenworldTerrainCache {
  private readonly cache = new Map<string, { value: Asset; expires: number }>();
  private readonly pending = new Map<string, Pending>();
  private readonly counts = new Map<string, number>();
  private size = 0;
  private running = 0;
  constructor(
    private readonly options: Options,
    private readonly now: () => number,
  ) {}
  private remove(key: string) {
    const row = this.cache.get(key);
    if (row) {
      this.size -= row.value?.byteLength ?? 0;
      this.cache.delete(key);
    }
  }
  invalidate(matches: (key: string) => boolean) {
    for (const k of this.cache.keys()) if (matches(k)) this.remove(k);
    // Readers already waiting on the old revision may finish. A new reader gets
    // a new job, and only that job can publish a cached value for this key.
    for (const k of this.pending.keys()) if (matches(k)) this.pending.delete(k);
  }
  get(
    key: string,
    server: string,
    ttl: number,
    signal: AbortSignal,
    read: (signal: AbortSignal) => Promise<Asset>,
  ): Promise<Asset> {
    if (signal.aborted) return Promise.reject(new DomainError('game_not_ready'));
    const ready = this.cache.get(key);
    if (ready && ready.expires > this.now()) {
      this.cache.delete(key);
      this.cache.set(key, ready);
      return Promise.resolve(ready.value);
    }
    this.remove(key);
    let task = this.pending.get(key);
    if (!task) {
      const count = this.counts.get(server) ?? 0;
      if (this.running >= this.options.active || count >= this.options.perServer)
        throw new DomainError('rate_limited');
      this.running++;
      this.counts.set(server, count + 1);
      const controller = new AbortController();
      const promise = Promise.resolve()
        .then(() => read(controller.signal))
        .then((value) => {
          if (controller.signal.aborted) throw new DomainError('conflict');
          if (
            this.pending.get(key)?.controller === controller &&
            (value?.byteLength ?? 0) <= this.options.bytes
          ) {
            this.cache.set(key, { value, expires: this.now() + ttl });
            this.size += value?.byteLength ?? 0;
            while (this.size > this.options.bytes || this.cache.size > this.options.entries) {
              const oldest = this.cache.keys().next().value;
              if (oldest === undefined) break;
              this.remove(oldest);
            }
          }
          return value;
        })
        .finally(() => {
          if (this.pending.get(key)?.controller === controller) this.pending.delete(key);
          this.running--;
          const remaining = (this.counts.get(server) ?? 1) - 1;
          if (remaining) this.counts.set(server, remaining);
          else this.counts.delete(server);
        });
      task = { controller, promise, readers: 0 };
      this.pending.set(key, task);
    }
    return this.subscribe(key, task, signal);
  }
  private subscribe(key: string, task: Pending, signal: AbortSignal) {
    task.readers++;
    return new Promise<Asset>((resolve, reject) => {
      let finished = false;
      const detach = () => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', abort);
        task.readers--;
      };
      const abort = () => {
        detach();
        if (task.readers === 0 && !this.options.finishStarted) {
          if (this.pending.get(key) === task) this.pending.delete(key);
          task.controller.abort();
        }
        reject(new DomainError('game_not_ready'));
      };
      signal.addEventListener('abort', abort, { once: true });
      task.promise.then(
        (value) => {
          detach();
          resolve(value);
        },
        (error) => {
          detach();
          reject(error);
        },
      );
    });
  }
}
