import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { AnnotationMode } from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { pdfWebLink } from './pdf-model.js';

type Outline = NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>;
export function PdfOutline({
  document,
  navigate,
}: {
  document: PDFDocumentProxy;
  navigate(destination: string | unknown[]): void;
}) {
  const t = useT();
  const [items, setItems] = useState<Outline>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void document.getOutline().then(
      (outline) => {
        if (active) setItems(outline ?? []);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [document]);
  if (failed) return <p className="folio-sidebar-note">{t('pdf.outlineUnavailable')}</p>;
  if (!items)
    return <div className="folio-side-skeleton" role="status" aria-label={t('viewer.loading')} />;
  if (!items.length) return <p className="folio-sidebar-note">{t('pdf.noOutline')}</p>;
  return (
    <nav aria-label={t('pdf.outline')}>
      <OutlineItems items={items} navigate={navigate} />
    </nav>
  );
}
function OutlineItems({
  items,
  navigate,
  depth = 0,
}: {
  items: Outline;
  navigate(destination: string | unknown[]): void;
  depth?: number;
}) {
  return (
    <ul className="folio-outline">
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: PDF outlines are immutable for this document instance.
        <OutlineItem key={`${index}:${item.title}`} item={item} navigate={navigate} depth={depth} />
      ))}
    </ul>
  );
}
function OutlineItem({
  item,
  navigate,
  depth,
}: {
  item: Outline[number];
  navigate(destination: string | unknown[]): void;
  depth: number;
}) {
  const [open, setOpen] = useState(false);
  const url = item.url && pdfWebLink(item.url);
  const children = item.items?.length > 0 && depth < 32;
  const label = item.title || '—';
  return (
    <li>
      <div className="folio-outline-row">
        {children && (
          <button
            type="button"
            className="folio-outline-toggle"
            aria-label={label}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? '⌄' : '›'}
          </button>
        )}
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        ) : (
          <button
            type="button"
            disabled={!item.dest}
            onClick={() => {
              if (item.dest) navigate(item.dest);
            }}
          >
            {label}
          </button>
        )}
      </div>
      {children && open && (
        <OutlineItems items={item.items} navigate={navigate} depth={depth + 1} />
      )}
    </li>
  );
}

const ROW = 172;
export function PdfThumbnails({
  document,
  page,
  rotation,
  navigate,
}: {
  document: PDFDocumentProxy;
  page: number;
  rotation: number;
  navigate(page: number): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 700 });
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const resize = new ResizeObserver(() =>
      setViewport({ top: element.scrollTop, height: element.clientHeight }),
    );
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const top = (page - 1) * ROW;
    if (top < element.scrollTop || top + ROW > element.scrollTop + element.clientHeight)
      element.scrollTop = top;
    setViewport({ top: element.scrollTop, height: element.clientHeight });
  }, [page]);
  const first = Math.max(0, Math.floor(viewport.top / ROW) - 2);
  const end = Math.min(document.numPages, Math.ceil((viewport.top + viewport.height) / ROW) + 2);
  return (
    <div
      className="folio-thumbnails"
      ref={root}
      onScroll={(event) =>
        setViewport({
          top: event.currentTarget.scrollTop,
          height: event.currentTarget.clientHeight,
        })
      }
    >
      <div style={{ height: first * ROW }} />
      {Array.from({ length: end - first }, (_, index) => first + index + 1).map((number) => (
        <Thumbnail
          key={number}
          document={document}
          page={number}
          rotation={rotation}
          selected={page === number}
          navigate={navigate}
        />
      ))}
      <div style={{ height: (document.numPages - end) * ROW }} />
    </div>
  );
}
function Thumbnail({
  document,
  page,
  rotation,
  selected,
  navigate,
}: {
  document: PDFDocumentProxy;
  page: number;
  rotation: number;
  selected: boolean;
  navigate(page: number): void;
}) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    let task: RenderTask | undefined;
    const target = canvas.current;
    if (!target) return;
    setReady(false);
    void document
      .getPage(page)
      .then(async (pdfPage) => {
        if (!active) return;
        const natural = pdfPage.getViewport({
          scale: 1,
          rotation: (pdfPage.rotate + rotation) % 360,
        });
        const viewport = pdfPage.getViewport({
          scale: Math.min(120 / natural.width, 135 / natural.height),
          rotation: (pdfPage.rotate + rotation) % 360,
        });
        target.width = Math.ceil(viewport.width);
        target.height = Math.ceil(viewport.height);
        task = pdfPage.render({ canvas: target, viewport, annotationMode: AnnotationMode.ENABLE });
        await task.promise;
        if (active) setReady(true);
      })
      .catch(() => {}); // Thumbnail failure never hides the authoritative document page.
    return () => {
      active = false;
      task?.cancel();
      target.width = 0;
      target.height = 0;
    };
  }, [document, page, rotation]);
  return (
    <button
      type="button"
      className="folio-thumbnail"
      aria-label={t('pdf.goPage', { page })}
      aria-current={selected ? 'page' : undefined}
      onClick={() => navigate(page)}
    >
      <span className="folio-thumbnail-image" data-ready={ready}>
        <canvas ref={canvas} />
      </span>
      <span>{page}</span>
    </button>
  );
}
