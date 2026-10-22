import {
  createMinecraftUiController,
  type WorldCatalogFile,
  type WorldCatalogProject,
} from '@nickhosting/minecraft/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useFormat, useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { ErrorNotice } from '../../components/ui.js';
import { Pagination } from '../../components/workspace-controls.js';
import { gameUiClient } from '../../features/integrations.js';
import { ViewerSelect } from '../../features/viewer-engine/viewer-select.js';
import { ModsIcon } from './mods-primitives.js';
import './world-catalog.css';

const controller = createMinecraftUiController(gameUiClient);
const key = (name: string) => `games.minecraft.datapacks.${name}`;
export function MinecraftDatapackCatalog({
  serverId,
  release,
  disabled,
  onClose,
  onQueue,
  preparations,
}: {
  serverId: string;
  release?: string;
  disabled: boolean;
  onClose(): void;
  preparations: ReadonlyMap<
    string,
    'queued' | 'preparing' | 'ready' | 'failed' | 'blocked' | 'review'
  >;
  onQueue(input: {
    provider: 'modrinth' | 'curseforge';
    projectId: string;
    file: WorldCatalogFile;
  }): void;
}) {
  const t = useT(),
    format = useFormat();
  const [provider, setProvider] = useState<'modrinth' | 'curseforge'>('modrinth');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [project, setProject] = useState<WorldCatalogProject>();
  const [fileOffset, setFileOffset] = useState(0);
  const [error, setError] = useState<unknown>();
  const searchInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const opener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const configuration = useQuery({
    queryKey: ['minecraft-datapack-catalog', serverId],
    queryFn: ({ signal }) => controller.datapackCatalog(serverId, signal),
    staleTime: 30_000,
  });
  const available =
    configuration.data?.providers.some((item) => item.id === provider && item.available) === true;
  const projects = useQuery({
    queryKey: ['minecraft-datapack-search', serverId, provider, query, offset],
    queryFn: ({ signal }) =>
      controller.searchDatapacks(serverId, { provider, query, offset }, signal),
    enabled: available && !project,
    staleTime: 60_000,
  });
  const files = useQuery({
    queryKey: ['minecraft-datapack-files', serverId, provider, project?.id, fileOffset],
    queryFn: ({ signal }) =>
      controller.datapackCatalogFiles(serverId, provider, project?.id ?? '', fileOffset, signal),
    enabled: available && Boolean(project),
    staleTime: 60_000,
  });
  const result = project ? files : projects;
  const currentOffset = project ? fileOffset : offset;
  const changePage = project ? setFileOffset : setOffset;
  const loading = configuration.isPending || (available && result.isPending);
  useEffect(() => {
    if (project) {
      if (results.current) results.current.scrollTop = 0;
      results.current?.focus({ preventScroll: true });
    } else {
      if (results.current) results.current.scrollTop = listScroll.current;
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      else searchInput.current?.focus({ preventScroll: true });
    }
  }, [project]);
  function prepare(file: WorldCatalogFile) {
    if (!project || disabled || !file.available) return;
    onQueue({ provider, projectId: project.id, file });
  }

  return (
    <section className="minecraft-datapack-store" aria-label={project?.name ?? t(key('browse'))}>
      <header className="datapack-store-header">
        <button
          type="button"
          className="catalog-back"
          onClick={() => (project ? setProject(undefined) : onClose())}
        >
          <ModsIcon name="back" />
          {t(key(project ? 'catalog.back' : 'backToInstalled'))}
        </button>
        {project && <h3>{project.name}</h3>}
      </header>
      <div className="world-catalog-toolbar">
        {!project && (
          <>
            <input
              type="search"
              ref={searchInput}
              aria-label={t(key('search'))}
              placeholder={t(key('search'))}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <ViewerSelect
              label={t(key('catalog.provider'))}
              value={provider}
              options={[
                { value: 'modrinth', label: 'Modrinth' },
                { value: 'curseforge', label: 'CurseForge' },
              ]}
              onChange={(value) => {
                setProvider(value as typeof provider);
                setOffset(0);
                setError(undefined);
              }}
            />
          </>
        )}
        {project && (
          <Tooltip content={t(key('catalog.project'))}>
            <a
              className="datapack-action"
              aria-label={t(key('catalog.project'))}
              href={project.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <path d="M14 3h7v7m0-7L10 14M10 5H4v15h15v-6" />
              </svg>
              <span className="sr-only">{t(key('catalog.project'))}</span>
            </a>
          </Tooltip>
        )}
      </div>
      {error || configuration.error || result.error ? (
        <ErrorNotice
          error={error ?? configuration.error ?? result.error}
          retry={() => {
            setError(undefined);
            if (configuration.error) void configuration.refetch();
            else void result.refetch();
          }}
        />
      ) : null}
      <div className="world-catalog-body" ref={results} tabIndex={-1} aria-busy={loading}>
        {loading && (
          <span className="sr-only" role="status">
            {t('web.loading')}
          </span>
        )}
        {loading ? (
          <div className="world-catalog-skeleton" aria-hidden="true">
            {[0, 1, 2, 3].map((item) => (
              <span key={item} />
            ))}
          </div>
        ) : configuration.error ? null : !available ? (
          <p className="world-catalog-status">{t(key('catalog.unavailable'))}</p>
        ) : project ? (
          <ul className="world-catalog-files">
            {files.data?.items.map((file) => {
              const preparation = preparations.get(`${provider}:${project.id}:${file.id}`);
              const done = preparation === 'ready';
              return (
                <li key={file.id}>
                  <div className="world-catalog-file-info">
                    <strong>{file.name}</strong>
                    <span>{file.filename}</span>
                    <span>
                      {format.bytes(file.bytes)} · {format.date(file.publishedAt)}
                    </span>
                    {file.gameVersions.length > 0 && (
                      <span
                        className={
                          release && !file.gameVersions.includes(release)
                            ? 'world-catalog-version-warning'
                            : undefined
                        }
                      >
                        {release && !file.gameVersions.includes(release)
                          ? t(key('catalog.otherVersion'), {
                              versions: file.gameVersions.join(', '),
                              current: release,
                            })
                          : t(key('catalog.version'), { versions: file.gameVersions.join(', ') })}
                      </span>
                    )}
                    {!file.available && (
                      <span>
                        {t(
                          key(
                            file.unavailableReason
                              ? `catalog.unavailable.${file.unavailableReason}`
                              : 'catalog.downloadUnavailable',
                          ),
                        )}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    disabled={
                      disabled ||
                      !file.available ||
                      done ||
                      preparation === 'queued' ||
                      preparation === 'preparing'
                    }
                    onClick={() => void prepare(file)}
                  >
                    {t(
                      key(
                        done
                          ? 'ready'
                          : preparation === 'preparing'
                            ? 'preparing'
                            : preparation === 'queued'
                              ? 'queued'
                              : preparation === 'blocked' || preparation === 'review'
                                ? preparation
                                : 'catalog.choose',
                      ),
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="world-catalog-projects">
            {projects.data?.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="world-catalog-project"
                  onClick={(event) => {
                    listScroll.current = results.current?.scrollTop ?? 0;
                    opener.current = event.currentTarget;
                    setProject(item);
                    setFileOffset(0);
                  }}
                >
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="world-catalog-cover" aria-hidden="true">
                      ◇
                    </span>
                  )}
                  <span className="world-catalog-project-info">
                    <strong>{item.name}</strong>
                    <span>{item.summary}</span>
                    <small>{item.authors.join(', ')}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {!loading && available && result.data?.items.length === 0 && (
          <p className="world-catalog-status">{t(key('catalog.empty'))}</p>
        )}
      </div>
      {available && result.data && result.data.total > 20 && (
        <Pagination
          label={t('web.pagination')}
          previousLabel={t(key('previous'))}
          nextLabel={t(key('next'))}
          summary={t(key('page'), {
            page: Math.floor(currentOffset / 20) + 1,
            pages: Math.ceil(result.data.total / 20),
          })}
          canPrevious={currentOffset > 0}
          canNext={currentOffset + 20 < result.data.total && currentOffset < 9980}
          onPrevious={() => changePage(Math.max(0, currentOffset - 20))}
          onNext={() => changePage(currentOffset + 20)}
        />
      )}
    </section>
  );
}
