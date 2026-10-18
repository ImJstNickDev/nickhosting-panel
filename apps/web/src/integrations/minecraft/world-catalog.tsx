import {
  createMinecraftUiController,
  type WorldCatalogFile,
  type WorldCatalogProject,
} from '@nickhosting/minecraft/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { idempotencyKey } from '../../api/client.js';
import { useFormat, useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { Dialog, ErrorNotice } from '../../components/ui.js';
import { gameUiClient } from '../../features/integrations.js';
import './world-catalog.css';

const controller = createMinecraftUiController(gameUiClient);
const key = (name: string) => `games.minecraft.worlds.catalog.${name}`;
export type SelectedCatalogWorld = {
  sourceId: string;
  projectName: string;
  filename: string;
  gameVersions: string[];
};

function CatalogIcon({ back = false }: { back?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {back ? <path d="m14 5-7 7 7 7M7 12h14" /> : <path d="M14 3h7v7m0-7L10 14M10 5H4v15h15v-6" />}
    </svg>
  );
}

export function MinecraftWorldCatalog({
  serverId,
  release,
  disabled,
  onClose,
  onChoose,
}: {
  serverId: string;
  release?: string;
  disabled: boolean;
  onClose(): void;
  onChoose(world: SelectedCatalogWorld): void;
}) {
  const t = useT(),
    format = useFormat();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [project, setProject] = useState<WorldCatalogProject>();
  const [fileOffset, setFileOffset] = useState(0);
  const [downloading, setDownloading] = useState<string>();
  const [error, setError] = useState<unknown>();
  const transfer = useRef<AbortController | undefined>(undefined);
  const requestKeys = useRef(new Map<string, string>());
  const searchInput = useRef<HTMLInputElement>(null);
  const resultsRegion = useRef<HTMLDivElement>(null);
  const currentDisabled = useRef(disabled);
  const mounted = useRef(true);
  currentDisabled.current = disabled;
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const configuration = useQuery({
    queryKey: ['minecraft-world-catalog', serverId],
    queryFn: ({ signal }) => controller.worldCatalog(serverId, signal),
    staleTime: 30_000,
  });
  const available =
    configuration.data?.providers.some(
      (provider) => provider.id === 'curseforge' && provider.available,
    ) === true;
  const projects = useQuery({
    queryKey: ['minecraft-world-catalog-search', serverId, query, offset],
    queryFn: ({ signal }) => controller.searchWorlds({ serverId, query, offset }, signal),
    enabled: available && !project,
    staleTime: 60_000,
  });
  const files = useQuery({
    queryKey: ['minecraft-world-catalog-files', serverId, project?.id, fileOffset],
    queryFn: ({ signal }) =>
      controller.worldCatalogFiles(serverId, project?.id ?? '', fileOffset, signal),
    enabled: available && Boolean(project),
    staleTime: 60_000,
  });
  const result = project ? files : projects;
  const resultOffset = project ? fileOffset : offset;
  const changePage = project ? setFileOffset : setOffset;
  const loading = configuration.isPending || (available && result.isPending);
  useEffect(() => {
    if (project) resultsRegion.current?.focus();
    else if (available) searchInput.current?.focus();
  }, [available, project]);

  async function acquire(file: WorldCatalogFile) {
    if (!project || !file.available || disabled || transfer.current) return;
    const abort = new AbortController();
    transfer.current = abort;
    setDownloading(file.id);
    setError(undefined);
    const identity = `${project.id}:${file.id}`;
    const requestKey = requestKeys.current.get(identity) ?? idempotencyKey();
    requestKeys.current.set(identity, requestKey);
    try {
      const source = await controller.acquireWorld(
        { serverId, projectId: project.id, versionId: file.id, idempotencyKey: requestKey },
        abort.signal,
      );
      if (mounted.current && !currentDisabled.current)
        onChoose({
          sourceId: source.id,
          projectName: project.name,
          filename: file.filename,
          gameVersions: file.gameVersions,
        });
    } catch (failure) {
      if (mounted.current) setError(failure);
    } finally {
      if (transfer.current === abort) transfer.current = undefined;
      if (mounted.current) setDownloading(undefined);
    }
  }

  return (
    <Dialog
      open
      title={project ? t(key('files'), { name: project.name }) : t(key('browse'))}
      onClose={onClose}
      closeIcon
      className="minecraft-world-catalog"
      initialFocusSelector="[data-catalog-focus]"
    >
      <div className="world-catalog-toolbar">
        {project ? (
          <>
            <Tooltip content={t(key('back'))}>
              <button
                type="button"
                className="minecraft-world-action"
                aria-label={t(key('back'))}
                disabled={Boolean(downloading)}
                onClick={() => {
                  setProject(undefined);
                  setError(undefined);
                }}
              >
                <CatalogIcon back />
              </button>
            </Tooltip>
            <span>CurseForge</span>
            <Tooltip content={t(key('view'))}>
              <a
                className="minecraft-world-action"
                href={project.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t(key('view'))}
              >
                <CatalogIcon />
              </a>
            </Tooltip>
          </>
        ) : (
          <input
            ref={searchInput}
            data-catalog-focus
            type="search"
            autoComplete="off"
            maxLength={256}
            aria-label={t(key('search'))}
            placeholder={t(key('search'))}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            disabled={!available}
          />
        )}
      </div>
      {configuration.error ? (
        <ErrorNotice error={configuration.error} retry={() => void configuration.refetch()} />
      ) : !configuration.isPending && !available ? (
        <p className="world-catalog-status">{t(key('notConfigured'))}</p>
      ) : null}
      {available && result.error && (
        <ErrorNotice error={result.error} retry={() => void result.refetch()} />
      )}
      {Boolean(error) && <ErrorNotice error={error} />}
      <div ref={resultsRegion} tabIndex={-1} className="world-catalog-body" aria-busy={loading}>
        {loading ? (
          <div className="world-catalog-skeleton" role="status" aria-label={t(key('loading'))}>
            {[0, 1, 2, 3].map((row) => (
              <span key={row} />
            ))}
          </div>
        ) : available && !result.error ? (
          project ? (
            <ul className="world-catalog-files">
              {files.data?.items.map((file) => (
                <li key={file.id}>
                  <div className="world-catalog-file-info">
                    <strong>{file.name}</strong>
                    <span>{file.filename}</span>
                    <span>
                      {file.gameVersions.length
                        ? file.gameVersions.join(' · ')
                        : t(key('versionUnknown'))}{' '}
                      · {format.bytes(file.bytes)}
                    </span>
                    {release &&
                      file.gameVersions.length > 0 &&
                      !file.gameVersions.includes(release) && (
                        <span className="world-catalog-version-warning">
                          {t(key('otherVersion'), {
                            versions: file.gameVersions.join(', '),
                            current: release,
                          })}
                        </span>
                      )}
                    {!file.available && <span>{t(key('unavailable'))}</span>}
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    data-catalog-focus
                    disabled={disabled || !file.available || Boolean(downloading)}
                    onClick={() => void acquire(file)}
                  >
                    {downloading === file.id ? t(key('downloading')) : t(key('choose'))}
                  </button>
                </li>
              ))}
              {files.data?.items.length === 0 && (
                <li className="world-catalog-status">{t(key('noFiles'))}</li>
              )}
            </ul>
          ) : (
            <ul className="world-catalog-projects">
              {projects.data?.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="world-catalog-project"
                    onClick={() => {
                      setProject(item);
                      setFileOffset(0);
                      setError(undefined);
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
              {projects.data?.items.length === 0 && (
                <li className="world-catalog-status">{t(key('empty'))}</li>
              )}
            </ul>
          )
        ) : null}
      </div>
      {downloading && (
        <div className="world-catalog-download" role="status">
          <progress aria-label={t(key('downloading'))} />
          <span>{t(key('downloading'))}</span>
        </div>
      )}
      {available && result.data && result.data.total > result.data.limit && (
        <nav
          className="minecraft-worlds-pagination"
          aria-label={t('games.minecraft.worlds.pagination')}
        >
          <button
            type="button"
            className="secondary"
            disabled={resultOffset === 0 || Boolean(downloading)}
            onClick={() => changePage(Math.max(0, resultOffset - (result.data?.limit ?? 20)))}
          >
            {t('games.minecraft.worlds.previous')}
          </button>
          <span>
            {t('games.minecraft.worlds.page', {
              page: String(Math.floor(resultOffset / result.data.limit) + 1),
              total: String(Math.ceil(Math.min(result.data.total, 10000) / result.data.limit)),
            })}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={
              resultOffset + result.data.limit >= Math.min(result.data.total, 10000) ||
              Boolean(downloading)
            }
            onClick={() => changePage(resultOffset + (result.data?.limit ?? 20))}
          >
            {t('games.minecraft.worlds.next')}
          </button>
        </nav>
      )}
      <div className="world-catalog-external">
        <Tooltip content={t(key('external'))}>
          <a href="https://www.minecraftmaps.com/" target="_blank" rel="noopener noreferrer">
            MinecraftMaps <CatalogIcon />
          </a>
        </Tooltip>
      </div>
    </Dialog>
  );
}
