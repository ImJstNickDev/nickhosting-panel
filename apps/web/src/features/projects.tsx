import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type {
  getPlatformProject,
  listPlatformProjects,
  listPlatformServers,
  lookupProjectCollaborator,
} from '../../../../packages/server-management/src/platform-queries.js';
import { api, queryClient } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { useT } from '../app/i18n.js';
import {
  ActionForm,
  Check,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  Page,
  Section,
  Select,
  Time,
  text,
} from '../components/ui.js';
import { CursorControls, ServerCards, TableRegion } from './servers.js';

type Projects = Result<typeof listPlatformProjects>;
type Project = Result<typeof getPlatformProject>;
type Servers = Result<typeof listPlatformServers>;
type Collaborator = Result<typeof lookupProjectCollaborator>;
export function ProjectsPage() {
  const t = useT(),
    navigate = useNavigate(),
    [search, setSearch] = useState(''),
    [cursors, setCursors] = useState<string[]>([]),
    [create, setCreate] = useState(false);
  const query = new URLSearchParams({
    limit: '30',
    ...(search ? { q: search } : {}),
    ...(cursors.length ? { cursor: cursors.at(-1) ?? '' } : {}),
  });
  const projects = useQuery({
    queryKey: ['projects', query.toString()],
    queryFn: () => api<Projects>(`/v1/platform/projects?${query}`),
  });
  return (
    <Page
      title={t('web.projects')}
      actions={
        <button type="button" onClick={() => setCreate(true)}>
          {t('platform.createProject')}
        </button>
      }
    >
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(text(new FormData(event.currentTarget), 'q'));
          setCursors([]);
        }}
      >
        <Input label={t('platform.projectSearch')} name="q" type="search" maxLength={100} />
        <button type="submit">{t('web.search')}</button>
      </form>
      {projects.isPending ? (
        <Loading />
      ) : projects.error ? (
        <ErrorNotice error={projects.error} retry={() => void projects.refetch()} />
      ) : !projects.data?.items.length ? (
        <Empty text={t('platform.noProjects')} />
      ) : (
        <Section>
          <TableRegion label={t('web.projects')}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('web.name')}</th>
                  <th scope="col">{t('web.created')}</th>
                </tr>
              </thead>
              <tbody>
                {projects.data.items.map((project) => (
                  <tr key={project.id}>
                    <th scope="row">
                      <Link to={`/projects/${project.id}`}>{project.name}</Link>
                    </th>
                    <td>
                      <Time value={project.created_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableRegion>
        </Section>
      )}
      <CursorControls
        next={projects.data?.nextCursor}
        previous={cursors.length > 0}
        onNext={(cursor) => setCursors([...cursors, cursor])}
        onPrevious={() => setCursors(cursors.slice(0, -1))}
      />
      <Dialog open={create} title={t('platform.createProject')} onClose={() => setCreate(false)}>
        <ActionForm
          success={false}
          submitLabel={t('platform.createProject')}
          onSubmit={async (form) => {
            const project = await api<{ id: string }>('/v1/projects', {
              body: { name: text(form, 'name') },
            });
            await queryClient.invalidateQueries({ queryKey: ['projects'] });
            navigate(`/projects/${project.id}`);
          }}
        >
          <Input label={t('web.name')} name="name" maxLength={100} required autoComplete="off" />
        </ActionForm>
      </Dialog>
    </Page>
  );
}
export function ProjectPage({ projectId: explicitId }: { projectId?: string } = {}) {
  const params = useParams(),
    projectId = explicitId ?? params.projectId ?? params.id ?? '';
  const t = useT(),
    navigate = useNavigate(),
    [deleting, setDeleting] = useState(false),
    [removing, setRemoving] = useState<Project['members'][number] | null>(null);
  const [lookup, setLookup] = useState<Collaborator>(),
    [cursors, setCursors] = useState<string[]>([]);
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<Project>(`/v1/platform/projects/${encodeURIComponent(projectId)}`),
  });
  const query = new URLSearchParams({
    projectId,
    limit: '12',
    ...(cursors.length ? { cursor: cursors.at(-1) ?? '' } : {}),
  });
  const servers = useQuery({
    queryKey: ['servers', 'project', projectId, query.toString()],
    queryFn: () => api<Servers>(`/v1/platform/servers?${query}`),
  });
  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['projects'] }),
      queryClient.invalidateQueries({ queryKey: ['server'] }),
      queryClient.invalidateQueries({ queryKey: ['servers'] }),
    ]);
  }
  async function member(userId: string, role: 'manager' | 'operator' | 'viewer' | null) {
    await api(`/v1/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'PUT',
      body: { userId, role },
    });
    await refresh();
  }
  if (project.isPending) return <Loading />;
  if (project.error)
    return <ErrorNotice error={project.error} retry={() => void project.refetch()} />;
  const data = project.data;
  if (!data) return null;
  return (
    <Page title={data.name} actions={<Link to="/projects">{t('web.projects')}</Link>}>
      <Section title={t('web.servers')}>
        {servers.isPending ? (
          <Loading />
        ) : servers.error ? (
          <ErrorNotice error={servers.error} />
        ) : servers.data?.items.length ? (
          <ServerCards items={servers.data.items} />
        ) : (
          <Empty text={t('web.noServers')} />
        )}
        <CursorControls
          next={servers.data?.nextCursor}
          previous={cursors.length > 0}
          onNext={(value) => setCursors([...cursors, value])}
          onPrevious={() => setCursors(cursors.slice(0, -1))}
        />
      </Section>
      <Section title={t('platform.projectMembers')}>
        <p>
          {t('platform.projectOwner')}: {data.owner.name}
        </p>
        <dl className="details">
          <div>
            <dt>{t('platform.viewer')}</dt>
            <dd>{t('platform.viewerRights')}</dd>
          </div>
          <div>
            <dt>{t('platform.operator')}</dt>
            <dd>{t('platform.operatorRights')}</dd>
          </div>
          <div>
            <dt>{t('platform.manager')}</dt>
            <dd>{t('platform.managerRights')}</dd>
          </div>
        </dl>
        {!data.members.length ? (
          <Empty />
        ) : (
          <TableRegion label={t('platform.projectMembers')}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('web.name')}</th>
                  <th scope="col">{t('web.role')}</th>
                  {data.canManage && <th scope="col">{t('web.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {data.members.map((item) => (
                  <tr key={item.id}>
                    <th scope="row">{item.name}</th>
                    <td>
                      {data.canManage ? (
                        <ActionForm
                          onSubmit={async (form) => {
                            await member(
                              item.id,
                              text(form, 'role') as 'manager' | 'operator' | 'viewer',
                            );
                          }}
                        >
                          <Select
                            name="role"
                            label={t('platform.memberRole', { name: item.name })}
                            defaultValue={item.role}
                          >
                            {['viewer', 'operator', 'manager'].map((role) => (
                              <option key={role} value={role}>
                                {t(`platform.${role}`)}
                              </option>
                            ))}
                          </Select>
                        </ActionForm>
                      ) : (
                        t(`platform.${item.role}`)
                      )}
                    </td>
                    {data.canManage && (
                      <td>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setRemoving(item)}
                        >
                          {t('web.remove')}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableRegion>
        )}
      </Section>
      {data.canManage && (
        <>
          <Section title={t('platform.addMember')}>
            <ActionForm
              success={false}
              submitLabel={t('platform.findMember')}
              onSubmit={async (form) => {
                setLookup(undefined);
                setLookup(
                  await api<Collaborator>(
                    `/v1/platform/projects/${encodeURIComponent(projectId)}/collaborator`,
                    { body: { email: text(form, 'email') } },
                  ),
                );
              }}
            >
              <Input
                label={t('web.email')}
                name="email"
                type="email"
                hint={t('platform.exactEmail')}
                maxLength={320}
                required
              />
            </ActionForm>
            {lookup && !lookup.user && <Notice>{t('platform.accountNotFound')}</Notice>}
            {lookup?.user && (
              <ActionForm
                key={lookup.user.id}
                submitLabel={t('platform.addMember')}
                onSubmit={async (form) => {
                  if (!lookup.user) return;
                  await member(
                    lookup.user.id,
                    text(form, 'role') as 'manager' | 'operator' | 'viewer',
                  );
                  setLookup(undefined);
                }}
              >
                <p>{lookup.user.name}</p>
                <Select name="role" label={t('web.role')} defaultValue="viewer">
                  {['viewer', 'operator', 'manager'].map((role) => (
                    <option key={role} value={role}>
                      {t(`platform.${role}`)}
                    </option>
                  ))}
                </Select>
              </ActionForm>
            )}
          </Section>
          <Section title={t('web.settings')}>
            <ActionForm
              onSubmit={async (form) => {
                await api(`/v1/platform/projects/${encodeURIComponent(projectId)}`, {
                  method: 'PATCH',
                  body: { name: text(form, 'name') },
                });
                await refresh();
              }}
            >
              <Input
                name="name"
                label={t('web.name')}
                defaultValue={data.name}
                maxLength={100}
                required
              />
            </ActionForm>
          </Section>
          <Section title={t('platform.deleteProject')}>
            <button type="button" className="danger" onClick={() => setDeleting(true)}>
              {t('platform.deleteProject')}
            </button>
          </Section>
        </>
      )}
      <Dialog
        open={deleting}
        title={t('platform.deleteProject')}
        onClose={() => setDeleting(false)}
      >
        <ActionForm
          success={false}
          submitLabel={t('platform.deleteProject')}
          onSubmit={async () => {
            await api(`/v1/platform/projects/${encodeURIComponent(projectId)}`, {
              method: 'DELETE',
              body: { confirm: true },
            });
            await refresh();
            navigate('/projects');
          }}
        >
          <p>{t('platform.deleteProjectWarning', { name: data.name })}</p>
          <Check label={t('platform.confirmConsequence')} required />
        </ActionForm>
      </Dialog>
      <Dialog open={removing !== null} title={t('web.remove')} onClose={() => setRemoving(null)}>
        {removing && (
          <ActionForm
            success={false}
            submitLabel={t('web.remove')}
            onSubmit={async () => {
              await member(removing.id, null);
              setRemoving(null);
            }}
          >
            <p>{t('platform.removeMember', { name: removing.name })}</p>
            <p>{t('platform.removeMemberWarning')}</p>
          </ActionForm>
        )}
      </Dialog>
    </Page>
  );
}
