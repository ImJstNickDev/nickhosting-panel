import type { GameViewerProps } from '@nickhosting/game-sdk/ui';
import { useEffect, useState } from 'react';
import { isSatisfactoryServerSettings } from '../fileman.js';
import {
  formatSaveMetadataValue,
  saveMetadataFields,
  saveMetadataLabels,
  saveMetadataValue,
} from './save-fields.js';
import { cachedParseSaveHeader, type SaveHeader, saveHeaderReadLimit } from './save-header.js';
import './save-viewer.css';

const key = (name: string) => `games.satisfactory.viewers.save.${name}`;
export default function SaveViewer({ source, host }: GameViewerProps) {
  const [state, setState] = useState<{ value?: SaveHeader; error?: string }>({});
  const serverSettings = isSatisfactoryServerSettings(source.name);
  useEffect(() => {
    if (serverSettings) return;
    const controller = new AbortController();
    setState({});
    void host
      .readPrefix?.(saveHeaderReadLimit, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted) setState({ value: cachedParseSaveHeader(bytes) });
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
  }, [host, serverSettings]);
  if (serverSettings) return <p>{host.t(key('serverSettings'))}</p>;
  if (state.error) return <p role="alert">{host.t(state.error)}</p>;
  if (!state.value) return <p role="status">{host.t(key('loading'))}</p>;
  const header = state.value;
  return (
    <div className="satisfactory-save-viewer">
      <dl>
        {saveMetadataFields.map((name) => (
          <div key={name}>
            <dt>{host.t(key(saveMetadataLabels[name]))}</dt>
            <dd>
              {formatSaveMetadataValue(
                saveMetadataValue(header, name, source.name),
                name,
                host.locale,
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
