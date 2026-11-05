import type { GameViewerProps } from '@nickhosting/game-sdk/ui';
import { useEffect, useState } from 'react';
import { type ManifestDocument, manifestReadLimit, parseManifest } from './manifest-parser.js';
import './manifest-viewer.css';

const key = (name: string) => `games.satisfactory.viewers.manifest.${name}`;
export default function ManifestViewer({ source, host }: GameViewerProps) {
  const [state, setState] = useState<{ value?: ManifestDocument; error?: string }>({});
  const [sectionIndex, setSectionIndex] = useState(0);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    setSectionIndex(0);
    setPage(0);
    if (source.size >= manifestReadLimit) {
      setState({ error: key('tooLarge') });
      return;
    }
    if (!host.readPrefix) {
      setState({ error: key('unavailable') });
      return;
    }
    void host
      .readPrefix(manifestReadLimit, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted) setState({ value: parseManifest(bytes, source.name) });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          error instanceof Error && error.message === 'manifest_too_large'
            ? key('tooLarge')
            : error instanceof Error && error.message === 'unsupported_manifest'
              ? key('unsupported')
              : error &&
                  typeof error === 'object' &&
                  'messageKey' in error &&
                  typeof error.messageKey === 'string'
                ? error.messageKey
                : key('unavailable');
        setState({ error: message });
      });
    return () => controller.abort();
  }, [host, source.name, source.size]);
  const t = (name: string) => host.t(key(name));
  const format = (value: string | number | boolean) =>
    typeof value === 'boolean' ? t(value ? 'yes' : 'no') : String(value);
  if (state.error)
    return (
      <div className="satisfactory-manifest-viewer">
        <p role="alert">{host.t(state.error)}</p>
      </div>
    );
  if (!state.value)
    return (
      <div className="satisfactory-manifest-viewer">
        <p role="status">{t('loading')}</p>
      </div>
    );
  const section = state.value.sections[sectionIndex];
  if (!section)
    return (
      <div className="satisfactory-manifest-viewer">
        <p>{t('noProfiles')}</p>
      </div>
    );
  const hasDetails = section.items.some(
    (item) => item.flags?.length || item.targets || item.details,
  );
  const hasEnabled = section.items.some((item) => item.enabled !== undefined);
  const pages = Math.max(1, Math.ceil(section.items.length / 50));
  return (
    <div className="satisfactory-manifest-viewer">
      {state.value.kind === 'profiles' && (
        <label className="satisfactory-manifest-profile">
          {t('profile')}
          <select
            value={sectionIndex}
            onChange={(event) => {
              setSectionIndex(Number(event.target.value));
              setPage(0);
            }}
          >
            {state.value.sections.map((value, index) => (
              <option key={value.title} value={index}>
                {value.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <dl>
        {section.fields.map((field) => (
          <div key={field.label}>
            <dt>{t(field.label)}</dt>
            <dd>{format(field.value)}</dd>
          </div>
        ))}
      </dl>
      <h3>{t(state.value.kind === 'plugin' ? 'dependencies' : 'mods')}</h3>
      {section.items.length ? (
        <>
          <div className="satisfactory-manifest-table">
            <table>
              <colgroup>
                <col style={{ width: hasDetails && hasEnabled ? '35%' : '40%' }} />
                <col />
                {hasEnabled && <col />}
                {hasDetails && <col />}
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">{t('reference')}</th>
                  <th scope="col">{t('version')}</th>
                  {hasEnabled && <th scope="col">{t('enabled')}</th>}
                  {hasDetails && <th scope="col">{t('details')}</th>}
                </tr>
              </thead>
              <tbody>
                {section.items.slice(page * 50, (page + 1) * 50).map((item, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Read-only rows preserve descriptor order, including duplicate references.
                  <tr key={`${item.reference}:${index}`}>
                    <th scope="row">{item.reference}</th>
                    <td>{item.version ?? t('unspecified')}</td>
                    {hasEnabled && (
                      <td>
                        {item.enabled === undefined ? t('unspecified') : format(item.enabled)}
                      </td>
                    )}
                    {hasDetails && (
                      <td>
                        {item.flags?.map((flag) => (
                          <div key={flag.label}>
                            {t(flag.label)}: {format(flag.value)}
                          </div>
                        ))}
                        {item.targets && (
                          <div>
                            {t('targets')}: {item.targets}
                          </div>
                        )}
                        {item.details && (
                          <div>
                            {t('dependencies')}: {item.details}
                          </div>
                        )}
                        {!item.details && !item.targets && !item.flags?.length && '—'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav aria-label={t('mods')}>
              <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
                {t('previous')}
              </button>
              <span>{host.t(key('page'), { page: page + 1, pages })}</span>
              <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
                {t('next')}
              </button>
            </nav>
          )}
        </>
      ) : (
        <p>{t(state.value.kind === 'plugin' ? 'emptyDependencies' : 'empty')}</p>
      )}
    </div>
  );
}
