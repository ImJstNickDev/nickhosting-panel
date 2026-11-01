import { useT } from '../../app/i18n.js';
export function ViewerLoading() {
  const t = useT();
  return (
    <div className="ve-loading" aria-busy="true">
      <div className="fm-skeleton" aria-hidden="true" />
      <span className="sr-only" role="status">
        {t('viewer.loading')}
      </span>
    </div>
  );
}
