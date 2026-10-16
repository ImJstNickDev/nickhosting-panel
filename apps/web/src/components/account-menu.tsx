import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { identityChanged } from '../app/session.js';
import { ProfileAvatar } from './profile-avatar.js';
import { ErrorNotice } from './ui.js';
import './account-menu.css';

export function AccountMenu({
  name,
  avatarUrl,
  support,
  onExitSupport,
}: {
  name: string;
  avatarUrl?: string | null;
  support: boolean;
  onExitSupport: () => Promise<void>;
}) {
  const t = useT();
  const navigate = useNavigate();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
    function dismissOnFocus(event: FocusEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismissOnEscape);
    document.addEventListener('focusin', dismissOnFocus);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismissOnEscape);
      document.removeEventListener('focusin', dismissOnFocus);
    };
  }, [open]);

  async function signOut() {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      if (support) {
        await onExitSupport();
        return;
      }
      await api('/api/auth/sign-out', { body: {} });
      await identityChanged();
      navigate('/login');
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="account-menu" ref={root}>
      <button
        type="button"
        className="account-avatar"
        ref={trigger}
        aria-label={`${t('web.profile')}: ${name}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <ProfileAvatar avatarUrl={avatarUrl} />
      </button>
      {open && (
        <div className="account-dropdown" id={id}>
          <div className="account-dropdown-profile">
            <span className="account-profile-avatar">
              <ProfileAvatar avatarUrl={avatarUrl} />
            </span>
            <div className="account-dropdown-name">{name}</div>
          </div>
          {!support && (
            <Link
              className="account-dropdown-action"
              to="/settings"
              onClick={() => {
                trigger.current?.focus();
                setOpen(false);
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="m9 3-1 3-3 1v4l-2 1 2 1v4l3 1 1 3h6l1-3 3-1v-4l2-1-2-1V7l-3-1-1-3Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              {t('web.settings')}
            </Link>
          )}
          <button
            type="button"
            className="account-dropdown-action account-sign-out"
            disabled={pending}
            aria-busy={pending}
            onClick={() => void signOut()}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M10 4H4v16h6M9 12h12m-5-5 5 5-5 5" />
            </svg>
            {t(support ? 'web.exitSupport' : 'web.signOut')}
          </button>
          {Boolean(error) && <ErrorNotice error={error} />}
        </div>
      )}
    </div>
  );
}
