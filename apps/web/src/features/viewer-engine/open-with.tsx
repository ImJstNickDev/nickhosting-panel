import { useId, useRef, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { Dialog, ErrorNotice } from '../../components/ui.js';
import {
  availableViewers,
  selectableViewers,
  type ViewerId,
  type ViewerPreference,
  type ViewerSource,
  viewerExtension,
} from './core/registry.js';
import { setViewerPreference } from './preferences.js';
import { ViewerIcon } from './viewer-icon.js';

export function OpenWithIcon() {
  return (
    <svg
      className="fm-viewer-action-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 17.5h7m-3.5-3.5 3.5 3.5-3.5 3.5" />
    </svg>
  );
}

export function OpenWith({
  serverId,
  source,
  selected,
  available = true,
  onChoose,
  onClose,
}: {
  serverId: string;
  source: ViewerSource;
  selected?: ViewerId;
  available?: boolean;
  onChoose: (id: ViewerId) => void;
  onClose: () => void;
}) {
  const t = useT();
  const descriptionId = useId();
  const suggested = availableViewers(source).filter((choice) => available || choice.id === 'text');
  const all = selectableViewers(source).filter((choice) => available || choice.id === 'text');
  const [showAll, setShowAll] = useState(
    Boolean(selected && !suggested.some((item) => item.id === selected)),
  );
  const choices = showAll ? all : suggested;
  const extension = viewerExtension(source.name);
  const [scope, setScope] = useState<ViewerPreference['scope'] | 'once'>('once');
  const [pending, setPending] = useState<ViewerId>();
  const submitting = useRef(false);
  const [error, setError] = useState<unknown>();
  async function choose(viewer: ViewerId) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(viewer);
    setError(undefined);
    try {
      if (scope !== 'once' && available && extension)
        await setViewerPreference(serverId, { scope, extension, viewerId: viewer });
      onChoose(viewer);
    } catch (failure) {
      setError(failure);
    } finally {
      submitting.current = false;
      setPending(undefined);
    }
  }
  return (
    <Dialog
      open
      title={t('viewer.openWith')}
      closeIcon
      onClose={() => {
        if (!submitting.current) onClose();
      }}
      closeDisabled={Boolean(pending)}
      initialFocusSelector=".ve-viewer-card"
      className="ve-chooser"
    >
      <p className="ve-chooser-filename">{source.name}</p>
      {error ? <ErrorNotice error={error} /> : null}
      {!available && <p>{t('viewer.notConfigured')}</p>}
      {choices.length > 0 && available && extension && (
        <label className="ve-scope">
          <span>{t('viewer.scope', { extension })}</span>
          <select
            value={scope}
            disabled={Boolean(pending)}
            onChange={(event) => setScope(event.target.value as typeof scope)}
          >
            {(
              ['once', 'server', ...(source.gameId ? ['game' as const] : []), 'global'] as const
            ).map((value) => (
              <option key={value} value={value}>
                {t(`viewer.scope.${value}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {all.length > suggested.length && (
        <div className="ve-chooser-filter">
          <button
            type="button"
            className="text-button"
            aria-expanded={showAll}
            aria-controls={`${descriptionId}-choices`}
            disabled={Boolean(pending)}
            onClick={() => setShowAll((value) => !value)}
          >
            {t(showAll ? 'viewer.showSuggested' : 'viewer.showAll')}
          </button>
        </div>
      )}
      <fieldset
        id={`${descriptionId}-choices`}
        className={`ve-viewer-options${showAll ? ' ve-viewer-options-all' : ''}`}
      >
        <legend className="sr-only">{t('viewer.choose')}</legend>
        {choices.map((item) => (
          <button
            key={item.id}
            type="button"
            className="ve-viewer-card"
            aria-label={t(item.label)}
            aria-describedby={item.description ? `${descriptionId}-${item.id}` : undefined}
            aria-current={selected === item.id ? 'true' : undefined}
            disabled={Boolean(pending)}
            onClick={() => void choose(item.id)}
          >
            <span className="ve-viewer-mark" data-viewer={item.id}>
              <ViewerIcon id={item.id} />
            </span>
            <strong>{t(item.label)}</strong>
            {item.description && (
              <span className="ve-viewer-kind" id={`${descriptionId}-${item.id}`}>
                {t(item.description)}
              </span>
            )}
          </button>
        ))}
      </fieldset>
      {choices.length === 0 && <p>{t('viewer.noViewers')}</p>}
      <span role="status" className="sr-only">
        {pending ? t('web.pending') : ''}
      </span>
    </Dialog>
  );
}
