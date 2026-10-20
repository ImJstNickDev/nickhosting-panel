import type { GameViewerProps } from '@nickhosting/game-sdk/ui';
import { useEffect, useState } from 'react';
import { modIconType } from './mod-icon.js';
import {
  type ModArchiveMetadata,
  type ModDependency,
  type ModMetadata,
  readModArchive,
} from './mod-metadata.js';
import './mod-viewer.css';

const key = (name: string) => `games.minecraft.viewers.modscope.${name}`;
const loaders: Record<string, string> = {
  fabric: 'Fabric',
  babric: 'Babric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  'forge-neoforge': 'Forge / NeoForge',
  liteloader: 'LiteLoader',
};
type Translate = GameViewerProps['host']['t'];

function Mark({ archive = false }: { archive?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {archive ? (
        <>
          <path d="m3 7 9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10" />
          <path d="m7 5 10 4v5" />
        </>
      ) : (
        <>
          <path d="M9 3h6v4h4v6h-4v4H9v-4H5V7h4z" />
          <circle cx="16" cy="17" r="4" />
          <path d="m19 20 3 3" />
        </>
      )}
    </svg>
  );
}

function ModIcon({ mod, host }: { mod: ModMetadata; host: GameViewerProps['host'] }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(undefined);
    if (!mod.iconPath) return;
    const controller = new AbortController();
    let created: string | undefined;
    void host.archive
      .read(mod.iconPath, 1024 * 1024, controller.signal)
      .then((bytes) => {
        if (controller.signal.aborted) return;
        const type = modIconType(bytes);
        if (!type) return;
        created = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
        setUrl(created);
      })
      .catch(() => {
        /* Optional artwork never prevents reading mod metadata. */
      });
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [host.archive, mod.iconPath]);
  return (
    <div className="mc-modscope-art" aria-hidden="true">
      {url ? <img src={url} alt="" onError={() => setUrl(undefined)} /> : <Mark />}
    </div>
  );
}

function Dependency({ item, t }: { item: ModDependency; t: Translate }) {
  return (
    <>
      {item.alternatives?.length ? (
        <span className="mc-modscope-dependency-group">
          <span>{t(key(item.combination === 'all' ? 'all' : 'any'))}</span>
          {item.alternatives.map((child) => (
            <span
              key={`${child.id}:${child.version}:${child.kind}:${JSON.stringify(child.alternatives)}`}
            >
              <Dependency item={child} t={t} />
            </span>
          ))}
        </span>
      ) : (
        <>
          <code>{item.id}</code>
          {item.version && item.version !== '*' && (
            <code className="mc-modscope-version-range">{item.version}</code>
          )}
        </>
      )}
      {item.unless && (
        <span className="mc-modscope-dependency-group">
          <span>{t(key('unless'))}</span>
          <span>
            <Dependency item={item.unless} t={t} />
          </span>
        </span>
      )}
    </>
  );
}

function ModDetails({ mod, host }: { mod: ModMetadata; host: GameViewerProps['host'] }) {
  const t = host.t;
  return (
    <>
      <header className="mc-modscope-header">
        <ModIcon mod={mod} host={host} />
        <div className="mc-modscope-heading">
          <div className="mc-modscope-tags">
            <span>{loaders[mod.loader] ?? mod.loader}</span>
            {mod.version && <span className="mc-modscope-version">{mod.version}</span>}
          </div>
          <h2>{mod.name}</h2>
          <code>{mod.id}</code>
        </div>
        <button
          type="button"
          className="mc-modscope-archive"
          onClick={() => host.openViewer('archive')}
        >
          <Mark archive />
          <span>{t(key('archive'))}</span>
        </button>
      </header>
      <div className="mc-modscope-columns">
        <div className="mc-modscope-main">
          {mod.description && <p className="mc-modscope-description">{mod.description}</p>}
          {!!mod.dependencies.length && (
            <section className="mc-modscope-dependencies" aria-label={t(key('dependencies'))}>
              <h3>{t(key('dependencies'))}</h3>
              <ul>
                {mod.dependencies.map((dependency) => (
                  <li key={JSON.stringify(dependency)}>
                    <div>
                      <Dependency item={dependency} t={t} />
                    </div>
                    <div className="mc-modscope-requirement">
                      <span data-kind={dependency.kind}>{t(key(dependency.kind))}</span>
                      {dependency.environment && <small>{t(key(dependency.environment))}</small>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <aside className="mc-modscope-facts">
          <dl>
            {!!mod.authors.length && (
              <div>
                <dt>{t(key('authors'))}</dt>
                <dd>{mod.authors.join(', ')}</dd>
              </div>
            )}
            <div>
              <dt>{t(key('environment'))}</dt>
              <dd>{t(key(mod.environment ?? 'unknown'))}</dd>
            </div>
            {!!mod.licenses.length && (
              <div>
                <dt>{t(key('license'))}</dt>
                <dd>{mod.licenses.join(', ')}</dd>
              </div>
            )}
          </dl>
          {!!mod.links.length && (
            <nav aria-label={t(key('links'))}>
              {mod.links.map((link) => (
                <a
                  key={`${link.label}:${link.url}`}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  <span>
                    {['homepage', 'sources', 'issues', 'discord', 'wiki', 'support'].includes(
                      link.label,
                    )
                      ? t(key(link.label))
                      : link.label}
                  </span>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                    <path d="M4 12 12 4M4 4h8v8" />
                  </svg>
                </a>
              ))}
            </nav>
          )}
        </aside>
      </div>
    </>
  );
}

export default function Modscope({ source, host }: GameViewerProps) {
  const t = host.t;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ data?: ModArchiveMetadata; error?: unknown }>({});
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    void attempt;
    setState({});
    setSelected(0);
    const controller = new AbortController();
    void readModArchive(host.archive, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data });
      },
      (error) => {
        if (!controller.signal.aborted) setState({ error });
      },
    );
    return () => controller.abort();
  }, [host.archive, attempt]);
  const mod = state.data?.mods[selected];
  return (
    <article className="mc-modscope" aria-label={t(key('name'))}>
      {!state.data && !state.error ? (
        <div className="mc-modscope-skeleton" role="status" aria-label={t(key('loading'))}>
          <div className="mc-modscope-skeleton-head">
            <i />
            <div>
              <i />
              <i />
            </div>
          </div>
          <i />
          <i />
          <i />
        </div>
      ) : state.error || !mod ? (
        <div className="mc-modscope-empty">
          <Mark />
          <h2>{t(key(state.error ? 'unavailable' : 'empty'))}</h2>
          {!state.error && <p>{t(key('emptyHint'))}</p>}
          <div>
            {!!state.error && (
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                {t(key('retry'))}
              </button>
            )}
            <button type="button" onClick={() => host.openViewer('archive')}>
              <Mark archive />
              {t(key('archive'))}
            </button>
          </div>
        </div>
      ) : (
        <>
          {state.data && state.data.mods.length > 1 && (
            <nav className="mc-modscope-bundled" aria-label={t(key('bundled'))}>
              {state.data.mods.map((item, index) => (
                <button
                  type="button"
                  key={`${item.source}:${item.id}`}
                  aria-pressed={index === selected}
                  onClick={() => setSelected(index)}
                >
                  {item.name}
                  <small>{loaders[item.loader] ?? item.loader}</small>
                </button>
              ))}
            </nav>
          )}
          <ModDetails mod={mod} host={host} />
        </>
      )}
      {state.data && (
        <details className="mc-modscope-source">
          <summary>
            {t(key('details'))}
            {!!state.data.issues.length && <span>{t(key('partial'))}</span>}
          </summary>
          <dl>
            <div>
              <dt>{source.name}</dt>
              <dd>
                {state.data.sources.map((path) => (
                  <code key={path}>{path}</code>
                ))}
              </dd>
            </div>
          </dl>
          {!!state.data.issues.length && (
            <ul>
              {state.data.issues.map((issue) => (
                <li key={`${issue.source}:${issue.code}`}>
                  <code>{issue.source}</code>
                  <span>{t(key(issue.code))}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </article>
  );
}
