import { type ComponentType, useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router';
import { ApiError, api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { Tooltip } from '../components/tooltip.js';
import { ErrorNotice, Input } from '../components/ui.js';
import { AccountIcon } from './account-icons.js';
import { SecuritySection } from './account-security-section.js';
import { refreshAccount, type TwoFactorStep, type useSecuritySetup } from './account-shared.js';
import './account-two-factor.css';

function SetupKey({ uri }: { uri: string }) {
  const t = useT();
  const [Qr, setQr] = useState<ComponentType<{ uri: string; title: string }>>();
  const [qrFailed, setQrFailed] = useState(false);
  const [copyError, setCopyError] = useState<unknown>();
  useEffect(() => {
    let active = true;
    // Lazy and optional: manual enrollment remains usable if the QR chunk cannot load.
    void import('./account-two-factor-qr.js').then(
      (module) => {
        if (active) setQr(() => module.AuthenticatorQr);
      },
      () => {
        if (active) setQrFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="totp-pairing">
      {!qrFailed && (
        <div className="totp-qr" aria-busy={!Qr}>
          {Qr ? (
            <Qr uri={uri} title={t('accountSecurity.qrLabel')} />
          ) : (
            <span className="settings-spinner" role="status" aria-label={t('web.loading')} />
          )}
        </div>
      )}
      <div className="totp-pairing-instructions">
        <p className="account-security-hint">
          {t(qrFailed ? 'accountSecurity.manualFallback' : 'accountSecurity.scanHint')}
        </p>
        <details className="totp-manual" open={qrFailed || undefined}>
          <summary>
            <AccountIcon name="chevron" />
            {t('accountSecurity.manualKey')}
          </summary>
          <div className="totp-key">
            <Input
              label={t('web.authenticatorKey')}
              value={new URL(uri).searchParams.get('secret') ?? ''}
              readOnly
              autoComplete="off"
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
            />
            <CopySecret
              value={new URL(uri).searchParams.get('secret') ?? ''}
              label={t('accountSecurity.copyKey')}
              onError={setCopyError}
            />
          </div>
        </details>
        {Boolean(copyError) && <ErrorNotice error={copyError} />}
      </div>
    </div>
  );
}

function CopySecret({
  value,
  label,
  onError,
}: {
  value: string;
  label: string;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="totp-copy">
      <Tooltip content={copied ? t('web.copied') : label}>
        <button
          type="button"
          className="account-security-icon"
          aria-label={label}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              onError(undefined);
            } catch {
              setCopied(false);
              onError(new ApiError('clipboard_unavailable', 'accountSecurity.copyFailed'));
            }
          }}
        >
          <AccountIcon name={copied ? 'check' : 'copy'} />
        </button>
      </Tooltip>
      <span className="visually-hidden" role="status">
        {copied ? t('web.copied') : ''}
      </span>
    </div>
  );
}

function RecoveryCodes({
  codes,
  done,
  pending,
}: {
  codes: string[];
  done: () => void;
  pending: boolean;
}) {
  const t = useT();
  const [error, setError] = useState<unknown>();
  return (
    <>
      <div className="totp-recovery-intro">
        <div>
          <h3 tabIndex={-1} data-totp-focus>
            {t('accountSecurity.saveCodes')}
          </h3>
          <p className="account-security-hint">{t('accountSecurity.saveCodesHint')}</p>
        </div>
        <div className="totp-recovery-actions">
          <CopySecret
            value={codes.join('\n')}
            label={t('accountSecurity.copyCodes')}
            onError={setError}
          />
          <Tooltip content={t('accountSecurity.downloadCodes')}>
            <button
              type="button"
              className="account-security-icon"
              aria-label={t('accountSecurity.downloadCodes')}
              onClick={() => {
                let url: string | undefined;
                try {
                  url = URL.createObjectURL(
                    new Blob([`${codes.join('\n')}\n`], { type: 'text/plain;charset=utf-8' }),
                  );
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = 'nickhosting-recovery-codes.txt';
                  link.click();
                  setError(undefined);
                } catch (cause) {
                  setError(cause);
                } finally {
                  if (url) {
                    const blobUrl = url;
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
                  }
                }
              }}
            >
              <AccountIcon name="download" />
            </button>
          </Tooltip>
        </div>
      </div>
      <ul className="totp-codes" aria-label={t('web.recoveryCodes')}>
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      {Boolean(error) && <ErrorNotice error={error} />}
      <div className="totp-footer">
        <button type="button" disabled={pending} onClick={done}>
          {t('accountSecurity.done')}
        </button>
      </div>
    </>
  );
}

export function TwoFactorSettings({
  hasPassword,
  unavailable,
}: {
  hasPassword: boolean;
  unavailable: boolean;
}) {
  const t = useT();
  const session = useSession();
  const profile = session.data?.subject;
  const setup = useOutletContext<ReturnType<typeof useSecuritySetup>>();
  const { step, setStep, codes, setCodes, totpURI, setTotpURI, pending, error, setError, run } =
    setup;
  const enabled =
    setup.confirmedEnabled && session.dataUpdatedAt <= setup.confirmedEnabled.at
      ? setup.confirmedEnabled.value
      : profile?.twoFactorEnabled;
  const [code, setCode] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const lastStep = useRef<TwoFactorStep | undefined>(undefined);
  useEffect(() => {
    if (pending) return;
    if (error) errorRef.current?.focus();
    else if (step !== lastStep.current || (step && document.activeElement === document.body))
      root.current
        ?.querySelector<HTMLElement>(
          step ? '[data-totp-focus]' : '.account-security-heading button',
        )
        ?.focus();
    lastStep.current = step;
  }, [step, pending, error]);
  function show(next: TwoFactorStep | undefined) {
    if (pending) return;
    setError(undefined);
    setCode('');
    setStep(next);
  }
  const stepIndex = step === 'confirm' ? 0 : step === 'authenticator' ? 1 : 2;
  const isSetup = step === 'confirm' || step === 'authenticator' || step === 'recovery';
  return (
    <div ref={root}>
      <SecuritySection
        title={t('web.twoFactor')}
        icon="shield"
        status={
          <span className={`account-security-state${enabled ? ' enabled' : ''}`}>
            {t(enabled ? 'web.enabled' : 'web.disabled')}
          </span>
        }
        actions={
          !step &&
          (totpURI ? (
            <button
              type="button"
              className="account-security-action"
              disabled={unavailable || pending}
              onClick={() => show('authenticator')}
            >
              {t('accountSecurity.resumeSetup')}
            </button>
          ) : enabled ? (
            <>
              <button
                type="button"
                className="account-security-action"
                disabled={unavailable || pending}
                onClick={() => show('codes')}
              >
                {t('web.recoveryCodes')}
              </button>
              <Tooltip content={t('accountSecurity.disableTotp')}>
                <button
                  type="button"
                  className="account-security-icon account-security-destructive"
                  aria-label={t('accountSecurity.disableTotp')}
                  disabled={unavailable || pending}
                  onClick={() => show('disable')}
                >
                  <AccountIcon name="remove" />
                </button>
              </Tooltip>
            </>
          ) : (
            <button
              type="button"
              className="account-security-action"
              disabled={unavailable || pending}
              onClick={() => show('confirm')}
            >
              {t('web.enable')}
            </button>
          ))
        }
      >
        {step && (
          <div className="totp-workflow" aria-busy={pending}>
            {isSetup && (
              <ol className="totp-steps" aria-label={t('accountSecurity.setupProgress')}>
                {(
                  [
                    'accountSecurity.confirmStep',
                    'accountSecurity.authenticatorStep',
                    'web.recoveryCodes',
                  ] as const
                ).map((label, index) => (
                  <li
                    key={label}
                    aria-current={index === stepIndex ? 'step' : undefined}
                    className={index < stepIndex ? 'complete' : ''}
                  >
                    <span aria-hidden="true">
                      {index < stepIndex ? <AccountIcon name="check" /> : index + 1}
                    </span>
                    {t(label)}
                  </li>
                ))}
              </ol>
            )}
            {Boolean(error) && (
              <div ref={errorRef} tabIndex={-1}>
                <ErrorNotice error={error} />
              </div>
            )}
            {step === 'recovery' ? (
              <RecoveryCodes
                codes={codes}
                pending={pending}
                done={() => {
                  if (!pending) {
                    setCodes([]);
                    show(undefined);
                  }
                }}
              />
            ) : (
              <form
                className="totp-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (unavailable || pending) return;
                  const form = event.currentTarget;
                  const passwordBody = hasPassword
                    ? { password: String(new FormData(form).get('password')) }
                    : {};
                  void run(async () => {
                    if (step === 'confirm') {
                      const result = await api<{ totpURI: string; backupCodes: string[] }>(
                        '/api/auth/two-factor/enable',
                        { body: passwordBody },
                      );
                      form.reset();
                      setTotpURI(result.totpURI);
                      setCodes(result.backupCodes);
                      setStep('authenticator');
                    } else if (step === 'authenticator') {
                      await api('/api/auth/two-factor/verify-totp', { body: { code } });
                      // Verification rotates the cookie; ignore its stale user/session response.
                      setup.setConfirmedEnabled({ value: true, at: Date.now() });
                      setTotpURI(undefined);
                      setCode('');
                      setStep('recovery');
                      await refreshAccount();
                    } else if (step === 'disable') {
                      await api('/api/auth/two-factor/disable', { body: passwordBody });
                      setup.setConfirmedEnabled({ value: false, at: Date.now() });
                      setTotpURI(undefined);
                      setCodes([]);
                      setStep(undefined);
                      await refreshAccount();
                    } else if (step === 'codes') {
                      const result = await api<{ backupCodes: string[] }>(
                        '/api/auth/two-factor/generate-backup-codes',
                        { body: passwordBody },
                      );
                      form.reset();
                      setCodes(result.backupCodes);
                      setStep('recovery');
                    }
                  });
                }}
              >
                <fieldset disabled={pending || unavailable}>
                  {step === 'authenticator' && totpURI ? (
                    <>
                      <h3>{t('accountSecurity.connectAuthenticator')}</h3>
                      <SetupKey uri={totpURI} />
                      <div className="totp-code-row">
                        <Input
                          label={t('web.code')}
                          name="code"
                          value={code}
                          onChange={(event) =>
                            setCode(event.currentTarget.value.replace(/\D/g, '').slice(0, 6))
                          }
                          type="text"
                          autoComplete="one-time-code"
                          inputMode="numeric"
                          pattern="[0-9]{6}"
                          minLength={6}
                          maxLength={12}
                          spellCheck={false}
                          required
                          data-totp-focus
                        />
                        <p className="account-security-hint">{t('accountSecurity.codeHint')}</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <h3>
                        {t(
                          step === 'confirm'
                            ? 'accountSecurity.confirmSetup'
                            : step === 'disable'
                              ? 'accountSecurity.disableTotp'
                              : 'web.newRecoveryCodes',
                        )}
                      </h3>
                      <p className="account-security-hint">
                        {t(
                          step === 'confirm'
                            ? 'accountSecurity.confirmHint'
                            : step === 'disable'
                              ? 'accountSecurity.disableTotpHint'
                              : 'accountSecurity.replaceCodesHint',
                        )}
                      </p>
                      {hasPassword && (
                        <Input
                          label={t('web.currentPassword')}
                          name="password"
                          type="password"
                          autoComplete="current-password"
                          required
                          data-totp-focus
                        />
                      )}
                    </>
                  )}
                  <div className="totp-footer">
                    <button
                      type="button"
                      className="account-security-action"
                      onClick={() => show(undefined)}
                    >
                      {t(step === 'authenticator' ? 'accountSecurity.setupLater' : 'web.cancel')}
                    </button>
                    <button
                      type="submit"
                      className={step === 'disable' ? 'danger' : undefined}
                      data-totp-focus={!hasPassword && step !== 'authenticator' ? true : undefined}
                    >
                      {pending && <span className="settings-spinner" aria-hidden="true" />}
                      {t(
                        step === 'confirm'
                          ? 'accountSecurity.continue'
                          : step === 'authenticator'
                            ? 'accountSecurity.verifyEnable'
                            : step === 'disable'
                              ? 'web.disable'
                              : 'web.newRecoveryCodes',
                      )}
                    </button>
                  </div>
                </fieldset>
              </form>
            )}
            <span className="visually-hidden" role="status">
              {pending ? t('web.pending') : ''}
            </span>
          </div>
        )}
      </SecuritySection>
    </div>
  );
}
