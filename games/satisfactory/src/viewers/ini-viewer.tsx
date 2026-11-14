import type { GameViewerProps } from '@nickhosting/game-sdk/ui';
import { useEffect, useState } from 'react';
import { type IniLine, iniReadLimit, parseIni } from './ini-parser.js';
import './ini-viewer.css';

const key = (name: string) => `games.satisfactory.viewers.ini.${name}`;
const pageSize = 200;
export default function IniViewer({ source, host }: GameViewerProps) {
  const [state, setState] = useState<{ value?: IniLine[]; error?: string }>({});
  const [page, setPage] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    setPage(0);
    if (source.size >= iniReadLimit) {
      setState({ error: key('tooLarge') });
    } else if (!host.readPrefix) {
      setState({ error: key('unavailable') });
    } else {
      void host
        .readPrefix(iniReadLimit, controller.signal)
        .then((bytes) => {
          if (!controller.signal.aborted) setState({ value: parseIni(bytes) });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setState({
              error:
                error instanceof Error && error.message === 'ini_too_large'
                  ? key('tooLarge')
                  : error &&
                      typeof error === 'object' &&
                      'messageKey' in error &&
                      typeof error.messageKey === 'string'
                    ? error.messageKey
                    : key('unavailable'),
            });
          }
        });
    }
    return () => controller.abort();
  }, [host, source.size]);
  const rows = state.value?.slice(page * pageSize, (page + 1) * pageSize);
  return (
    <div className="satisfactory-ini-viewer">
      <div className="satisfactory-ini-toolbar">
        <button type="button" onClick={() => host.openViewer('text')}>
          {host.t(key('textEditor'))}
        </button>
      </div>
      {state.error ? (
        <p role="alert">{host.t(state.error)}</p>
      ) : !rows ? (
        <p role="status">{host.t(key('loading'))}</p>
      ) : !rows.length ? (
        <p>{host.t(key('empty'))}</p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th scope="col">{host.t(key('line'))}</th>
                <th scope="col">{host.t(key('setting'))}</th>
                <th scope="col">{host.t(key('value'))}</th>
              </tr>
            </thead>
            <tbody>
              {page > 0 && rows[0]?.kind !== 'section' && rows[0]?.section ? (
                <tr className="satisfactory-ini-section">
                  <td />
                  <th colSpan={2} scope="row">
                    [{rows[0].section}]
                  </th>
                </tr>
              ) : null}
              {rows.map((row) => (
                <tr key={row.line} className={`satisfactory-ini-${row.kind}`}>
                  <td className="satisfactory-ini-line">{row.line}</td>
                  {row.kind === 'entry' ? (
                    <>
                      <th scope="row">
                        <code>
                          {row.operator}
                          {row.key}
                        </code>
                        {row.operation !== 'set' ? (
                          <span className="satisfactory-ini-operation">
                            {host.t(key(row.operation))}
                          </span>
                        ) : null}
                      </th>
                      <td>
                        <code>{row.value}</code>
                      </td>
                    </>
                  ) : row.kind === 'section' ? (
                    <th scope="row" colSpan={2}>
                      <code>{row.raw}</code>
                    </th>
                  ) : (
                    <td colSpan={2}>
                      {row.kind === 'unrecognized' ? (
                        <span className="satisfactory-ini-operation">
                          {host.t(key('unrecognized'))}
                        </span>
                      ) : null}
                      <code>{row.raw || '\u00a0'}</code>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {state.value && state.value.length > pageSize ? (
            <nav className="satisfactory-ini-pagination" aria-label={host.t(key('name'))}>
              <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
                {host.t(key('previous'))}
              </button>
              <span>
                {host.t(key('range'), {
                  start: page * pageSize + 1,
                  end: Math.min((page + 1) * pageSize, state.value.length),
                  total: state.value.length,
                })}
              </span>
              <button
                type="button"
                disabled={(page + 1) * pageSize >= state.value.length}
                onClick={() => setPage(page + 1)}
              >
                {host.t(key('next'))}
              </button>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
