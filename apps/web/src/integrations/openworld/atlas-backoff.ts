/** One circuit per optional resource family. Honor Retry-After without multiplying retries by tile count. */
export class AtlasBackoff {
  blocked = false;
  private attempts = 0;
  private scopeError = false;
  private lastLimit = 0;
  private deadline: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private paused = false;
  constructor(
    private readonly resume: () => void,
    private readonly report: (reason: unknown) => void,
  ) {}
  fail(error: unknown) {
    const status =
      typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
    if (typeof status === 'number' && [401, 403, 404, 409].includes(status)) {
      if (this.scopeError) return;
      this.reset();
      this.blocked = true;
      this.scopeError = true;
      this.report(error);
      return;
    }
    if (this.blocked) return;
    this.blocked = true;
    const rate = status === 429;
    const now = Date.now();
    if (now - this.lastLimit > 60000) this.attempts = 0;
    if (!rate || this.attempts >= 3) {
      this.report(error);
      return;
    }
    this.attempts++;
    const seconds =
      typeof error === 'object' &&
      error !== null &&
      'retryAfterSeconds' in error &&
      typeof error.retryAfterSeconds === 'number' &&
      Number.isFinite(error.retryAfterSeconds)
        ? error.retryAfterSeconds
        : 0;
    this.deadline =
      now + Math.max(seconds * 1000, 500 * 2 ** (this.attempts - 1)) + Math.random() * 180;
    this.lastLimit = this.deadline;
    this.schedule();
  }
  private schedule() {
    if (this.paused || this.deadline === undefined || this.timer !== undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.deadline = undefined;
        this.blocked = false;
        this.resume();
      },
      Math.max(0, this.deadline - Date.now()),
    );
  }
  pause(value: boolean) {
    this.paused = value;
    if (value) {
      clearTimeout(this.timer);
      this.timer = undefined;
    } else this.schedule();
  }
  reset() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.deadline = undefined;
    this.attempts = 0;
    this.scopeError = false;
    this.blocked = false;
  }
}

export type AtlasTerrainStatus = 'retrying' | 'incomplete' | null;

/** A tile keeps its own retry budget. After an upstream failure, probe one resource at a time. */
export class AtlasTileRetries {
  private readonly tiles = new Map<string, { attempts: number; at: number }>();
  private delay = 0;
  private nextRequest = 0;
  private wakeTime = Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private status: AtlasTerrainStatus = null;

  constructor(
    private readonly resume: () => void,
    private readonly notify?: (status: AtlasTerrainStatus) => void,
  ) {}

  get probing() {
    return this.delay > 0;
  }
  has(key: string) {
    return this.tiles.has(key);
  }
  readyAt(key: string) {
    return Math.max(this.nextRequest, this.tiles.get(key)?.at ?? 0);
  }
  fail(key: string) {
    const now = Date.now();
    const attempts = (this.tiles.get(key)?.attempts ?? 0) + 1;
    const wait = [4000, 12000][attempts - 1];
    this.tiles.set(key, { attempts, at: wait === undefined ? Infinity : now + wait });
    if (now >= this.nextRequest) {
      this.delay = Math.min(30000, this.delay ? this.delay * 2 : 1000);
      this.nextRequest = now + this.delay;
    }
    this.updateStatus();
  }
  succeed(key: string) {
    this.delay = 0;
    this.nextRequest = 0;
    if (this.tiles.delete(key)) this.updateStatus();
  }
  invalidate(matches: (key: string) => boolean) {
    // A newer native revision gets one more read without resetting the outage backoff.
    for (const [key, tile] of this.tiles) {
      if (tile.at === Infinity && matches(key)) {
        tile.at = Date.now() + 4000;
        tile.attempts = 2;
      }
    }
    this.updateStatus();
  }
  retain(wanted: ReadonlyMap<string, unknown>) {
    for (const key of this.tiles.keys()) if (!wanted.has(key)) this.tiles.delete(key);
    this.updateStatus();
  }
  wakeAt(at: number) {
    if (at === this.wakeTime) return;
    clearTimeout(this.timer);
    this.wakeTime = at;
    if (Number.isFinite(at)) {
      this.timer = setTimeout(
        () => {
          this.wakeTime = Infinity;
          this.resume();
        },
        Math.max(0, at - Date.now()),
      );
    }
  }
  reset() {
    this.wakeAt(Infinity);
    this.tiles.clear();
    this.delay = 0;
    this.nextRequest = 0;
    this.updateStatus();
  }
  private updateStatus() {
    let status: AtlasTerrainStatus = this.tiles.size ? 'retrying' : null;
    for (const tile of this.tiles.values()) {
      if (tile.at === Infinity) {
        status = 'incomplete';
        break;
      }
    }
    if (status !== this.status) {
      this.status = status;
      this.notify?.(status);
    }
  }
}
