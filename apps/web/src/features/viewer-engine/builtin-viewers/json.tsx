import { useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { ErrorNotice } from '../../../components/ui.js';
import { readViewerBytes, viewerPath } from '../core/access.js';
import { previewLimits } from '../core/limits.js';
import { viewerExtension } from '../core/registry.js';
import type { ViewerProps } from '../core/types.js';
import { useViewerResource } from '../core/use-resource.js';
import { ViewerLoading } from '../loading.js';
import type { JsonTreeNode } from './json-model.js';

function parseInWorker(
  text: string,
  extension: string,
  signal: AbortSignal,
): Promise<JsonTreeNode> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const worker = new Worker(new URL('./json-worker.ts', import.meta.url), { type: 'module' });
    const timeout = window.setTimeout(() => {
      finish();
      reject({ messageKey: 'viewer.jsonComplex' });
    }, previewLimits.jsonParseMs);
    function finish() {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      worker.terminate();
    }
    function cancel() {
      finish();
      reject(signal.reason);
    }
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent<{ tree?: JsonTreeNode; error?: string }>) => {
      finish();
      if (event.data.tree) resolve(event.data.tree);
      else reject({ messageKey: event.data.error ?? 'viewer.jsonInvalid' });
    };
    worker.onerror = () => {
      finish();
      reject({ messageKey: 'viewer.jsonInvalid' });
    };
    worker.postMessage({ text, extension });
  });
}
function JsonNode({ node, root = false }: { node: JsonTreeNode; root?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(root);
  const [limit, setLimit] = useState(100);
  const [full, setFull] = useState(false);
  if (!node.children)
    return (
      <li className="ve-json-value">
        <span>{node.key === undefined ? '' : `${node.key}: `}</span>
        <code>{full ? node.raw : node.raw.slice(0, 2000)}</code>
        {node.raw.length > 2000 && !full && (
          <button type="button" className="text-button" onClick={() => setFull(true)}>
            {t('viewer.more')}
          </button>
        )}
      </li>
    );
  return (
    <li>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          {node.key === undefined ? '' : `${node.key}: `}
          <code>{node.kind === 'Array' ? '[ ]' : '{ }'}</code> <small>{node.children.length}</small>
        </summary>
        {open && (
          <ul>
            {node.children.slice(0, limit).map((child) => (
              <JsonNode key={child.offset} node={child} />
            ))}
            {limit < node.children.length && (
              <li>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setLimit((value) => value + 100)}
                >
                  {t('viewer.more')}
                </button>
              </li>
            )}
          </ul>
        )}
      </details>
    </li>
  );
}
export default function JsonViewer({ serverId, source }: ViewerProps) {
  const url = viewerPath(serverId, source);
  const result = useViewerResource(url, async (signal) => {
    const bytes = await readViewerBytes(url, previewLimits.jsonBytes, signal);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return parseInWorker(text, viewerExtension(source.name), signal);
  });
  if (result.error) return <ErrorNotice error={result.error} />;
  if (!result.value) return <ViewerLoading />;
  return (
    <div className="ve-json">
      <ul>
        <JsonNode node={result.value} root />
      </ul>
    </div>
  );
}
