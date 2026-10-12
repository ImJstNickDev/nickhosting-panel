import { useQuery } from '@tanstack/react-query';
import { type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../app/i18n.js';
import { FileIcon } from './file-icon.js';
import { fileBreadcrumbs, joinFilePath, validMoveTarget } from './file-manager-model.js';
import { filePathCandidates } from './file-path-model.js';
import { fileDirectoryQuery } from './service-contracts.js';
import './file-destination-tree.css';

interface FileDestinationTreeProps {
  serverId: string;
  value: string;
  onChange: (path: string) => void;
  source: string;
  names: string[];
  disabled?: boolean;
}

interface TreeState extends FileDestinationTreeProps {
  expanded: Set<string>;
  active: string;
  tree: RefObject<HTMLDivElement | null>;
  focus: (path: string, element: HTMLElement) => void;
  toggle: (path: string) => void;
}

function DestinationFolder({
  path,
  name,
  level,
  state,
}: {
  path: string;
  name: string;
  level: number;
  state: TreeState;
}) {
  const t = useT();
  const id = useId();
  const item = useRef<HTMLDivElement>(null);
  const expanded = state.expanded.has(path);
  const query = useQuery({
    ...fileDirectoryQuery(state.serverId, path),
    enabled: expanded,
    retry: false,
  });
  // Reuse the path picker's filename guard as well as its stable folder ordering.
  const folders = filePathCandidates(query.data ?? [], '').filter((entry) => !entry.is_file);
  const expandable = !query.data || query.isError || folders.length > 0;
  const unavailable = !validMoveTarget(state.source, state.names, path);
  const selected = state.value === path;
  const focus = () => {
    if (item.current) state.focus(path, item.current);
  };
  const select = () => {
    focus();
    if (!state.disabled && !unavailable) state.onChange(path);
  };
  const toggle = () => {
    focus();
    if (!state.disabled) state.toggle(path);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
    const current = event.currentTarget;
    const rows = Array.from(
      state.tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
    );
    const index = rows.indexOf(current);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = rows[Math.min(index + 1, rows.length - 1)];
    else if (event.key === 'ArrowUp') next = rows[Math.max(index - 1, 0)];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows.at(-1);
    else if (event.key === 'ArrowRight') {
      if (expandable && !expanded) toggle();
      else
        next = current.querySelector<HTMLElement>('[role="group"] [role="treeitem"]') ?? undefined;
    } else if (event.key === 'ArrowLeft') {
      if (expandable && expanded) toggle();
      else next = current.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined;
    } else if (event.key === 'Enter' || event.key === ' ') select();
    else return;
    event.preventDefault();
    event.stopPropagation();
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <div
      ref={item}
      role="treeitem"
      aria-labelledby={`${id}-name`}
      aria-describedby={unavailable ? `${id}-unavailable` : undefined}
      aria-expanded={expandable ? expanded : undefined}
      aria-selected={selected}
      aria-disabled={Boolean(state.disabled || unavailable)}
      aria-level={level}
      data-destination-path={path}
      tabIndex={state.active === path ? 0 : -1}
      className="file-destination-item"
      onFocus={(event) => {
        if (event.target === event.currentTarget) state.focus(path, event.currentTarget);
      }}
      onKeyDown={keyDown}
      onClick={(event) => {
        if ((event.target as Element).closest('[role="treeitem"]') === event.currentTarget)
          select();
      }}
    >
      <div
        className="file-destination-row"
        style={{ paddingInlineStart: 4 + Math.min(level - 1, 6) * 16 }}
      >
        {expandable ? (
          <button
            type="button"
            tabIndex={-1}
            className="file-destination-toggle"
            aria-label={t(expanded ? 'file.destinationCollapse' : 'file.destinationExpand', {
              name,
            })}
            aria-expanded={expanded}
            aria-disabled={Boolean(state.disabled)}
            disabled={state.disabled}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
          >
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <path d={expanded ? 'm5 7 5 5 5-5' : 'm7 5 5 5-5 5'} />
            </svg>
          </button>
        ) : (
          <span className="file-destination-toggle-space" aria-hidden="true" />
        )}
        <FileIcon folder />
        <span className="file-destination-name" id={`${id}-name`}>
          {name}
        </span>
        {selected && (
          <svg
            className="file-destination-selected"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <path d="m4 10 4 4 8-8" />
          </svg>
        )}
      </div>
      {unavailable && (
        <span className="sr-only" id={`${id}-unavailable`}>
          {t('file.destinationUnavailable')}
        </span>
      )}
      {expanded && (
        // biome-ignore lint/a11y/useSemanticElements: A nested ARIA tree group is not a form fieldset.
        <div role="group" className="file-destination-children" aria-busy={query.isFetching}>
          {query.isPending && (
            <div className="file-destination-loading" role="status">
              <span className="sr-only">{t('web.loading')}</span>
              {[0, 1, 2].map((line) => (
                <span key={line} className="file-destination-skeleton" aria-hidden="true" />
              ))}
            </div>
          )}
          {query.isError && (
            <div className="file-destination-error" role="alert">
              <span>{t('file.pathUnavailable')}</span>
              <button
                type="button"
                className="secondary"
                aria-disabled={Boolean(state.disabled || query.isFetching)}
                disabled={state.disabled || query.isFetching}
                onClick={(event) => {
                  event.stopPropagation();
                  focus();
                  void query.refetch();
                }}
              >
                {t('web.retry')}
              </button>
            </div>
          )}
          {folders.map((folder) => (
            <DestinationFolder
              key={folder.name}
              path={joinFilePath(path, folder.name)}
              name={folder.name}
              level={level + 1}
              state={state}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DestinationTree(props: FileDestinationTreeProps) {
  const t = useT();
  const tree = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(
    () =>
      new Set(
        [...fileBreadcrumbs(props.source), ...fileBreadcrumbs(props.value)].map(({ path }) => path),
      ),
  );
  const [active, setActive] = useState('');
  const activePath = useRef('');
  const focusedItem = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = tree.current;
    if (!element) return;
    // A refreshed directory can remove the roving tab stop without a blur event.
    // Restore its closest surviving ancestor, without taking focus from another control.
    const observer = new MutationObserver(() => {
      const rows = Array.from(element.querySelectorAll<HTMLElement>('[role="treeitem"]'));
      const byPath = new Map(rows.map((row) => [row.dataset.destinationPath, row]));
      if (byPath.has(activePath.current)) return;
      let path = activePath.current;
      while (path && !byPath.has(path)) path = path.split('/').slice(0, -1).join('/');
      const fallback = byPath.get(path);
      if (!fallback) return;
      const restoreFocus =
        focusedItem.current &&
        !focusedItem.current.isConnected &&
        document.activeElement === document.body;
      activePath.current = path;
      setActive(path);
      if (restoreFocus) fallback.focus();
    });
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  const state: TreeState = {
    ...props,
    tree,
    expanded,
    active,
    focus: (path, element) => {
      activePath.current = path;
      focusedItem.current = element;
      setActive(path);
      if (document.activeElement !== element) element.focus();
    },
    toggle: (path) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    },
  };

  return (
    <div
      ref={tree}
      role="tree"
      aria-label={t('file.destination')}
      className="file-destination-tree"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) focusedItem.current = null;
      }}
    >
      <DestinationFolder path="" name={t('file.root')} level={1} state={state} />
    </div>
  );
}

export function FileDestinationTree(props: FileDestinationTreeProps) {
  return <DestinationTree key={`${props.serverId}\0${props.source}`} {...props} />;
}
