import type { Page } from '@playwright/test';

type Point = { x: number; y: number; t: number };
type Snapshot = { pointer: Point | null; mark: Point; frame: number };
type SamplingWindow = Window & { finishDragSample?: () => Snapshot[] };
const percentile = (v: number[], p: number) => {
  const sorted = v.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
};

/** Drive real mouse events at an independent cadence, recording the visible checkpoint.
 * Unlike a scripted camera track this exercises DOM input, streaming, camera and overlays.
 * The timing is event-to-observed-RAF; it does not include display scanout.
 */
export async function sampleIsometricDrag(page: Page, offset: number, onStart?: () => void) {
  const canvas = page.locator('.ow-map-stage canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw Error('Missing map canvas');
  const startX = Math.round(box.x + box.width * (offset > 0 ? 0.24 : 0.68)),
    y = Math.round(box.y + box.height * 0.68);
  const hit = await canvas.evaluate(
    (el, { x, y }) =>
      document.elementFromPoint(x, y) === el
        ? null
        : document.elementFromPoint(x, y)?.outerHTML.slice(0, 150),
    { x: startX, y },
  );
  if (hit) throw Error(`Canvas drag target obstructed: ${hit}`);
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    x: startX,
    y,
    clickCount: 1,
  });

  await page.evaluate(() => {
    const marker = document.querySelector<HTMLElement>('.ow-map-location');
    if (!marker) throw Error('Missing anchor');
    const events = new AbortController();
    let pointer: Point | null = null;
    const samples: Snapshot[] = [];
    window.addEventListener(
      'pointermove',
      (e) => {
        if (e.buttons === 1 && e.isTrusted)
          pointer = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      },
      { capture: true, signal: events.signal },
    );
    const sample = (frame: number) => {
      const r = (document.querySelector('.ow-map-location') ?? marker).getBoundingClientRect();
      samples.push({
        mark: { x: r.left + r.width / 2, y: r.top + r.height / 2, t: performance.now() },
        pointer,
        frame,
      });
      id = requestAnimationFrame(sample);
    };
    let id = requestAnimationFrame(sample);
    (window as SamplingWindow).finishDragSample = () => {
      cancelAnimationFrame(id);
      events.abort();
      delete (window as SamplingWindow).finishDragSample;
      return samples;
    };
    return new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  });
  const moves: Promise<unknown>[] = [];
  const steps = 112,
    durationMs = 1400;
  onStart?.();
  const start = performance.now();
  try {
    for (let step = 1; step <= steps; step++) {
      const wait = start + (step * durationMs) / steps - performance.now();
      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      moves.push(
        session.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: startX + Math.round((offset * step) / steps),
          y,
          buttons: 1,
          button: 'left',
          pointerType: 'mouse',
        }),
      );
    }
    await Promise.all(moves);
  } finally {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      buttons: 0,
      x: startX + offset,
      y,
      clickCount: 1,
    });
    await session.detach();
  }
  const samples = await page.evaluate(async () => {
    for (let i = 0; i < 5; i++)
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
    return (window as SamplingWindow).finishDragSample?.() ?? [];
  });
  const first = samples[0],
    last = samples.at(-1);
  if (!first || !last) throw Error('No presented samples');
  const raf: number[] = [],
    movementGaps: number[] = [],
    latency: number[] = [];
  let latestTime: number | undefined,
    maxBackwards = 0;
  for (let i = 1; i < samples.length; i++) {
    const curr = samples[i],
      prev = samples[i - 1];
    if (!curr || !prev || !curr.pointer) continue;
    const dx = (curr.mark.x - prev.mark.x) * Math.sign(offset);
    maxBackwards = Math.max(maxBackwards, -dx);
    raf.push(curr.frame - prev.frame);
    if (dx > 0.3) {
      if (latestTime !== undefined) movementGaps.push(curr.frame - latestTime);
      latestTime = curr.frame;
      latency.push(curr.mark.t - curr.pointer.t);
    }
  }
  const yPositions = samples.map((s) => s.mark.y);
  return {
    viewport: {
      cssWidth: Math.round(box.width),
      cssHeight: Math.round(box.height),
      dpr: await page.evaluate(() => devicePixelRatio),
    },
    meshResponses: await page.evaluate(
      ({ begin, end }) =>
        performance
          .getEntriesByType('resource')
          .filter(
            (entry) =>
              entry.name.includes('/map/meshes?') &&
              entry.startTime + entry.duration >= begin &&
              entry.startTime + entry.duration <= end,
          ).length,
      { begin: first.mark.t, end: last.mark.t },
    ),
    dx: last.mark.x - first.mark.x,
    expectedDx: offset,
    orthogonalDriftPx: Math.max(...yPositions) - Math.min(...yPositions),
    backwardsPx: maxBackwards,
    deliveredMoves: new Set(samples.flatMap((s) => (s.pointer ? [s.pointer.t] : []))).size,
    rafP50: percentile(raf, 0.5),
    rafP95: percentile(raf, 0.95),
    rafMax: Math.max(...raf),
    movementP95: percentile(movementGaps, 0.95),
    inputToObservedP95: percentile(latency, 0.95),
    over50ms: raf.filter((x) => x > 50.1).length,
  };
}
