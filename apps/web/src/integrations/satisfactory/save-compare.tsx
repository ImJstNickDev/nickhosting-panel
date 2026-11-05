import type { FilemanContext } from '@nickhosting/game-sdk/ui';
import {
  cachedParseSaveHeader,
  formatSaveMetadataValue,
  type SaveHeader,
  satisfactoryFileKind,
  saveHeaderReadLimit,
  saveMetadataFields,
  saveMetadataLabels,
  saveMetadataValue,
} from '@nickhosting/satisfactory/ui';
import { useEffect, useState } from 'react';
import { useLocale, useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { Dialog, ErrorNotice } from '../../components/ui.js';
import { useFilemanNavigation } from '../../features/fileman/host.js';
import { createGameViewerHost } from '../../features/viewer-engine/game-viewer-host.js';
import './save-compare.css';

const key = (name: string) => `games.satisfactory.viewers.save.${name}`;
type Selected = NonNullable<FilemanContext['selection']>;
export function comparableSatisfactorySaves(
  selection: Selected | undefined,
): selection is Selected {
  return (
    selection?.length === 2 &&
    selection.every(
      (file) => !file.directory && !file.symlink && satisfactoryFileKind(file.name) === 'save',
    )
  );
}
type ReadState = { header?: SaveHeader; error?: unknown };
function Comparison({
  serverId,
  identity,
  selection,
  onClose,
}: {
  serverId: string;
  identity: string;
  selection: Selected;
  onClose(): void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [states, setStates] = useState<ReadState[]>([{}, {}]);
  useEffect(() => {
    const controller = new AbortController();
    const hosts = selection.map((source) =>
      createGameViewerHost({
        source,
        serverId,
        identity,
        t: (name) => name,
        onViewerChange: () => {},
      }),
    );
    hosts.forEach(({ host }, index) => {
      void host
        .readPrefix?.(saveHeaderReadLimit, controller.signal)
        .then((bytes) => {
          const header = cachedParseSaveHeader(bytes);
          if (!controller.signal.aborted)
            setStates((current) => current.map((state, i) => (i === index ? { header } : state)));
        })
        .catch((error: unknown) => {
          const failure =
            error instanceof Error && error.message === 'unsupported_save_header'
              ? { messageKey: key('unsupported') }
              : error && typeof error === 'object' && 'messageKey' in error
                ? error
                : { messageKey: key('unavailable') };
          if (!controller.signal.aborted)
            setStates((current) =>
              current.map((state, i) => (i === index ? { error: failure } : state)),
            );
        });
    });
    return () => {
      controller.abort();
      hosts.forEach((item) => {
        item.dispose();
      });
    };
  }, [identity, selection, serverId]);
  const ready = states.every((state) => state.header);
  return (
    <Dialog
      open
      title={t(key('compare'))}
      onClose={onClose}
      className="satisfactory-save-comparison"
      closeIcon
    >
      <table>
        <thead>
          <tr>
            <th scope="col">{t(key('metadata'))}</th>
            {selection.map((source, index) => (
              <th scope="col" key={source.path}>
                {source.name}
                {states[index]?.error ? (
                  <ErrorNotice error={states[index]?.error} />
                ) : !states[index]?.header ? (
                  <p role="status">{t(key('loading'))}</p>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {saveMetadataFields.map((field) => {
            const values = states.map((state, index) =>
              state.header
                ? saveMetadataValue(state.header, field, selection[index]?.name ?? '')
                : undefined,
            );
            const different = ready && values[0] !== values[1];
            return (
              <tr key={field} data-different={different || undefined}>
                <th scope="row">
                  {t(key(saveMetadataLabels[field]))}
                  {different && <small>{t(key('different'))}</small>}
                </th>
                {values.map((value, index) => (
                  <td key={selection[index]?.path}>
                    {value === undefined ? '—' : formatSaveMetadataValue(value, field, locale)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Dialog>
  );
}
export function SatisfactorySaveCompare({
  serverId,
  selection,
}: {
  serverId: string;
  selection: Selected;
}) {
  const t = useT();
  const { viewerIdentity } = useFilemanNavigation();
  const [captured, setCaptured] = useState<{ identity: string; sources: Selected }>();
  useEffect(() => {
    setCaptured((current) => (current?.identity === viewerIdentity ? current : undefined));
  }, [viewerIdentity]);
  if (!viewerIdentity || !comparableSatisfactorySaves(selection)) return null;
  return (
    <>
      <Tooltip placement="cursor" content={t(key('compare'))}>
        <button
          type="button"
          className="fm-tool"
          aria-label={t(key('compare'))}
          onClick={() =>
            setCaptured({
              identity: viewerIdentity,
              sources: selection.map((source) => ({ ...source })),
            })
          }
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <path d="M3 4h7v16H3zM14 4h7v16h-7zM6 8h1m-1 4h1m10-4h1m-1 4h1" />
          </svg>
        </button>
      </Tooltip>
      {captured?.identity === viewerIdentity && (
        <Comparison
          serverId={serverId}
          identity={viewerIdentity}
          selection={captured.sources}
          onClose={() => setCaptured(undefined)}
        />
      )}
    </>
  );
}
