import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { Tooltip } from '../components/tooltip.js';
import {
  ActionForm,
  Badge,
  ConfirmDialog,
  Dialog,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  Section,
} from '../components/ui.js';
import { assignmentConnectionChoice } from './connection.api.js';
import {
  type ConnectionChoice,
  ConnectionFields,
  type ConnectionOptions,
} from './connection-fields.js';
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
    refetchInterval: 15000,
  });
  const options = useQuery({
    queryKey: ['connection-options', 'server', serverId],
    queryFn: () => api<ConnectionOptions>(`${serverPath(serverId)}/connection-options`),
  });
  const [remove, setRemove] = useState<DnsAssignments[number]>();
  const [editing, setEditing] = useState(false),
    [choice, setChoice] = useState<ConnectionChoice>({});
  const [plan, setPlan] = useState<DnsPlan>(),
    [error, setError] = useState<unknown>(),
    [copied, setCopied] = useState(false);
  const canManage =
    server.data?.permissions.manage && session.data?.context.sessionType === 'regular';
  const assignment = connection.data?.primaryDnsAssignmentId
    ? dns.data?.find((item) => item.id === connection.data?.primaryDnsAssignmentId)
    : (dns.data?.find((item) => item.state === 'active') ?? dns.data?.[0]);
  const primary = connection.data?.ports.find((port) => port.primary && port.displayAddress);
  const address = primary?.displayAddress;
  const addressState = connection.data?.addressState;
  const missingAddress =
    addressState === 'pending'
      ? 'connection.addressPreparing'
      : addressState === 'uncertain' || addressState === 'deleting'
        ? 'connection.addressUnavailable'
        : 'service.noConnection';
  async function refresh() {
    await Promise.all([connection.refetch(), dns.refetch()]);
  }
  async function save() {
    await api(`${serverPath(serverId)}/dns${assignment ? `/${assignment.id}` : ''}`, {
      method: assignment ? 'PUT' : 'POST',
      body: choice,
    });
    setEditing(false);
    setPlan(undefined);
    await refresh();
  }
  return (
    <>
      <Section title={t('service.address')}>
        {connection.isPending ? (
          <Loading />
        ) : connection.error ? (
          <ErrorNotice error={connection.error} />
        ) : (
          <>
            <div className="connection-primary">
              {address ? <code>{address}</code> : <Empty text={t(missingAddress)} />}
              {assignment ? (
                <Badge value={assignment.state} />
              ) : connection.data.addressState === 'pending' ? (
                <Badge value="pending" />
              ) : null}
              <div className="connection-actions">
                {address && (
                  <Tooltip content={t(copied ? 'web.copied' : 'web.copy')}>
                    <button
                      type="button"
                      aria-label={t('web.copy')}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(address);
                          setCopied(true);
                          setError(undefined);
                        } catch (failure) {
                          setError(failure);
                        }
                      }}
                    >
                      <svg
                        aria-hidden="true"
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                      >
                        <path d="M9 8h11v13H9z M5 16H3V3h11v2" />
                      </svg>
                    </button>
                  </Tooltip>
                )}
                {canManage && assignment && ['pending', 'uncertain'].includes(assignment.state) && (
                  <Tooltip content={t('connection.remove')}>
                    <button
                      type="button"
                      className="connection-remove"
                      aria-label={t('connection.remove')}
                      onClick={() => setRemove(assignment)}
                    >
                      <svg
                        aria-hidden="true"
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                      >
                        <path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7" />
                      </svg>
                    </button>
                  </Tooltip>
                )}
                {canManage && options.data?.configured && options.data.customizable && (
                  <Tooltip content={t('connection.edit')}>
                    <button
                      type="button"
                      aria-label={t('connection.edit')}
                      disabled={Boolean(
                        (connection.data.primaryDnsAssignmentId && !assignment) ||
                          (assignment && assignment.state !== 'active'),
                      )}
                      onClick={() => {
                        setChoice(assignmentConnectionChoice(assignment, options.data));
                        setPlan(undefined);
                        setEditing(true);
                      }}
                    >
                      <svg
                        aria-hidden="true"
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                      >
                        <path d="m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5" />
                      </svg>
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
            {canManage &&
              options.data?.configured &&
              options.data.mode !== 'static-host-port' &&
              connection.data.addressState !== 'pending' &&
              !connection.data.primaryDnsAssignmentId &&
              !assignment && (
                <ActionForm
                  submitLabel={t('connection.activate')}
                  success={false}
                  onSubmit={async () => {
                    await api(`${serverPath(serverId)}/dns`, { body: {} });
                    await refresh();
                  }}
                >
                  {null}
                </ActionForm>
              )}
            {assignment?.state === 'pending' && address && (
              <p className="muted">{t('service.addressPending')}</p>
            )}
            {options.data && !options.data.configured && (
              <p className="muted">{t('connection.unconfigured')}</p>
            )}
            {connection.data.connectionMode === 'direct' && (
              <Notice>{t('service.directReachability')}</Notice>
            )}
            {Boolean(error) && <ErrorNotice error={error} />}
            {dns.error && <ErrorNotice error={dns.error} />}
            {options.error && <ErrorNotice error={options.error} />}
          </>
        )}
      </Section>
      {connection.data && connection.data.ports.length > 0 && (
        <Section title={t('connection.ports')}>
          <section
            className="table-scroll connection-ports"
            aria-label={t('connection.ports')}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the named ports table.
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th>{t('service.portRole')}</th>
                  <th>{t('service.address')}</th>
                  <th>{t('service.transport')}</th>
                  <th>{t('service.port')}</th>
                </tr>
              </thead>
              <tbody>
                {connection.data.ports.map((port) => (
                  <tr key={`${port.role}:${port.transport}`}>
                    <td>{port.role}</td>
                    <td>
                      <code>{port.displayAddress ?? t(missingAddress)}</code>
                    </td>
                    <td>{port.transport.toUpperCase()}</td>
                    <td>{port.port ?? t('web.unavailable')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </Section>
      )}
      <ConfirmDialog
        open={Boolean(remove)}
        title={t('connection.remove')}
        confirmLabel={t('web.delete')}
        destructive
        onClose={() => setRemove(undefined)}
        onConfirm={async () => {
          if (!remove) return;
          await api(`${serverPath(serverId)}/dns/${remove.id}`, {
            method: 'DELETE',
            body: { confirm: true },
          });
          setRemove(undefined);
          await refresh();
        }}
      >
        <p>{t('connection.removeHelp')}</p>
      </ConfirmDialog>
      <Dialog
        open={editing}
        title={t('connection.edit')}
        onClose={() => {
          setEditing(false);
          setPlan(undefined);
        }}
      >
        {options.data && (
          <ActionForm
            submitLabel={t(plan ? 'web.save' : 'service.previewAddress')}
            success={false}
            onSubmit={async () => {
              if (plan) await save();
              else {
                const preview = await api<DnsPlan>(`${serverPath(serverId)}/dns/preview`, {
                  body: choice,
                });
                setPlan(preview);
                setChoice({
                  ...(preview.domainId ? { domainId: preview.domainId } : {}),
                  ...(preview.subdomain ? { subdomain: preview.subdomain } : {}),
                });
              }
            }}
          >
            <ConnectionFields
              options={options.data}
              value={choice}
              onChange={(value) => {
                setChoice(value);
                setPlan(undefined);
              }}
            />
            {plan && (
              <>
                <code>{plan.displayAddress}</code>
                <p className="muted">{t('connection.replaceHelp')}</p>
              </>
            )}
          </ActionForm>
        )}
      </Dialog>
    </>
  );
}
