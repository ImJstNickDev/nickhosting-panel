import { describe, expect, it, vi } from 'vitest';
import { DelimitedClient, type DelimitedWorker } from './delimited-client.js';
import { DelimitedModel } from './delimited-model.js';
import {
  type DelimitedEdit,
  type DelimitedRequest,
  type DelimitedResponse,
  delimitedLimits,
} from './delimited-protocol.js';

const explicitHeader = { delimiter: 'auto', header: true } as const;

describe('delimited model', () => {
  it('detects semicolon and TSV without coercing numbers or duplicate columns', () => {
    const model = new DelimitedModel(
      'id;id;value\r\n00001;900719925474099312345;=1+2\r\n',
      'csv',
      explicitHeader,
    );
    const page = model.view();
    expect(page.delimiter).toBe(';');
    expect(page.columns).toEqual(['id', 'id', 'value']);
    expect(page.rows[0]?.cells).toEqual(['00001', '900719925474099312345', '=1+2']);
    expect(new DelimitedModel('name\tvalue\na\t01\n', 'tsv').view().rows[0]?.cells).toEqual([
      'a',
      '01',
    ]);
  });

  it('preserves BOM, CRLF, multiline quoting, escaped quotes and untouched field spellings', () => {
    const original = '\uFEFF"name",value,extra\r\n"first\r\nline","a""b",0001\r\n"last",002,\r\n';
    const model = new DelimitedModel(original, 'csv', explicitHeader);
    const first = model.view().rows[0];
    expect(first?.cells).toEqual(['first\r\nline', 'a"b', '0001']);
    expect(
      model.edit({ type: 'set-cell', rowId: required(first).id, column: 1, value: 'a"b' }, 0).text,
    ).toBe(original);
    const edited = model.edit(
      { type: 'set-cell', rowId: required(first).id, column: 1, value: 'new,value' },
      0,
    );
    expect(edited.text).toBe(original.replace('"a""b"', '"new,value"'));
    expect(edited.page.revision).toBe(1);
    expect(
      new DelimitedModel(edited.text, 'csv', explicitHeader).detail(required(first).id, 1),
    ).toBe('new,value');
  });

  it('rejects malformed quotes and never attempts repair', () => {
    for (const input of ['a,b\n"unfinished,b', 'a,b\n"quoted"junk,b', 'a,b\na"b,c']) {
      expect(() => new DelimitedModel(input)).toThrow('syntax');
    }
  });

  it('uses conservative header detection with explicit choices', () => {
    expect(new DelimitedModel('name,value\na,01\nb,02').view().header).toBe(true);
    expect(new DelimitedModel('alpha,beta\ngamma,delta').view().header).toBe(false);
    expect(new DelimitedModel('name,name\na,1').view().header).toBe(false);
    expect(new DelimitedModel('name,name\na,1', 'csv', explicitHeader).view().columns).toEqual([
      'name',
      'name',
    ]);
    expect(
      new DelimitedModel('name,value\na,1', 'csv', { delimiter: ',', header: false }).view().rows,
    ).toHaveLength(2);
  });

  it('retains ragged fields and pads only the view', () => {
    const source = 'a,b\n1,2,003\n4\n';
    const model = new DelimitedModel(source, 'csv', explicitHeader);
    const page = model.view();
    expect(page.columns).toEqual(['a', 'b', '']);
    expect(page.rows.map((row) => row.cells)).toEqual([
      ['1', '2', '003'],
      ['4', '', ''],
    ]);
    expect(
      model.edit({ type: 'set-cell', rowId: required(page.rows[0]).id, column: 0, value: '1' }, 0)
        .text,
    ).toBe(source);
    expect(
      model.edit(
        { type: 'set-cell', rowId: required(page.rows[1]).id, column: 2, value: 'tail' },
        0,
      ).text,
    ).toBe('a,b\n1,2,003\n4,,tail\n');
  });

  it('edits stable source identities after filtering and sorting', () => {
    const model = new DelimitedModel('key,value\nz,001\na,002\nm,003', 'csv', explicitHeader);
    const view = { query: '002', sort: { column: 0, direction: 'desc' } } as const;
    const row = required(model.view(view).rows[0]);
    const edit = model.edit(
      { type: 'set-cell', rowId: row.id, column: 0, value: 'changed' },
      0,
      view,
    );
    expect(edit.text).toBe('key,value\nz,001\nchanged,002\nm,003');
    expect(edit.page.rows[0]?.id).toBe(row.id);
    expect(() => model.edit({ type: 'remove-row', rowId: row.id }, 0)).toThrow('stale');
    expect(() => model.detail(row.id, 0, 0)).toThrow('stale');
  });

  it('inserts and removes rows/columns, renames headers and retains formula text', () => {
    const model = new DelimitedModel('a,b\nx,1', 'csv', explicitHeader);
    let result = model.edit({ type: 'insert-row', cells: ['y', '=SUM(A1)'] }, 0);
    expect(result.text).toBe('a,b\nx,1\ny,=SUM(A1)');
    const id = required(result.page.rows[1]).id;
    result = model.edit({ type: 'insert-column', column: 1, name: 'middle' }, result.page.revision);
    expect(result.page.columns).toEqual(['a', 'middle', 'b']);
    expect(model.detail(id, 2)).toBe('=SUM(A1)');
    result = model.edit(
      { type: 'rename-header', column: 1, value: 'renamed' },
      result.page.revision,
    );
    expect(model.detail(-1, 1)).toBe('renamed');
    result = model.edit({ type: 'remove-column', column: 1 }, result.page.revision);
    result = model.edit({ type: 'remove-row', rowId: id }, result.page.revision);
    expect(result.page.rows).toHaveLength(1);
    expect(result.page.rows[0]?.cells).toEqual(['x', '1']);
  });

  it.each(['beforeId', 'afterId'] as const)(
    'inserts at the source %s anchor selected through sorting, filtering and pagination',
    (anchor) => {
      const model = new DelimitedModel(
        'key,value\nz,keep\nx,hidden\na,keep\nm,keep',
        'csv',
        explicitHeader,
      );
      const view = {
        query: 'keep',
        column: 1,
        sort: { column: 0, direction: 'desc' },
        offset: 1,
        limit: 1,
      } as const;
      const row = required(model.view(view).rows[0]);
      expect(row.cells[0]).toBe('m');
      expect(row.sourceRow).toBe(5);
      const result = model.edit(
        { type: 'insert-row', [anchor]: row.id, cells: ['new', 'keep'] },
        0,
        view,
      );
      expect(result.text).toBe(
        anchor === 'beforeId'
          ? 'key,value\nz,keep\nx,hidden\na,keep\nnew,keep\nm,keep'
          : 'key,value\nz,keep\nx,hidden\na,keep\nm,keep\nnew,keep',
      );
      expect(model.view().rows.find((item) => item.id === row.id)?.sourceRow).toBe(
        anchor === 'beforeId' ? 6 : 5,
      );
      expect(result.page.rows[0]?.sourceRow).toBe(anchor === 'beforeId' ? 5 : 6);
    },
  );

  it('resolves repeatedly inserted row identities by source order, with current source ordinals', () => {
    const model = new DelimitedModel('name\na\nb', 'csv', explicitHeader);
    let result = model.edit({ type: 'insert-row', beforeId: 2, cells: ['middle'] }, 0);
    const middle = required(result.page.rows[1]);
    expect(middle.id).toBe(3);
    expect(middle.sourceRow).toBe(3);
    result = model.edit(
      { type: 'insert-row', afterId: middle.id, cells: ['after'] },
      result.page.revision,
    );
    result = model.edit(
      { type: 'insert-row', beforeId: middle.id, cells: ['before'] },
      result.page.revision,
    );
    expect(result.text).toBe('name\na\nbefore\nmiddle\nafter\nb');
    expect(result.page.rows.map(({ id, sourceRow }) => [id, sourceRow])).toEqual([
      [1, 2],
      [5, 3],
      [3, 4],
      [4, 5],
      [2, 6],
    ]);
    result = model.edit({ type: 'remove-row', rowId: 5 }, result.page.revision);
    expect(result.page.rows.map((row) => row.sourceRow)).toEqual([2, 3, 4, 5]);
  });

  it.each([true, false])('inserts first/last data rows with header=%s', (header) => {
    const model = new DelimitedModel(header ? 'name\na\nb' : 'a\nb', 'csv', {
      delimiter: ',',
      header,
    });
    let result = model.edit({ type: 'insert-row', position: 'first', cells: ['first'] }, 0);
    result = model.edit(
      { type: 'insert-row', position: 'last', cells: ['last'] },
      result.page.revision,
    );
    result = model.edit({ type: 'insert-row', cells: ['append'] }, result.page.revision);
    expect(result.text).toBe(`${header ? 'name\n' : ''}first\na\nb\nlast\nappend`);
    expect(result.page.rows.map((row) => row.sourceRow)).toEqual(
      header ? [2, 3, 4, 5, 6] : [1, 2, 3, 4, 5],
    );
    if (header) expect(result.page.columns).toEqual(['name']);
  });

  it.each([
    { source: '', header: false, expected: 'new' },
    { source: '', header: true, expected: '""\nnew' },
    { source: '""', header: true, expected: '""\nnew' },
    { source: 'name', header: true, expected: 'name\nnew' },
    { source: 'name\n', header: true, expected: 'name\nnew' },
  ])('inserts into empty data rows: %j', ({ source, header, expected }) => {
    for (const position of ['first', 'last'] as const) {
      const options = { delimiter: ',', header } as const;
      const model = new DelimitedModel(source, 'csv', options);
      const result = model.edit({ type: 'insert-row', position, cells: ['new'] }, 0);
      expect(result.text).toBe(expected);
      expect(result.page.rows).toHaveLength(1);
      expect(result.page.rows[0]?.sourceRow).toBe(header ? 2 : 1);
      expect(new DelimitedModel(result.text, 'csv', options).view().rows).toEqual(result.page.rows);
    }
  });

  it('rejects ambiguous, invalid and header anchors without changing source or revision', () => {
    const source = 'name\na\nb';
    const model = new DelimitedModel(source, 'csv', explicitHeader);
    const initial = model.view();
    const invalid: DelimitedEdit[] = [
      { type: 'insert-row', beforeId: 1, afterId: 2 },
      { type: 'insert-row', beforeId: 1, position: 'first' },
      { type: 'insert-row', afterId: 1, position: 'last' },
      { type: 'insert-row', beforeId: 0 },
      { type: 'insert-row', afterId: 0 },
      { type: 'insert-row', beforeId: 99 },
      { type: 'insert-row', afterId: 99 },
      { type: 'insert-row', afterId: 1.5 },
      { type: 'insert-row', position: 'middle' } as unknown as DelimitedEdit,
    ];
    for (const op of invalid) {
      expect(() => model.edit(op, 0)).toThrow('invalid');
      expect(model.view()).toEqual(initial);
      expect(model.edit({ type: 'set-cell', rowId: 1, column: 0, value: 'a' }, 0).text).toBe(
        source,
      );
    }
    const result = model.edit({ type: 'insert-row', position: 'first', cells: ['new'] }, 0);
    expect(result.page.rows[0]?.id).toBe(3);
  });

  it('preserves exact original fields and undo source when inserting beside quoted records', () => {
    const source = '\uFEFF"name",value\r\n"a\r\nb",0001\r\n"last",002';
    const model = new DelimitedModel(source, 'csv', explicitHeader);
    const originalPage = model.view();
    let result = model.edit({ type: 'insert-row', afterId: 1, cells: ['new,value', ''] }, 0);
    expect(result.text).toBe('\uFEFF"name",value\r\n"a\r\nb",0001\r\n"new,value",""\r\n"last",002');
    expect(new DelimitedModel(result.text, 'csv', explicitHeader).view().rows[1]?.cells).toEqual([
      'new,value',
      '',
    ]);
    result = model.edit(
      { type: 'remove-row', rowId: required(result.page.rows[1]).id },
      result.page.revision,
    );
    expect(result.text).toBe(source);
    // Source undo reloads the prior document, including its original spellings and identities.
    const restored = new DelimitedModel(source, 'csv', explicitHeader);
    expect(restored.view()).toEqual(originalPage);
    expect(restored.edit({ type: 'set-cell', rowId: 1, column: 1, value: '0001' }, 0).text).toBe(
      source,
    );
  });

  it('bounds pages, previews, file bytes and shape; failed edits are atomic', () => {
    const model = new DelimitedModel(
      `name,value\n${Array.from({ length: 250 }, (_, i) => `${i},${'x'.repeat(300)}`).join('\n')}`,
      'csv',
      explicitHeader,
    );
    const page = model.view({ limit: 100000 });
    expect(page.rows).toHaveLength(100);
    expect(page.rows[0]?.cells[1]).toHaveLength(256);
    expect(page.truncatedCells).toBe(true);
    expect(model.detail(required(page.rows[0]).id, 1)).toHaveLength(300);
    expect(() =>
      model.edit(
        {
          type: 'set-cell',
          rowId: required(page.rows[0]).id,
          column: 1,
          value: 'x'.repeat(delimitedLimits.bytes),
        },
        0,
      ),
    ).toThrow('limit');
    expect(model.view().revision).toBe(0);
    expect(model.detail(required(page.rows[0]).id, 1)).toHaveLength(300);
    expect(() => new DelimitedModel('é'.repeat(delimitedLimits.bytes))).toThrow('limit');
    expect(() => new DelimitedModel(Array(129).fill('x').join(','))).toThrow('limit');
    expect(() => new DelimitedModel('a,b\n'.repeat(50_001))).toThrow('limit');
  });

  it('handles empty files and a single quoted empty cell distinctly', () => {
    expect(new DelimitedModel('').view().rows).toEqual([]);
    expect(new DelimitedModel('\uFEFF').view().rows).toEqual([]);
    expect(new DelimitedModel('""').view().rows[0]?.cells).toEqual(['']);
    const model = new DelimitedModel('');
    const result = model.edit({ type: 'insert-row', cells: [''] }, 0);
    expect(result.page.rows).toHaveLength(1);
    expect(new DelimitedModel(result.text).view().rows).toHaveLength(1);
  });
});

class FakeWorker implements DelimitedWorker {
  onmessage: DelimitedWorker['onmessage'] = null;
  onerror: DelimitedWorker['onerror'] = null;
  onmessageerror: DelimitedWorker['onmessageerror'] = null;
  messages: (DelimitedRequest & { requestId: number })[] = [];
  terminated = false;
  postMessage(message: DelimitedRequest & { requestId: number }) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(response: DelimitedResponse) {
    this.onmessage?.({ data: response } as MessageEvent<DelimitedResponse>);
  }
}

describe('delimited client lifecycle', () => {
  it('terminates and fences stale worker messages on source changes', async () => {
    const workers: FakeWorker[] = [];
    const client = new DelimitedClient(undefined, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const old = client.load('old', 'csv');
    const stale = expect(old).rejects.toMatchObject({ code: 'stale' });
    const current = client.load('new', 'csv');
    expect(workers[0]?.terminated).toBe(true);
    required(workers[0]).reply({
      requestId: required(required(workers[1]).messages[0]).requestId,
      error: 'syntax',
    });
    required(workers[1]).reply({
      requestId: required(required(workers[1]).messages[0]).requestId,
      result: new DelimitedModel('new').view(),
    });
    await stale;
    expect((await current).rows[0]?.cells).toEqual(['new']);
    const pending = client.view();
    const disposed = expect(pending).rejects.toMatchObject({ code: 'disposed' });
    client.dispose();
    await disposed;
    expect(workers[1]?.terminated).toBe(true);
    await expect(client.view()).rejects.toMatchObject({ code: 'disposed' });
  });

  it('terminates a deadline-exceeding worker and allows explicit reload', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const client = new DelimitedClient(undefined, () => worker);
      const pending = client.load('x', 'csv');
      const timeout = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(delimitedLimits.deadlineMs);
      await timeout;
      expect(worker.terminated).toBe(true);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture');
  return value;
}
