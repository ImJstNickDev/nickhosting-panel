import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../app/i18n.js';
import { filePathCandidates, parseFilePathInput } from './file-path-model.js';
import { fileDirectoryQuery, type ServerFile } from './service-contracts.js';
import './file-path-picker.css';

interface FilePathPickerProps {
  serverId: string;
  directory: string;
  focusSignal: number;
  onNavigate(path: string): void;
  onOpenFile(entry: ServerFile, directory: string): void;
  onClose(): void;
}

const join = (directory: string, name: string) => (directory ? `${directory}/${name}` : name);

export function FilePathPicker({
  serverId,
  directory,
  focusSignal,
  onNavigate,
  onOpenFile,
  onClose,
}: FilePathPickerProps) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(directory ? `/${directory}/` : '/');
  const [error, setError] = useState<string>();
  const [selection, setSelection] = useState<{ revision: string; index: number }>();
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
    above: boolean;
  }>();
  const parsed = useMemo(() => parseFilePathInput(value), [value]);
  const query = useQuery({
    ...fileDirectoryQuery(serverId, parsed?.parent ?? ''),
    enabled: Boolean(parsed),
    retry: false,
  });
  const candidates = useMemo(
    () => (parsed && !query.isError ? filePathCandidates(query.data ?? [], parsed.prefix) : []),
    [parsed, query.data, query.isError],
  );
  const revision = `${serverId}\0${value}\0${query.dataUpdatedAt}`;
  const active = selection?.revision === revision ? selection.index : -1;
  const current = candidates[active];
  const message =
    error ??
    (!parsed
      ? 'file.invalidPath'
      : query.isPending
        ? 'web.loading'
        : query.isError
          ? 'file.pathUnavailable'
          : candidates.length === 0
            ? 'file.pathNoMatches'
            : undefined);

  useLayoutEffect(() => {
    // A repeated shortcut must select the input even when this component stays mounted.
    void focusSignal;
    input.current?.focus();
    input.current?.select();
  }, [focusSignal]);

  useLayoutEffect(() => {
    const update = () => {
      if (!input.current) return;
      const anchor = input.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? document.documentElement.clientWidth;
      const height = viewport?.height ?? window.innerHeight;
      const below = top + height - anchor.bottom - 14;
      const above = anchor.top - top - 14;
      const displayAbove = below < 120 && above > below;
      const popupWidth = Math.min(Math.max(anchor.width, 280), width - 16);
      setPosition({
        left: Math.max(left + 8, Math.min(anchor.left, left + width - popupWidth - 8)),
        top: displayAbove ? anchor.top - 6 : anchor.bottom + 6,
        width: popupWidth,
        maxHeight: Math.max(48, Math.min(320, displayAbove ? above : below)),
        above: displayAbove,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    if (input.current) observer.observe(input.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, []);

  useEffect(() => {
    if (active >= 0)
      popup.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({
        block: 'nearest',
      });
  }, [active]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !input.current?.contains(event.target) &&
        !popup.current?.contains(event.target)
      )
        onClose();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [onClose]);

  const choose = (entry: ServerFile) => {
    if (!parsed || entry.is_symlink || query.isError || query.isPending) return;
    if (entry.is_file) onOpenFile(entry, parsed.parent);
    else {
      setValue(`/${join(parsed.parent, entry.name)}/`);
      setSelection(undefined);
      setError(undefined);
      input.current?.focus();
    }
  };
  const confirm = () => {
    if (!parsed) return setError('file.invalidPath');
    if (query.isPending) return;
    if (query.isError) return setError('file.pathUnavailable');
    if (current) return choose(current);
    if (parsed.directoryInput) return onNavigate(parsed.path);
    const exact = candidates.find((entry) => entry.name === parsed.prefix);
    if (!exact) return setError('file.pathNotFound');
    if (exact.is_file) onOpenFile(exact, parsed.parent);
    else onNavigate(join(parsed.parent, exact.name));
  };

  return (
    <>
      <form className="fm-path-form" onSubmit={(event) => event.preventDefault()}>
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label={t('web.path')}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded="true"
          aria-controls={`${id}-options`}
          aria-activedescendant={current ? `${id}-option-${active}` : undefined}
          aria-describedby={message ? `${id}-message` : undefined}
          aria-invalid={Boolean(error || !parsed)}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore="true"
          data-lpignore="true"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setSelection(undefined);
            setError(undefined);
          }}
          onBlur={() => {
            queueMicrotask(() => {
              const target = document.activeElement;
              if (target !== input.current && !popup.current?.contains(target)) onClose();
            });
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!candidates.length) return;
              const next =
                active < 0
                  ? event.key === 'ArrowDown'
                    ? 0
                    : candidates.length - 1
                  : (active + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) %
                    candidates.length;
              setSelection({ revision, index: next });
            } else if (event.key === 'Enter' || (event.key === ' ' && current)) {
              event.preventDefault();
              confirm();
            }
          }}
        />
      </form>
      {createPortal(
        <div
          ref={popup}
          className="file-path-popup"
          style={{
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            width: position?.width ?? 280,
            maxHeight: position?.maxHeight ?? 320,
            transform: position?.above ? 'translateY(-100%)' : undefined,
            visibility: position ? 'visible' : 'hidden',
          }}
        >
          <div
            id={`${id}-options`}
            role="listbox"
            className="file-path-options"
            aria-label={t('file.pathCandidates')}
          >
            {candidates.map((entry, index) => (
              <button
                type="button"
                role="option"
                id={`${id}-option-${index}`}
                key={entry.name}
                tabIndex={-1}
                aria-selected={index === active}
                className="file-path-option"
                onPointerDown={(event) => {
                  if (event.pointerType === 'mouse') event.preventDefault();
                }}
                onClick={() => choose(entry)}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                  data-folder={!entry.is_file}
                >
                  <path
                    d={
                      entry.is_file
                        ? 'M6 3h8l4 4v14H6Z M14 3v5h4'
                        : 'M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3Z'
                    }
                  />
                </svg>
                <span>
                  {entry.name}
                  {entry.is_file ? '' : '/'}
                </span>
              </button>
            ))}
          </div>
          {message && (
            <p id={`${id}-message`} role="status">
              {t(message)}
            </p>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
