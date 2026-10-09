import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import {
  ActionForm,
  Badge,
  Check,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  Section,
  Select,
  Time,
  text,
} from '../components/ui.js';
import {
  type Connections,
  type DnsAssignments,
  type DnsPlan,
  platformPath,
  serverPath,
  useServer,
} from './service-contracts.js';

export function NetworkPage({ serverId }: { serverId: string }) {
  const t = useT(),
    server = useServer(serverId),
    session = useSession();
  const connection = useQuery({
    queryKey: ['connections', serverId],
    queryFn: () => api<Connections>(`${platformPath(serverId)}/connections`),
    refetchInterval: 15000,
  });
  const dns = useQuery({
    queryKey: ['dns', serverId],
    queryFn: () => api<DnsAssignments>(`${serverPath(serverId)}/dns`),
  });
  const [plan, setPlan] = useState<{
    value: DnsPlan;
    request: { subdomain: string; portRole?: string };
    assignmentId?: string;
  }>();
  const [remove, setRemove] = useState<DnsAssignments[number]>();
  const [copied, setCopied] = useState<string>();
  const [copyError, setCopyError] = useState<unknown>();
  const canManage =
    server.data?.permissions.manage && session.data?.context.sessionType === 'regular';
  const roles = [...new Set(connection.data?.ports.map((p) => p.role))];
  async function refresh() {
    await Promise.all([connection.refetch(), dns.refetch()]);
  }
  return (
    <>
      <Section title={t('web.network')}>
        {connection.isPending ? (
          <Loading />
        ) : connection.error ? (
          <ErrorNotice error={connection.error} />
        ) : !connection.data.ports.length ? (
          <Empty text={t('service.noConnection')} />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('service.portRole')}</th>
                  <th>{t('service.address')}</th>
                  <th>{t('service.transport')}</th>
                  <th>{t('web.status')}</th>
                  <th>{t('web.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {connection.data.ports.map((port) => {
                  const address =
                    port.hostname && port.port
                      ? `${port.hostname.includes(':') ? `[${port.hostname}]` : port.hostname}:${port.port}`
                      : null;
                  return (
                    <tr key={`${port.role}:${port.transport}`}>
                      <td>{port.role}</td>
                      <td>
                        <code>{address ?? t('web.unconfigured')}</code>
                      </td>
                      <td>{port.transport.toUpperCase()}</td>
                      <td>
                        <Badge value={port.status} />
                      </td>
                      <td>
                        {address && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(address);
                                setCopied(address);
                                setCopyError(undefined);
                              } catch (error) {
                                setCopyError(error);
                              }
                            }}
                          >
                            {t(copied === address ? 'web.copied' : 'web.copy')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {Boolean(copyError) && <ErrorNotice error={copyError} />}
        {connection.data?.srv && <p className="muted">{t('service.srvInfo')}</p>}
      </Section>
      {connection.data?.mode === 'custom-subdomain' && (
        <Section title={t('service.subdomains')}>
          {dns.isPending ? (
            <Loading />
          ) : dns.error ? (
            <ErrorNotice error={dns.error} />
          ) : (
            <div className="stack">
              {dns.data.map((assignment) => (
                <div className="section-heading" key={assignment.id}>
                  <div>
                    <code>{assignment.connection.displayAddress}</code>{' '}
                    <Badge value={assignment.state} />
                    <p>
                      <Time value={assignment.updatedAt} />
                    </p>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setRemove(assignment)}
                    >
                      {t('web.delete')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {canManage && (
            <ActionForm
              submitLabel={t('service.previewAddress')}
              success={false}
              onSubmit={async (data) => {
                const request = {
                  subdomain: text(data, 'subdomain'),
                  ...(text(data, 'role') ? { portRole: text(data, 'role') } : {}),
                };
                const value = await api<DnsPlan>(`${serverPath(serverId)}/dns/preview`, {
                  body: request,
                });
                setPlan({ value, request, assignmentId: text(data, 'assignment') || undefined });
              }}
            >
              <Input
                label={t('service.subdomain')}
                name="subdomain"
                required
                pattern="[a-z0-9][a-z0-9-]*"
                maxLength={63}
              />
              {roles.length > 1 && (
                <Select label={t('service.portRole')} name="role">
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </Select>
              )}
              {Boolean(dns.data?.length) && (
                <Select label={t('service.assignment')} name="assignment">
                  <option value="">{t('service.newAddress')}</option>
                  {dns.data?.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.connection.hostname}
                    </option>
                  ))}
                </Select>
              )}
            </ActionForm>
          )}
        </Section>
      )}
      <Dialog
        open={Boolean(plan)}
        title={t('service.previewAddress')}
        onClose={() => setPlan(undefined)}
      >
        {plan && (
          <ActionForm
            submitLabel={t('web.confirm')}
            success={false}
            onSubmit={async () => {
              await api(
                `${serverPath(serverId)}/dns${plan.assignmentId ? `/${plan.assignmentId}` : ''}`,
                { method: plan.assignmentId ? 'PUT' : 'POST', body: plan.request },
              );
              setPlan(undefined);
              await refresh();
            }}
          >
            <p>
              <code>{plan.value.displayAddress}</code>
            </p>
            <Notice>{t('service.addressPending')}</Notice>
            <Check required label={t('web.confirm')} />
          </ActionForm>
        )}
      </Dialog>
      <Dialog open={Boolean(remove)} title={t('web.delete')} onClose={() => setRemove(undefined)}>
        {remove && (
          <ActionForm
            submitLabel={t('web.delete')}
            success={false}
            onSubmit={async () => {
              await api(`${serverPath(serverId)}/dns/${remove.id}`, {
                method: 'DELETE',
                body: { confirm: true },
              });
              setRemove(undefined);
              await refresh();
            }}
          >
            <p>{t('service.deleteAddressWarning', { hostname: remove.connection.hostname })}</p>
            <Check required label={t('web.confirm')} />
          </ActionForm>
        )}
      </Dialog>
    </>
  );
}
