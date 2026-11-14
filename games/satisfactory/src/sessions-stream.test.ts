import { expect, it } from 'vitest';
import { readOfflineSnapshots } from './offline-snapshots.js';
import { satisfactoryEnumerationMaxBytes } from './response-limits.js';
import { streamSatisfactorySessions } from './sessions-stream.js';

const save = {
  saveVersion: 1,
  buildVersion: 123,
  saveName: 'factory_"雪🌍',
  mapName: 'Persistent_Level',
  mapOptions: '\\escape',
  sessionName: 'Factory',
  playDurationSeconds: 123,
  saveDateTime: '2026-11-02T00:00:00Z',
  isModdedSave: false,
  isEditedSave: false,
  isCreativeModeEnabled: false,
};
async function* chunks(text: string, size = 1) {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}
const response = (saves = [save]) => ({
  data: { sessions: [{ sessionName: 'Factory', saveHeaders: saves }], currentSessionIndex: 0 },
});
it('emits a native save before the producer sends the remainder of its response', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ended = false;
  async function* source() {
    yield Buffer.from(
      `{"data":{"sessions":[{"sessionName":"Factory","saveHeaders":[${JSON.stringify(save)}`,
    );
    await gate;
    ended = true;
    yield Buffer.from(']}],"currentSessionIndex":0}}');
  }
  const events = streamSatisfactorySessions(source());
  expect((await events.next()).value).toMatchObject({ type: 'session', sessionName: 'Factory' });
  expect((await events.next()).value).toMatchObject({ type: 'save', save });
  expect(ended).toBe(false);
  release();
  expect((await events.next()).value).toEqual({ type: 'complete', data: response().data });
});
it('parses escaped strings and split multibyte UTF-8 even across one-byte chunks', async () => {
  const events = await collect(streamSatisfactorySessions(chunks(JSON.stringify(response()))));
  expect(events.at(-1)).toEqual({ type: 'complete', data: response().data });
});
it('supports large enumerations in the parser and persistent observations while ordinary replies stay bounded', async () => {
  const body = response(
    Array.from({ length: 1000 }, (_, i) => ({
      ...save,
      saveName: `save-${i}`,
      mapOptions: 'x'.repeat(1024),
    })),
  );
  expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(1048576);
  const events = await collect(streamSatisfactorySessions(chunks(JSON.stringify(body), 16384)));
  expect(events.filter((event) => event.type === 'save')).toHaveLength(1000);
  const snapshot = readOfflineSnapshots({ EnumerateSessions: { observedAt: Date.now(), body } });
  expect(snapshot.EnumerateSessions?.body.data).toEqual(body.data);
  expect(
    readOfflineSnapshots({
      GetServerOptions: {
        observedAt: Date.now(),
        body: { data: { serverOptions: { large: 'x'.repeat(65536) }, pendingServerOptions: {} } },
      },
    }),
  ).toEqual({});
});
it.each([
  (text: string) => text.slice(0, -2),
  (text: string) => `${text.slice(0, -1)},"errorCode":"insufficient_scope"}`,
  (text: string) => `${text}trailing`,
  (text: string) => text.replace('"currentSessionIndex":0', '"currentSessionIndex":10'),
  (text: string) =>
    text.replace('"currentSessionIndex":0', '"currentSessionIndex":0,"currentSessionIndex":0'),
  (text: string) => text.replace('"sessions":[', '"sessions":[,'),
  (text: string) => text.replace('"currentSessionIndex":0', '"currentSessionIndex":0,'),
])('never commits a malformed/truncated/late-error native envelope', async (modify) => {
  const emitted: unknown[] = [];
  await expect(async () => {
    for await (const event of streamSatisfactorySessions(
      chunks(modify(JSON.stringify(response())), 31),
    ))
      emitted.push(event);
  }).rejects.toThrow();
  expect(emitted).not.toContainEqual(expect.objectContaining({ type: 'complete' }));
});
it('rejects bytes over the configured ceiling and closes the source on consumer cancellation', async () => {
  await expect(
    collect(
      streamSatisfactorySessions(
        (async function* () {
          yield Buffer.alloc(satisfactoryEnumerationMaxBytes + 1);
        })(),
      ),
    ),
  ).rejects.toThrow();
  let closed = false;
  async function* source() {
    try {
      yield Buffer.from(JSON.stringify(response()));
    } finally {
      closed = true;
    }
  }
  const events = streamSatisfactorySessions(source());
  await events.next();
  await events.return(undefined);
  expect(closed).toBe(true);
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

it('emits session before its saves even when native JSON orders saveHeaders before sessionName', async () => {
  const value = {
    data: { currentSessionIndex: 0, sessions: [{ saveHeaders: [save], sessionName: 'Factory' }] },
  };
  const events = await collect(streamSatisfactorySessions(chunks(JSON.stringify(value), 11)));
  expect(events.map((event) => event.type)).toEqual(['session', 'save', 'complete']);
  expect(events.at(-1)).toEqual({ type: 'complete', data: response().data });
});
