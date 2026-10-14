import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewLimits } from '../core/limits.js';
import { JsonClientError, JsonTreeClient } from './json-client.js';
import { JsonTreeModel, jsonFailure } from './json-model.js';
import { type JsonResponse, jsonWindowLimits } from './json-protocol.js';

describe('worker-resident JSON index', () => {
  it('preserves lexical numbers, duplicate keys, prototype-like names and source identities', () => {
    const source = '{"n":9007199254740993123456789,"n":1.234567890123456789,"__proto__":null}';
    const model = new JsonTreeModel(source, 'json');
    const children = model.view().rows.slice(1);
    expect(children.map((child) => [child.key, model.copy(child.id, 'value')])).toEqual([
      ['n', '9007199254740993123456789'],
      ['n', '1.234567890123456789'],
      ['__proto__', 'null'],
    ]);
    expect(new Set(children.map((child) => child.id)).size).toBe(3);
    expect(children.map((child) => model.detail(child.id).pointerAmbiguous)).toEqual([
      true,
      true,
      false,
    ]);
    expect(model.copy(model.view().selectedId, 'subtree')).toBe(source);
  });

  it('preserves JSONC comments/trailing commas and JSON5 lexemes and decodes only explicit string values', () => {
    const commented = '{/* a */"ok":true,}';
    const jsonc = new JsonTreeModel(commented, 'jsonc');
    expect(jsonc.copy(jsonc.view().selectedId, 'subtree')).toBe(commented);
    const model = new JsonTreeModel(
      "{bare:'va\\nlue', hex:0xabcdef, inf:-Infinity, n:NaN,}",
      'json5',
    );
    const rows = model.view().rows.slice(1);
    expect(rows.map((child) => child.preview)).toEqual([
      "'va\\nlue'",
      '0xabcdef',
      '-Infinity',
      'NaN',
    ]);
    expect(model.copy(rows[0]?.id ?? -1, 'decoded')).toBe('va\nlue');
    expect(model.copy(rows[0]?.id ?? -1, 'value')).toBe('va\nlue');
    expect(model.copy(rows[0]?.id ?? -1, 'subtree')).toBe("'va\\nlue'");
    expect(model.detail(rows[0]?.id ?? -1).decoded).toBe('va\nlue');
    expect(() => new JsonTreeModel(commented, 'json')).toThrow();
    expect(() => new JsonTreeModel('{"run":alert(1)}', 'json5')).toThrow();
  });

  it('encodes RFC 6901 pointers and marks descendants of duplicate members as ambiguous', () => {
    const model = new JsonTreeModel('{"a~/":{"":1},"dup":{"child":2},"dup":3}', 'json');
    let view = model.action({ type: 'search', query: '1' });
    expect(model.copy(view.selectedId, 'pointer')).toBe('/a~0~1/');
    expect(model.detail(view.selectedId).pointerAmbiguous).toBe(false);
    view = model.action({ type: 'search', query: 'child' });
    expect(model.copy(view.selectedId, 'pointer')).toBe('/dup/child');
    expect(model.detail(view.selectedId).pointerAmbiguous).toBe(true);
    expect(model.copy(model.view(0).rows[0]?.id ?? -1, 'pointer')).toBe('');
  });

  it('searches decoded keys and scalar values, reveals ancestors, and cycles matches in document order', () => {
    const model = new JsonTreeModel(
      '{"nested":{"key\\u0020match":"MAtch value"},"array":["other match",7]}',
      'json',
    );
    model.action({ type: 'collapseAll' });
    let view = model.action({ type: 'search', query: 'match' });
    expect(view.matchCount).toBe(2);
    expect(view.matchIndex).toBe(0);
    expect(view.rows.find((row) => row.selected)?.key).toBe('key match');
    expect(view.rows.filter((row) => row.expanded).map((row) => row.key)).toEqual([
      undefined,
      'nested',
    ]);
    const first = view.selectedId;
    view = model.action({ type: 'match', direction: -1 });
    expect(view.matchIndex).toBe(1);
    expect(model.copy(view.selectedId, 'pointer')).toBe('/array/0');
    view = model.action({ type: 'match', direction: 1 });
    expect(view.selectedId).toBe(first);
    view = model.action({ type: 'search', query: 'absent' });
    expect(view.matchCount).toBe(0);
    expect(view.matchIndex).toBe(-1);
    expect(model.action({ type: 'search', query: '' }).rows.every((row) => !row.matched)).toBe(
      true,
    );
  });

  it('navigates only visible rows and keeps selection visible when an ancestor collapses', () => {
    const model = new JsonTreeModel('{"branch":[1,2],"tail":3}', 'json');
    let view = model.action({ type: 'move', direction: 'next' });
    const branch = view.selectedId;
    expect(view.rows.find((row) => row.selected)?.key).toBe('branch');
    view = model.action({ type: 'move', direction: 'child' });
    expect(view.selectedId).toBe(branch);
    expect(view.totalVisible).toBe(5);
    view = model.action({ type: 'move', direction: 'child' });
    expect(model.copy(view.selectedId, 'pointer')).toBe('/branch/0');
    view = model.action({ type: 'collapse', id: branch });
    expect(view.selectedId).toBe(branch);
    expect(view.totalVisible).toBe(3);
    view = model.action({ type: 'move', direction: 'last' });
    expect(model.copy(view.selectedId, 'pointer')).toBe('/tail');
    expect(model.action({ type: 'move', direction: 'next' }).selectedId).toBe(view.selectedId);
    expect(model.action({ type: 'move', direction: 'first' }).selectedIndex).toBe(0);
    expect(model.action({ type: 'collapseAll' }).totalVisible).toBe(1);
  });

  it('bounds every normal reply while explicit clipboard requests retain complete source', () => {
    const key = 'k'.repeat(5000);
    const source = JSON.stringify({ [key]: `${'x'.repeat(20_000)}😀tail` });
    const model = new JsonTreeModel(source, 'json');
    const row = model.view().rows[1];
    expect(row?.key).toHaveLength(jsonWindowLimits.key);
    expect(row?.keyTruncated).toBe(true);
    expect(row?.preview).toHaveLength(jsonWindowLimits.preview);
    expect(row?.previewTruncated).toBe(true);
    const id = row?.id ?? -1;
    const detail = model.detail(id, 0, Number.MAX_SAFE_INTEGER);
    expect(detail.raw).toHaveLength(jsonWindowLimits.detail);
    expect(detail.pointer).toHaveLength(jsonWindowLimits.pointer);
    expect(detail.pointerTruncated).toBe(true);
    expect(model.copy(id, 'pointer')).toBe(`/${key}`);
    let rebuilt = '';
    for (let offset = 0; offset < detail.totalLength; ) {
      const chunk = model.detail(id, offset, 7);
      expect(chunk.raw.isWellFormed()).toBe(true);
      rebuilt += chunk.raw;
      offset = chunk.offset + chunk.raw.length;
    }
    expect(rebuilt).toBe(model.copy(id, 'subtree'));
    expect(model.detail(id, detail.totalLength + 100).raw).toBe('');
  });

  it('reports sanitized syntax locations and enforces bytes, nesting, node and deadline budgets', () => {
    let failure: unknown;
    try {
      new JsonTreeModel('{\n "a": }', 'json');
    } catch (error) {
      failure = error;
    }
    expect(jsonFailure(failure)).toEqual({ code: 'viewer.jsonInvalid', line: 2, column: 7 });
    expect(() => new JsonTreeModel(`${'['.repeat(129)}0${']'.repeat(129)}`, 'json')).toThrow(
      RangeError,
    );
    expect(() => new JsonTreeModel(`[${'0,'.repeat(100_000)}0]`, 'json')).toThrow(RangeError);
    expect(() => new JsonTreeModel(`"${'é'.repeat(previewLimits.jsonBytes / 2)}"`, 'json')).toThrow(
      'json_bytes',
    );
    let tick = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => tick++ * 6000);
    expect(() => new JsonTreeModel('1', 'json')).toThrow('json_timeout');
    clock.mockRestore();
    expect(jsonFailure(new RangeError())).toEqual({ code: 'viewer.jsonComplex' });
    expect(jsonFailure(new Error('json_timeout'))).toEqual({ code: 'viewer.jsonTimeout' });
  });

  it('keeps astral characters intact across raw, decoded and preview boundaries', () => {
    const model = new JsonTreeModel('"12345😀tail"', 'json');
    const first = model.detail(0, 0, 7);
    expect(first.raw).toBe('"12345');
    const second = model.detail(0, first.raw.length, 7);
    expect(first.raw + second.raw).toBe(model.copy(0, 'subtree'));
    expect(model.detail(0, 7, 7).offset).toBe(6);
    expect(model.detail(0, 0, 6).decoded).toBe('12345');
    expect(model.detail(0, 6, 6).decodedOffset).toBe(5);
    expect(second.raw.isWellFormed()).toBe(true);
    const preview = new JsonTreeModel(JSON.stringify(`${'a'.repeat(238)}😀`), 'json').view()
      .rows[0];
    expect(preview?.preview).toHaveLength(239);
    expect(preview?.preview.isWellFormed()).toBe(true);
    expect(preview?.previewTruncated).toBe(true);
  });

  it('benchmarks supported wide/deep/large fixtures and caps worker viewport serialization', () => {
    const fixtures = [
      ['wide', `[${Array.from({ length: 99_999 }, (_, index) => String(index)).join(',')}]`],
      ['deep', `${'['.repeat(128)}0${']'.repeat(128)}`],
      ['large', JSON.stringify({ payload: 'x'.repeat(7 * 1024 * 1024) })],
    ] as const;
    const timings: Record<
      string,
      { ms: number; sourceBytes: number; replyBytes: number; rows: number }
    > = {};
    for (const [name, source] of fixtures) {
      const start = performance.now();
      const model = new JsonTreeModel(source, 'json');
      model.action({ type: 'search', query: '99998' });
      const view = model.view(0, 100_000);
      timings[name] = {
        ms: Math.round(performance.now() - start),
        sourceBytes: new TextEncoder().encode(source).byteLength,
        replyBytes: new TextEncoder().encode(JSON.stringify(view)).byteLength,
        rows: view.rows.length,
      };
      expect(view.rows.length).toBeLessThanOrEqual(jsonWindowLimits.rows);
      expect(JSON.stringify(view).length).toBeLessThan(100_000);
      expect(timings[name]?.ms).toBeLessThan(previewLimits.jsonParseMs);
      if (name === 'wide') {
        expect(view.totalNodes).toBe(100_000);
        expect(view.selectedIndex).toBe(99_999);
        expect(model.view(99_990, 20).rows).toHaveLength(10);
      }
    }
    console.info('JSON index fixture timings (ms)', timings);
  });
});

class FakeWorker {
  static latest: FakeWorker;
  onmessage?: (event: MessageEvent<JsonResponse>) => void;
  onerror?: (event: ErrorEvent) => void;
  onmessageerror?: () => void;
  sent: { requestId: number }[] = [];
  terminated = false;
  constructor() {
    FakeWorker.latest = this;
  }
  postMessage(message: { requestId: number }) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(response: JsonResponse) {
    this.onmessage?.({ data: response } as MessageEvent<JsonResponse>);
  }
}

describe('JSON worker client lifetime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('routes request IDs and exposes structured parse errors', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new JsonTreeClient();
    const first = client.copy(3, 'value');
    const second = client.copy(4, 'value');
    FakeWorker.latest.reply({ requestId: 2, result: 'second' });
    FakeWorker.latest.reply({ requestId: 1, result: 'first' });
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    const failed = client.load('invalid', 'json');
    FakeWorker.latest.reply({
      requestId: 3,
      error: { code: 'viewer.jsonInvalid', line: 2, column: 3 },
    });
    await expect(failed).rejects.toMatchObject({
      messageKey: 'viewer.jsonInvalid',
      line: 2,
      column: 3,
    });
    client.dispose();
    expect(FakeWorker.latest.terminated).toBe(true);
  });

  it('aborts pending work, terminates the worker, and rejects subsequent requests', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const abort = new AbortController();
    const client = new JsonTreeClient(abort.signal);
    const pending = client.load('{}', 'json');
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.view(0)).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.latest.terminated).toBe(true);
    client.dispose();
  });

  it('reports worker and transport failures as unavailable and releases all pending work', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    for (const failure of ['error', 'messageerror', 'postMessage']) {
      const client = new JsonTreeClient();
      const worker = FakeWorker.latest;
      const first = client.load('{}', 'json');
      if (failure === 'postMessage') {
        vi.spyOn(worker, 'postMessage').mockImplementation(() => {
          throw new Error('Transport failed');
        });
      }
      const second = client.view(0);
      if (failure === 'error')
        worker.onerror?.({ preventDefault: vi.fn() } as unknown as ErrorEvent);
      if (failure === 'messageerror') worker.onmessageerror?.();
      await expect(first).rejects.toMatchObject({ messageKey: 'viewer.jsonUnavailable' });
      await expect(second).rejects.toMatchObject({ messageKey: 'viewer.jsonUnavailable' });
      expect(worker.terminated).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('enforces a hard worker deadline even when synchronous parsing cannot respond', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    const client = new JsonTreeClient();
    const pending = client.load('{}', 'json');
    const rejection = expect(pending).rejects.toEqual(
      new JsonClientError({ code: 'viewer.jsonTimeout' }),
    );
    await vi.advanceTimersByTimeAsync(previewLimits.jsonParseMs);
    await rejection;
    expect(FakeWorker.latest.terminated).toBe(true);
  });
});
