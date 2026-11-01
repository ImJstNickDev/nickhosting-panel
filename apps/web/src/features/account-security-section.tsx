import { type ReactNode, useEffect, useId, useRef } from 'react';
import { AccountIcon as SecurityIcon } from './account-icons.js';

export function SecuritySection({
  title,
  icon,
  status,
  actions,
  children,
}: {
  title: string;
  icon: Parameters<typeof SecurityIcon>[0]['name'];
  status?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="account-security-section" aria-labelledby={id}>
      <div className="account-security-heading">
        <span className="account-security-symbol">
          <SecurityIcon name={icon} />
        </span>
        <div className="account-security-heading-text">
          <h2 id={id}>{title}</h2>
          {status}
        </div>
        {actions && <div className="account-security-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function SecurityDrawer({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input:not([readonly])')?.focus();
  }, []);
  return (
    <div ref={ref} className="account-security-drawer">
      {children}
    </div>
  );
}
