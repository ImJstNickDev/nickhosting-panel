import { useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { ApiError, api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { ActionForm, Details, Empty, ErrorNotice, Input, Time } from '../components/ui.js';
import type { Combination } from './minecraft-admin-model.js';
import { CreationState } from './minecraft-admin-presentation.js';

const checks = [
  'installation',
  'status',
  'intentionalJoin',
  'sleepingResponse',
  'wakingResponse',
  'blockedResponse',
  'manualStop',
  'transparentLogin',
  'readiness',
  'playerIdle',
  'wakeAdmission',
  'gracefulSave',
] as const;
export function CombinationDetail({
  choice,
  mappingLabel,
  refresh,
}: {
  choice: Combination;
  mappingLabel: string;
  refresh: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [importing, setImporting] = useState(false);
  const reason = choice.creation?.reason;
  const runtimeLink = `/owner/integrations/minecraft/runtime?runtime=${encodeURIComponent(choice.combination.profile)}`;
  async function toggle() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/v1/owner/minecraft/compatibility/${choice.id}/availability`, {
        method: 'PUT',
        body: { enabled: !choice.enabled },
      });
      await refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="minecraft-version-details">
      <section className="minecraft-version-availability" aria-label={t('versions.creation')}>
        <div>
          <h3>{t('versions.userCreation')}</h3>
          <CreationState choice={choice} />
        </div>
        {reason && <p className="muted">{t(`versions.reason.${reason}`)}</p>}
        {(reason === 'mapping-disabled' || reason === 'mapping-changed') && (
          <Link to={runtimeLink}>{t('versions.configureMapping')}</Link>
        )}
        {reason === 'node-disabled' && (
          <Link to="/owner/infrastructure">{t('versions.configureNode')}</Link>
        )}
        {reason?.startsWith('rollout-') && (
          <Link to="/owner/integrations/minecraft/general">{t('versions.configureRollout')}</Link>
        )}
        <div className="minecraft-version-availability-toggle">
          <span>{t(choice.enabled ? 'versions.offered' : 'versions.notOffered')}</span>
          <button type="button" className="secondary" disabled={busy} onClick={() => void toggle()}>
            {t(busy ? 'web.loading' : choice.enabled ? 'versions.disable' : 'versions.enable')}
          </button>
        </div>
        {error !== undefined && <ErrorNotice error={error} />}
      </section>
      <section>
        <h3>{t('versions.declaredFeatures')}</h3>
        <p className="muted minecraft-support-authority">
          {t(
            choice.supportAuthority === 'integration'
              ? 'versions.integrationDeclaration'
              : 'versions.noDeclaration',
          )}
        </p>
        {choice.capabilities && (
          <dl className="minecraft-feature-list">
            {(
              [
                'installation',
                'directConnection',
                'gateway',
                'readiness',
                'playerIdle',
                'sleepWake',
                'playerManagement',
              ] as const
            ).map((capability) => (
              <div key={capability}>
                <dt>{t(`gameAdmin.capability.${capability}`)}</dt>
                <dd className={choice.capabilities?.[capability] ? 'supported' : 'muted'}>
                  {t(choice.capabilities?.[capability] ? 'gameUi.yes' : 'gameUi.no')}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <section>
        <h3>{t('versions.runtimeConfiguration')}</h3>
        <Details
          values={[
            [t('gameAdmin.mapping'), mappingLabel],
            [t('gameAdmin.java'), String(choice.combination.javaMajor)],
            [t('gameAdmin.image'), choice.image ?? t('web.unavailable')],
          ]}
        />
      </section>
      <details className="minecraft-version-evidence">
        <summary>
          {t('versions.recordedTests')} <span>{choice.evidence.length}</span>
        </summary>
        <div className="minecraft-version-evidence-body">
          {choice.evidence.length ? (
            choice.evidence.map((report) => (
              <details key={report.runId}>
                <summary>
                  <Time value={report.recordedAt} /> · {t(`gameAdmin.${report.kind}`)}
                </summary>
                <Details
                  values={[
                    [t('gameAdmin.run'), report.runId],
                    [
                      t('gameAdmin.client'),
                      report.client
                        ? `${report.client.implementation} ${report.client.version}`
                        : '—',
                    ],
                    [t('gameAdmin.server'), report.server?.uuid ?? '—'],
                    [t('gameAdmin.digest'), report.evidenceSha256],
                  ]}
                />
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('gameAdmin.check')}</th>
                        <th>{t('gameAdmin.result')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checks.map((check) => (
                        <tr key={check}>
                          <td>{t(`gameAdmin.check.${check}`)}</td>
                          <td>
                            {t(
                              report.checks[check] === true
                                ? 'gameAdmin.passed'
                                : report.checks[check] === false
                                  ? 'gameAdmin.failed'
                                  : 'web.unknown',
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))
          ) : (
            <Empty text={t('gameAdmin.noEvidence')} />
          )}
          {!importing ? (
            <button type="button" className="secondary" onClick={() => setImporting(true)}>
              {t('gameAdmin.importEvidence')}
            </button>
          ) : (
            <ActionForm
              onSubmit={async (data) => {
                const file = data.get('evidence');
                if (!(file instanceof File) || file.size < 1 || file.size > 4 * 1024 * 1024)
                  throw new ApiError('validation_failed', 'gameAdmin.evidenceInvalid');
                let raw: unknown;
                try {
                  raw = JSON.parse(await file.text());
                } catch {
                  throw new ApiError('validation_failed', 'gameAdmin.evidenceInvalid');
                }
                const envelope = z
                  .object({
                    report: z.record(z.string(), z.unknown()),
                    signature: z.string().regex(/^[a-f0-9]{64}$/),
                  })
                  .strict()
                  .safeParse(raw);
                if (!envelope.success)
                  throw new ApiError('validation_failed', 'gameAdmin.evidenceInvalid');
                await api(`/v1/owner/minecraft/compatibility/${choice.id}/evidence`, {
                  body: envelope.data,
                });
                await refresh();
                setImporting(false);
              }}
              submitLabel={t('gameAdmin.importEvidence')}
            >
              <Input
                label={t('gameAdmin.signedReport')}
                name="evidence"
                type="file"
                accept=".json"
                required
              />
              <p className="muted">{t('gameAdmin.signatureBoundary')}</p>
            </ActionForm>
          )}
        </div>
      </details>
      <details>
        <summary>{t('versions.technical')}</summary>
        <Details
          values={[
            [t('gameAdmin.choiceId'), choice.id],
            [t('gameAdmin.mapping'), choice.mappingId],
            [t('gameAdmin.protocol'), String(choice.combination.protocolId ?? t('web.unknown'))],
            [t('gameAdmin.family'), choice.combination.family],
            [t('gameAdmin.build'), choice.combination.buildId ?? '—'],
            [t('gameAdmin.loader'), choice.combination.loaderVersion ?? '—'],
          ]}
        />
      </details>
    </div>
  );
}
