import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, apiError } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';

export function Page({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <header className="page-heading">
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        {actions && <div className="actions">{actions}</div>}
      </header>
      {children}
    </>
  );
}
export function Section({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="section">
      {title && (
        <header className="section-heading">
          <h2>{title}</h2>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}
export function Loading() {
  const t = useT();
  return (
    <p role="status" className="muted">
      {t('web.loading')}
    </p>
  );
}
export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  const t = useT();
  const normalized = error instanceof ApiError ? error : apiError(error);
  return (
    <div className="notice error" role="alert">
      <p>{t(normalized.messageKey)}</p>
      {normalized.requestId && (
        <small>{t('web.errorReference', { id: normalized.requestId })}</small>
      )}
      {retry && (
        <button type="button" className="secondary" onClick={retry}>
          {t('web.retry')}
        </button>
      )}
    </div>
  );
}
export function Empty({ text, children }: { text?: string; children?: ReactNode }) {
  const t = useT();
  return (
    <div className="empty">
      <p>{text ?? t('web.empty')}</p>
      {children}
    </div>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice" role="status">
      {children}
    </div>
  );
}
export function Badge({ value, label }: { value: string; label?: string }) {
  const t = useT();
  return (
    <span
      className={`badge ${['failed', 'blocked', 'uncertain', 'offline', 'running', 'ready', 'succeeded'].includes(value) ? value : ''}`}
    >
      {label ?? t(`web.${value}`)}
    </span>
  );
}
export function Field({
  label,
  children,
  hint,
  error,
  id,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string;
  id: string;
}) {
  return (
    <div className={`field${error ? ' invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {children}
      {Boolean(error) && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
export function Input({
  label,
  hint,
  ...props
}: React.ComponentPropsWithRef<'input'> & { label: string; hint?: string }) {
  const generated = useId();
  const id = props.id ?? generated;
  return (
    <Field label={label} id={id} hint={hint}>
      <input
        {...props}
        id={id}
        aria-describedby={
          [props['aria-describedby'], hint ? `${id}-hint` : undefined].filter(Boolean).join(' ') ||
          undefined
        }
      />
    </Field>
  );
}
export function Select({
  label,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const generated = useId();
  const id = props.id ?? generated;
  return (
    <Field label={label} id={id}>
      <select {...props} id={id}>
        {children}
      </select>
    </Field>
  );
}
export function Check({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const generated = useId();
  const id = props.id ?? generated;
  return (
    <label className="check" htmlFor={id}>
      <input {...props} type="checkbox" id={id} />
      <span>{label}</span>
    </label>
  );
}
export function Textarea({
  label,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  const generated = useId();
  const id = props.id ?? generated;
  return (
    <Field label={label} id={id}>
      <textarea {...props} id={id} />
    </Field>
  );
}
export function ActionForm({
  onSubmit,
  children,
  submitLabel,
  success,
  className,
}: {
  onSubmit: (data: FormData) => Promise<unknown>;
  children: ReactNode;
  submitLabel?: string;
  success?: string | false;
  className?: string;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [done, setDone] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setDone(false);
    const data = new FormData(event.currentTarget);
    try {
      await onSubmit(data);
      setDone(true);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className={className ?? 'form'}
      onSubmit={submit}
      aria-busy={busy}
      onChange={() => setDone(false)}
    >
      {Boolean(error) && (
        <div ref={errorRef} tabIndex={-1}>
          <ErrorNotice error={error} />
        </div>
      )}
      <fieldset disabled={busy}>{children}</fieldset>
      <div className="form-footer">
        <button type="submit" disabled={busy}>
          {busy ? t('web.pending') : (submitLabel ?? t('web.save'))}
        </button>
        {done && success !== false && <span role="status">{success ?? t('web.saved')}</span>}
      </div>
    </form>
  );
}
export function Dialog({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const t = useT();
  useEffect(() => {
    const element = ref.current;
    if (open && element && !element.open) element.showModal();
    else if (!open && element?.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <header className="section-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="secondary" onClick={onClose}>
          {t('web.close')}
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function JobNotice({ jobId }: { jobId?: string }) {
  const t = useT();
  return jobId ? (
    <Notice>
      <span>{t('web.accepted')} </span>
      <Link to={`/activity/${jobId}`}>{t('web.viewActivity')}</Link>
    </Notice>
  ) : null;
}
export function Time({ value }: { value?: string | null }) {
  const t = useT();
  const format = useFormat();
  return value ? (
    <time dateTime={value} title={format.date(value)}>
      {format.date(value)}
    </time>
  ) : (
    <span>{t('web.unknown')}</span>
  );
}
export function Details({ values }: { values: Array<[string, ReactNode]> }) {
  return (
    <dl className="details">
      {values.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function text(data: FormData, key: string) {
  return String(data.get(key) ?? '').trim();
}
export function number(data: FormData, key: string) {
  return Number(data.get(key));
}
