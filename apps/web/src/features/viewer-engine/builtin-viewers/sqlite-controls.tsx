import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';

export function DatagridColumnFilter({
  columns,
  value,
  onChange,
  disabled,
}: {
  columns: string[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    root.current
      ?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Wrapper observes focus leaving its interactive children.
    <div
      className="dg-column-filter"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="secondary dg-filter-trigger"
        ref={trigger}
        aria-label={t('datagrid.filterColumn')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span>{value || t('datagrid.allColumns')}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={t('datagrid.filterColumn')}
          className="dg-column-menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
            const index = items.indexOf(event.target as HTMLButtonElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          {['', ...columns].map((column) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={value === column}
              key={column}
              onClick={() => {
                onChange(column);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <span>{column || t('datagrid.allColumns')}</span>
              <span aria-hidden="true">{value === column ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DatagridResize({
  name,
  width,
  onResize,
}: {
  name: string;
  width: number;
  onResize: (width: number) => void;
}) {
  const t = useT();
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const resize = (next: number) => onResize(Math.min(720, Math.max(100, next)));
  return (
    // biome-ignore lint/a11y/useSemanticElements: An interactive resize separator is not a thematic break.
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('datagrid.resize', { column: name })}
      aria-valuemin={100}
      aria-valuemax={720}
      aria-valuenow={width}
      className="dg-resize"
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        resize(
          event.key === 'Home'
            ? 100
            : event.key === 'End'
              ? 720
              : width + (event.key === 'ArrowLeft' ? -20 : 20),
        );
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current) resize(drag.current.width + event.clientX - drag.current.x);
      }}
      onPointerUp={() => {
        drag.current = undefined;
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
      }}
      onPointerCancel={() => {
        drag.current = undefined;
      }}
    />
  );
}
