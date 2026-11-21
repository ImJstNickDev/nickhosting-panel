import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type OpenworldScreenshot, screenshotName } from './screenshots.js';

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uint = z.number().int().nonnegative().max(0xffffffff);
const account = z.uuid();
const session = z.object({ connection: uint, account });
const request = session.extend({ request: uint, seq: sequence, at: sequence });
const captureWrite = request.extend({
  writtenSeq: sequence,
  writtenAt: sequence,
  name: screenshotName,
  bytes: sequence,
});
const cursor = z.object({
  seq: sequence,
  anchor: z.string().max(64),
  seeded: z.boolean(),
  sessions: z.array(session).max(1024),
  requests: z.array(request).max(512),
  awaitingFiles: z
    .array(captureWrite.extend({ remaining: z.number().int().min(1).max(12) }))
    .max(512),
});
export const consolePage = z.object({
  last: sequence,
  lines: z.array(z.object({ seq: sequence, text: z.string() })).max(500),
});
export type CaptureCursor = z.output<typeof cursor>;
type ConsoleLine = z.output<typeof consolePage>['lines'][number];
export type CaptureWrite = z.output<typeof captureWrite>;

export function captureCursor(raw?: unknown): CaptureCursor {
  const result = cursor.safeParse(raw);
  return result.success
    ? result.data
    : { seq: 0, anchor: '', seeded: false, sessions: [], requests: [], awaitingFiles: [] };
}

function digest(line: ConsoleLine) {
  return createHash('sha256').update(line.text).digest('hex');
}

const envelope =
  /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) \[INFO \] \[([a-z-]+)\] \[t\d+\] (.+) {2}\(([A-Za-z0-9_]+\.cpp):\d+\)$/;
const admitted =
  /^EVT event=player\.auth\.admit req=[\w.-]{1,64} conn=(\d{1,10}) mode=(\w+) player=(\S{1,128}) guest=([01]) staff=[01]$/;
const lifecycle = /^client (?:connected|disconnected) : conn=(\d{1,10}) /;
const requested =
  /^EVT event=console\.exec req=[\w.-]{1,64} verb=screenshot target=(\d{1,10}) request_id=(\d{1,10})$/;
const written =
  /^conn=(\d{1,10}) : screenshot written: (?:[\w./-]{1,256}\/)?screenshots\/([^/\\]{1,192}) \(request_id=(\d{1,10}), \d{1,5}x\d{1,5}, (\d{1,12}) byte\(s\)\)$/;

function forget(state: CaptureCursor, connection: number) {
  state.sessions = state.sessions.filter((s) => s.connection !== connection);
  state.requests = state.requests.filter((r) => r.connection !== connection);
}

function event(state: CaptureCursor, line: ConsoleLine, touched: Set<number>) {
  if (line.text.length > 4096 || /[\r\n]/u.test(line.text) || line.text.includes('\0')) return;
  const fields = envelope.exec(line.text);
  if (!fields) return;
  const [, timestamp, channel, message, file] = fields;
  const at = Date.parse(`${timestamp?.replace(' ', 'T')}Z`);
  if (!Number.isSafeInteger(at) || !message) return;
  if (file === 'PlayerAuth.cpp' && channel === 'server-auth') {
    const match = admitted.exec(message);
    if (match) {
      const connection = Number(match[1]);
      touched.add(connection);
      forget(state, connection);
      const player = account.safeParse(match[3]);
      if (match[2] === 'online' && match[4] === '0' && player.success && connection <= 0xffffffff)
        state.sessions.push({ connection, account: player.data.toLowerCase() });
    }
  } else if (channel === 'server-net') {
    const change = file === 'EventDispatch.cpp' ? lifecycle.exec(message) : null;
    if (change) {
      const connection = Number(change[1]);
      forget(state, connection);
      touched.add(connection);
    }
    if (file !== 'ScreenshotDataHandler.cpp') return;
    const match = written.exec(message);
    if (!match) return;
    const connection = Number(match[1]);
    const name = match[2];
    const id = Number(match[3]);
    if (
      !name ||
      !screenshotName.safeParse(name).success ||
      !name.endsWith(`-conn${connection}-req${id}.png`)
    )
      return;
    const pending = state.requests.find((r) => r.connection === connection && r.request === id);
    if (!pending) return;
    state.requests = state.requests.filter((r) => r !== pending);
    if (at < pending.at || at - pending.at > 120_000) return;
    return { ...pending, writtenSeq: line.seq, writtenAt: at, name, bytes: Number(match[4]) };
  } else if (channel === 'server-console' && file === 'ConsoleVerbs.cpp') {
    const match = requested.exec(message);
    if (!match) return;
    const connection = Number(match[1]);
    const id = Number(match[2]);
    const owner = state.sessions.find((s) => s.connection === connection);
    state.requests = state.requests.filter((r) => r.connection !== connection || r.request !== id);
    if (owner && id <= 0xffffffff)
      state.requests.push({ ...owner, request: id, seq: line.seq, at });
    if (state.requests.length > 512) state.requests.shift();
  }
}

// Each continuation overlaps its last record. Reused sequence numbers after a restart,
// missed pages, and truncated rings all invalidate session-local evidence.
export function consumeCapturePage(state: CaptureCursor, page: z.output<typeof consolePage>) {
  const captures: CaptureWrite[] = [];
  const touched = new Set<number>();
  const first = page.lines[0];
  let start = 0;
  let gap = false;
  function reset() {
    Object.assign(state, captureCursor());
    touched.clear();
    gap = true;
  }
  if (state.anchor) {
    if (first?.seq === state.seq && digest(first) === state.anchor) start = 1;
    else reset();
  }
  for (const line of page.lines.slice(start)) {
    if (line.seq !== state.seq + 1) reset();
    const write = event(state, line, touched);
    if (write) captures.push(write);
    state.seq = line.seq;
  }
  const last = page.lines.at(-1);
  if (last) state.anchor = digest(last);
  if (state.sessions.length > 1024) reset();
  return { captures, touched, gap, caughtUp: state.seq === page.last };
}

export function matchCaptureFiles(writes: CaptureWrite[], files: OpenworldScreenshot[]) {
  const byName = new Map<string, OpenworldScreenshot | null>();
  for (const file of files) byName.set(file.name, byName.has(file.name) ? null : file);
  return writes.flatMap((write) => {
    const file = byName.get(write.name);
    // On the tested dedicated runtime the native logger uses UTC. The file mtime
    // immediately precedes the written event (6–7 ms in the real-client fixture).
    if (!file || file.bytes !== write.bytes || Math.abs(file.mtimeMs - write.writtenAt) > 2_000)
      return [];
    return [{ ...write, mtimeMs: file.mtimeMs }];
  });
}
