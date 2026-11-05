import type { GameViewerProps } from '@nickhosting/game-sdk/ui';
import { useEffect, useState } from 'react';
import { parseSaveHeader, type SaveHeader, saveHeaderReadLimit } from './save-header.js';
import './save-viewer.css';

const key = (name: string) => `games.satisfactory.viewers.save.${name}`;
export default function SaveViewer({ source, host }: GameViewerProps) {
  const [state, setState] = useState<{ value?: SaveHeader; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    void host
      .readPrefix?.(saveHeaderReadLimit, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted) setState({ value: parseSaveHeader(bytes) });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          const message =
            error instanceof Error && error.message === 'unsupported_save_header'
              ? key('unsupported')
              : error &&
                  typeof error === 'object' &&
                  'messageKey' in error &&
                  typeof error.messageKey === 'string'
                ? error.messageKey
                : key('unavailable');
          setState({ error: message });
        }
      });
    if (!host.readPrefix) setState({ error: key('unavailable') });
    return () => controller.abort();
  }, [host]);
  if (state.error) return <p role="alert">{host.t(state.error)}</p>;
  if (!state.value) return <p role="status">{host.t(key('loading'))}</p>;
  const header = state.value;
  const duration = `${Math.floor(header.playDurationSeconds / 3600)}:${String(Math.floor(header.playDurationSeconds / 60) % 60).padStart(2, '0')}:${String(header.playDurationSeconds % 60).padStart(2, '0')}`;
  const fields = {
    session: header.sessionName,
    save: header.saveName ?? source.name,
    map: header.mapName,
    savedAt: new Date(header.savedAt).toLocaleString(host.locale === 'it' ? 'it-IT' : 'en-GB'),
    duration,
    build: header.buildVersion,
    format: header.saveVersion,
  };
  return (
    <div className="satisfactory-save-viewer">
      <dl>
        {Object.entries(fields).map(([name, value]) => (
          <div key={name}>
            <dt>{host.t(key(name))}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
