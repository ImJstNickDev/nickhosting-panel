/** One revocation check per active session/server, shared by all its file/range requests.
 * The initial request was already authorized. No database work occurs per chunk. */
export class ViewerAccessWatch {
  #entries = new Map<
    string,
    {
      controller: AbortController;
      refs: number;
      check: () => Promise<void>;
      pending?: Promise<void>;
    }
  >();
  #timer: ReturnType<typeof setInterval>;
  constructor(intervalMs = 1000) {
    this.#timer = setInterval(() => this.tick(), intervalMs);
    this.#timer.unref();
  }
  subscribe(key: string, check: () => Promise<void>) {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { controller: new AbortController(), refs: 0, check };
      this.#entries.set(key, entry);
    }
    entry.refs++;
    const held = entry;
    let released = false;
    return {
      signal: held.controller.signal,
      release: () => {
        if (released) return;
        released = true;
        if (--held.refs === 0 && this.#entries.get(key) === held) this.#entries.delete(key);
      },
    };
  }
  tick() {
    for (const [key, entry] of this.#entries) {
      if (entry.pending) continue;
      entry.pending = entry
        .check()
        .catch(() => {
          entry.controller.abort(new Error('viewer_access_revoked'));
          if (this.#entries.get(key) === entry) this.#entries.delete(key);
        })
        .finally(() => {
          entry.pending = undefined;
        });
    }
  }
  close() {
    clearInterval(this.#timer);
    for (const entry of this.#entries.values()) entry.controller.abort();
    this.#entries.clear();
  }
}
