import { useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { ErrorNotice } from '../../../components/ui.js';
import { readViewerBytes, viewerPath } from '../core/access.js';
import { previewLimits } from '../core/limits.js';
import type { ViewerId } from '../core/registry.js';
import type { ViewerProps } from '../core/types.js';
import { useViewerResource } from '../core/use-resource.js';
import { DocumentEditor } from '../document-editor.js';
import { ViewerLoading } from '../loading.js';

/** Archive text entries are read-only; regular text stays in the existing revision-aware editor. */
export default function TextViewer({
  serverId,
  source,
  chrome,
  initialView = 'text',
  onViewChange,
  identity,
  onOpen,
}: ViewerProps & { initialView?: ViewerId; onViewChange?: (view: ViewerId) => void }) {
  const [view, setView] = useState<ViewerId>(initialView);
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
      <DocumentEditor
        selectedView={onViewChange ? initialView : view}
        onViewChange={onViewChange ?? setView}
        actionTarget={chrome?.tools}
        initialFragment={source.fragment}
        resourceContext={{
          serverId,
          source,
          identity,
          onOpen: (next, fragment) => onOpen({ ...next, fragment }),
        }}
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
