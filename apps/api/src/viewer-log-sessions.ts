import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { ViewerFormatError, ViewerSessionCache } from './viewer-cache.js';
import type { ViewerLogSession } from './viewer-log.js';

export interface OpenLogSnapshot {
  revision: string;
  signal: AbortSignal;
  create(): Promise<ViewerLogSession>;
  close(): Promise<void>;
}
type Shared = { value: ViewerLogSession; signal: AbortSignal };
type Held = {
  revision: string;
  key: string;
  shared: Shared;
  release(): void;
  readers: number;
  retired: boolean;
  done: ReturnType<typeof Promise.withResolvers<void>>;
};
type Tab = {
  owner: string;
  path: string;
  binding: string;
  controller: AbortController;
  expires: number;
  held?: Held;
  refresh?: Promise<{ revision: string; changed: boolean }>;
  detach?: () => void;
};
/** Tab leases over the existing revision cache; no content or authentication tokens in handles. */
export class ViewerLogSessions {
  readonly #tabs = new Map<string, Tab>();
  readonly #cache = new ViewerSessionCache<Shared>();
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;
  constructor(readonly options: { idleMs?: number; maximum?: number; now?: () => number } = {}) {
    this.#timer = setInterval(() => {
      void this.expire().catch(() => undefined);
    }, 10_000);
    this.#timer.unref();
  }
  #now() {
    return this.options.now?.() ?? Date.now();
  }
  #touch(tab: Tab) {
    tab.expires = this.#now() + (this.options.idleMs ?? 90_000);
  }
  #get(owner: string, id: string) {
    const tab = this.#tabs.get(id);
    if (!tab || tab.owner !== owner) throw new DomainError('not_found');
    if (tab.expires <= this.#now() || tab.controller.signal.aborted) {
      void this.release(owner, id).catch(() => undefined);
      throw new DomainError('not_found');
    }
    return tab;
  }
  inspect(owner: string, id: string) {
    const tab = this.#get(owner, id);
    return { path: tab.path, binding: tab.binding };
  }
  async #acquire(owner: string, opened: OpenLogSnapshot, signal: AbortSignal): Promise<Held> {
    const key = JSON.stringify([owner, opened.revision]);
    let adopted = false;
    try {
      const lease = await this.#cache.acquire(
        key,
        async () => {
          adopted = true;
          try {
            const value = await opened.create();
            if (opened.signal.aborted) {
              await value.close();
              opened.signal.throwIfAborted();
            }
            return {
              session: { value, signal: opened.signal },
              dispose: async () => {
                await value.close();
                await opened.close();
              },
            };
          } catch (error) {
            await opened.close();
            throw error;
          }
        },
        signal,
      );
      return {
        revision: opened.revision,
        key,
        shared: lease.session,
        release: lease.release,
        readers: 0,
        retired: false,
        done: Promise.withResolvers<void>(),
      };
    } catch (error) {
      void this.#cache.discardIdle(key).catch(() => undefined);
      throw error;
    } finally {
      if (!adopted) await opened.close();
    }
  }
  #retire(held: Held) {
    held.retired = true;
    if (held.readers === 0) {
      held.release();
      void this.#cache.discardIdle(held.key).then(held.done.resolve, held.done.reject);
    }
    return held.done.promise;
  }
  #watch(id: string, tab: Tab) {
    tab.detach?.();
    const signal = tab.held?.shared.signal;
    if (!signal) return;
    const revoke = () => {
      void this.release(tab.owner, id).catch(() => undefined);
    };
    signal.addEventListener('abort', revoke, { once: true });
    tab.detach = () => signal.removeEventListener('abort', revoke);
    if (signal.aborted) revoke();
  }
  async open(
    owner: string,
    path: string,
    binding: string,
    opened: OpenLogSnapshot,
    signal: AbortSignal,
  ) {
    if (
      this.#closed ||
      this.#tabs.size >= (this.options.maximum ?? 64) ||
      [...this.#tabs.values()].filter((tab) => tab.owner === owner).length >= 16
    ) {
      await opened.close();
      throw new ViewerFormatError('viewer_cache_busy');
    }
    const id = randomUUID();
    const tab: Tab = { owner, path, binding, controller: new AbortController(), expires: 0 };
    this.#touch(tab);
    this.#tabs.set(id, tab);
    try {
      tab.held = await this.#acquire(
        owner,
        opened,
        AbortSignal.any([signal, tab.controller.signal]),
      );
      if (tab.controller.signal.aborted || signal.aborted) {
        await this.#retire(tab.held);
        throw new DomainError('not_found');
      }
      this.#watch(id, tab);
      if (tab.controller.signal.aborted) throw new DomainError('forbidden');
      return { sessionId: id, revision: tab.held.revision };
    } catch (error) {
      await this.release(owner, id);
      throw error;
    }
  }
  renew(owner: string, id: string) {
    this.#touch(this.#get(owner, id));
  }
  async query(
    owner: string,
    id: string,
    query: Parameters<ViewerLogSession['query']>[0],
    signal: AbortSignal,
  ) {
    const tab = this.#get(owner, id),
      held = tab.held;
    if (!held) throw new DomainError('not_found');
    this.#touch(tab);
    held.readers++;
    try {
      const combined = AbortSignal.any([signal, tab.controller.signal, held.shared.signal]);
      combined.throwIfAborted();
      const page = await held.shared.value.query(query, combined);
      combined.throwIfAborted();
      return { ...page, revision: held.revision };
    } finally {
      held.readers--;
      if (held.retired && held.readers === 0) await this.#retire(held);
    }
  }
  async refresh(owner: string, id: string, create: () => Promise<OpenLogSnapshot>) {
    const tab = this.#get(owner, id);
    this.#touch(tab);
    if (tab.refresh) return tab.refresh;
    const pending = (async () => {
      const opened = await create();
      if (opened.revision === tab.held?.revision) {
        await opened.close();
        tab.controller.signal.throwIfAborted();
        return { revision: tab.held.revision, changed: false };
      }
      const next = await this.#acquire(owner, opened, tab.controller.signal);
      if (tab.controller.signal.aborted || this.#tabs.get(id) !== tab) {
        await this.#retire(next);
        throw new DomainError('not_found');
      }
      const previous = tab.held;
      tab.held = next;
      this.#watch(id, tab);
      if (previous) await this.#retire(previous);
      tab.controller.signal.throwIfAborted();
      return { revision: next.revision, changed: true };
    })();
    tab.refresh = pending;
    try {
      return await pending;
    } finally {
      if (tab.refresh === pending) tab.refresh = undefined;
    }
  }
  async release(owner: string, id: string) {
    const tab = this.#tabs.get(id);
    if (!tab || tab.owner !== owner) return;
    this.#tabs.delete(id);
    tab.detach?.();
    tab.controller.abort();
    if (tab.held) await this.#retire(tab.held);
  }
  async expire() {
    await Promise.all(
      [...this.#tabs]
        .filter(([, tab]) => tab.expires <= this.#now())
        .map(([id, tab]) => this.release(tab.owner, id)),
    );
  }
  async close() {
    this.#closed = true;
    clearInterval(this.#timer);
    await Promise.all([...this.#tabs].map(([id, tab]) => this.release(tab.owner, id)));
    await this.#cache.close();
  }
}
