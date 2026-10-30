import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  ContentCatalogProvider,
  MinecraftModsSnapshot,
  ModCatalogProject,
  ModCatalogVersion,
} from '../../../../../games/minecraft/src/ui/mods-controller.js';
import { ErrorNotice } from '../../components/ui.js';
import { useAddons, useAddonsT } from './addons-context.js';
import { modBlockerChain } from './mods-model.js';
import { ModsChannel, ModsIcon, modsKey } from './mods-primitives.js';
import { ModsVersions } from './mods-versions.js';

type Blocker = MinecraftModsSnapshot['blockers'][number];
const knownReasons = new Set([
  'conflict',
  'version-conflict',
  'incompatible-version',
  'alpha-only',
  'unavailable',
  'unresolved',
  'datapack_dependency',
]);
function blockerProject(
  provider: ContentCatalogProvider,
  id: string,
  name: string,
): ModCatalogProject {
  return {
    provider,
    id,
    name,
    summary: '',
    websiteUrl: '',
    authors: [],
    downloads: 0,
    tags: [],
    environment: { kind: 'unknown', source: 'unknown', original: [] },
  };
}

export function ModsBlocker({
  item,
  data,
  serverId,
  disabled,
  preferBeta,
  onProject,
  onVersion,
  selectedFile,
}: {
  item: Blocker;
  data: MinecraftModsSnapshot;
  serverId: string;
  disabled: boolean;
  preferBeta: boolean;
  onProject(project: ModCatalogProject): void;
  onVersion(project: ModCatalogProject, version: ModCatalogVersion, force: boolean): void;
  selectedFile(project: ModCatalogProject): { id: string; name: string } | undefined;
}) {
  const t = useAddonsT();
  const provider = item.provider;
  const roots =
    item.roots ??
    (item.requiredBy
      ? [{ projectId: item.requiredBy, name: item.requiredByName ?? item.requiredBy }]
      : []);
  const parentChain = modBlockerChain(item);
  const ownProject = provider ? blockerProject(provider, item.projectId, item.name) : undefined;
  return (
    <div className="mods-blocker">
      <div className="mods-blocker-heading">
        <div>
          {Boolean(parentChain) && (
            <span className="mods-blocker-chain">
              {parentChain} <span aria-hidden="true">→</span>
            </span>
          )}
          <strong>{item.name}</strong>
        </div>
        {ownProject && (
          <button
            type="button"
            className="mods-quiet-button"
            aria-label={t(modsKey('details'), { name: item.name })}
            onClick={() => onProject(ownProject)}
          >
            <ModsIcon name="external" />
            {t(modsKey('detailsShort'))}
          </button>
        )}
      </div>
      <p>{t(modsKey(`blocker.${knownReasons.has(item.reason) ? item.reason : 'unknown'}`))}</p>
      {item.availableMinecraftVersions?.length || item.availableLoaders?.length ? (
        <div className="mods-blocker-evidence">
          {Boolean(item.availableMinecraftVersions?.length) && (
            <span>
              {t(modsKey('blocker.observedVersions'), {
                versions: item.availableMinecraftVersions?.join(', ') ?? '',
              })}
            </span>
          )}
          {Boolean(item.availableLoaders?.length) && (
            <span>
              {t(modsKey('blocker.observedLoaders'), {
                loaders: item.availableLoaders?.join(', ') ?? '',
              })}
            </span>
          )}
          <span>
            {t(modsKey('blocker.server'), { version: data.version, loader: data.loader })}
          </span>
        </div>
      ) : null}
      {provider &&
        roots.map((root) => {
          if (
            !data.roots.some(
              (selected) => selected.provider === provider && selected.projectId === root.projectId,
            )
          )
            return null;
          const project = blockerProject(provider, root.projectId, root.name);
          return (
            <div className="mods-blocker-resolution" key={root.projectId}>
              <span>{t(modsKey('blocker.changeParent'), { name: root.name })}</span>
              <ModsVersions
                serverId={serverId}
                provider={provider}
                projectId={root.projectId}
                selected={selectedFile(project)}
                preferBeta={preferBeta}
                disabled={disabled}
                onSelect={(file, force) => onVersion(project, file, force)}
              />
              <ModsAlternative
                serverId={serverId}
                project={project}
                revision={data.revision}
                target={`${data.version}:${data.loader}`}
                disabled={disabled}
                onSelect={(file) => onVersion(project, file, false)}
              />
            </div>
          );
        })}
    </div>
  );
}

function ModsAlternative({
  serverId,
  project,
  revision,
  target,
  disabled,
  onSelect,
}: {
  serverId: string;
  project: ModCatalogProject;
  revision: number;
  target: string;
  disabled: boolean;
  onSelect(file: ModCatalogVersion): void;
}) {
  const t = useAddonsT();
  const { controller: modsController, queryKey } = useAddons();
  const [requestedScope, setRequestedScope] = useState<string>();
  const scope = `${revision}:${target}`;
  const requested = requestedScope === scope;
  const result = useQuery({
    queryKey: [
      ...queryKey(serverId, 'alternatives'),
      project.provider,
      project.id,
      revision,
      target,
    ],
    queryFn: ({ signal }) =>
      modsController.alternatives(serverId, project.provider, project.id, revision, signal),
    enabled: requested,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const candidate =
    requested && result.data?.revision === revision ? result.data.items[0] : undefined;
  return (
    <div className="mods-alternative">
      {!requested ? (
        <button
          type="button"
          className="mods-quiet-button"
          disabled={disabled}
          onClick={() => setRequestedScope(scope)}
        >
          <ModsIcon name="search" />
          {t(modsKey('alternative.find'), { name: project.name })}
        </button>
      ) : result.isPending ? (
        <span className="mods-update-note" role="status">
          {t(modsKey('alternative.searching'))}
        </span>
      ) : result.error ? (
        <ErrorNotice error={result.error} retry={() => void result.refetch()} />
      ) : candidate ? (
        <div className="mods-alternative-found">
          <div>
            <strong>{candidate.version}</strong>
            <ModsChannel channel={candidate.channel} />
            <small>{t(modsKey('alternative.found'))}</small>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={disabled || !candidate.available || Boolean(candidate.compatibility.length)}
            onClick={() => onSelect(candidate)}
          >
            {t(modsKey('alternative.use'), { version: candidate.version })}
          </button>
        </div>
      ) : (
        <span className="mods-update-note" role="status">
          {t(modsKey(result.data?.limited ? 'alternative.limited' : 'alternative.none'))}
        </span>
      )}
    </div>
  );
}
