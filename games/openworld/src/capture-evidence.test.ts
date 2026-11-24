import { describe, expect, it } from 'vitest';
import { captureCursor, consumeCapturePage, matchCaptureFiles } from './capture-evidence.js';

const account = '3b3bc838-3ee1-4000-80ac-e83d87f4ef33';
const stamp = '2026-11-21 23:20:21.307';
const mtimeMs = Date.parse('2026-11-21T23:20:21.300Z');
const wrap = (channel: string, text: string, source: string) =>
  `${stamp} [INFO ] [${channel}] [t0] ${text}  (${source}:117)`;
const admit = (guest = 0) =>
  wrap(
    'server-auth',
    `EVT event=player.auth.admit req=T-01 conn=2 mode=online player=${account} guest=${guest} staff=0`,
    'PlayerAuth.cpp',
  );
const request = (id: number) =>
  wrap(
    'server-console',
    `EVT event=console.exec req=U-08 verb=screenshot target=2 request_id=${id}`,
    'ConsoleVerbs.cpp',
  );
const name = (id: number) => `server-screenshot-mono99-conn2-req${id}.png`;
const written = (id: number) =>
  wrap(
    'server-net',
    `conn=2 : screenshot written: owserver_data/screenshots/${name(id)} (request_id=${id}, 2560x1600, 162269 byte(s))`,
    'ScreenshotDataHandler.cpp',
  );
const file = (id: number) => ({ name: name(id), bytes: 162269, mtimeMs });
const page = (start: number, ...texts: string[]) => ({
  last: start + texts.length - 1,
  lines: texts.map((text, i) => ({ seq: start + i, text })),
});

describe('native screenshot provenance', () => {
  it('correlates simultaneous captures independently of gallery order and verifies native file identity', () => {
    const state = captureCursor();
    consumeCapturePage(state, page(200, admit(), request(1), request(2)));
    const { captures } = consumeCapturePage(
      captureCursor(state),
      page(202, request(2), written(2), written(1)),
    );
    expect(captures.map((c) => [c.request, c.account])).toEqual([
      [2, account],
      [1, account],
    ]);
    expect(matchCaptureFiles(captures, [file(1), file(2)]).map((c) => c.name)).toEqual([
      name(2),
      name(1),
    ]);
    expect(
      matchCaptureFiles(captures, [
        { ...file(1), mtimeMs: mtimeMs - 5000 },
        { ...file(2), bytes: 5 },
      ]),
    ).toEqual([]);
    expect(matchCaptureFiles(captures, [file(1), file(1)])).toEqual([]);
  });
  it.each([60, -210, 345, 765])(
    'matches the disk revision across a native clock offset of %i minutes',
    (offset) => {
      const local = Date.parse(`${stamp.replace(' ', 'T')}Z`);
      const when = local - offset * 60_000;
      const state = captureCursor();
      consumeCapturePage(state, page(1, admit()), { before: when - 7_000, after: when - 6_800 });
      const { captures } = consumeCapturePage(
        captureCursor(state),
        page(1, admit(), request(7), written(7)),
        { before: when + 1_000, after: when + 1_100 },
      );
      expect(matchCaptureFiles(captures, [{ ...file(7), mtimeMs: when - 7 }])).toHaveLength(1);
      expect(matchCaptureFiles(captures, [{ ...file(7), mtimeMs: when - 3_600_000 }])).toEqual([]);
    },
  );
  it('holds recent first-page captures until a subsequent observed native line proves the clock offset', () => {
    const when = Date.parse('2026-11-21T22:20:21.307Z');
    const state = captureCursor();
    const { captures } = consumeCapturePage(state, page(200, admit(), request(1), written(1)), {
      before: when + 700,
      after: when + 880,
    });
    const original = { ...file(1), mtimeMs: when - 7 };
    expect(matchCaptureFiles(captures, [original], state.clock)).toEqual([]);
    expect(matchCaptureFiles(captures, [file(1)], state.clock)).toEqual([]);
    const fresh = admit().replace(stamp, '2026-11-21 23:20:22.607');
    consumeCapturePage(state, page(202, written(1), fresh), {
      before: when + 1500,
      after: when + 1600,
    });
    expect(matchCaptureFiles(captures, [original], state.clock)).toHaveLength(1);
    expect(matchCaptureFiles(captures, [file(1)], state.clock)).toEqual([]);
  });
  it('rejects ambiguous offsets after a long pause and accepts a clock change during a request', () => {
    const when = Date.parse('2026-10-25T00:59:58Z');
    const state = captureCursor();
    const connecting = admit().replace(stamp, '2026-10-25 02:59:50.000');
    const beforeChange = request(1).replace(stamp, '2026-10-25 02:59:58.000');
    const afterChange = written(1).replace(stamp, '2026-10-25 02:00:02.000');
    consumeCapturePage(state, page(1, connecting), { before: when - 5_000, after: when - 5_000 });
    consumeCapturePage(state, page(1, connecting, beforeChange), {
      before: when + 100,
      after: when + 120,
    });
    const ambiguous = captureCursor(state);
    expect(
      consumeCapturePage(ambiguous, page(2, beforeChange, afterChange), {
        before: when + 86_400_000,
        after: when + 86_400_100,
      }).captures,
    ).toEqual([]);
    const { captures } = consumeCapturePage(state, page(2, beforeChange, afterChange), {
      before: when + 4200,
      after: when + 4220,
    });
    expect(matchCaptureFiles(captures, [{ ...file(1), mtimeMs: when + 3995 }])).toHaveLength(1);
  });
  it('does not carry a request across a dropped page, a reused console sequence or a new admission', () => {
    for (const next of [
      page(9, written(7)),
      page(2, 'different process', written(7)),
      page(2, request(7), admit(1), written(7)),
    ]) {
      const state = captureCursor();
      consumeCapturePage(state, page(1, admit(), request(7)));
      expect(consumeCapturePage(state, next).captures).toEqual([]);
    }
  });
  it('rejects pasted logs, commands, a guest identity and a filename bearing different native IDs', () => {
    const chat = wrap('server-net', `chat: ${admit()}`, 'ChatHandler.cpp');
    const multiline = `chat payload\n${admit()}`;
    for (const identity of [
      chat,
      multiline,
      admit(1),
      admit().replace('PlayerAuth.cpp', 'ConsoleVerbs.cpp'),
    ]) {
      expect(
        consumeCapturePage(captureCursor(), page(1, identity, request(9), written(9))).captures,
      ).toEqual([]);
    }
    const write = written(1).replace(name(1), name(3));
    expect(
      consumeCapturePage(captureCursor(), page(1, admit(), request(1), write)).captures,
    ).toEqual([]);
    expect(
      consumeCapturePage(
        captureCursor(),
        page(
          1,
          admit(),
          request(1),
          wrap('server-net', 'client disconnected : conn=2 reason=left', 'EventDispatch.cpp'),
          written(1),
        ),
      ).captures,
    ).toEqual([]);
  });
});
