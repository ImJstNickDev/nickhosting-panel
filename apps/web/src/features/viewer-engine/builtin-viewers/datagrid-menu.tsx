import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../../app/i18n.js';
import type { DatagridMenuAnchor } from './datagrid-table.js';
import './datagrid-menu.css';

export type DatagridMenuItem = {
  id: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
  children?: DatagridMenuItem[];
};

type MenuLevel = {
  items: DatagridMenuItem[];
  label: string;
  anchor: DatagridMenuAnchor;
};

/** Source-neutral menu: readers supply translated actions and enforce capabilities. */
export function DatagridMenu({
  anchor,
  label,
  items,
  note,
  onClose,
}: {
  anchor: DatagridMenuAnchor;
  label: string;
  items: DatagridMenuItem[];
  note?: string;
  onClose(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [submenus, setSubmenus] = useState<MenuLevel[]>([]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        anchor.trigger.focus({ preventScroll: true });
        closeRef.current();
      }
    }
    function dismissOnResize() {
      anchor.trigger.focus({ preventScroll: true });
      closeRef.current();
    }
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('resize', dismissOnResize);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('resize', dismissOnResize);
      // Do not take focus away from an action's newly opened dialog or editor.
      if (
        document.activeElement === document.body ||
        root.current?.contains(document.activeElement)
      ) {
        anchor.trigger.focus({ preventScroll: true });
      }
    };
  }, [anchor.trigger]);

  function close() {
    anchor.trigger.focus({ preventScroll: true });
    onClose();
  }

  const levels = [{ items, label, anchor }, ...submenus];
  return createPortal(
    <div ref={root} className="dg-context-root">
      {levels.map((level, depth) => (
        <MenuPanel
          // biome-ignore lint/suspicious/noArrayIndexKey: Each depth is a stable menu level.
          key={depth}
          {...level}
          note={depth === 0 ? note : undefined}
          submenu={depth > 0}
          expanded={submenus[depth]?.anchor.trigger.dataset.menuItem}
          onClose={close}
          onBack={() => {
            level.anchor.trigger.focus({ preventScroll: true });
            setSubmenus((current) => current.slice(0, depth - 1));
          }}
          onOpen={(item, trigger) => {
            if (!item.children?.length) return;
            const rect = trigger.getBoundingClientRect();
            setSubmenus((current) => [
              ...current.slice(0, depth),
              {
                items: item.children ?? [],
                label: item.label,
                anchor: { x: rect.right, y: rect.top, trigger },
              },
            ]);
          }}
          onFocusItem={(id) => {
            if (submenus[depth]?.anchor.trigger.dataset.menuItem !== id) {
              setSubmenus((current) => current.slice(0, depth));
            }
          }}
        />
      ))}
    </div>,
    document.body,
  );
}

function MenuPanel({
  anchor,
  label,
  items,
  note,
  submenu,
  expanded,
  onClose,
  onBack,
  onOpen,
  onFocusItem,
}: MenuLevel & {
  note?: string;
  submenu: boolean;
  expanded?: string;
  onClose(): void;
  onBack(): void;
  onOpen(item: DatagridMenuItem, trigger: HTMLElement): void;
  onFocusItem(id: string): void;
}) {
  const t = useT();
  const compact = window.matchMedia('(max-width: 600px)').matches;
  const panel = useRef<HTMLDivElement>(null);
  const noteId = useId();
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - 8;
    let left = anchor.x;
    if (submenu && left > maxLeft) left = anchor.trigger.getBoundingClientRect().left - rect.width;
    setPosition({
      left: Math.max(8, Math.min(left, maxLeft)),
      top: Math.max(8, Math.min(anchor.y, window.innerHeight - rect.height - 8)),
    });
    element.querySelector<HTMLElement>('[role="menuitem"][data-menu-item]')?.focus();
  }, [anchor, submenu]);

  return (
    <div
      ref={panel}
      className="dg-context-menu"
      role="menu"
      aria-label={label}
      aria-describedby={note ? noteId : undefined}
      style={position}
      tabIndex={-1}
      onKeyDown={(event) => {
        event.stopPropagation();
        const buttons = Array.from(
          panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
        );
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') event.preventDefault();
          if (event.key === 'Escape' && submenu) onBack();
          else onClose();
        } else if (event.key === 'ArrowLeft' && submenu) {
          event.preventDefault();
          onBack();
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          const trigger = buttons[index];
          const item = items.find((candidate) => candidate.id === trigger?.dataset.menuItem);
          if (item && trigger && !item.disabled) onOpen(item, trigger);
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          let next = index + (event.key === 'ArrowUp' ? -1 : 1);
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = buttons.length - 1;
          buttons[(next + buttons.length) % buttons.length]?.focus();
        } else if (
          event.key.length === 1 &&
          !event.ctrlKey &&
          !event.metaKey &&
          event.key !== ' '
        ) {
          const candidates = [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)];
          candidates
            .find((button) =>
              button.textContent
                ?.trim()
                .toLocaleLowerCase()
                .startsWith(event.key.toLocaleLowerCase()),
            )
            ?.focus();
        }
      }}
    >
      {submenu && compact && (
        <button
          type="button"
          role="menuitem"
          className="dg-context-back"
          tabIndex={-1}
          onClick={onBack}
        >
          <span className="dg-context-icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="m13 6-6 6 6 6M7 12h13" />
            </svg>
          </span>
          {t('web.back')}
        </button>
      )}
      {note && (
        <div className="dg-context-note" id={noteId} role="presentation">
          {note}
        </div>
      )}
      {items.map((item) => (
        <button
          type="button"
          role="menuitem"
          key={item.id}
          data-menu-item={item.id}
          data-danger={item.danger || undefined}
          aria-disabled={item.disabled || undefined}
          aria-haspopup={item.children?.length ? 'menu' : undefined}
          aria-expanded={item.children?.length ? expanded === item.id : undefined}
          tabIndex={-1}
          onFocus={() => onFocusItem(item.id)}
          onClick={(event) => {
            if (item.disabled) return;
            if (item.children?.length) onOpen(item, event.currentTarget);
            else {
              onClose();
              item.onSelect?.();
            }
          }}
        >
          <span className="dg-context-icon" aria-hidden="true">
            {item.icon}
          </span>
          <span>{item.label}</span>
          {item.children?.length ? (
            <span className="dg-context-chevron" aria-hidden="true">
              ›
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
