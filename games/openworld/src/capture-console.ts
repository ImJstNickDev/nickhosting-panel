import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import {
  type CaptureCursor,
  type CaptureWrite,
  consolePage,
  consumeCapturePage,
  matchCaptureFiles,
} from './capture-evidence.js';
import { OpenworldTokenExpired } from './dashboard-api.js';
import { readNativeBytes } from './native-response.js';
import { openworldScreenshots } from './screenshots.js';

const roster = z.object({ players: z.array(z.unknown()).max(1024) });
const verified = z.object({
  id: z.number().int().nonnegative().max(0xffffffff),
  account: z.uuid(),
  accountVerified: z.literal(true),
  admitted: z.literal(true),
});

export async function readCaptureEvidence(
  origin: string,
  token: string,
  signal: AbortSignal,
  state: CaptureCursor,
  fetcher = fetch,
  now = Date.now,
) {
  async function read(path: string) {
    const response = await fetcher(new URL(path, origin), {
      signal,
      redirect: 'error',
      headers: { accept: 'application/json', 'X-OW-Token': token },
    });
    if (
      !response.ok ||
      response.headers.get('content-type')?.split(';')[0] !== 'application/json'
    ) {
      await response.body?.cancel();
      if (response.status === 401) throw new OpenworldTokenExpired();
      throw new DomainError('integration_unavailable');
    }
    return JSON.parse(
      new TextDecoder().decode(await readNativeBytes(response, 4 * 1024 * 1024)),
    ) as unknown;
  }
  async function page() {
    const after = Math.max(0, state.seq - 1);
    const before = now();
    const result = consolePage.parse(await read(`/api/live/console?after=${after}&limit=500`));
    if (
      result.lines.some(
        (l, i) => l.seq > result.last || (i > 0 && l.seq <= (result.lines[i - 1]?.seq ?? 0)),
      )
    )
      throw new DomainError('integration_unavailable');
    return consumeCapturePage(state, result, { before, after: now() });
  }
  const writes: CaptureWrite[] = [];
  let caughtUp = false;
  // Bound recovery per pass so a busy server does not monopolize the worker.
  for (let i = 0; i < 4 && !caughtUp; ++i) {
    const result = await page();
    if (result.gap) writes.length = 0;
    writes.push(...result.captures);
    caughtUp = result.caughtUp;
  }
  if (!state.seeded && caughtUp) {
    // A player may have joined before the oldest retained console record. Fence
    // the verified live roster between console reads. Never apply it retroactively.
    const current = roster.parse(await read('/api/live/players'));
    const fence = await page();
    if (fence.gap) writes.length = 0;
    writes.push(...fence.captures);
    caughtUp = fence.caughtUp;
    if (fence.caughtUp && !fence.gap) {
      const seeded = new Map<number, string | null>();
      for (const p of current.players) {
        const player = verified.safeParse(p);
        if (player.success) {
          const { id, account } = player.data;
          seeded.set(id, seeded.has(id) ? null : account.toLowerCase());
        }
      }
      for (const [connection, account] of seeded) {
        if (
          account &&
          !fence.touched.has(connection) &&
          !state.sessions.some((s) => s.connection === connection)
        )
          state.sessions.push({ connection, account });
      }
      state.seeded = true;
    }
  }
  const pending = [...state.awaitingFiles, ...writes.map((write) => ({ ...write, remaining: 12 }))];
  const gallery = pending.length
    ? await openworldScreenshots(origin, token, signal, fetcher)
    : { files: [] };
  const captures = matchCaptureFiles(pending, gallery.files, state.clock);
  const matched = new Set(captures.map((c) => c.writtenSeq));
  state.awaitingFiles = pending
    .filter((w) => !matched.has(w.writtenSeq) && w.remaining > 1)
    .slice(-512)
    .map((w) => ({ ...w, remaining: w.remaining - 1 }));
  return { captures, caughtUp };
}
