import type { GameViewerProps } from '@nickhosting/game-sdk/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { filterLog, type LogLine, logReadLimit, parseLog } from './log-parser.js';
import './log-viewer.css';

const key = (value: string) => `games.satisfactory.viewers.log.${value}`;
const pageSize = 200;
export default function LogViewer({ source, host }: GameViewerProps) {
  const [state, setState] = useState<{ lines?: LogLine[]; truncated?: boolean; error?: string }>(
    {},
  );
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState('all');
  const [page, setPage] = useState(0);
  const currentFilter = useRef({ query, level });
  currentFilter.current = { query, level };
  useEffect(() => {
    void refresh;
    const controller = new AbortController();
    setState({});
    setPage(0);
    const archived = Boolean(source.entry || source.archives?.length);
    const read = async () => {
      if (archived && source.size >= logReadLimit) throw { messageKey: key('archiveLarge') };
      const result = archived
        ? { bytes: await host.readPrefix?.(logReadLimit, controller.signal), truncated: false }
        : await host.readTail?.(logReadLimit, controller.signal);
      if (!result?.bytes) throw new Error('unavailable');
      if (archived && result.bytes.length >= logReadLimit)
        throw { messageKey: key('archiveLarge') };
      const lines = parseLog(result.bytes, result.truncated);
      if (!controller.signal.aborted) {
        const filter = currentFilter.current;
        const count = filterLog(lines, filter.query, filter.level).length;
        setPage(archived ? 0 : Math.max(0, Math.ceil(count / pageSize) - 1));
        setState({ lines, truncated: result.truncated });
      }
    };
    void read().catch((error: unknown) => {
      if (!controller.signal.aborted)
        setState({
          error:
            error &&
            typeof error === 'object' &&
            'messageKey' in error &&
            typeof error.messageKey === 'string'
              ? error.messageKey
              : key('unavailable'),
        });
    });
    return () => controller.abort();
  }, [host, source.entry, source.archives, source.size, refresh]);
  const filtered = useMemo(
    () => filterLog(state.lines ?? [], query, level),
    [state.lines, query, level],
  );
  const rows = filtered.slice(page * pageSize, (page + 1) * pageSize);
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
              setPage(0);
            }}
          />
        </label>
        <label>
          {host.t(key('level'))}
          <select
            aria-label={host.t(key('level'))}
            value={level}
            onChange={(event) => {
              setLevel(event.target.value);
              setPage(0);
            }}
          >
            {['all', 'error', 'warning', 'info'].map((value) => (
              <option key={value} value={value}>
                {host.t(key(value))}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => setRefresh((value) => value + 1)}
          disabled={!state.lines && !state.error}
        >
          {host.t(key('refresh'))}
        </button>
      </div>
      {state.truncated && <p className="satisfactory-log-note">{host.t(key('tail'))}</p>}
      {state.error ? (
        <p role="alert">{host.t(state.error)}</p>
      ) : !state.lines ? (
        <p role="status">{host.t(key('loading'))}</p>
      ) : !rows.length ? (
        <p>{host.t(key(state.lines.length ? 'noMatches' : 'empty'))}</p>
      ) : (
        <div className="satisfactory-log-lines">
          {rows.map((line) => (
            <div key={line.index} className={`satisfactory-log-${line.level}`}>
              <code>{line.text || '\u00a0'}</code>
            </div>
          ))}
        </div>
      )}
      {filtered.length > pageSize && (
        <nav className="satisfactory-log-pagination" aria-label={host.t(key('name'))}>
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
            {host.t(key('previous'))}
          </button>
          <span>
            {host.t(key('range'), {
              start: page * pageSize + 1,
              end: Math.min((page + 1) * pageSize, filtered.length),
              total: filtered.length,
            })}
          </span>
          <button
            type="button"
            disabled={(page + 1) * pageSize >= filtered.length}
            onClick={() => setPage(page + 1)}
          >
            {host.t(key('next'))}
          </button>
        </nav>
      )}
    </div>
  );
}
