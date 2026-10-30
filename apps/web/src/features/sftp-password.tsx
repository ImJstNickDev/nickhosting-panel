import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import { ErrorNotice } from '../components/ui.js';
import { type IssuedCredential, serverPath } from './service-contracts.js';

/** Explicit requests only: secrets never enter the query cache or browser storage. */
export function useSftpPassword(serverId: string) {
  const request = useRef<AbortController | undefined>(undefined);
  const [pending, setPending] = useState(false);
  useEffect(() => () => request.current?.abort(), []);
  const cancel = useCallback(() => {
    request.current?.abort();
    setPending(false);
  }, []);
  const load = async (credentialId: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    try {
      const credential = await api<IssuedCredential & { password: string }>(
        `${serverPath(serverId)}/sftp/${encodeURIComponent(credentialId)}/password`,
        { body: {}, signal: controller.signal },
      );
      if (!controller.signal.aborted) return { credential, signal: controller.signal };
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return { load, cancel, pending };
}

export function SftpPassword({
  serverId,
  credentialId,
  disabled,
}: {
  serverId: string;
  credentialId: string;
  disabled: boolean;
}) {
  const t = useT();
  const { load, cancel, pending } = useSftpPassword(serverId);
  const [shown, setShown] = useState(false),
    [password, setPassword] = useState<string>(),
    [copied, setCopied] = useState(false),
    [copyFailed, setCopyFailed] = useState(false),
    [error, setError] = useState<unknown>();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function retrieve(copy: boolean) {
    setError(undefined);
    setCopyFailed(false);
    setCopied(false);
    if (!copy) setShown(true);
    try {
      const result = await load(credentialId);
      if (!result) return;
      if (!copy) setPassword(result.credential.password);
      else {
        if (shown) setPassword(result.credential.password);
        try {
          await navigator.clipboard.writeText(result.credential.password);
          if (!result.signal.aborted) setCopied(true);
        } catch {
          if (!result.signal.aborted) {
            setPassword(result.credential.password);
            setShown(true);
            setCopyFailed(true);
          }
        }
      }
    } catch (failure) {
      setShown(false);
      setPassword(undefined);
      setError(failure);
    }
  }
  return (
    <div className="sftp-recoverable">
      <div className="sftp-value">
        {shown && password ? (
          <input
            aria-label={t('web.password')}
            onClick={(event) => event.currentTarget.select()}
            onFocus={(event) => event.currentTarget.select()}
            value={password}
            readOnly
            type="text"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
          />
        ) : (
          <span>
            <span aria-hidden="true">••••••••••••••••</span>
            <span className="visually-hidden">
              {t(pending ? 'web.loading' : 'sftp.passwordGenerated')}
            </span>
          </span>
        )}
        <Tooltip content={t(shown ? 'sftp.hidePassword' : 'sftp.showPassword')}>
          <button
            type="button"
            className="sftp-icon"
            aria-label={t(shown ? 'sftp.hidePassword' : 'sftp.showPassword')}
            aria-pressed={shown}
            disabled={disabled && !shown}
            onClick={() => {
              if (shown) {
                cancel();
                setShown(false);
                setPassword(undefined);
                setError(undefined);
                setCopyFailed(false);
              } else void retrieve(false);
            }}
          >
            <svg
              width="19"
              height="19"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6" />
              {shown && <path d="m3 3 18 18" />}
            </svg>
          </button>
        </Tooltip>
        <Tooltip content={t(copied ? 'web.copied' : 'sftp.copyPassword')}>
          <button
            type="button"
            className="sftp-icon"
            aria-label={t(copied ? 'web.copied' : 'sftp.copyPassword')}
            disabled={disabled || pending}
            onClick={() => void retrieve(true)}
          >
            <svg
              width="19"
              height="19"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <path d="M9 8h11v13H9z M5 16H3V3h11v2" />
            </svg>
          </button>
        </Tooltip>
      </div>
      <span className="visually-hidden" role="status">
        {copied ? t('web.copied') : ''}
      </span>
      {copyFailed && (
        <p className="sftp-copy-error" role="alert">
          {t('sftp.copyFailed')}
        </p>
      )}
      {error !== undefined && <ErrorNotice error={error} />}
    </div>
  );
}
