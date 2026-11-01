import { useEffect } from 'react';
import { Link } from 'react-router';
import { useT } from '../app/i18n.js';
import { ErrorNotice } from '../components/ui.js';
import { discardFileSave, type FileSaveScope, useFileSaveRecords } from './file-background-save.js';
import './file-save-notices.css';

/** Visible across routes; these are browser-memory drafts, never a durable-save guarantee. */
export function FileSaveNotices({ scope }: { scope: FileSaveScope | undefined }) {
  const t = useT();
  const records = useFileSaveRecords(scope);
  const hasUnsaved = records.length > 0;
  useEffect(() => {
    if (!hasUnsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsaved]);
  if (!hasUnsaved) return null;
  return (
    <div className="file-save-notices">
      {records.map((record) => (
        <div className="file-save-notice" key={record.id}>
          <div className="file-save-summary" role="status">
            <Link
              to={`/servers/${encodeURIComponent(record.serverId)}/files`}
              state={{ fileSaveId: record.id }}
            >
              {t(record.status === 'pending' ? 'file.savePendingName' : 'file.saveFailedName', {
                name: record.path,
              })}
            </Link>
            {record.status === 'error' && (
              <button
                type="button"
                className="secondary"
                onClick={() => discardFileSave(scope, record.serverId, record.path)}
              >
                {t('file.discardSave')}
              </button>
            )}
          </div>
          {record.status === 'error' && <ErrorNotice error={record.error} />}
        </div>
      ))}
    </div>
  );
}
