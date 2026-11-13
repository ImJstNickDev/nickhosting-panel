import type { GameViewerLogPage, GameViewerProps } from '@nickhosting/game-sdk/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { filterLog, logReadLimit, parseLog } from './log-parser.js';
import { extendLogWindow, logPageSize } from './log-window.js';
import './log-viewer.css';

const key = (value: string) => `games.satisfactory.viewers.log.${value}`;
const errorKey = (error: unknown) =>
  error &&
  typeof error === 'object' &&
  'messageKey' in error &&
  typeof error.messageKey === 'string'
    ? error.messageKey
    : key('unavailable');
type Anchor = { line: string; top: number };
export default function LogViewer({ source, host }: GameViewerProps) {
  const [state, setState] = useState<{ value?: GameViewerLogPage; error?: string }>({});
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState<'all' | 'error' | 'warning' | 'info'>('all');
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const value = useRef<GameViewerLogPage | undefined>(undefined);
  const positioning = useRef<{ anchor?: Anchor; edge?: 'top' | 'bottom' } | undefined>(undefined);
  const runtime = useRef<
    { scroll(): void; refresh(quiet: boolean): void; fill(): void } | undefined
  >(undefined);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 200);
    return () => clearTimeout(timer);
  }, [query]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const viewport = window.visualViewport;
      const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      let remainingSpacing = 0;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        remainingSpacing +=
          (Number.parseFloat(style.paddingBottom) || 0) +
          (Number.parseFloat(style.borderBottomWidth) || 0) +
          (Number.parseFloat(style.marginBottom) || 0);
        if (parent.tagName === 'MAIN') break;
      }
      const height = Math.max(
        0,
        Math.floor(bottom - element.getBoundingClientRect().top - Math.max(16, remainingSpacing)),
      );
      if (element.style.height !== `${height}px`) element.style.height = `${height}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    const header = element.parentElement?.previousElementSibling;
    if (header) observer.observe(header);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
    };
  }, []);
  useLayoutEffect(() => {
    void state; // Restore the measured anchor after the new row window commits.
    const element = scroller.current,
      position = positioning.current;
    if (!element || !position) return;
    positioning.current = undefined;
    if (position.edge) element.scrollTop = position.edge === 'bottom' ? element.scrollHeight : 0;
    else if (position.anchor) {
      const row = element.querySelector<HTMLElement>(`[data-line="${position.anchor.line}"]`);
      if (row)
        element.scrollTop +=
          row.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          position.anchor.top;
    }
    runtime.current?.fill();
  }, [state]);
  useEffect(() => {
    if (query !== search) return;
    const controller = new AbortController();
    const archived = Boolean(source.entry || source.archives?.length);
    let reading = false,
      ready = false,
      queuedRefresh = false,
      queuedQuiet = true,
      fillAllowed = true;
    let archiveBytes: Promise<Uint8Array<ArrayBuffer>> | undefined;
    const anchor = (): Anchor | undefined => {
      const element = scroller.current;
      if (!element) return;
      const top = element.getBoundingClientRect().top;
      const row = Array.from(element.querySelectorAll<HTMLElement>('[data-line]')).find(
        (item) => item.getBoundingClientRect().bottom > top,
      );
      return row
        ? { line: row.dataset.line ?? '', top: row.getBoundingClientRect().top - top }
        : undefined;
    };
    const page = async (offset: number): Promise<GameViewerLogPage> => {
      if (!archived) {
        if (!host.log) throw new Error('unavailable');
        return host.log.page(
          { offset, limit: logPageSize, query: search, level },
          controller.signal,
        );
      }
      if (source.size >= logReadLimit || !host.readPrefix)
        throw { messageKey: key('archiveLarge') };
      archiveBytes ??= host.readPrefix(logReadLimit, controller.signal);
      const bytes = await archiveBytes;
      if (bytes.length >= logReadLimit) throw { messageKey: key('archiveLarge') };
      const lines = parseLog(bytes),
        filtered = filterLog(lines, search, level);
      const last = Math.max(0, Math.ceil(filtered.length / logPageSize) - 1) * logPageSize;
      const start = offset === -1 ? last : Math.min(Math.max(0, offset), last);
      return {
        revision: 'archive',
        offset: start,
        total: filtered.length,
        totalLines: lines.length,
        rows: filtered
          .slice(start, start + logPageSize)
          .map((row) => ({ line: row.index + 1, text: row.text, level: row.level })),
      };
    };
    const publish = (
      next: GameViewerLogPage,
      position: { anchor?: Anchor; edge?: 'top' | 'bottom' },
    ) => {
      if (controller.signal.aborted) return;
      value.current = next;
      positioning.current = position;
      setState({ value: next });
    };
    const perform = async (
      operation: 'initial' | 'before' | 'after' | 'refresh',
      quiet = false,
    ) => {
      if (reading) {
        if (operation === 'refresh') {
          queuedRefresh = true;
          queuedQuiet = queuedQuiet && quiet;
        }
        return;
      }
      const current = value.current;
      if (operation !== 'initial' && !current) return;
      let followEdge = false;
      reading = true;
      fillAllowed = true;
      setBusy(true);
      try {
        let next: GameViewerLogPage;
        if (operation === 'initial') next = await page(search || level !== 'all' ? 0 : -1);
        else if (operation === 'refresh') {
          if (archived) archiveBytes = undefined;
          else await host.log?.refresh(controller.signal);
          next = await page(current?.offset ?? 0);
          const wanted = current?.rows.length ?? logPageSize;
          while (next.rows.length < wanted && next.offset + next.rows.length < next.total) {
            const extra = await page(next.offset + next.rows.length);
            if (extra.revision !== next.revision || !extra.rows.length)
              throw { code: 'viewer_revision_changed', messageKey: key('changed') };
            next = { ...next, rows: [...next.rows, ...extra.rows].slice(0, wanted) };
          }
        } else {
          const offset =
            operation === 'before'
              ? Math.max(0, (current?.offset ?? 0) - logPageSize)
              : (current?.offset ?? 0) + (current?.rows.length ?? 0);
          const extra = await page(offset);
          next = current
            ? extendLogWindow(current, extra, operation === 'before' ? 'before' : 'after')
            : extra;
        }
        if (controller.signal.aborted) return;
        const position =
          operation === 'initial'
            ? { edge: (search || level !== 'all' ? 'top' : 'bottom') as 'top' | 'bottom' }
            : { anchor: anchor() };
        if (
          (operation === 'before' || operation === 'after') &&
          position.anchor &&
          !next.rows.some((row) => String(row.line) === position.anchor?.line)
        ) {
          followEdge = true;
          return;
        }
        ready = true;
        publish(next, position);
      } catch (error) {
        if (controller.signal.aborted) return;
        fillAllowed = false;
        if (
          quiet &&
          value.current &&
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'viewer_revision_changed'
        )
          return;
        const denied =
          error &&
          typeof error === 'object' &&
          'status' in error &&
          [401, 403, 404, 410].includes(Number(error.status));
        if (denied) {
          value.current = undefined;
          ready = false;
        }
        setState((previous) => ({
          ...(!denied ? { value: previous.value } : {}),
          error: errorKey(error),
        }));
      } finally {
        reading = false;
        if (!controller.signal.aborted) {
          setBusy(false);
          if (queuedRefresh) {
            const quiet = queuedQuiet;
            queuedRefresh = false;
            queuedQuiet = true;
            void perform('refresh', quiet);
          } else
            requestAnimationFrame(() => {
              if (!controller.signal.aborted) {
                runtime.current?.fill();
                if (operation === 'refresh' || followEdge) runtime.current?.scroll();
              }
            });
        }
      }
    };
    const loadEdge = (fill = false) => {
      const element = scroller.current,
        current = value.current;
      if (
        !ready ||
        reading ||
        !element ||
        !current ||
        controller.signal.aborted ||
        (fill && !fillAllowed)
      )
        return;
      if (fill && element.scrollHeight > element.clientHeight + 1) return;
      if (current.offset > 0 && (fill || element.scrollTop < 160)) void perform('before');
      else if (
        current.offset + current.rows.length < current.total &&
        (fill || element.scrollHeight - element.scrollTop - element.clientHeight < 160)
      )
        void perform('after');
    };
    runtime.current = {
      scroll: () => loadEdge(),
      fill: () => loadEdge(true),
      refresh: (quiet) => {
        void perform(value.current ? 'refresh' : 'initial', quiet);
      },
    };
    const unsubscribe = host.log?.onChange(() => {
      void perform('refresh', true);
    });
    void perform('initial');
    return () => {
      controller.abort();
      unsubscribe?.();
      runtime.current = undefined;
    };
  }, [host, source.entry, source.archives, source.size, query, search, level]);
  const page = state.value;
  return (
    <div className="satisfactory-log-viewer" ref={root} data-offset={page?.offset}>
      <div className="satisfactory-log-toolbar">
        <label>
          {host.t(key('search'))}
          <input
            type="search"
            value={query}
            maxLength={256}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </label>
        <label>
          {host.t(key('level'))}
          <select
            aria-label={host.t(key('level'))}
            value={level}
            onChange={(event) => {
              setLevel(event.target.value as typeof level);
            }}
          >
            {(['all', 'error', 'warning', 'info'] as const).map((value) => (
              <option key={value} value={value}>
                {host.t(key(value))}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            runtime.current?.refresh(false);
          }}
          disabled={busy}
        >
          {host.t(key('refresh'))}
        </button>
      </div>
      {state.error && <p role="alert">{host.t(state.error)}</p>}
      <section
        className="satisfactory-log-lines"
        ref={scroller}
        onScroll={() => runtime.current?.scroll()}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: A named scroll region must be keyboard scrollable.
        tabIndex={0}
        aria-label={host.t(key('contents'))}
      >
        {!page ? (
          !state.error && <p role="status">{host.t(key('loading'))}</p>
        ) : !page.rows.length ? (
          <p>{host.t(key(page.totalLines ? 'noMatches' : 'empty'))}</p>
        ) : (
          page.rows.map((line) => (
            <div key={line.line} data-line={line.line} className={`satisfactory-log-${line.level}`}>
              <code>{line.text || '\u00a0'}</code>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
