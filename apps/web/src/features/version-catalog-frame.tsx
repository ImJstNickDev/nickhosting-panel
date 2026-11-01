import type { ReactNode } from 'react';

/** Shared visual structure; each catalog retains its own data and mutation contract. */
export function VersionCatalogFrame({
  navigation,
  actions,
  filters,
  children,
  footer,
  status,
}: {
  navigation: ReactNode;
  actions?: ReactNode;
  filters: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  status?: ReactNode;
}) {
  return (
    <div className="version-catalog-frame">
      <header className="version-catalog-header">
        <div className="version-catalog-navigation">{navigation}</div>
        {actions && <div className="version-catalog-actions">{actions}</div>}
      </header>
      <div className="version-catalog-filters">{filters}</div>
      <div className="version-catalog-body">{children}</div>
      {footer && <div className="version-catalog-footer">{footer}</div>}
      {status && <div className="version-catalog-status">{status}</div>}
    </div>
  );
}
