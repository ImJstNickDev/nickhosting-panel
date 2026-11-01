import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { ApiError, api, queryClient } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { useUnsavedChanges } from '../components/navigation-guard.js';
import { ConfirmDialog, Dialog, Empty, ErrorNotice, Loading, Page } from '../components/ui.js';
import { platformPath, useServer } from './service-contracts.js';
import './subusers.css';

interface PermissionDefinition {
  key: string;
  resource: string;
  kind: 'read' | 'write' | 'additional';
  labelKey?: string;
  resourceLabelKey?: string;
}
interface Subuser {
  userId: string;
  name: string;
  username: string;
  directPermissionKeys: string[];
  inheritedPermissionKeys: string[];
  effectivePermissionKeys: string[];
  project: { id: string; name: string; role: string } | null;
  protected: boolean;
  canEdit: boolean;
  canDelete: boolean;
}
interface SubusersResponse {
  items: Subuser[];
  permissionDefinitions: PermissionDefinition[];
  grantablePermissionKeys: string[];
}
type Selected = Pick<
  Subuser,
  | 'userId'
  | 'name'
  | 'username'
  | 'directPermissionKeys'
  | 'inheritedPermissionKeys'
  | 'project'
  | 'canEdit'
  | 'effectivePermissionKeys'
  | 'protected'
>;

export function ServerSubusers() {
  const { serverId = '' } = useParams();
  const server = useServer(serverId);
  const t = useT();
  const path = `${platformPath(serverId)}/subusers`;
  const queryKey = ['subusers', serverId];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api<SubusersResponse>(path, { signal }),
    refetchInterval: 10000,
  });
  const [editorOpen, setEditorOpen] = useState(false);
  const [selected, setSelected] = useState<Selected>();
  const [draft, setDraft] = useState<string[]>([]);
  const [identifier, setIdentifier] = useState('');
  const [error, setError] = useState<unknown>();
  const [notFound, setNotFound] = useState(false);
  const [pending, setPending] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [removing, setRemoving] = useState<Subuser>();
  const [notice, setNotice] = useState('');
  const dirty =
    editorOpen &&
    Boolean(selected) &&
    JSON.stringify([...draft].sort()) !==
      JSON.stringify([...(selected?.directPermissionKeys ?? [])].sort());
  useUnsavedChanges(dirty || pending, pending);
  const forbidden = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);
  const permissionKeys =
    (server.data as { permissionKeys?: string[] } | undefined)?.permissionKeys ?? [];
  const canWrite = permissionKeys.includes('subusers.write');
  const freshSelected =
    selected && query.data?.items.find((item) => item.userId === selected.userId);
  const canEdit = Boolean(
    canWrite &&
      selected?.canEdit &&
      (!freshSelected || freshSelected.canEdit) &&
      !query.error &&
      !server.error,
  );
  function openEditor(item?: Subuser) {
    setSelected(item);
    setDraft(item?.directPermissionKeys ?? []);
    setIdentifier('');
    setError(undefined);
    setNotFound(false);
    setEditorOpen(true);
    setNotice('');
  }
  function closeEditor() {
    if (pending) return;
    if (dirty) setDiscard(true);
    else {
      setEditorOpen(false);
      setSelected(undefined);
    }
  }
  function updatePermission(definition: PermissionDefinition, checked: boolean) {
    if (!query.data) return;
    const resourcePermissions = query.data.permissionDefinitions.filter(
      (item) => item.resource === definition.resource,
    );
    const read = resourcePermissions.find((item) => item.kind === 'read');
    setDraft((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(definition.key);
        if (read) next.add(read.key);
      } else {
        next.delete(definition.key);
        if (definition.kind === 'read')
          for (const item of resourcePermissions) next.delete(item.key);
      }
      return [...next];
    });
  }
  async function lookup() {
    setPending(true);
    setError(undefined);
    setNotFound(false);
    try {
      const result = await api<{ user: { userId: string; name: string; username: string } | null }>(
        `${path}/lookup`,
        { body: { identifier } },
      );
      if (!result.user) {
        setNotFound(true);
        return;
      }
      const existing = query.data?.items.find((item) => item.userId === result.user?.userId);
      setSelected(
        existing ?? {
          ...result.user,
          directPermissionKeys: [],
          inheritedPermissionKeys: [],
          project: null,
          canEdit: true,
          protected: false,
          effectivePermissionKeys: [],
        },
      );
      setDraft(existing?.directPermissionKeys ?? []);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  async function save() {
    if (!selected || !draft.length || !canEdit || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await api<SubusersResponse>(`${path}/${encodeURIComponent(selected.userId)}`, {
        method: 'PUT',
        body: { permissionKeys: draft },
      });
      queryClient.setQueryData(queryKey, result);
      setSelected(undefined);
      setEditorOpen(false);
      setNotice('subusers.saved');
      await queryClient.invalidateQueries({ queryKey: ['server', serverId] });
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  if (query.isPending) return <Loading />;
  if (!query.data || forbidden)
    return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  const resources = [...new Set(query.data.permissionDefinitions.map((item) => item.resource))];
  return (
    <Page
      title={t('serverNav.subusers')}
      actions={
        canWrite && (
          <button
            type="button"
            disabled={Boolean(query.error || server.error)}
            onClick={() => openEditor()}
          >
            {t('subusers.add')}
          </button>
        )
      }
    >
      {query.error && <ErrorNotice error={query.error} retry={() => void query.refetch()} />}
      {notice && <p role="status">{t(notice)}</p>}
      <div className="subusers-workspace">
        {!query.data.items.length ? (
          <Empty text={t('subusers.empty')} />
        ) : (
          <ul className="subusers-list">
            {query.data.items.map((item) => (
              <li key={item.userId}>
                <div className="subusers-identity">
                  <strong>{item.name}</strong>
                  <small>@{item.username}</small>
                </div>
                <div className="subusers-origin">
                  <span>
                    {t(
                      item.protected
                        ? 'subusers.protected'
                        : item.directPermissionKeys.length
                          ? 'subusers.direct'
                          : 'subusers.inheritedOnly',
                    )}
                  </span>
                  {item.project && (
                    <small>{t('subusers.inherited', { project: item.project.name })}</small>
                  )}
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    aria-label={t('subusers.edit', { name: item.name })}
                    onClick={() => openEditor(item)}
                  >
                    {t('subusers.permissions')}
                  </button>
                  {item.canDelete && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={Boolean(query.error || server.error)}
                      onClick={() => {
                        setRemoving(item);
                        setNotice('');
                      }}
                    >
                      {t('subusers.remove')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Dialog
        open={editorOpen}
        title={selected ? t('subusers.edit', { name: selected.name }) : t('subusers.add')}
        onClose={closeEditor}
        closeIcon
        closeDisabled={pending}
        className="subusers-dialog"
      >
        {editorOpen && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void (selected ? save() : lookup());
            }}
          >
            {!selected ? (
              <>
                <label className="field">
                  <span>{t('subusers.email')}</span>
                  <input
                    type="email"
                    autoComplete="off"
                    required
                    value={identifier}
                    disabled={pending}
                    onChange={(event) => {
                      setIdentifier(event.target.value);
                      setNotFound(false);
                    }}
                  />
                </label>
                {notFound && <p role="status">{t('subusers.notFound')}</p>}
              </>
            ) : (
              <>
                <p className="muted">{t('subusers.dependencies')}</p>
                {selected.project && (
                  <p className="muted">
                    {t('subusers.inherited', { project: selected.project.name })}
                  </p>
                )}
                <table className="subusers-matrix" aria-label={t('subusers.permissions')}>
                  <thead>
                    <tr className="subusers-matrix-row subusers-matrix-heading">
                      <th scope="col">{t('subusers.resource')}</th>
                      {(['read', 'write', 'additional'] as const).map((kind) => (
                        <th scope="col" key={kind}>
                          {t(`subusers.${kind}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {resources.map((resource) => {
                      const definitions = query.data.permissionDefinitions.filter(
                        (item) => item.resource === resource,
                      );
                      const resourceLabel = t(
                        definitions[0]?.resourceLabelKey ?? `permission.resource.${resource}`,
                      );
                      return (
                        <tr className="subusers-matrix-row" key={resource}>
                          <th scope="row">{resourceLabel}</th>
                          {(['read', 'write', 'additional'] as const).map((kind) => {
                            const cells = definitions.filter((item) => item.kind === kind);
                            return (
                              <td key={kind} className="subusers-matrix-cell">
                                <span className="subusers-mobile-column" aria-hidden="true">
                                  {t(`subusers.${kind}`)}
                                </span>
                                {cells.length ? (
                                  cells.map((definition) => {
                                    const inherited = (
                                      freshSelected ?? selected
                                    ).inheritedPermissionKeys.includes(definition.key);
                                    const protectedGrant =
                                      selected.protected &&
                                      selected.effectivePermissionKeys.includes(definition.key);
                                    const label = t(
                                      definition.labelKey ??
                                        `permission.action.${definition.key.split('.').at(-1)}`,
                                    );
                                    return (
                                      <label key={definition.key} className="subusers-permission">
                                        <span>
                                          <input
                                            type="checkbox"
                                            checked={
                                              draft.includes(definition.key) || protectedGrant
                                            }
                                            disabled={
                                              !canEdit ||
                                              pending ||
                                              !query.data.grantablePermissionKeys.includes(
                                                definition.key,
                                              )
                                            }
                                            onChange={(event) =>
                                              updatePermission(definition, event.target.checked)
                                            }
                                            aria-label={`${resourceLabel}: ${label}`}
                                            aria-describedby={
                                              inherited ? `inherited-${definition.key}` : undefined
                                            }
                                          />
                                          {label}
                                        </span>
                                        {inherited && (
                                          <small
                                            id={`inherited-${definition.key}`}
                                            title={t('subusers.inherited', {
                                              project: selected.project?.name ?? '',
                                            })}
                                          >
                                            {t('subusers.projectPermission')}
                                          </small>
                                        )}
                                      </label>
                                    );
                                  })
                                ) : (
                                  <span>—</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="muted">{t('subusers.delegation')}</p>
                {(query.error || server.error) && <p role="status">{t('subusers.unavailable')}</p>}
              </>
            )}
            {Boolean(error) && <ErrorNotice error={error} />}
            <div className="actions">
              <button type="button" className="secondary" disabled={pending} onClick={closeEditor}>
                {t('web.cancel')}
              </button>
              {(!selected || selected.canEdit) && (
                <button
                  type="submit"
                  disabled={pending || Boolean(selected && (!canEdit || !dirty || !draft.length))}
                >
                  {t(pending ? 'web.loading' : selected ? 'web.save' : 'subusers.find')}
                </button>
              )}
            </div>
          </form>
        )}
      </Dialog>
      <ConfirmDialog
        open={Boolean(removing)}
        title={t('subusers.remove')}
        confirmLabel={t('subusers.remove')}
        destructive
        onClose={() => setRemoving(undefined)}
        onConfirm={async () => {
          if (!removing) return;
          const result = await api<SubusersResponse>(
            `${path}/${encodeURIComponent(removing.userId)}`,
            { method: 'DELETE' },
          );
          queryClient.setQueryData(queryKey, result);
          setRemoving(undefined);
          setNotice('subusers.removed');
        }}
      >
        <p>{t('subusers.removeConfirm', { name: removing?.name ?? '' })}</p>
        <p>
          {removing?.inheritedPermissionKeys.length
            ? t('subusers.retained', { project: removing.project?.name ?? '' })
            : t('subusers.revoked')}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={discard}
        title={t('subusers.discardTitle')}
        confirmLabel={t('subusers.discard')}
        destructive
        busy={pending}
        onClose={() => {
          setDiscard(false);
        }}
        onConfirm={async () => {
          setDraft([]);
          setSelected(undefined);
          setEditorOpen(false);
          setDiscard(false);
        }}
      >
        <p>{t('subusers.discardBody')}</p>
      </ConfirmDialog>
    </Page>
  );
}
