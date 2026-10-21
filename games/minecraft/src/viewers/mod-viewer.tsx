import type { GameViewerProps } from '@nickhosting/game-sdk/ui';
import { useEffect, useState } from 'react';
import { JarDetails, JarFact, JarMark, JarViewer, jarKey } from './jar-viewer.js';
import { modIconType } from './mod-icon.js';
import { type ModDependency, type ModMetadata, readModArchive } from './mod-metadata.js';

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
      {url ? <img src={url} alt="" onError={() => setUrl(undefined)} /> : <JarMark />}
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
    <JarDetails
      item={mod}
      platform={loaders[mod.loader] ?? mod.loader}
      icon={<ModIcon mod={mod} host={host} />}
      host={host}
      links={mod.links}
      facts={
        <>
          {!!mod.authors.length && (
            <JarFact label={t(jarKey('authors'))}>{mod.authors.join(', ')}</JarFact>
          )}
          <JarFact label={t(key('environment'))}>{t(key(mod.environment ?? 'unknown'))}</JarFact>
          {!!mod.licenses.length && (
            <JarFact label={t(key('license'))}>{mod.licenses.join(', ')}</JarFact>
          )}
        </>
      }
    >
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
    </JarDetails>
  );
}

const read = async (...args: Parameters<typeof readModArchive>) => {
  const { mods, ...result } = await readModArchive(...args);
  return { ...result, items: mods };
};
const platform = (mod: ModMetadata) => loaders[mod.loader] ?? mod.loader;
export default function Modscope(props: GameViewerProps) {
  return (
    <JarViewer {...props} kind="mod" read={read} platform={platform}>
      {(mod) => <ModDetails mod={mod} host={props.host} />}
    </JarViewer>
  );
}
