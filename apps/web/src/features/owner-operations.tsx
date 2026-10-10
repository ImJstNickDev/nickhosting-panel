import type { ManagementRuntime } from '@nickhosting/server-management';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import {
  ActionForm,
  Check,
  Dialog,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  Section,
  Textarea,
  Time,
  text,
} from '../components/ui.js';
import { ActivityPage } from './activity.js';

type Claim = {
  id: string;
  server_id: string;
  declared_bytes: string;
  reserved_bytes: string;
  scope_hash: string;
  created_at: string;
};
export function OwnerOperationsPage() {
  const t = useT(),
    format = useFormat();
  const [selected, setSelected] = useState<Claim>();
  const [reconciliation, setReconciliation] =
    useState<Awaited<ReturnType<ManagementRuntime['reconcile']>>>();
  const claims = useQuery({
    queryKey: ['owner-uploads'],
    queryFn: () => api<Claim[]>('/v1/owner/uploads'),
  });
  return (
    <>
      <ActivityPage />
      <Section title={t('owner.uploadRecovery')}>
        {claims.isPending ? (
          <Loading />
        ) : claims.error ? (
          <ErrorNotice error={claims.error} />
        ) : !claims.data.length ? (
          <Empty text={t('owner.noUploadClaims')} />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('web.servers')}</th>
                  <th>{t('web.reserved')}</th>
                  <th>{t('web.created')}</th>
                  <th>{t('web.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {claims.data.map((claim) => (
                  <tr key={claim.id}>
                    <td>
                      <Link to={`/servers/${claim.server_id}/files`}>{claim.server_id}</Link>
                    </td>
                    <td>{format.bytes(Number(claim.reserved_bytes))}</td>
                    <td>
                      <Time value={claim.created_at} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setSelected(claim)}
                      >
                        {t('owner.reviewRecovery')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Dialog
          open={Boolean(selected)}
          title={t('owner.uploadRecovery')}
          onClose={() => setSelected(undefined)}
        >
          {selected && (
            <ActionForm
              success={false}
              submitLabel={t('owner.releaseClaim')}
              onSubmit={async (data) => {
                await api(`/v1/owner/uploads/${selected.id}/recover`, {
                  body: {
                    confirm: true,
                    remoteTransferFinished: true,
                    temporaryFilesRemoved: true,
                    scopeHash: selected.scope_hash,
                    reason: text(data, 'reason'),
                    evidence: text(data, 'evidence'),
                  },
                });
                setSelected(undefined);
                await claims.refetch();
              }}
            >
              <Notice>{t('owner.uploadRecoveryWarning')}</Notice>
              <Textarea
                label={t('web.reason')}
                name="reason"
                minLength={10}
                maxLength={1000}
                required
              />
              <Textarea
                label={t('owner.evidence')}
                name="evidence"
                minLength={20}
                maxLength={4000}
                required
              />
              <Check required label={t('owner.remoteTransferFinished')} />
              <Check required label={t('owner.temporaryFilesRemoved')} />
              <Check required label={t('web.confirm')} />
            </ActionForm>
          )}
        </Dialog>
      </Section>
      <Section title={t('owner.reconciliation')}>
        <ActionForm
          submitLabel={t('owner.reconcile')}
          success={false}
          onSubmit={async () => {
            setReconciliation(undefined);
            setReconciliation(await api('/v1/owner/reconcile', { body: {} }));
            await claims.refetch();
          }}
        >
          <p className="muted">{t('owner.reconcileDescription')}</p>
        </ActionForm>
        {reconciliation && (
          <Notice>
            <p>{t('owner.reconcileSummary', { count: reconciliation.observed })}</p>
            {reconciliation.unavailable.length > 0 && (
              <>
                <p>{t('owner.reconcileUnavailable')}</p>
                <ul>
                  {reconciliation.unavailable.map((id) => (
                    <li key={id}>
                      <Link to={`/servers/${id}`}>{id}</Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p>
              {t('owner.reconcileExternal', {
                recovered: reconciliation.external.recovered,
                failed: reconciliation.external.failed,
              })}
            </p>
            {(reconciliation.unavailable.length > 0 || reconciliation.external.failed > 0) && (
              <p>{t('owner.reconcilePartial')}</p>
            )}
          </Notice>
        )}
      </Section>
    </>
  );
}
