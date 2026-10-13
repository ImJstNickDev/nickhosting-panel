import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function ViewerSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = '',
  triggerContent,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; content?: ReactNode }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  triggerContent?: ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(selected);
  const open = expanded && !disabled && options.length > 0;
  const activeIndex = Math.min(active, options.length - 1);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !popup.current?.contains(target)) setExpanded(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const button = trigger.current;
    const menu = popup.current;
    if (!button || !menu) return;
    const position = () => {
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
      const topEdge = (viewport?.offsetTop ?? 0) + 8;
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 16;
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16;
      const anchor = button.getBoundingClientRect();
      const availableWidth = Math.max(0, rightEdge - leftEdge);
      menu.style.minWidth = `${Math.min(anchor.width, availableWidth)}px`;
      menu.style.maxWidth = `${availableWidth}px`;
      const below = Math.max(0, bottomEdge - anchor.bottom - 5);
      const above = Math.max(0, anchor.top - topEdge - 5);
      const desiredHeight = Math.min(menu.scrollHeight + 2, 288);
      const useAbove = below < desiredHeight && above > below;
      menu.style.maxHeight = `${Math.min(288, useAbove ? above : below)}px`;
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(leftEdge, Math.min(anchor.right - bounds.width, rightEdge - bounds.width))}px`;
      menu.style.top = `${Math.max(topEdge, Math.min(useAbove ? anchor.top - 5 - bounds.height : anchor.bottom + 5, bottomEdge - bounds.height))}px`;
    };
    const onScroll = (event: Event) => {
      if (!menu.contains(event.target as Node)) position();
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(button);
    observer.observe(menu);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', onScroll, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', onScroll, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const menu = popup.current;
    const option = document.getElementById(`${id}-${activeIndex}`);
    if (!menu || !option) return;
    const bounds = menu.getBoundingClientRect();
    const item = option.getBoundingClientRect();
    if (item.top < bounds.top) menu.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) menu.scrollTop += item.bottom - bounds.bottom;
  }, [open, activeIndex, id]);
  useEffect(() => {
    if (disabled) setExpanded(false);
  }, [disabled]);
  function choose(index: number) {
    const option = options[index];
    if (!option || disabled) return;
    setExpanded(false);
    onChange(option.value);
    trigger.current?.focus({ preventScroll: true });
  }
  return (
    <div className={`ve-select ${className}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="text-button ve-select-trigger"
        disabled={disabled || options.length === 0}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        aria-activedescendant={open ? `${id}-${activeIndex}` : undefined}
        onBlur={(event) => {
          if (
            !root.current?.contains(event.relatedTarget) &&
            !popup.current?.contains(event.relatedTarget)
          )
            setExpanded(false);
        }}
        onClick={() => {
          setActive(selected);
          setExpanded(!open);
        }}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing)
            return;
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            setExpanded(false);
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(
              open
                ? Math.max(
                    0,
                    Math.min(
                      options.length - 1,
                      activeIndex + (event.key === 'ArrowDown' ? 1 : -1),
                    ),
                  )
                : selected,
            );
            setExpanded(true);
          } else if (open && (event.key === 'Home' || event.key === 'End')) {
            event.preventDefault();
            setActive(event.key === 'Home' ? 0 : options.length - 1);
          } else if (open && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            choose(activeIndex);
          } else if (event.key === 'Tab') setExpanded(false);
        }}
      >
        {triggerContent ?? <span>{options[selected]?.label}</span>}
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
      {open &&
        createPortal(
          <div
            ref={popup}
            className={`ve-select-options ${className}`}
            id={`${id}-options`}
            role="listbox"
            aria-label={label}
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                id={`${id}-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-label={option.label}
                aria-selected={option.value === value}
                data-active={index === activeIndex}
                onPointerMove={() => setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                {option.content ?? option.label}
              </button>
            ))}
          </div>,
          document.fullscreenElement ?? document.body,
        )}
    </div>
  );
}
