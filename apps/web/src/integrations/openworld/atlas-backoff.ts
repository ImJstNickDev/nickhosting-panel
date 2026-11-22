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
