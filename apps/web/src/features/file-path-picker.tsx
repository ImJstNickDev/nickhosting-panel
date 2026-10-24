import type { FilemanPathEntry } from '@nickhosting/game-sdk/ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../app/i18n.js';
import { filePathCandidates, parseFilePathInput } from './file-path-model.js';
import { useFilemanPathProvider } from './fileman/host.js';
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
  const provider = useFilemanPathProvider();
  const [value, setValue] = useState(
    () => provider?.currentPath ?? (directory ? `/${directory}/` : '/'),
  );
  const [error, setError] = useState<string>();
  const confirmation = useRef<AbortController | undefined>(undefined);
  const cancelConfirmation = useCallback(() => {
    confirmation.current?.abort();
    confirmation.current = undefined;
  }, []);
  const close = useCallback(() => {
    cancelConfirmation();
    onClose();
  }, [cancelConfirmation, onClose]);
  useLayoutEffect(() => cancelConfirmation, [cancelConfirmation]);
  const providerScope = useRef(provider);
  useLayoutEffect(() => {
    if (providerScope.current !== provider) {
      providerScope.current = provider;
      // A contributed filesystem changed while this picker was open. Close it,
      // including after its own successful navigation, instead of replaying stale work.
      close();
    }
  }, [provider, close]);
  const [selection, setSelection] = useState<{ revision: string; index: number }>();
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
    above: boolean;
  }>();
  const parsed = useMemo(() => parseFilePathInput(value), [value]);
  const virtual = parsed && provider?.owns(parsed.parent) ? provider : undefined;
  const nativeQuery = useQuery({
    ...fileDirectoryQuery(serverId, parsed?.parent ?? '', { prepareDownloads: false }),
    enabled: Boolean(parsed) && !virtual,
    retry: false,
  });
  const virtualQuery = useQuery({
    queryKey: ['fileman-path', ...(virtual?.key ?? []), parsed?.parent, parsed?.prefix],
    queryFn: ({ signal }) => {
      if (!virtual || !parsed) throw new Error('Fileman path provider unavailable.');
      return virtual.list(parsed.parent, parsed.prefix, signal);
    },
    enabled: Boolean(virtual),
    retry: false,
    // The provider owns its bounded metadata cache; the picker retains no duplicate history.
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const query = virtual ? virtualQuery : nativeQuery;
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
        close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [close]);

  const apply = async (
    operation: (signal: AbortSignal) => void | Promise<void>,
    closeOnSuccess: boolean,
  ) => {
    if (confirmation.current) return;
    const controller = new AbortController();
    confirmation.current = controller;
    setError(undefined);
    try {
      await operation(controller.signal);
      if (!controller.signal.aborted && closeOnSuccess) close();
    } catch {
      if (!controller.signal.aborted) setError('file.pathUnavailable');
    } finally {
      if (confirmation.current === controller) confirmation.current = undefined;
    }
  };
  const choose = (entry: FilemanPathEntry) => {
    if (!parsed || entry.is_symlink || query.isError || query.isPending) return;
    if (entry.is_file) {
      const path = join(parsed.parent, entry.name);
      if (provider?.owns(path)) void apply((signal) => provider.open(path, signal), true);
      else {
        const nativeEntry = nativeQuery.data?.find((file) => file.name === entry.name);
        if (nativeEntry) void apply(() => onOpenFile(nativeEntry, parsed.parent), false);
      }
    } else {
      cancelConfirmation();
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
    if (parsed.directoryInput) {
      if (provider?.owns(parsed.path))
        void apply((signal) => provider.navigate(parsed.path, signal), true);
      else void apply(() => onNavigate(parsed.path), false);
      return;
    }
    const match =
      candidates.find((entry) => entry.name === parsed.prefix) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (!match) return setError('file.pathNotFound');
    choose(match);
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
            cancelConfirmation();
            setValue(event.target.value);
            setSelection(undefined);
            setError(undefined);
          }}
          onBlur={() => {
            queueMicrotask(() => {
              const target = document.activeElement;
              if (target !== input.current && !popup.current?.contains(target)) close();
            });
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
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
