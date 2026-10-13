import { useT } from '../../../app/i18n.js';
import { ErrorNotice } from '../../../components/ui.js';
import { FileTextEditor } from '../../file-text-editor.js';
import { readViewerBytes, viewerPath } from '../core/access.js';
import { previewLimits } from '../core/limits.js';
import type { ViewerProps } from '../core/types.js';
import { useViewerResource } from '../core/use-resource.js';
import { ViewerLoading } from '../loading.js';

/** Archive text entries are read-only; regular text stays in the existing revision-aware editor. */
export default function TextViewer({ serverId, source }: ViewerProps) {
  const t = useT();
  const url = viewerPath(serverId, source);
  const result = useViewerResource(url, async (signal) => {
    const bytes = await readViewerBytes(url, previewLimits.textBytes, signal);
    if (bytes.includes(0)) throw { messageKey: 'file.editorUnavailable.binary' };
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  });
  if (result.error) return <ErrorNotice error={result.error} />;
  if (result.value === undefined) return <ViewerLoading />;
  return (
    <div className="ve-text">
      <FileTextEditor
        path={source.name}
        value={result.value}
        readOnly
        onChange={() => {}}
        onSave={() => {}}
        label={t('service.content')}
      />
    </div>
  );
}
