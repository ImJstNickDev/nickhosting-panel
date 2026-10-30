import type { GameViewerProps } from '@nickhosting/game-sdk/ui';
import type { ReactNode } from 'react';
import { JarDetails, JarFact, JarMark, JarViewer, jarKey } from './jar-viewer.js';
import { type PluginMetadata, readPluginArchive } from './plugin-metadata.js';

const key = (name: string) => `games.minecraft.viewers.plugscope.${name}`;
const platforms = {
  bukkit: 'Bukkit / Spigot',
  paper: 'Paper',
  bungeecord: 'BungeeCord',
  velocity: 'Velocity',
};
const platform = (plugin: PluginMetadata) => platforms[plugin.platform];

/** Long command/permission inventories remain collapsed and scroll within a bounded panel. */
function Inventory({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <details className="mc-plugscope-inventory">
      <summary>
        {title}
        <span>{count}</span>
      </summary>
      <div className="mc-plugscope-inventory-body">{children}</div>
    </details>
  );
}

function PluginDetails({
  plugin,
  host,
}: {
  plugin: PluginMetadata;
  host: GameViewerProps['host'];
}) {
  const t = host.t;
  return (
    <JarDetails
      item={plugin}
      platform={platform(plugin)}
      host={host}
      links={plugin.links}
      icon={
        <div className="mc-modscope-art mc-plugscope-art" aria-hidden="true">
          <JarMark kind="plugin" />
        </div>
      }
      facts={
        <>
          {!!plugin.authors.length && (
            <JarFact label={t(jarKey('authors'))}>{plugin.authors.join(', ')}</JarFact>
          )}
          {plugin.apiVersion && <JarFact label={t(key('apiVersion'))}>{plugin.apiVersion}</JarFact>}
          {plugin.main && (
            <JarFact label={t(key('main'))}>
              <code>{plugin.main}</code>
            </JarFact>
          )}
          {plugin.load && (
            <JarFact label={t(key('load'))}>
              {['STARTUP', 'POSTWORLD'].includes(plugin.load) ? t(key(plugin.load)) : plugin.load}
            </JarFact>
          )}
          {plugin.foliaSupported !== undefined && (
            <JarFact label={t(key('folia'))}>
              {t(key(plugin.foliaSupported ? 'declared' : 'notDeclared'))}
            </JarFact>
          )}
          {!!plugin.provides.length && (
            <JarFact label={t(key('provides'))}>{plugin.provides.join(', ')}</JarFact>
          )}
          {!!plugin.contributors.length && (
            <JarFact label={t(key('contributors'))}>{plugin.contributors.join(', ')}</JarFact>
          )}
        </>
      }
    >
      {!!plugin.dependencies.length && (
        <section className="mc-modscope-dependencies" aria-label={t(key('dependencies'))}>
          <h3>{t(key('dependencies'))}</h3>
          <ul>
            {plugin.dependencies.map((dependency) => (
              <li key={`${dependency.stage ?? ''}:${dependency.kind}:${dependency.id}`}>
                <div className="mc-plugscope-dependency">
                  <code>{dependency.id}</code>
                  {(dependency.stage ||
                    dependency.load ||
                    dependency.joinClasspath !== undefined) && (
                    <span className="mc-plugscope-dependency-detail">
                      {dependency.stage && <span>{t(key(dependency.stage))}</span>}
                      {dependency.load && <span>{t(key(`order.${dependency.load}`))}</span>}
                      {dependency.joinClasspath !== undefined && (
                        <span>
                          {t(
                            key(dependency.joinClasspath ? 'classpathShared' : 'classpathIsolated'),
                          )}
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <span className="mc-modscope-requirement">{t(key(dependency.kind))}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!plugin.commands.length && (
        <Inventory title={t(key('commands'))} count={plugin.commands.length}>
          {plugin.commands.map((command) => (
            <details key={command.name} className="mc-plugscope-entry">
              <summary>
                <code>/{command.name}</code>
                {command.description && <span>{command.description}</span>}
              </summary>
              <dl>
                {!!command.aliases.length && (
                  <JarFact label={t(key('aliases'))}>
                    {command.aliases.map((alias) => `/${alias}`).join(', ')}
                  </JarFact>
                )}
                {command.usage && (
                  <JarFact label={t(key('usage'))}>
                    <code>{command.usage}</code>
                  </JarFact>
                )}
                {command.permission && (
                  <JarFact label={t(key('permission'))}>
                    <code>{command.permission}</code>
                  </JarFact>
                )}
                {command.permissionMessage && (
                  <JarFact label={t(key('permissionMessage'))}>{command.permissionMessage}</JarFact>
                )}
              </dl>
            </details>
          ))}
        </Inventory>
      )}
      {!!plugin.permissions.length && (
        <Inventory title={t(key('permissions'))} count={plugin.permissions.length}>
          {plugin.defaultPermission && (
            <p className="mc-plugscope-default">
              {t(key('defaultPermission'))}: <code>{plugin.defaultPermission}</code>
            </p>
          )}
          {plugin.permissions.map((permission) => (
            <details key={permission.name} className="mc-plugscope-entry">
              <summary>
                <code>{permission.name}</code>
                {permission.default && (
                  <span className="mc-plugscope-permission-default">
                    {t(key('defaultPermission'))}: {permission.default}
                  </span>
                )}
              </summary>
              {permission.description && <p>{permission.description}</p>}
              {!!permission.children.length && (
                <dl>
                  {permission.children.map((child) => (
                    <JarFact key={child.name} label={child.name}>
                      {t(key(child.value ? 'granted' : 'denied'))}
                    </JarFact>
                  ))}
                </dl>
              )}
            </details>
          ))}
        </Inventory>
      )}
      {(plugin.bootstrapper || plugin.loader || plugin.prefix || plugin.libraries.length > 0) && (
        <details className="mc-plugscope-technical">
          <summary>{t(key('technical'))}</summary>
          <dl>
            {plugin.bootstrapper && (
              <JarFact label={t(key('bootstrapper'))}>
                <code>{plugin.bootstrapper}</code>
              </JarFact>
            )}
            {plugin.loader && (
              <JarFact label={t(key('loader'))}>
                <code>{plugin.loader}</code>
              </JarFact>
            )}
            {plugin.prefix && <JarFact label={t(key('prefix'))}>{plugin.prefix}</JarFact>}
            {!!plugin.libraries.length && (
              <JarFact label={t(key('libraries'))}>
                {plugin.libraries.map((library) => (
                  <code key={library}>{library}</code>
                ))}
              </JarFact>
            )}
          </dl>
        </details>
      )}
    </JarDetails>
  );
}

const read = async (...args: Parameters<typeof readPluginArchive>) => {
  const { plugins, ...result } = await readPluginArchive(...args);
  return { ...result, items: plugins };
};
export default function Plugscope(props: GameViewerProps) {
  return (
    <JarViewer {...props} kind="plugin" read={read} platform={platform}>
      {(plugin) => <PluginDetails plugin={plugin} host={props.host} />}
    </JarViewer>
  );
}
