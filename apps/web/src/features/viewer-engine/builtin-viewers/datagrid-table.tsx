import type { ReactNode, RefObject } from 'react';
import { useFormat, useT } from '../../../app/i18n.js';
import { DatagridResize } from './sqlite-controls.js';

export type DatagridSelection = { row: number; column: number };
export type DatagridContext = DatagridSelection & { kind: 'cell' | 'row' | 'column' };
export type DatagridMenuAnchor = { x: number; y: number; trigger: HTMLElement };

/** Source-neutral rendering: readers own fetching, values, edits and consistency. */
export function DatagridTable<Row>({
  label,
  columns,
  rows,
  gridRef,
  rowKey,
  rowNumber,
  selected,
  onSelect,
  onOpen,
  onCopy,
  busy,
  readOnly,
  inert,
  sort,
  onSort,
  widths,
  onResize,
  empty,
  cellType,
  renderCell,
  editing,
  columnKey,
  onHeaderFocus,
  onHeaderOpen,
  onContext,
}: {
  label: string;
  columns: string[];
  rows: Row[];
  gridRef: RefObject<HTMLDivElement | null>;
  rowKey(row: Row, index: number): string | number;
  rowNumber(row: Row, index: number): number;
  selected?: DatagridSelection;
  onSelect(selection: DatagridSelection): void;
  onOpen(selection: DatagridSelection): void;
  onCopy(): void;
  busy: boolean;
  readOnly: boolean;
  inert?: boolean;
  sort?: { column: number; direction: 'asc' | 'desc' };
  onSort(column: number): void;
  widths: Map<string, number>;
  onResize(column: string, width: number): void;
  empty: string;
  cellType?(row: Row, column: number): string | undefined;
  renderCell(row: Row, column: number): ReactNode;
  editing?: DatagridSelection;
  columnKey?(index: number): string;
  onHeaderFocus?(column: number): void;
  onHeaderOpen?(column: number): void;
  onContext?(target: DatagridContext, anchor: DatagridMenuAnchor): void;
}) {
  const t = useT();
  const format = useFormat();
  function openContext(target: DatagridContext, trigger: HTMLElement, x?: number, y?: number) {
    if (!onContext) return;
    // Focus synchronously: a deferred cell focus would steal focus back from the menu.
    trigger.focus();
    if (target.kind === 'column') onHeaderFocus?.(target.column);
    else onSelect({ row: target.row, column: target.column });
    const bounds = trigger.getBoundingClientRect();
    onContext(target, { x: x ?? bounds.left, y: y ?? bounds.bottom, trigger });
  }
  return (
    <div className="dg-grid-scroll" ref={gridRef} inert={inert || undefined}>
      <table
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: WAI-ARIA grid retains native table semantics.
        role="grid"
        aria-label={label}
        aria-readonly={readOnly}
        className="dg-grid"
        style={{
          width:
            48 +
            columns.reduce(
              (sum, column, index) => sum + (widths.get(columnKey?.(index) ?? column) ?? 190),
              0,
            ),
        }}
      >
        <colgroup>
          <col style={{ width: 48 }} />
          {columns.map((column, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Source column positions also distinguish duplicate headers.
            <col key={index} style={{ width: widths.get(columnKey?.(index) ?? column) ?? 190 }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="dg-row-number" aria-label={t('datagrid.rowNumber')}>
              <span aria-hidden="true">#</span>
            </th>
            {columns.map((column, index) => (
              <th
                scope="col"
                // biome-ignore lint/suspicious/noArrayIndexKey: Source column positions distinguish duplicate headers.
                key={index}
                aria-sort={
                  sort?.column === index
                    ? sort.direction === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
                onContextMenu={(event) => {
                  const trigger = event.currentTarget.querySelector<HTMLElement>('.dg-sort');
                  if (!onContext || !trigger) return;
                  event.preventDefault();
                  openContext(
                    { kind: 'column', row: -1, column: index },
                    trigger,
                    event.clientX,
                    event.clientY,
                  );
                }}
              >
                <button
                  type="button"
                  className="dg-sort"
                  disabled={busy}
                  aria-label={t('datagrid.sort', { column })}
                  onClick={() => onSort(index)}
                  onFocus={() => onHeaderFocus?.(index)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (
                      onContext &&
                      (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
                    ) {
                      event.preventDefault();
                      openContext({ kind: 'column', row: -1, column: index }, event.currentTarget);
                      return;
                    }
                    if (event.key === 'ArrowDown' && rows.length) {
                      event.preventDefault();
                      gridRef.current
                        ?.querySelector<HTMLElement>(`[data-row="0"][data-column="${index}"]`)
                        ?.focus();
                    }
                    if (event.key === 'F2' && onHeaderOpen) {
                      event.preventDefault();
                      onHeaderOpen(index);
                    }
                  }}
                >
                  <span>{column}</span>
                  <span className="dg-sort-mark" aria-hidden="true">
                    {sort?.column === index ? (sort.direction === 'asc' ? '↑' : '↓') : ''}
                  </span>
                </button>
                <DatagridResize
                  name={column}
                  width={widths.get(columnKey?.(index) ?? column) ?? 190}
                  onResize={(width) => onResize(columnKey?.(index) ?? column, width)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowKey(row, rowIndex)}>
              <th
                scope="row"
                className="dg-row-number"
                onContextMenu={(event) => {
                  const trigger = event.currentTarget.querySelector<HTMLElement>('.dg-row-target');
                  if (!onContext || !trigger) return;
                  event.preventDefault();
                  openContext(
                    { kind: 'row', row: rowIndex, column: Math.max(0, selected?.column ?? 0) },
                    trigger,
                    event.clientX,
                    event.clientY,
                  );
                }}
              >
                {onContext ? (
                  <button
                    type="button"
                    className="dg-row-target"
                    tabIndex={-1}
                    data-row-target={rowIndex}
                    onFocus={() =>
                      onSelect({ row: rowIndex, column: Math.max(0, selected?.column ?? 0) })
                    }
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault();
                        openContext(
                          {
                            kind: 'row',
                            row: rowIndex,
                            column: Math.max(0, selected?.column ?? 0),
                          },
                          event.currentTarget,
                        );
                      }
                    }}
                  >
                    {format.number(rowNumber(row, rowIndex))}
                  </button>
                ) : (
                  format.number(rowNumber(row, rowIndex))
                )}
              </th>
              {columns.map((_, columnIndex) => {
                const active =
                  selected &&
                  selected.row >= 0 &&
                  selected.row < rows.length &&
                  selected.column < columns.length
                    ? selected.row === rowIndex && selected.column === columnIndex
                    : rowIndex === 0 && columnIndex === 0;
                const isEditing = editing?.row === rowIndex && editing.column === columnIndex;
                return (
                  <td
                    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: WAI-ARIA gridcell retains native table semantics.
                    role="gridcell"
                    // biome-ignore lint/suspicious/noArrayIndexKey: Source column positions distinguish duplicate headers.
                    key={columnIndex}
                    data-row={rowIndex}
                    data-column={columnIndex}
                    data-type={cellType?.(row, columnIndex)}
                    tabIndex={active ? 0 : -1}
                    aria-selected={!!selected && selected.row >= 0 && active}
                    onFocus={() => onSelect({ row: rowIndex, column: columnIndex })}
                    onClick={(event) => {
                      if (!isEditing) event.currentTarget.focus();
                    }}
                    onDoubleClick={() => {
                      if (!busy && !isEditing) onOpen({ row: rowIndex, column: columnIndex });
                    }}
                    onContextMenu={(event) => {
                      if (!onContext || isEditing) return;
                      event.preventDefault();
                      openContext(
                        { kind: 'cell', row: rowIndex, column: columnIndex },
                        event.currentTarget,
                        event.clientX,
                        event.clientY,
                      );
                    }}
                    onKeyDown={(event) => {
                      if (
                        isEditing ||
                        event.nativeEvent.isComposing ||
                        event.target !== event.currentTarget
                      )
                        return;
                      if (
                        onContext &&
                        (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
                      ) {
                        event.preventDefault();
                        openContext(
                          { kind: 'cell', row: rowIndex, column: columnIndex },
                          event.currentTarget,
                        );
                        return;
                      }
                      if (
                        (event.ctrlKey || event.metaKey) &&
                        event.key.toLowerCase() === 'c' &&
                        !window.getSelection()?.toString()
                      ) {
                        event.preventDefault();
                        onCopy();
                        return;
                      }
                      if (['Enter', 'F2'].includes(event.key) && !busy) {
                        event.preventDefault();
                        onOpen({ row: rowIndex, column: columnIndex });
                        return;
                      }
                      if (
                        ![
                          'ArrowLeft',
                          'ArrowRight',
                          'ArrowUp',
                          'ArrowDown',
                          'Home',
                          'End',
                        ].includes(event.key)
                      )
                        return;
                      event.preventDefault();
                      const next = { row: rowIndex, column: columnIndex };
                      if (event.key === 'ArrowLeft') next.column--;
                      if (event.key === 'ArrowRight') next.column++;
                      if (event.key === 'ArrowUp') next.row--;
                      if (event.key === 'ArrowDown') next.row++;
                      if (event.key === 'Home') {
                        next.column = 0;
                        if (event.ctrlKey || event.metaKey) next.row = 0;
                      }
                      if (event.key === 'End') {
                        next.column = columns.length - 1;
                        if (event.ctrlKey || event.metaKey) next.row = rows.length - 1;
                      }
                      next.row = Math.max(0, Math.min(rows.length - 1, next.row));
                      next.column = Math.max(0, Math.min(columns.length - 1, next.column));
                      gridRef.current
                        ?.querySelector<HTMLElement>(
                          `[data-row="${next.row}"][data-column="${next.column}"]`,
                        )
                        ?.focus();
                    }}
                  >
                    {renderCell(row, columnIndex)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="dg-empty">{empty}</div>}
    </div>
  );
}
