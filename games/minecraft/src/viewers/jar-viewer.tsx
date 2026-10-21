import type { GameViewerProps } from '@nickhosting/game-sdk/ui';
import { type ReactNode, useEffect, useState } from 'react';
import type { JarArchiveReader, JarMetadataIssue } from './jar-descriptors.js';
import './mod-viewer.css';

export const jarKey = (name: string) => `games.minecraft.viewers.jar.${name}`;
type JarItem = { id: string; name: string; source: string; version?: string; description?: string };
type JarResult<T> = { items: T[]; issues: JarMetadataIssue[]; sources: string[] };

export function JarMark({ kind = 'mod' }: { kind?: 'mod' | 'plugin' | 'archive' }) {
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
      {kind === 'archive' ? (
        <>
          <path d="m3 7 9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10" />
          <path d="m7 5 10 4v5" />
        </>
      ) : kind === 'plugin' ? (
        <>
          <path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v3" />
          <path d="M9 12h6" />
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

/** A single lifecycle and Fileman transport for both integration-owned JAR viewers. */
export function JarViewer<T extends JarItem>({
  source,
  host,
  kind,
  read,
  platform,
  children,
}: GameViewerProps & {
  kind: 'mod' | 'plugin';
  read: (archive: JarArchiveReader, signal: AbortSignal) => Promise<JarResult<T>>;
  platform: (item: T) => string;
  children: (item: T) => ReactNode;
}) {
  const key = (name: string) =>
    `games.minecraft.viewers.${kind === 'mod' ? 'modscope' : 'plugscope'}.${name}`;
  const t = host.t;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ data?: JarResult<T>; error?: unknown }>({});
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    void attempt;
    setState({});
    setSelected(0);
    const controller = new AbortController();
    void read(host.archive, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data });
      },
      (error) => {
        if (!controller.signal.aborted) setState({ error });
      },
    );
    return () => controller.abort();
  }, [host.archive, attempt, read]);
  const item = state.data?.items[selected];
  return (
    <article
      className={`mc-modscope${kind === 'plugin' ? ' mc-plugscope' : ''}`}
      aria-label={t(key('name'))}
    >
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
      ) : state.error || !item ? (
        <div className="mc-modscope-empty">
          <JarMark kind={kind} />
          <h2>{t(key(state.error ? 'unavailable' : 'empty'))}</h2>
          {!state.error && <p>{t(key('emptyHint'))}</p>}
          <div>
            {!!state.error && (
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                {t(jarKey('retry'))}
              </button>
            )}
            <button type="button" onClick={() => host.openViewer('archive')}>
              <JarMark kind="archive" />
              {t(jarKey('archive'))}
            </button>
          </div>
        </div>
      ) : (
        <>
          {state.data && state.data.items.length > 1 && (
            <nav className="mc-modscope-bundled" aria-label={t(key('bundled'))}>
              {state.data.items.map((entry, index) => (
                <button
                  type="button"
                  key={`${entry.source}:${entry.id}`}
                  aria-pressed={index === selected}
                  onClick={() => setSelected(index)}
                >
                  {entry.name}
                  <small>{platform(entry)}</small>
                </button>
              ))}
            </nav>
          )}
          {children(item)}
        </>
      )}
      {state.data && (
        <details className="mc-modscope-source">
          <summary>
            {t(jarKey('details'))}
            {!!state.data.issues.length && <span>{t(jarKey('partial'))}</span>}
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
                  <span>{t(jarKey(issue.code))}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </article>
  );
}

export function JarDetails({
  item,
  platform,
  icon,
  host,
  facts,
  links,
  children,
}: {
  item: JarItem;
  platform: string;
  icon: ReactNode;
  host: GameViewerProps['host'];
  facts: ReactNode;
  links: readonly { label: string; url: string }[];
  children?: ReactNode;
}) {
  return (
    <>
      <header className="mc-modscope-header">
        {icon}
        <div className="mc-modscope-heading">
          <div className="mc-modscope-tags">
            <span>{platform}</span>
            {item.version && <span className="mc-modscope-version">{item.version}</span>}
          </div>
          <h2>{item.name}</h2>
          <code>{item.id}</code>
        </div>
        <button
          type="button"
          className="mc-modscope-archive"
          onClick={() => host.openViewer('archive')}
        >
          <JarMark kind="archive" />
          <span>{host.t(jarKey('archive'))}</span>
        </button>
      </header>
      <div className="mc-modscope-columns">
        <div className="mc-modscope-main">
          {item.description && <p className="mc-modscope-description">{item.description}</p>}
          {children}
        </div>
        <aside className="mc-modscope-facts">
          <dl>{facts}</dl>
          {!!links.length && (
            <nav aria-label={host.t(jarKey('links'))}>
              {links.map((link) => (
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
                      ? host.t(jarKey(link.label))
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

export function JarFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
