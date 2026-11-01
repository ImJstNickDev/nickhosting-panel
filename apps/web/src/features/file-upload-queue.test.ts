import { describe, expect, it } from 'vitest';
import {
  largeUploadBytes,
  nextUpload,
  planUploadBatch,
  runUploadPool,
} from './file-upload-queue.js';

const item = (path: string, size = 1) => ({ path, file: { size } });
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('upload scheduling', () => {
  it('starts the largest file first, then drains small files beside it', () => {
    const small = item('small', 1),
      medium = item('medium', 100),
      large = item('large', largeUploadBytes),
      largest = item('largest', largeUploadBytes * 2);
    expect(nextUpload([medium, large, small, largest], [])).toBe(largest);
    expect(nextUpload([medium, large, small], [largest])).toBe(small);
    expect(nextUpload([medium, large], [largest])).toBe(medium);
    expect(nextUpload([large], [largest])).toBe(large);
  });

  it('keeps FIFO for only small files and uses every slot for only large files', () => {
    const first = item('first', 100),
      second = item('second', 1);
    expect(nextUpload([first, second], [])).toBe(first);
    expect(nextUpload([first, second], [item('active')])).toBe(first);
    const firstLarge = item('large', largeUploadBytes),
      secondLarge = item('larger', largeUploadBytes * 2);
    expect(nextUpload([firstLarge, secondLarge], [item('active-large', largeUploadBytes)])).toBe(
      secondLarge,
    );
    expect(nextUpload([], [])).toBeUndefined();
  });

  it('bounds each manifest by bytes and count and delays colliding paths', () => {
    const files = [item('a', 4), item('b', 7), item('c', 3), item('A', 1), item('a/inside', 1)];
    expect(planUploadBatch(files, 8, 500).map((entry) => entry.path)).toEqual(['a', 'c']);
    expect(planUploadBatch(files, 20, 2).map((entry) => entry.path)).toEqual(['a', 'b']);
    expect(
      planUploadBatch([item('huge', 999), item('small', 2)], 10, 500).map((entry) => entry.path),
    ).toEqual(['small']);
    expect(files).toHaveLength(5);
  });

  it('refills a free slot while a large file is still transferring', async () => {
    const large = item('large', largeUploadBytes),
      small = item('small'),
      later = item('later');
    const pending = [small, large, later],
      started: string[] = [];
    const gates = new Map(pending.map((entry) => [entry.path, deferred()]));
    const run = runUploadPool({
      concurrency: 2,
      next: (active: readonly (typeof large)[]) => {
        const selected = nextUpload(pending, active);
        if (selected) pending.splice(pending.indexOf(selected), 1);
        return selected;
      },
      run: async (entry) => {
        started.push(entry.path);
        await gates.get(entry.path)?.promise;
      },
    });
    await Promise.resolve();
    expect(started).toEqual(['large', 'small']);
    gates.get('small')?.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['large', 'small', 'later']);
    gates.get('large')?.resolve();
    gates.get('later')?.resolve();
    await run;
  });

  it('allows individual cancellation/failure without replaying or blocking siblings', async () => {
    const pending = [item('cancelled'), item('failed'), item('next')],
      started: string[] = [],
      outcomes: string[] = [];
    const active = deferred();
    const run = runUploadPool({
      concurrency: 2,
      next: () => pending.shift(),
      run: async (entry) => {
        started.push(entry.path);
        if (entry.path === 'cancelled') await active.promise;
        outcomes.push(entry.path === 'next' ? 'complete' : entry.path);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['cancelled', 'failed', 'next']);
    active.resolve();
    await run;
    expect(outcomes).toEqual(['failed', 'complete', 'cancelled']);
  });

  it('stops dispatch after the identity is invalidated while draining active requests', async () => {
    const pending = [item('first'), item('second'), item('third')],
      gate = deferred();
    let current = true;
    const started: string[] = [];
    const run = runUploadPool({
      concurrency: 2,
      next: () => (current ? pending.shift() : undefined),
      run: async (entry) => {
        started.push(entry.path);
        await gate.promise;
      },
    });
    await Promise.resolve();
    current = false;
    gate.resolve();
    await run;
    expect(started).toEqual(['first', 'second']);
    expect(pending.map((entry) => entry.path)).toEqual(['third']);
  });
});
