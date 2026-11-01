import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { quillDiagramSourceAllowed } from './ui-model.js';

let queue: Promise<unknown> = Promise.resolve();
/** Mermaid's DOM measurement is serialized; no generated SVG is inserted into the application. */
function renderDiagram(id: string, source: string, signal: AbortSignal) {
  const task = queue
    .catch(() => {})
    .then(async () => {
      signal.throwIfAborted();
      if (!quillDiagramSourceAllowed(source))
        throw new Error('Diagram configuration or external assets are not allowed');
      const { default: mermaid } = await import('mermaid');
      signal.throwIfAborted();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
        htmlLabels: false,
        maxTextSize: 32_768,
        maxEdges: 200,
        flowchart: { htmlLabels: false },
        suppressErrorRendering: true,
        secure: [
          'securityLevel',
          'startOnLoad',
          'maxTextSize',
          'maxEdges',
          'flowchart',
          'htmlLabels',
          'suppressErrorRendering',
        ],
      });
      const { svg } = await mermaid.render(id, source);
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (parsed.querySelector('parsererror')) throw new Error('Invalid diagram');
      // An image document is inert, and external references are stripped as well.
      for (const element of parsed.querySelectorAll(
        'script,foreignObject,image,iframe,object,embed,a',
      ))
        element.remove();
      for (const element of parsed.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
          if (
            /^on/i.test(attribute.name) ||
            ((attribute.localName === 'href' || attribute.localName === 'src') &&
              !attribute.value.startsWith('#'))
          )
            element.removeAttributeNode(attribute);
        }
      }
      return new XMLSerializer().serializeToString(parsed.documentElement);
    });
  queue = task;
  return task;
}
export function QuillDiagram({ source }: { source: string }) {
  const t = useT();
  const id = useId().replace(/[^a-z0-9]/gi, '');
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const controller = new AbortController();
    let blobUrl: string | undefined;
    setUrl(undefined);
    setFailed(false);
    void renderDiagram(`quill-diagram-${id}`, source, controller.signal).then(
      (svg) => {
        if (cancelled) return;
        blobUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        setUrl(blobUrl);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [visible, source, id]);
  return (
    <div ref={ref} className="quill-diagram">
      {url ? (
        <img src={url} alt={t('quill.diagram')} />
      ) : failed ? (
        <p role="status">{t('quill.diagramError')}</p>
      ) : (
        <div className="quill-diagram-skeleton" aria-hidden="true" />
      )}
      <details>
        <summary>{t('quill.source')}</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </div>
  );
}
