import type { GameViewerLogPage, GameViewerProps } from '@nickhosting/game-sdk/ui';
import { useEffect, useRef, useState } from 'react';
import { filterLog, logReadLimit, parseLog } from './log-parser.js';
import './log-viewer.css';

const key = (value: string) => `games.satisfactory.viewers.log.${value}`;
const pageSize = 200;
const errorKey = (error: unknown) =>
  error &&
  typeof error === 'object' &&
  'messageKey' in error &&
  typeof error.messageKey === 'string'
    ? error.messageKey
    : key('unavailable');
export default function LogViewer({ source, host }: GameViewerProps) {
  const [state, setState] = useState<{ value?: GameViewerLogPage; error?: string }>({});
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const [level, setLevel] = useState<'all' | 'error' | 'warning' | 'info'>('all');
  const [offset, setOffset] = useState(-1);
  const [refresh, setRefresh] = useState(0);
  const quietRefresh = useRef(false);
  const resolvedOffset = useRef(0);
  const previousRefresh = useRef(0);
  const archiveBytes = useRef<Promise<Uint8Array<ArrayBuffer>> | undefined>(undefined);
  const archiveLifetime = useRef<AbortController | undefined>(undefined);
  const archived = Boolean(source.entry || source.archives?.length);
  useEffect(() => {
    // A different host owns different selected-source authority and archive bytes.
    void host;
    const controller = new AbortController();
    archiveLifetime.current = controller;
    archiveBytes.current = undefined;
    return () => controller.abort();
  }, [host]);
  useEffect(
    () =>
      host.log?.onChange(() => {
        quietRefresh.current = true;
        setRefresh((value) => value + 1);
      }),
    [host],
  );
  useEffect(() => {
    if (query !== search) return;
    const controller = new AbortController();
    const update = refresh !== previousRefresh.current;
    const quiet = update && quietRefresh.current;
    const target = offset === -1 && update ? resolvedOffset.current : offset;
    const load = async () => {
      let value: GameViewerLogPage;
      if (archived) {
        if (source.size >= logReadLimit) throw { messageKey: key('archiveLarge') };
        const lifetime = archiveLifetime.current;
        if (!lifetime || !host.readPrefix) throw new Error('unavailable');
        if (update) archiveBytes.current = undefined;
        archiveBytes.current ??= host.readPrefix(logReadLimit, lifetime.signal);
        const bytes = await archiveBytes.current;
        if (bytes.length >= logReadLimit) throw { messageKey: key('archiveLarge') };
        const lines = parseLog(bytes);
        const filtered = filterLog(lines, search, level);
        const start = Math.min(
          Math.max(0, target),
          Math.max(0, Math.ceil(filtered.length / pageSize) - 1) * pageSize,
        );
        value = {
          revision: 'archive',
          offset: start,
          total: filtered.length,
          totalLines: lines.length,
          rows: filtered
            .slice(start, start + pageSize)
            .map((line) => ({ line: line.index + 1, text: line.text, level: line.level })),
        };
      } else {
        if (!host.log) throw new Error('unavailable');
        if (update) {
          await host.log.refresh(controller.signal);
          previousRefresh.current = refresh;
        }
        value = await host.log.page(
          { offset: target, limit: pageSize, query: search, level },
          controller.signal,
        );
      }
      if (controller.signal.aborted) return;
      resolvedOffset.current = value.offset;
      setState((previous) => ({
        value:
          previous.value && JSON.stringify(previous.value) === JSON.stringify(value)
            ? previous.value
            : value,
      }));
    };
    // Search is server-side over the complete snapshot; debounce typing, never the page buttons.
    const timer = setTimeout(() => {
      void load().catch((error) => {
        if (controller.signal.aborted) return;
        const denied =
          error &&
          typeof error === 'object' &&
          'status' in error &&
          [401, 403, 404, 410].includes(Number(error.status));
        setState((previous) => {
          if (
            quiet &&
            previous.value &&
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'viewer_revision_changed'
          )
            return previous;
          return { ...(denied ? {} : { value: previous.value }), error: errorKey(error) };
        });
      });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [host, archived, source.size, query, search, level, offset, refresh]);
  const page = state.value;
  return (
    <div className="satisfactory-log-viewer">
      <div className="satisfactory-log-toolbar">
        <label>
          {host.t(key('search'))}
          <input
            type="search"
            value={query}
            maxLength={256}
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(0);
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
              setOffset(0);
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
            quietRefresh.current = false;
            setRefresh((value) => value + 1);
          }}
          disabled={!page && !state.error}
        >
          {host.t(key('refresh'))}
        </button>
      </div>
      {state.error && <p role="alert">{host.t(state.error)}</p>}
      {!page ? (
        !state.error && <p role="status">{host.t(key('loading'))}</p>
      ) : !page.rows.length ? (
        <p>{host.t(key(page.totalLines ? 'noMatches' : 'empty'))}</p>
      ) : (
        <div className="satisfactory-log-lines">
          {page.rows.map((line) => (
            <div key={line.line} className={`satisfactory-log-${line.level}`}>
              <code>{line.text || '\u00a0'}</code>
            </div>
          ))}
        </div>
      )}
      {page && page.total > pageSize && (
        <nav className="satisfactory-log-pagination" aria-label={host.t(key('name'))}>
          <button
            type="button"
            disabled={page.offset === 0}
            onClick={() => setOffset(Math.max(0, page.offset - pageSize))}
          >
            {host.t(key('previous'))}
          </button>
          <span>
            {host.t(key('range'), {
              start: page.offset + 1,
              end: page.offset + page.rows.length,
              total: page.total,
            })}
          </span>
          <button
            type="button"
            disabled={page.offset + page.rows.length >= page.total}
            onClick={() => setOffset(page.offset + pageSize)}
          >
            {host.t(key('next'))}
          </button>
        </nav>
      )}
    </div>
  );
}
