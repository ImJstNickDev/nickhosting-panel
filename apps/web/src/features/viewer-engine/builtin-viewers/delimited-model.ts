import Papa from 'papaparse';
import type { DocumentPosition } from '../core/document-view.js';
import {
  type DelimitedDelimiter,
  type DelimitedEdit,
  type DelimitedEditResult,
  DelimitedError,
  type DelimitedOptions,
  type DelimitedPage,
  type DelimitedRevealResult,
  type DelimitedView,
  delimitedLimits,
} from './delimited-protocol.js';

interface RecordRow {
  id: number;
  cells: string[];
  /** Original field spellings preserve untouched quoting and exact text. */
  fields: string[];
  ending: string;
}
const delimiters: DelimitedDelimiter[] = [',', ';', '\t', '|'];
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const fail = (code: ConstructorParameters<typeof DelimitedError>[0]): never => {
  throw new DelimitedError(code);
};
const validIndex = (value: number, length: number) =>
  Number.isInteger(value) && value >= 0 && value < length;

/** Strict lexical validation and original field slices; Papa owns value decoding. */
function fieldsOf(raw: string, delimiter: string): string[] {
  const fields: string[] = [];
  let start = 0;
  let quoted = false;
  let closed = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (quoted) {
      if (char === '"') {
        if (raw[i + 1] === '"') i++;
        else {
          quoted = false;
          closed = true;
        }
      }
    } else if (char === delimiter) {
      fields.push(raw.slice(start, i));
      start = i + 1;
      closed = false;
    } else if (char === '"' && i === start && !closed) quoted = true;
    else if (closed || char === '"' || char === '\n' || char === '\r') fail('syntax');
  }
  if (quoted) fail('syntax');
  fields.push(raw.slice(start));
  return fields;
}
function headerLikely(rows: RecordRow[]): boolean {
  const first = rows[0]?.cells;
  if (!first || rows.length < 2 || new Set(first).size !== first.length) return false;
  if (!first.every((value) => /^[\p{L}_][\p{L}\p{N}_ .-]*$/u.test(value))) return false;
  const typed = (value: string) =>
    /^(?:[+-]?\d+(?:\.\d+)?|true|false|\d{4}-\d{2}-\d{2})$/i.test(value);
  const sample = rows.slice(1, 9);
  return (
    sample.every((row) => row.cells.length === first.length) &&
    first.some((_, column) => sample.every((row) => typed(row.cells[column] ?? '')))
  );
}
function validateRows(rows: RecordRow[]): void {
  if (rows.length > delimitedLimits.rows) fail('limit');
  let cells = 0;
  for (const row of rows) {
    cells += row.cells.length;
    if (row.cells.length > delimitedLimits.columns || cells > delimitedLimits.cells) fail('limit');
  }
}

/** Renderer-independent, worker-owned table. View ordering never changes source identity. */
export class DelimitedModel {
  readonly delimiter: DelimitedDelimiter;
  readonly newline: string;
  readonly header: boolean;
  private rows: RecordRow[] = [];
  private nextId = 0;
  private revision = 0;
  private readonly bom: string;
  private text: string;
  private offsets?: {
    revision: number;
    rows: { row: RecordRow; start: number; end: number; fields: number[] }[];
  };

  constructor(
    text: string,
    extension = 'csv',
    options: DelimitedOptions = { delimiter: 'auto', header: 'auto' },
  ) {
    if (text.length > delimitedLimits.bytes || bytes(text) > delimitedLimits.bytes) fail('limit');
    if (options.delimiter !== 'auto' && !delimiters.includes(options.delimiter)) fail('invalid');
    this.text = text;
    this.bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const input = text.slice(this.bom.length);
    const selected =
      options.delimiter === 'auto'
        ? extension.replace(/^\./, '').toLowerCase() === 'tsv'
          ? '\t'
          : ''
        : options.delimiter;
    let cursor = 0;
    let cellCount = 0;
    let parsedDelimiter: string = selected || ',';
    let newline = '\n';
    if (input)
      Papa.parse<string[]>(input, {
        delimiter: selected,
        delimitersToGuess: delimiters,
        header: false,
        dynamicTyping: false,
        skipEmptyLines: false,
        step: (result, parser) => {
          if (result.errors.some((error) => error.code !== 'UndetectableDelimiter')) {
            parser.abort();
            fail('syntax');
          }
          parsedDelimiter = result.meta.delimiter;
          newline = result.meta.linebreak || '\n';
          let raw = input.slice(cursor, result.meta.cursor);
          const phantom = cursor === input.length && raw === '';
          cursor = result.meta.cursor;
          if (phantom) return;
          const ending = raw.endsWith(newline) ? newline : '';
          if (ending) raw = raw.slice(0, -ending.length);
          cellCount += result.data.length;
          this.rows.push({
            id: this.nextId++,
            cells: result.data,
            fields: fieldsOf(raw, parsedDelimiter),
            ending,
          });
          if (
            this.rows.length > delimitedLimits.rows ||
            result.data.length > delimitedLimits.columns ||
            cellCount > delimitedLimits.cells
          ) {
            parser.abort();
            fail('limit');
          }
        },
      });
    if (!delimiters.includes(parsedDelimiter as DelimitedDelimiter)) fail('syntax');
    this.delimiter = parsedDelimiter as DelimitedDelimiter;
    this.newline = newline;
    this.header = options.header === 'auto' ? headerLikely(this.rows) : options.header;
    validateRows(this.rows);
  }

  private width(rows = this.rows): number {
    return rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  }
  private dataRows(): RecordRow[] {
    return this.header ? this.rows.slice(1) : this.rows;
  }
  private orderedRows(view: DelimitedView): RecordRow[] {
    const width = this.width();
    if (view.column !== undefined && !validIndex(view.column, width)) fail('invalid');
    if (
      view.sort &&
      (!validIndex(view.sort.column, width) || !['asc', 'desc'].includes(view.sort.direction))
    )
      fail('invalid');
    const query = (view.query ?? '').toLocaleLowerCase();
    if (query.length > 4096) fail('limit');
    let rows = this.dataRows();
    if (query)
      rows = rows.filter((row) =>
        (view.column === undefined ? row.cells : [row.cells[view.column] ?? '']).some((cell) =>
          cell.toLocaleLowerCase().includes(query),
        ),
      );
    if (view.sort) {
      const { column, direction } = view.sort;
      rows = [...rows].sort((a, b) => {
        const left = a.cells[column] ?? '';
        const right = b.cells[column] ?? '';
        return (left < right ? -1 : left > right ? 1 : 0) * (direction === 'asc' ? 1 : -1);
      });
    }
    return rows;
  }
  view(view: DelimitedView = {}): DelimitedPage {
    const width = this.width();
    const rows = this.orderedRows(view);
    const requestedOffset = Number.isFinite(view.offset)
      ? Math.max(0, Math.floor(view.offset ?? 0))
      : 0;
    const limit = Number.isFinite(view.limit)
      ? Math.max(1, Math.min(delimitedLimits.page, Math.floor(view.limit ?? delimitedLimits.page)))
      : delimitedLimits.page;
    const offset = Math.min(requestedOffset, Math.max(0, rows.length - 1));
    let truncatedCells = false;
    const preview = (cell: string) => {
      if (cell.length > delimitedLimits.preview) truncatedCells = true;
      return cell.slice(0, delimitedLimits.preview);
    };
    const columns = Array.from({ length: width }, (_, column) =>
      preview(this.header ? (this.rows[0]?.cells[column] ?? '') : String(column + 1)),
    );
    const sourceRows = new Map(this.rows.map((row, index) => [row.id, index + 1]));
    const pageRows = rows.slice(offset, offset + limit).map((row) => ({
      id: row.id,
      sourceRow: sourceRows.get(row.id) as number,
      cells: Array.from({ length: width }, (_, column) => preview(row.cells[column] ?? '')),
    }));
    return {
      revision: this.revision,
      delimiter: this.delimiter,
      newline: this.newline,
      header: this.header,
      columns,
      rows: pageRows,
      total: rows.length,
      offset,
      sourceRows: this.dataRows().length,
      truncatedCells,
    };
  }

  /** Build once per revision from retained lexical spellings, never reparse CSV. */
  private sourceOffsets() {
    if (this.offsets?.revision === this.revision) return this.offsets.rows;
    let cursor = this.bom.length;
    const rows = this.rows.map((row) => {
      const start = cursor;
      const fields = row.fields.map((field, column) => {
        if (column) cursor += this.delimiter.length;
        const offset = cursor;
        cursor += field.length;
        return offset;
      });
      const end = cursor;
      cursor += row.ending.length;
      return { row, start, end, fields };
    });
    this.offsets = { revision: this.revision, rows };
    return rows;
  }

  position(rowId: number, column: number, revision: number): DocumentPosition | null {
    if (revision !== this.revision) fail('stale');
    if (!validIndex(column, this.width())) return null;
    const row = this.sourceOffsets().find((item, index) =>
      rowId === -1 ? this.header && index === 0 : item.row.id === rowId,
    );
    // Padded cells in ragged records have no field spelling; use that record's end.
    return row ? { offset: row.fields[column] ?? row.end } : null;
  }

  reveal(position: DocumentPosition, view: DelimitedView, revision: number): DelimitedRevealResult {
    if (revision !== this.revision) fail('stale');
    if (!Number.isFinite(position.offset)) fail('invalid');
    const offset = Math.max(0, Math.min(this.text.length, Math.floor(position.offset)));
    const offsets = this.sourceOffsets();
    if (!offsets.length) return { page: this.view(view), view };
    // Record boundaries use raw source positions, including quoted embedded newlines.
    let low = 0;
    let high = offsets.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if ((offsets[middle]?.start ?? Infinity) <= offset) low = middle;
      else high = middle;
    }
    const target = offsets[low];
    if (!target) return fail('invalid');
    let column = 0;
    for (let index = 1; index < target.fields.length; index++) {
      if ((target.fields[index] ?? Infinity) > offset) break;
      column = index;
    }
    if (this.header && low === 0)
      return { page: this.view(view), view, selection: { row: -1, column } };
    let nextView = view;
    let rows = this.orderedRows(nextView);
    let index = rows.findIndex((row) => row.id === target.row.id);
    if (index < 0) {
      nextView = { ...view, query: '' };
      rows = this.orderedRows(nextView);
      index = rows.findIndex((row) => row.id === target.row.id);
    }
    const limit = Number.isFinite(view.limit)
      ? Math.max(1, Math.min(delimitedLimits.page, Math.floor(view.limit ?? delimitedLimits.page)))
      : delimitedLimits.page;
    nextView = { ...nextView, offset: Math.floor(index / limit) * limit };
    const page = this.view(nextView);
    return { page, view: nextView, selection: { row: index - page.offset, column } };
  }

  detail(rowId: number, column: number, revision = this.revision): string {
    if (revision !== this.revision) fail('stale');
    const row =
      rowId === -1 && this.header
        ? this.rows[0]
        : this.dataRows().find((item) => item.id === rowId);
    if (!row || !validIndex(column, this.width())) return fail('invalid');
    return row.cells[column] ?? '';
  }

  edit(op: DelimitedEdit, revision: number, view: DelimitedView = {}): DelimitedEditResult {
    if (revision !== this.revision) fail('stale');
    // Edits are transactional: syntax/size/shape failures leave source and revision intact.
    const rows = this.rows.map((row) => ({
      ...row,
      cells: [...row.cells],
      fields: [...row.fields],
    }));
    const width = this.width();
    const encode = (value: string) =>
      value === ''
        ? '""'
        : Papa.unparse([[value]], {
            delimiter: this.delimiter,
            newline: this.newline,
            escapeFormulae: false,
          });
    const setCell = (row: RecordRow, column: number, value: string) => {
      if (row.cells[column] === value) return;
      while (row.cells.length <= column) {
        row.cells.push('');
        row.fields.push('');
      }
      row.cells[column] = value;
      row.fields[column] = encode(value);
    };
    const find = (id: number) => {
      const row = rows.find((item, index) => item.id === id && (!this.header || index > 0));
      if (!row) return fail('invalid');
      return row;
    };
    let nextId = this.nextId;
    switch (op.type) {
      case 'set-cell':
        if (!validIndex(op.column, width)) fail('invalid');
        setCell(find(op.rowId), op.column, op.value);
        break;
      case 'rename-header':
        if (!this.header || !rows[0] || !validIndex(op.column, width)) return fail('invalid');
        setCell(rows[0], op.column, op.value);
        break;
      case 'insert-row': {
        if (
          [op.beforeId, op.afterId, op.position].filter((anchor) => anchor !== undefined).length >
            1 ||
          (op.position !== undefined && op.position !== 'first' && op.position !== 'last')
        )
          fail('invalid');
        const cells = op.cells ?? Array.from({ length: Math.max(1, width) }, () => '');
        if (!cells.length) fail('invalid');
        if (cells.length > delimitedLimits.columns) fail('limit');
        if (this.header && !rows.length)
          rows.push({
            id: nextId++,
            cells: cells.map(() => ''),
            fields: cells.map(() => '""'),
            ending: this.newline,
          });
        const index =
          op.beforeId !== undefined
            ? rows.indexOf(find(op.beforeId))
            : op.afterId !== undefined
              ? rows.indexOf(find(op.afterId)) + 1
              : op.position === 'first'
                ? this.header
                  ? 1
                  : 0
                : rows.length;
        rows.splice(index, 0, {
          id: nextId++,
          cells: [...cells],
          fields: cells.map(encode),
          ending: index < rows.length ? this.newline : '',
        });
        break;
      }
      case 'remove-row':
        rows.splice(rows.indexOf(find(op.rowId)), 1);
        break;
      case 'insert-column':
        if (!validIndex(op.column, width + 1)) fail('invalid');
        if (width >= delimitedLimits.columns) fail('limit');
        if (!rows.length) rows.push({ id: nextId++, cells: [], fields: [], ending: '' });
        for (const [index, row] of rows.entries()) {
          while (row.cells.length < op.column) {
            row.cells.push('');
            row.fields.push('');
          }
          const value = this.header && index === 0 ? (op.name ?? '') : '';
          row.cells.splice(op.column, 0, value);
          row.fields.splice(op.column, 0, encode(value));
        }
        break;
      case 'remove-column':
        if (!validIndex(op.column, width) || width <= 1) fail('invalid');
        for (const row of rows) {
          row.cells.splice(op.column, 1);
          row.fields.splice(op.column, 1);
          if (!row.cells.length) {
            row.cells.push('');
            row.fields.push('""');
          }
        }
        break;
    }
    validateRows(rows);
    // A newly inserted last record needs a separator after its predecessor.
    for (let index = 0; index < rows.length - 1; index++) {
      const row = rows[index];
      if (row && !row.ending) row.ending = this.newline;
    }
    const text =
      this.bom + rows.map((row) => row.fields.join(this.delimiter) + row.ending).join('');
    if (text.length > delimitedLimits.bytes || bytes(text) > delimitedLimits.bytes) fail('limit');
    if (text !== this.text) {
      this.rows = rows;
      this.nextId = nextId;
      this.text = text;
      this.revision++;
    }
    // Structural changes can invalidate a former column filter or sort.
    const newWidth = this.width();
    const safeView = {
      ...view,
      column:
        view.column !== undefined && validIndex(view.column, newWidth) ? view.column : undefined,
      sort: view.sort && validIndex(view.sort.column, newWidth) ? view.sort : undefined,
    };
    return { text: this.text, page: this.view(safeView) };
  }
}
