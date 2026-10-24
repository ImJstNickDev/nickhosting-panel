/** Visual-only clock. Never writes to the media element or drives playback. */
export class AudioPlaybackClock {
  private native = 0;
  private observedAt = 0;
  private frameAt = 0;
  private position = 0;

  reset(time: number, now: number) {
    this.native = this.position = Math.max(0, time);
    this.observedAt = this.frameAt = now;
    return this.position;
  }

  sample(time: number, now: number, rate: number) {
    const elapsed = Math.max(0, (now - this.frameAt) / 1000);
    // Seeks, looping and background-tab gaps are discontinuities, not drift.
    if (time < this.native || Math.abs(time - this.native) > 0.25 || elapsed > 0.25)
      return this.reset(time, now);
    if (time !== this.native) {
      this.native = time;
      this.observedAt = now;
    }
    this.frameAt = now;
    const step = elapsed * rate;
    const target = time + (Math.min(100, now - this.observedAt) / 1000) * rate;
    const predicted = this.position + step;
    // Ease small clock phase differences without resetting on each quantized
    // reading (which causes a sawtooth). Correction is limited to 10% of speed.
    const correction = Math.max(-step * 0.1, Math.min(step * 0.1, target - predicted));
    this.position = Math.max(this.position, Math.min(predicted + correction, time + 0.1 * rate));
    return this.position;
  }
}
