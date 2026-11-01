import { type Ref, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';

export function DatagridSearch({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange(value: string): void;
  inputRef: Ref<HTMLInputElement>;
}) {
  const t = useT();
  const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  return (
    <div className="dg-search-field" data-empty={value.length === 0}>
      <input
        ref={inputRef}
        type="search"
        aria-label={t('datagrid.searchData')}
        placeholder={t('datagrid.searchData')}
        aria-keyshortcuts={mac ? 'Meta+F' : 'Control+F'}
        maxLength={200}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {!value && <kbd>{mac ? '⌘ + F' : 'CTRL + F'}</kbd>}
    </div>
  );
}

export function DatagridColumnFilter({
  columns,
  value,
  onChange,
  disabled,
}: {
  columns: string[];
  value: string;
  onChange(value: string): void;
  disabled: boolean;
}) {
  const t = useT();
  return (
    <DatagridChoice
      label={t('datagrid.filterColumn')}
      value={value}
      onChange={onChange}
      disabled={disabled}
      choices={[
        { value: '', label: t('datagrid.allColumns') },
        ...columns.map((column) => ({ value: column, label: column })),
      ]}
    />
  );
}

export function DatagridChoice({
  choices,
  value,
  onChange,
  disabled,
  label,
}: {
  choices: Array<{ value: string; label: string }>;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  label: string;
}) {
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
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span>{choices.find((choice) => choice.value === value)?.label}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={label}
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
          {choices.map((choice) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={value === choice.value}
              key={choice.value}
              onClick={() => {
                onChange(choice.value);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <span>{choice.label}</span>
              <span aria-hidden="true">{value === choice.value ? '✓' : ''}</span>
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
