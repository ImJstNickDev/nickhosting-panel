import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';

export function IconPicker({
  frames,
  selected,
  onSelect,
}: {
  frames: { url: string; width?: number; height?: number; bpp?: number }[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  const t = useT();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selected);
  const image = frames[selected];
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);
  function choose(index: number) {
    setOpen(false);
    onSelect(index);
    trigger.current?.focus({ preventScroll: true });
  }
  if (!image) return null;
  return (
    <div className="ve-icon-picker" ref={root}>
      <span className="sr-only" id={`${id}-label`}>
        {t('viewer.iconImage')}
      </span>
      <button
        ref={trigger}
        type="button"
        className="text-button ve-icon-trigger"
        role="combobox"
        aria-labelledby={`${id}-label ${id}-value`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onBlur={(event) => {
          if (!root.current?.contains(event.relatedTarget)) setOpen(false);
        }}
        onClick={() => {
          setActive(selected);
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing)
            return;
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(
              open
                ? Math.max(
                    0,
                    Math.min(frames.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)),
                  )
                : selected,
            );
            setOpen(true);
          } else if (open && (event.key === 'Home' || event.key === 'End')) {
            event.preventDefault();
            setActive(event.key === 'Home' ? 0 : frames.length - 1);
          } else if (open && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            choose(active);
          } else if (event.key === 'Tab') setOpen(false);
        }}
      >
        <img src={image.url} alt="" draggable={false} />
        <span id={`${id}-value`}>
          {image.width} × {image.height}
          <small>{image.bpp} bit</small>
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div
          className="ve-icon-options"
          id={`${id}-options`}
          role="listbox"
          aria-labelledby={`${id}-label`}
        >
          {frames.map((frame, index) => (
            <button
              key={frame.url}
              id={`${id}-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === selected}
              data-active={index === active}
              onPointerMove={() => setActive(index)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <img src={frame.url} alt="" draggable={false} />
              <span>
                {frame.width} × {frame.height}
              </span>
              <small>{frame.bpp} bit</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
