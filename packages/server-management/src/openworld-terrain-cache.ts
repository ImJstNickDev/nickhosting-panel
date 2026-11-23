import { DomainError } from '@nickhosting/core';

type Asset = Uint8Array<ArrayBuffer> | null;
type Pending = {
  controller: AbortController;
  promise: Promise<Asset>;
  readers: number;
  start?: () => void;
};
type Options = {
  bytes: number;
  entries: number;
  active: number;
  perServer: number;
  // Admit a bounded set of distinct assets, then start native reads in FIFO order.
  parallelPerServer?: number;
  // The native generator can finish an accepted CPU job after its HTTP client
  // disappears. Keep it counted and reusable until the request actually settles.
  finishStarted?: boolean;
};

export class OpenworldTerrainCache {
  private readonly cache = new Map<string, { value: Asset; expires: number }>();
  private readonly pending = new Map<string, Pending>();
  private readonly admitted = new Map<string, Set<Pending>>();
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
    read: (signal: AbortSignal, waited: boolean, beginFreshRead: () => void) => Promise<Asset>,
    onStored?: (value: Asset) => void,
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
      const jobs = this.admitted.get(server) ?? new Set<Pending>();
      if (this.running >= this.options.active || jobs.size >= this.options.perServer)
        throw new DomainError('rate_limited');
      this.running++;
      this.admitted.set(server, jobs);
      const controller = new AbortController();
      const slot = Promise.withResolvers<void>();
      const parallel = this.options.parallelPerServer;
      const waited =
        parallel !== undefined && Array.from(jobs).filter((job) => !job.start).length >= parallel;
      const promise = slot.promise
        .then(() => {
          controller.signal.throwIfAborted();
          return read(controller.signal, waited, () => {
            // A warm lookup can itself observe an edit and invalidate this pending slot.
            // A native read starting *after* that edit may publish; never replace a newer job.
            if (!controller.signal.aborted && !this.pending.has(key) && !this.cache.has(key))
              this.pending.set(key, job);
          });
        })
        .then((value) => {
          if (controller.signal.aborted) throw new DomainError('conflict');
          if (
            this.pending.get(key)?.controller === controller &&
            (value?.byteLength ?? 0) <= this.options.bytes
          ) {
            const retained =
              value && value.byteLength !== value.buffer.byteLength ? new Uint8Array(value) : value;
            this.cache.set(key, { value: retained, expires: this.now() + ttl });
            this.size += value?.byteLength ?? 0;
            while (this.size > this.options.bytes || this.cache.size > this.options.entries) {
              const oldest = this.cache.keys().next().value;
              if (oldest === undefined) break;
              this.remove(oldest);
            }
            onStored?.(retained);
          }
          return value;
        })
        .finally(() => {
          if (this.pending.get(key)?.controller === controller) this.pending.delete(key);
          this.running--;
          jobs.delete(job);
          if (!jobs.size) this.admitted.delete(server);
          else if (!job.start) {
            for (const next of jobs) {
              if (!next.start || next.controller.signal.aborted) continue;
              next.start();
              delete next.start;
              break;
            }
          }
        });
      const job: Pending = { controller, promise, readers: 0 };
      if (waited) job.start = slot.resolve;
      else slot.resolve();
      jobs.add(job);
      this.pending.set(key, job);
      task = job;
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
        if (task.readers === 0 && (task.start || !this.options.finishStarted)) {
          if (this.pending.get(key) === task) this.pending.delete(key);
          task.controller.abort();
          // Release a cancelled waiter without spending a native slot on it.
          task.start?.();
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
