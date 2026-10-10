import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type {
  getPlatformUser,
  listPlatformAudit,
  listPlatformUsers,
} from '../../../../packages/server-management/src/platform-queries.js';
import { api } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { useFormat, useT } from '../app/i18n.js';
import { identityChanged, useSession } from '../app/session.js';
import {
  ActionForm,
  Badge,
  Check,
  Details,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  number,
  Page,
  Section,
  Select,
  Textarea,
  Time,
  text,
} from '../components/ui.js';

export function OwnerUsersPage() {
  const t = useT();
  const [q, setQ] = useState(''),
    [role, setRole] = useState(''),
    [cursor, setCursor] = useState<string>();
  const users = useQuery({
    queryKey: ['owner-users', q, role, cursor],
    queryFn: () => {
      const params = new URLSearchParams({ q });
      if (role) params.set('role', role);
      if (cursor) params.set('cursor', cursor);
      return api<Result<typeof listPlatformUsers>>(`/v1/platform/owner/users?${params}`);
    },
  });
  return (
    <Page
      title={t('web.users')}
      actions={
        <Link className="button secondary" to="/owner/invitations">
          {t('web.invites')}
        </Link>
      }
    >
      <Section>
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setQ(text(new FormData(event.currentTarget), 'q'));
            setCursor(undefined);
          }}
        >
          <Input label={t('web.search')} name="q" defaultValue={q} maxLength={100} />
          <Select
            label={t('web.role')}
            value={role}
            onChange={(event) => {
              setRole(event.target.value);
              setCursor(undefined);
            }}
          >
            <option value="">{t('web.all')}</option>
            {['owner', 'operator', 'user'].map((value) => (
              <option value={value} key={value}>
                {t(`owner.role.${value}`)}
              </option>
            ))}
          </Select>
          <button type="submit" className="secondary">
            {t('web.search')}
          </button>
        </form>
        {users.isPending ? (
          <Loading />
        ) : users.error ? (
          <ErrorNotice error={users.error} />
        ) : !users.data.items.length ? (
          <Empty />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('web.name')}</th>
                  <th>{t('web.email')}</th>
                  <th>{t('web.role')}</th>
                  <th>{t('web.created')}</th>
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <Link to={`/owner/users/${user.id}`}>{user.name}</Link>
                    </td>
                    <td>{user.email}</td>
                    <td>{t(`owner.role.${user.role}`)}</td>
                    <td>
                      <Time value={user.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="actions">
          {cursor && (
            <button className="secondary" type="button" onClick={() => setCursor(undefined)}>
              {t('owner.firstPage')}
            </button>
          )}
          {users.data?.nextCursor && (
            <button
              className="secondary"
              type="button"
              onClick={() => setCursor(users.data.nextCursor!)}
            >
              {t('web.next')}
            </button>
          )}
        </div>
      </Section>
    </Page>
  );
}
export function OwnerUserPage() {
  const { userId = '' } = useParams();
  const queryClient = useQueryClient();
  const t = useT(),
    format = useFormat(),
    session = useSession(),
    navigate = useNavigate();
  const [assisting, setAssisting] = useState(false);
  const user = useQuery({
    queryKey: ['owner-user', userId],
    queryFn: () =>
      api<Result<typeof getPlatformUser>>(`/v1/platform/owner/users/${encodeURIComponent(userId)}`),
  });
  if (user.isPending) return <Loading />;
  if (user.error) return <ErrorNotice error={user.error} />;
  const value = user.data,
    quota = value.quota;
  return (
    <Page
      title={value.name}
      actions={
        userId !== session.data?.actor.id ? (
          <button type="button" className="secondary" onClick={() => setAssisting(true)}>
            {t('web.support')}
          </button>
        ) : undefined
      }
    >
      <div className="columns">
        <Section title={t('web.profile')}>
          <Details
            values={[
              [t('web.email'), value.email],
              [t('web.role'), t(`owner.role.${value.role}`)],
              [t('web.created'), <Time key="created" value={value.createdAt} />],
            ]}
          />
          {value.role !== 'owner' && (
            <ActionForm
              onSubmit={async (data) => {
                await api('/v1/owner/roles', {
                  method: 'PATCH',
                  body: { userId, role: text(data, 'role') },
                });
                await user.refetch();
              }}
            >
              <Select label={t('web.role')} name="role" defaultValue={value.role}>
                <option value="user">{t('owner.role.user')}</option>
                <option value="operator">{t('owner.role.operator')}</option>
              </Select>
            </ActionForm>
          )}
          <p>
            <Link to={`/owner/servers?ownerId=${encodeURIComponent(userId)}`}>
              {t('web.servers')}
            </Link>
          </p>
        </Section>
        <Section title={t('web.quota')}>
          <Details
            values={[
              [
                t('web.memory'),
                `${format.number(quota.committed.memoryMiB)} / ${format.number(quota.limits.memoryMiB)} MiB`,
              ],
              [
                t('web.cpu'),
                `${format.number(quota.committed.cpuPercent)} / ${format.number(quota.limits.cpuPercent)}%`,
              ],
              [
                t('web.disk'),
                `${format.number(quota.committed.storageMiB)} MiB / ${quota.limits.storageMiB === null ? t('owner.globalPool') : `${format.number(quota.limits.storageMiB)} MiB`}`,
              ],
              [
                t('web.servers'),
                `${format.number(quota.committed.serverCount)} / ${quota.limits.serverCount === null ? t('owner.noCountLimit') : format.number(quota.limits.serverCount)}`,
              ],
            ]}
          />
          <details>
            <summary>{t('owner.overrideQuota')}</summary>
            <ActionForm
              onSubmit={async (data) => {
                await api('/v1/owner/user-limits', {
                  method: 'PUT',
                  body: {
                    userId,
                    memoryMiB: number(data, 'memory'),
                    cpuPercent: number(data, 'cpu'),
                    storageMiB: number(data, 'storage'),
                    reason: text(data, 'reason'),
                    ...(text(data, 'expires')
                      ? { expiresAt: new Date(text(data, 'expires')).toISOString() }
                      : {}),
                  },
                });
                await Promise.all([
                  user.refetch(),
                  queryClient.invalidateQueries({ queryKey: ['audit', userId] }),
                ]);
              }}
            >
              <Input
                label={`${t('web.memory')} (MiB)`}
                name="memory"
                type="number"
                min={1}
                defaultValue={quota.limits.memoryMiB}
                required
              />
              <Input
                label={`${t('web.cpu')} (%)`}
                name="cpu"
                type="number"
                min={1}
                defaultValue={quota.limits.cpuPercent}
                required
              />
              <Input
                label={`${t('web.disk')} (MiB)`}
                name="storage"
                type="number"
                min={1}
                defaultValue={
                  quota.override?.storageMiB ??
                  quota.limits.storageMiB ??
                  Math.max(1024, quota.committed.storageMiB)
                }
                required
              />
              <Input
                label={t('web.expires')}
                name="expires"
                type="datetime-local"
                step={1}
                defaultValue={
                  quota.override?.expiresAt
                    ? new Date(
                        Date.parse(quota.override.expiresAt) -
                          new Date(quota.override.expiresAt).getTimezoneOffset() * 60000,
                      )
                        .toISOString()
                        .slice(0, 19)
                    : ''
                }
              />
              <Textarea
                label={t('web.reason')}
                name="reason"
                minLength={8}
                maxLength={300}
                required
              />
            </ActionForm>
          </details>
          {quota.override && (
            <Notice>
              {t(quota.override.active ? 'owner.overrideActive' : 'owner.overrideExpired')}{' '}
              {quota.override.expiresAt ? (
                <Time value={quota.override.expiresAt} />
              ) : (
                t('owner.noExpiry')
              )}
            </Notice>
          )}
        </Section>
      </div>
      <Section title={t('owner.quotaHistory')}>
        <AuditTable userId={userId} />
      </Section>
      <Dialog open={assisting} title={t('web.support')} onClose={() => setAssisting(false)}>
        <ActionForm
          success={false}
          submitLabel={t('owner.startSupport')}
          onSubmit={async (data) => {
            const totp = text(data, 'totp'),
              recovery = text(data, 'recovery');
            const grant = await api<{ token: string }>('/v1/identity/step-up', {
              body: {
                password: String(data.get('password')),
                ...(totp ? { totpCode: totp } : {}),
                ...(recovery ? { recoveryCode: recovery } : {}),
              },
            });
            await api('/v1/web/support', {
              body: {
                stepUpToken: grant.token,
                subjectUserId: userId,
                reason: text(data, 'reason'),
              },
            });
            await identityChanged();
            navigate('/');
          }}
        >
          <p>{t('owner.supportWarning')}</p>
          <Textarea label={t('web.reason')} name="reason" minLength={8} maxLength={300} required />
          <Input
            label={t('web.currentPassword')}
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          {session.data?.actor.twoFactorEnabled && (
            <>
              <Input
                label={t('web.code')}
                name="totp"
                autoComplete="one-time-code"
                inputMode="numeric"
              />
              <Input label={t('web.recoveryCode')} name="recovery" autoComplete="off" />
            </>
          )}
          <Check required label={t('web.confirm')} />
        </ActionForm>
      </Dialog>
    </Page>
  );
}
type Invitation = {
  id: string;
  email: string | null;
  role: string;
  remainingUses: number;
  maxUses: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};
export function InvitationsPage() {
  const t = useT();
  const [link, setLink] = useState<string>(),
    [create, setCreate] = useState(false);
  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: () => api<Invitation[]>('/v1/owner/invitations'),
  });
  return (
    <Page
      title={t('web.invites')}
      actions={
        <button type="button" onClick={() => setCreate(true)}>
          {t('owner.createInvite')}
        </button>
      }
    >
      {link && (
        <Notice>
          <Input label={t('owner.inviteLink')} value={link} readOnly autoComplete="off" />
          <p>{t('owner.inviteOnce')}</p>
          <button type="button" className="secondary" onClick={() => setLink(undefined)}>
            {t('web.close')}
          </button>
        </Notice>
      )}
      <Section>
        {invitations.isPending ? (
          <Loading />
        ) : invitations.error ? (
          <ErrorNotice error={invitations.error} />
        ) : !invitations.data.length ? (
          <Empty />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('web.email')}</th>
                  <th>{t('web.role')}</th>
                  <th>{t('owner.uses')}</th>
                  <th>{t('web.expires')}</th>
                  <th>{t('web.status')}</th>
                  <th>{t('web.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {invitations.data.map((invite) => (
                  <tr key={invite.id}>
                    <td>{invite.email ?? t('owner.anyEmail')}</td>
                    <td>{t(`owner.role.${invite.role}`)}</td>
                    <td>
                      {invite.remainingUses} / {invite.maxUses}
                    </td>
                    <td>
                      <Time value={invite.expiresAt} />
                    </td>
                    <td>
                      <Badge
                        value={
                          invite.revokedAt
                            ? 'revoked'
                            : Date.parse(invite.expiresAt) <= Date.now()
                              ? 'expired'
                              : invite.remainingUses === 0
                                ? 'succeeded'
                                : 'active'
                        }
                      />
                    </td>
                    <td>
                      {!invite.revokedAt &&
                        invite.remainingUses > 0 &&
                        Date.parse(invite.expiresAt) > Date.now() && (
                          <ActionForm
                            submitLabel={t('web.revoke')}
                            success={false}
                            onSubmit={async () => {
                              await api(`/v1/owner/invitations/${invite.id}`, { method: 'DELETE' });
                              await invitations.refetch();
                            }}
                          >
                            <Check required label={t('web.confirm')} />
                          </ActionForm>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Dialog open={create} title={t('owner.createInvite')} onClose={() => setCreate(false)}>
        <ActionForm
          submitLabel={t('owner.createInvite')}
          success={false}
          onSubmit={async (data) => {
            const email = text(data, 'email'),
              expires = text(data, 'expires');
            const response = await api<{ url: string }>('/v1/owner/invitations', {
              body: {
                ...(email ? { email } : {}),
                role: text(data, 'role'),
                maxUses: number(data, 'uses'),
                ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}),
              },
            });
            setLink(response.url);
            setCreate(false);
            await invitations.refetch();
          }}
        >
          <Input label={`${t('web.email')} (${t('web.optional')})`} type="email" name="email" />
          <Select label={t('web.role')} name="role">
            <option value="user">{t('owner.role.user')}</option>
            <option value="operator">{t('owner.role.operator')}</option>
          </Select>
          <Input
            label={t('owner.maxUses')}
            type="number"
            name="uses"
            min={1}
            max={100}
            defaultValue={1}
            required
          />
          <Input label={t('web.expires')} type="datetime-local" name="expires" />
        </ActionForm>
      </Dialog>
    </Page>
  );
}
export function OwnerAuditPage() {
  const t = useT();
  return (
    <Page title={t('web.audit')}>
      <Section>
        <AuditTable />
      </Section>
    </Page>
  );
}
function AuditTable({ userId }: { userId?: string }) {
  const t = useT();
  const [action, setAction] = useState(''),
    [actor, setActor] = useState(''),
    [cursor, setCursor] = useState<string>();
  const events = useQuery({
    queryKey: ['audit', userId, action, actor, cursor],
    queryFn: () => {
      const params = new URLSearchParams();
      if (userId) params.set('userId', userId);
      if (action) params.set('action', action);
      if (actor) params.set('actorId', actor);
      if (cursor) params.set('cursor', cursor);
      return api<Result<typeof listPlatformAudit>>(`/v1/platform/owner/audit?${params}`);
    },
  });
  return (
    <>
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setAction(text(data, 'action'));
          setActor(text(data, 'actor'));
          setCursor(undefined);
        }}
      >
        <Input label={t('owner.eventType')} name="action" defaultValue={action} />
        <Input label={t('owner.actorId')} name="actor" defaultValue={actor} />
        <button type="submit" className="secondary">
          {t('web.filter')}
        </button>
      </form>
      {events.isPending ? (
        <Loading />
      ) : events.error ? (
        <ErrorNotice error={events.error} />
      ) : !events.data.items.length ? (
        <Empty />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('web.created')}</th>
                <th>{t('owner.eventType')}</th>
                <th>{t('owner.actorId')}</th>
                <th>{t('owner.subjectId')}</th>
                <th>{t('web.details')}</th>
              </tr>
            </thead>
            <tbody>
              {events.data.items.map((event) => (
                <tr key={event.id}>
                  <td>
                    <Time value={event.created_at} />
                  </td>
                  <td>
                    <code>{event.action}</code>
                  </td>
                  <td>{event.actor_user_id}</td>
                  <td>{event.subject_user_id}</td>
                  <td>
                    <details>
                      <summary>{t('web.details')}</summary>
                      <dl className="details">
                        {Object.entries(event.metadata as Record<string, unknown>).map(
                          ([key, value]) => (
                            <div key={key}>
                              <dt>{key}</dt>
                              <dd>
                                <code>
                                  {typeof value === 'string' ? value : JSON.stringify(value)}
                                </code>
                              </dd>
                            </div>
                          ),
                        )}
                      </dl>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="actions">
        {cursor && (
          <button type="button" className="secondary" onClick={() => setCursor(undefined)}>
            {t('owner.firstPage')}
          </button>
        )}
        {events.data?.nextCursor && (
          <button
            type="button"
            className="secondary"
            onClick={() => setCursor(events.data.nextCursor!)}
          >
            {t('web.next')}
          </button>
        )}
      </div>
    </>
  );
}
