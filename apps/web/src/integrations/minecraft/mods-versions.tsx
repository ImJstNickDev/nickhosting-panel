import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import type {
  ContentCatalogProvider,
  ModCatalogVersion,
} from '../../../../../games/minecraft/src/ui/mods-controller.js';
import { useFormat } from '../../app/i18n.js';
import { ErrorNotice } from '../../components/ui.js';
import { useAddons, useAddonsT } from './addons-context.js';
import {
  ModsChannel,
  ModsCheckbox,
  ModsIcon,
  ModsPagination,
  ModsSkeleton,
  modsKey,
} from './mods-primitives.js';

export function ModsVersions({
  serverId,
  provider,
  projectId,
  selected,
  preferBeta,
  disabled,
  onSelect,
}: {
  serverId: string;
  provider: ContentCatalogProvider;
  projectId: string;
  selected?: { id: string; name: string };
  preferBeta: boolean;
  disabled?: boolean;
  onSelect(version: ModCatalogVersion, force: boolean): void;
}) {
  const t = useAddonsT();
  const { controller: modsController, queryKey } = useAddons();
  const format = useFormat();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [offset, setOffset] = useState(0);
  const [force, setForce] = useState<ModCatalogVersion>();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLFieldSetElement>(null);
  const forceCancel = useRef<HTMLButtonElement>(null);
  const versions = useQuery({
    queryKey: [...queryKey(serverId, 'versions'), provider, projectId, all, offset, preferBeta],
    queryFn: ({ signal }) =>
      modsController.versions(
        serverId,
        provider,
        projectId,
        {
          offset,
          includeIncompatible: all,
          preferBeta,
        },
        signal,
      ),
    staleTime: 60_000,
    enabled: open,
  });
  useEffect(() => {
    if (open) panel.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (force) forceCancel.current?.focus();
  }, [force]);
  const choose = (version: ModCatalogVersion, forced = false) => {
    if (disabled || !version.available) return;
    if (version.compatibility.length && !forced) {
      setForce(version);
      return;
    }
    onSelect(version, forced);
    setOpen(false);
    setForce(undefined);
    trigger.current?.focus({ preventScroll: true });
  };
  return (
    <div className="mods-version-picker">
      <button
        ref={trigger}
        type="button"
        className="mods-version-trigger"
        aria-label={
          selected
            ? t(modsKey('selectedVersion'), { version: selected.name })
            : t(modsKey('selectVersion'))
        }
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
          setForce(undefined);
        }}
      >
        <ModsIcon name="version" />
        <span>{selected?.name ?? t(modsKey('automatic'))}</span>
        <ModsIcon name="chevron" />
      </button>
      {open && (
        <fieldset
          ref={panel}
          id={id}
          className="mods-version-panel"
          aria-label={t(modsKey('versions'))}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
              setForce(undefined);
              trigger.current?.focus();
            }
          }}
        >
          <ModsCheckbox
            label={t(modsKey('showIncompatible'))}
            checked={all}
            onChange={(value) => {
              setAll(value);
              setOffset(0);
              setForce(undefined);
            }}
          />
          {versions.error && (
            <ErrorNotice error={versions.error} retry={() => void versions.refetch()} />
          )}
          {versions.isPending ? (
            <ModsSkeleton rows={3} />
          ) : (
            <div className="mods-version-list">
              {versions.data?.items.map((version) => (
                <button
                  type="button"
                  key={version.id}
                  className="mods-version-option"
                  aria-pressed={selected?.id === version.id}
                  disabled={!version.available || disabled}
                  onClick={() => choose(version)}
                >
                  <span>
                    <strong>{version.version}</strong>
                    <ModsChannel channel={version.channel} />
                  </span>
                  <small>
                    {format.date(version.publishedAt)} · {format.bytes(version.bytes)}
                  </small>
                  {version.compatibility.length > 0 && (
                    <small className="mods-warning-text">
                      {version.compatibility
                        .map((reason) => t(modsKey(`incompatibility.${reason}`)))
                        .join(' · ')}
                    </small>
                  )}
                  {!version.available && (
                    <small>
                      {t(modsKey(`unavailable.${version.unavailableReason ?? 'artifact'}`))}
                    </small>
                  )}
                </button>
              ))}
              {versions.data?.items.length === 0 && (
                <p className="mods-quiet-empty">{t(modsKey('noVersions'))}</p>
              )}
            </div>
          )}
          {(versions.data?.total ?? 0) > 20 && (
            <ModsPagination
              offset={offset}
              total={versions.data?.total ?? 0}
              onChange={setOffset}
            />
          )}
          {force && (
            <div className="mods-force" role="alert">
              <div>
                <ModsIcon name="warning" />
                <strong>{t(modsKey('forceTitle'))}</strong>
              </div>
              <p>{t(modsKey('forceBody'))}</p>
              <div className="mods-force-actions">
                <button
                  ref={forceCancel}
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setForce(undefined);
                    trigger.current?.focus({ preventScroll: true });
                  }}
                >
                  {t(modsKey('cancel'))}
                </button>
                <button
                  type="button"
                  className="mods-force-confirm"
                  onClick={() => choose(force, true)}
                >
                  {t(modsKey('force'))}
                </button>
              </div>
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}
