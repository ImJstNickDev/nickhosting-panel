import { useState } from 'react';
import { useT } from '../../app/i18n.js';
import { Dialog, ErrorNotice } from '../../components/ui.js';
import {
  availableViewers,
  type ViewerId,
  type ViewerPreference,
  type ViewerSource,
  viewerExtension,
} from './core/registry.js';
import { setViewerPreference } from './preferences.js';

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
  const choices = availableViewers(source).filter((choice) => available || choice.id === 'text');
  const [viewer, setViewer] = useState<ViewerId | undefined>(selected ?? choices[0]?.id);
  const [remember, setRemember] = useState(false);
  const [scope, setScope] = useState<ViewerPreference['scope']>('server');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  async function choose() {
    if (!viewer || pending) return;
    setPending(true);
    setError(undefined);
    try {
      if (remember && available)
        await setViewerPreference(serverId, {
          scope,
          extension: viewerExtension(source.name),
          viewerId: viewer,
        });
      onChoose(viewer);
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      title={t('viewer.openWith')}
      closeIcon
      onClose={() => {
        if (!pending) onClose();
      }}
      closeDisabled={pending}
      className="ve-chooser"
    >
      <p className="ve-chooser-filename">{source.name}</p>
      {error ? <ErrorNotice error={error} /> : null}
      {!available && <p>{t('viewer.notConfigured')}</p>}
      <fieldset className="ve-viewer-options">
        <legend className="sr-only">{t('viewer.choose')}</legend>
        {choices.map((item) => (
          <label key={item.id}>
            <input
              type="radio"
              name="viewer"
              value={item.id}
              checked={viewer === item.id}
              onChange={() => setViewer(item.id)}
            />
            <span>{t(item.label)}</span>
          </label>
        ))}
      </fieldset>
      {choices.length === 0 ? (
        <p>{t('viewer.noViewers')}</p>
      ) : (
        <>
          {available && viewerExtension(source.name) && (
            <label className="ve-remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />
              {t('viewer.remember')}
            </label>
          )}
          {remember && (
            <label className="ve-scope">
              {t('viewer.scope')}
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as ViewerPreference['scope'])}
              >
                {(['server', 'game', 'global'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`viewer.scope.${value}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="ve-chooser-actions">
            <button type="button" className="secondary" disabled={pending} onClick={onClose}>
              {t('web.cancel')}
            </button>
            <button type="button" disabled={!viewer || pending} onClick={() => void choose()}>
              {t(pending ? 'web.pending' : 'viewer.open')}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
