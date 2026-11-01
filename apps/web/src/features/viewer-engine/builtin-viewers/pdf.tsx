import {
  AnnotationEditorType,
  AnnotationMode,
  GlobalWorkerOptions,
  getDocument,
  PasswordResponses,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import upstreamStyles from 'pdfjs-dist/web/pdf_viewer.css?inline';
import type { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../api/client.js';
import { useLocale, useT } from '../../../app/i18n.js';
import { ErrorNotice } from '../../../components/ui.js';
import { viewerPath } from '../core/access.js';
import type { ViewerProps } from '../core/types.js';
import { useViewerFind } from '../core/use-find.js';
import { PdfButton, PdfIcon } from './pdf-controls.js';
import { createPdfLocalization } from './pdf-localization.js';
import { pdfLimits, pdfWebLink, readPdfPosition, savePdfPosition } from './pdf-model.js';
import { printPdf } from './pdf-print.js';
import { PdfOutline, PdfThumbnails } from './pdf-sidebar.js';
import './pdf.css';

GlobalWorkerOptions.workerSrc = workerUrl;
// The component stylesheet also includes stock PDF.js application selectors
// (.sidebar, button.hasPopupMenu) and root color-scheme variables. Keep all of
// them inside Folio and remove them on unmount; never publish them app-wide.
const scopedStyles = `@scope (.folio) {${upstreamStyles.replace(/:root\b/g, ':scope')}}`;
interface Engine {
  viewer: PDFViewer;
  links: PDFLinkService;
  bus: EventBus;
  document: PDFDocumentProxy;
}
export default function PdfViewer(props: ViewerProps) {
  return <Folio key={JSON.stringify([props.identity, props.serverId, props.source])} {...props} />;
}
function Folio({ source, serverId, identity }: ViewerProps) {
  const t = useT();
  const { locale } = useLocale();
  const root = useRef<HTMLElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const engine = useRef<Engine | undefined>(undefined);
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [pageDraft, setPageDraft] = useState('1');
  const [scale, setScale] = useState(1);
  const [scaleDraft, setScaleDraft] = useState<string>();
  const [rotation, setRotation] = useState(0);
  const [sidebar, setSidebar] = useState<'thumbnails' | 'outline'>();
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState({ current: 0, total: 0 });
  const [finding, setFinding] = useState(false);
  const [password, setPassword] = useState<{ update(value: string): void; incorrect: boolean }>();
  const [passwordDraft, setPasswordDraft] = useState('');
  useEffect(() => {
    if (password) passwordInput.current?.focus();
  }, [password]);
  const [printState, setPrintState] = useState<number>();
  const [printFailure, setPrintFailure] = useState(false);
  const printController = useRef<AbortController | undefined>(undefined);
  const releasePrint = useRef<(() => void) | undefined>(undefined);
  const translation = useRef(t);
  translation.current = t;
  const positionKey = JSON.stringify([
    identity,
    serverId,
    source.path,
    source.archives,
    source.entry,
  ]);
  const navigate = (target: number) => {
    const current = engine.current;
    if (!current) return;
    current.viewer.currentPageNumber = Math.max(
      1,
      Math.min(current.document.numPages, Math.trunc(target)),
    );
  };
  const openFind = () => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    });
  };
  useViewerFind(true, openFind);
  const find = (previous = false, again = false) =>
    engine.current?.bus.dispatch('find', {
      source: root.current,
      type: again ? 'again' : '',
      query,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(
      () =>
        engine.current?.bus.dispatch('find', {
          source: root.current,
          type: '',
          query,
          phraseSearch: true,
          caseSensitive: false,
          entireWord: false,
          highlightAll: true,
          findPrevious: false,
          matchDiacritics: false,
        }),
      150,
    );
    return () => clearTimeout(timer);
  }, [query, ready]);
  useEffect(() => {
    if (!findOpen) engine.current?.bus.dispatch('findbarclose', { source: root.current });
  }, [findOpen]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry must recreate the document transport.
  useEffect(() => {
    const scroll = container.current;
    const content = pages.current;
    if (!scroll || !content) return;
    const lifecycle = new AbortController();
    let localization: ReturnType<typeof createPdfLocalization> | undefined;
    let loading: PDFDocumentLoadingTask | undefined;
    let viewer: PDFViewer | undefined;
    let links: PDFLinkService | undefined;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      if (!viewer?.pdfDocument) return;
      savePdfPosition(positionKey, {
        page: viewer.currentPageNumber,
        scale: String(viewer.currentScaleValue),
        rotation: viewer.pagesRotation,
      });
    };
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 250);
    };
    setReady(false);
    setFailure(undefined);
    setDocument(undefined);
    setPassword(undefined);
    void (async () => {
      if (source.size > pdfLimits.sourceBytes) throw { messageKey: 'viewer.tooLarge' };
      const { EventBus, PDFLinkService, PDFViewer, PDFFindController, GenericL10n, LinkTarget } =
        await import('pdfjs-dist/web/pdf_viewer.mjs');
      lifecycle.signal.throwIfAborted();
      const bus = new EventBus();
      class PassiveLinks extends PDFLinkService {
        override addLinkAttributes(link: HTMLAnchorElement, raw: string) {
          const url = pdfWebLink(raw);
          if (url) {
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.setAttribute('aria-label', url);
          } else {
            link.removeAttribute('href');
            link.setAttribute('aria-disabled', 'true');
          }
        }
        // PDF attachments and named print/save/launch actions do not bypass Fileman.
        override executeNamedAction(action: string) {
          if (['NextPage', 'PrevPage', 'FirstPage', 'LastPage'].includes(action))
            super.executeNamedAction(action);
        }
        getAttachmentContent() {
          return Promise.resolve(null);
        }
      }
      links = new PassiveLinks({
        eventBus: bus,
        externalLinkTarget: LinkTarget.BLANK,
        ignoreDestinationZoom: true,
      });
      const finder = new PDFFindController({ eventBus: bus, linkService: links });
      localization = createPdfLocalization(GenericL10n, locale, (key, values) =>
        translation.current(key, values),
      );
      const options = {
        container: scroll,
        viewer: content,
        eventBus: bus,
        linkService: links,
        findController: finder,
        annotationMode: AnnotationMode.ENABLE,
        annotationEditorMode: AnnotationEditorType.DISABLE,
        enableAutoLinking: false,
        enablePermissions: true,
        enableSelectionRendering: false,
        maxCanvasPixels: pdfLimits.canvasPixels,
        maxCanvasDim: 8192,
        enableDetailCanvas: true,
        minDurationToUpdateCanvas: 120,
        imageResourcesPath: '/pdfjs/images/',
        abortSignal: lifecycle.signal,
        l10n: localization,
      };
      viewer = new PDFViewer(options);
      await localization.translate(scroll);
      links.setViewer(viewer);
      const eventOptions = { signal: lifecycle.signal };
      bus.on(
        'pagesinit',
        () => {
          if (!viewer) return;
          const position = readPdfPosition(positionKey);
          viewer.pagesRotation = position?.rotation ?? 0;
          viewer.currentScaleValue = position?.scale ?? 'page-width';
          viewer.currentPageNumber = Math.min(position?.page ?? 1, viewer.pagesCount);
          setRotation(viewer.pagesRotation);
          setReady(true);
          scroll.focus({ preventScroll: true });
        },
        eventOptions,
      );
      bus.on(
        'pagechanging',
        ({ pageNumber }: { pageNumber: number }) => {
          setPage(pageNumber);
          setPageDraft(String(pageNumber));
          scheduleSave();
        },
        eventOptions,
      );
      bus.on(
        'scalechanging',
        ({ scale: next }: { scale: number }) => {
          setScale(next);
          scheduleSave();
        },
        eventOptions,
      );
      bus.on(
        'rotationchanging',
        ({ pagesRotation }: { pagesRotation: number }) => {
          setRotation(pagesRotation);
          scheduleSave();
        },
        eventOptions,
      );
      bus.on(
        'updatefindmatchescount',
        ({ matchesCount }: { matchesCount: { current: number; total: number } }) =>
          setMatches(matchesCount),
        eventOptions,
      );
      bus.on(
        'updatefindcontrolstate',
        ({
          state,
          matchesCount,
        }: {
          state: number;
          matchesCount: { current: number; total: number };
        }) => {
          setFinding(state === 3);
          if (matchesCount) setMatches(matchesCount);
        },
        eventOptions,
      );
      bus.on(
        'pagerendered',
        ({ error }: { error?: unknown }) => {
          if (error) setFailure('pdf.pageUnavailable');
        },
        eventOptions,
      );
      const metadata = await api<{ revision: string; size: number }>(
        `/v1/servers/${encodeURIComponent(serverId)}/files/viewer?path=${encodeURIComponent(source.path)}`,
        { signal: lifecycle.signal },
      );
      if (!source.entry && metadata.size > pdfLimits.sourceBytes)
        throw { messageKey: 'viewer.tooLarge' };
      if (!metadata.revision) throw { messageKey: 'pdf.unavailable' };
      lifecycle.signal.throwIfAborted();
      loading = getDocument({
        httpHeaders: { 'If-Match': `"${metadata.revision}"` },
        url: viewerPath(serverId, source),
        withCredentials: false,
        rangeChunkSize: 512 * 1024,
        disableAutoFetch: true,
        disableStream: true,
        enableXfa: false,
        canvasMaxAreaInBytes: 32 * 1024 * 1024,
        cMapUrl: '/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/pdfjs/standard_fonts/',
        wasmUrl: '/pdfjs/wasm/',
        iccUrl: '/pdfjs/iccs/',
      });
      loading.onPassword = (update: (value: string) => void, reason: number) => {
        if (!lifecycle.signal.aborted)
          setPassword({ update, incorrect: reason === PasswordResponses.INCORRECT_PASSWORD });
      };
      const pdf = await loading.promise;
      lifecycle.signal.throwIfAborted();
      if (pdf.numPages > pdfLimits.pages) throw { messageKey: 'viewer.tooLarge' };
      engine.current = { viewer, links, bus, document: pdf };
      setDocument(pdf);
      setPassword(undefined);
      links.setDocument(pdf);
      viewer.setDocument(pdf);
      void Promise.resolve(viewer.pagesPromise).catch(() => {
        if (!lifecycle.signal.aborted) setFailure('pdf.pageUnavailable');
      });
    })().catch((error: unknown) => {
      if (lifecycle.signal.aborted) return;
      const key =
        error && typeof error === 'object' && 'messageKey' in error
          ? String(error.messageKey)
          : 'pdf.unavailable';
      setFailure(key);
    });
    return () => {
      save();
      if (saveTimer) clearTimeout(saveTimer);
      lifecycle.abort();
      void localization?.destroy();
      printController.current?.abort();
      releasePrint.current?.();
      releasePrint.current = undefined;
      viewer?.setDocument(null);
      links?.setDocument(null);
      engine.current = undefined;
      void loading?.destroy().catch(() => {});
    };
  }, [attempt, positionKey, serverId, source, locale]);
  const zoom = (factor: number, origin?: [number, number]) => {
    const viewer = engine.current?.viewer;
    if (!viewer) return;
    const rect = container.current?.getBoundingClientRect();
    viewer.updateScale({
      scaleFactor: factor,
      drawingDelay: 120,
      origin: origin ?? (rect ? [rect.width / 2, rect.height / 2] : undefined),
    });
  };
  useEffect(() => {
    const scroll = container.current;
    if (!scroll) return;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !engine.current) return;
      event.preventDefault();
      const rect = scroll.getBoundingClientRect();
      engine.current.viewer.updateScale({
        scaleFactor: Math.exp(-event.deltaY * 0.005),
        drawingDelay: 120,
        origin: [event.clientX - rect.left, event.clientY - rect.top],
      });
    };
    scroll.addEventListener('wheel', wheel, { passive: false });
    return () => scroll.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    const scroll = container.current;
    if (!scroll) return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        // PDF.js writes this variable on documentElement; scoped defaults must
        // instead receive the measured height of this embedded viewport.
        root.current?.style.setProperty('--viewer-container-height', `${scroll.clientHeight}px`);
        const viewer = engine.current?.viewer;
        if (!viewer) return;
        const mode = viewer.currentScaleValue;
        if (mode === 'page-width' || mode === 'page-fit') viewer.currentScaleValue = mode;
        viewer.update();
      });
    });
    observer.observe(scroll);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);
  const print = async () => {
    if (!engine.current || printController.current || !engine.current.viewer.printingAllowed)
      return;
    releasePrint.current?.();
    releasePrint.current = undefined;
    const controller = new AbortController();
    printController.current = controller;
    setPrintState(0);
    setPrintFailure(false);
    try {
      releasePrint.current = await printPdf(
        engine.current.document,
        rotation,
        controller.signal,
        setPrintState,
      );
    } catch {
      if (!controller.signal.aborted) setPrintFailure(true);
    } finally {
      setPrintState(undefined);
      printController.current = undefined;
    }
  };
  const closeFind = () => {
    setFindOpen(false);
    container.current?.focus();
  };
  return (
    <section
      className="folio"
      ref={root}
      aria-label="Folio"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && findOpen) {
          event.stopPropagation();
          event.preventDefault();
          closeFind();
          return;
        }
        const input = (event.target as HTMLElement).closest(
          'input,textarea,[contenteditable="true"]',
        );
        if (input) return;
        if ((event.ctrlKey || event.metaKey) && ['+', '=', '-', '0', 'p'].includes(event.key)) {
          event.preventDefault();
          if (event.key === 'p') void print();
          else if (event.key === '0') {
            if (engine.current) engine.current.viewer.currentScaleValue = 'page-width';
          } else zoom(event.key === '-' ? 1 / 1.2 : 1.2);
        }
      }}
    >
      <style>{scopedStyles}</style>
      <div className="folio-toolbar" role="toolbar" aria-label={t('pdf.controls')}>
        <div className="folio-tools">
          <PdfButton
            label={t('pdf.thumbnails')}
            pressed={sidebar === 'thumbnails'}
            onClick={() => setSidebar(sidebar === 'thumbnails' ? undefined : 'thumbnails')}
            disabled={!ready}
          >
            <PdfIcon name="thumbnails" />
          </PdfButton>
          <PdfButton
            label={t('pdf.outline')}
            pressed={sidebar === 'outline'}
            onClick={() => setSidebar(sidebar === 'outline' ? undefined : 'outline')}
            disabled={!ready}
          >
            <PdfIcon name="outline" />
          </PdfButton>
        </div>
        <div className="folio-tools">
          <PdfButton
            label={t('pdf.previous')}
            onClick={() => navigate(page - 1)}
            disabled={!ready || page <= 1}
          >
            <PdfIcon name="previous" />
          </PdfButton>
          <input
            className="folio-page-number"
            inputMode="numeric"
            aria-label={t('pdf.pageNumber')}
            value={pageDraft}
            disabled={!ready}
            onChange={(event) => setPageDraft(event.target.value)}
            onFocus={(event) => event.target.select()}
            onBlur={() => setPageDraft(String(page))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                const number = Number(pageDraft);
                if (Number.isInteger(number) && number > 0) navigate(number);
                setPageDraft(String(engine.current?.viewer.currentPageNumber ?? page));
              }
            }}
          />
          <span className="folio-page-count">/ {document?.numPages ?? '—'}</span>
          <PdfButton
            label={t('pdf.next')}
            onClick={() => navigate(page + 1)}
            disabled={!ready || page >= (document?.numPages ?? 0)}
          >
            <PdfIcon name="next" />
          </PdfButton>
        </div>
        <div className="folio-tools folio-zoom-tools">
          <PdfButton
            label={t('pdf.zoomOut')}
            onClick={() => zoom(1 / 1.2)}
            disabled={!ready || scale <= 0.1}
          >
            <PdfIcon name="minus" />
          </PdfButton>
          <label className="folio-zoom-value">
            <input
              inputMode="decimal"
              aria-label={t('pdf.zoom')}
              value={scaleDraft ?? Math.round(scale * 100)}
              disabled={!ready}
              onChange={(event) => setScaleDraft(event.target.value)}
              onFocus={(event) => {
                setScaleDraft(String(Math.round(scale * 100)));
                event.target.select();
              }}
              onBlur={() => setScaleDraft(undefined)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  const value = Number(scaleDraft?.replace(',', '.'));
                  if (value >= 10 && value <= 2500 && engine.current)
                    engine.current.viewer.currentScale = value / 100;
                  setScaleDraft(undefined);
                  event.currentTarget.blur();
                }
              }}
            />
            <span>%</span>
          </label>
          <PdfButton
            label={t('pdf.zoomIn')}
            onClick={() => zoom(1.2)}
            disabled={!ready || scale >= 25}
          >
            <PdfIcon name="plus" />
          </PdfButton>
          <PdfButton
            label={t('pdf.fitWidth')}
            onClick={() => {
              if (engine.current) engine.current.viewer.currentScaleValue = 'page-width';
            }}
            disabled={!ready}
          >
            <PdfIcon name="width" />
          </PdfButton>
          <PdfButton
            label={t('pdf.fitPage')}
            onClick={() => {
              if (engine.current) engine.current.viewer.currentScaleValue = 'page-fit';
            }}
            disabled={!ready}
          >
            <PdfIcon name="fit" />
          </PdfButton>
          <PdfButton
            label={t('pdf.actual')}
            onClick={() => {
              if (engine.current) engine.current.viewer.currentScale = 1;
            }}
            disabled={!ready}
          >
            <PdfIcon name="actual" />
          </PdfButton>
        </div>
        <div className="folio-tools">
          <PdfButton
            label={t('pdf.rotate')}
            onClick={() => {
              if (engine.current) engine.current.viewer.pagesRotation = (rotation + 90) % 360;
            }}
            disabled={!ready}
          >
            <PdfIcon name="rotate" />
          </PdfButton>
          <PdfButton label={t('pdf.find')} onClick={openFind} pressed={findOpen} disabled={!ready}>
            <PdfIcon name="find" />
          </PdfButton>
          {!failure && (
            <PdfButton
              label={t('pdf.retry')}
              onClick={() => setAttempt(attempt + 1)}
              disabled={!ready}
            >
              <PdfIcon name="refresh" />
            </PdfButton>
          )}
          <PdfButton
            label={t('pdf.print')}
            onClick={() => void print()}
            disabled={
              !ready || printState !== undefined || engine.current?.viewer.printingAllowed === false
            }
          >
            <PdfIcon name="print" />
          </PdfButton>
        </div>
      </div>
      {findOpen && (
        <div className="folio-find">
          <input
            ref={searchInput}
            type="search"
            aria-label={t('pdf.find')}
            placeholder={t('pdf.find')}
            value={query}
            maxLength={500}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                find(event.shiftKey, true);
              }
            }}
          />
          <span role="status">
            {query
              ? finding
                ? t('pdf.searching')
                : matches.total
                  ? t('pdf.matches', matches)
                  : t('pdf.noMatches')
              : ''}
          </span>
          <PdfButton
            label={t('pdf.previousMatch')}
            onClick={() => find(true, true)}
            disabled={!query}
          >
            <PdfIcon name="previous" />
          </PdfButton>
          <PdfButton label={t('pdf.nextMatch')} onClick={() => find(false, true)} disabled={!query}>
            <PdfIcon name="next" />
          </PdfButton>
          <PdfButton label={t('pdf.closeSearch')} onClick={closeFind}>
            <PdfIcon name="close" />
          </PdfButton>
        </div>
      )}
      {(printState !== undefined || printFailure) && (
        <div className="folio-print-status" role="status">
          {printState !== undefined ? (
            <>
              <span>
                {t('pdf.preparingPrint', { page: printState, total: document?.numPages ?? 0 })}
              </span>
              <PdfButton
                label={t('pdf.cancelPrint')}
                onClick={() => printController.current?.abort()}
              >
                <PdfIcon name="close" />
              </PdfButton>
            </>
          ) : (
            <>
              <span>{t('pdf.printUnavailable')}</span>
              <PdfButton label={t('pdf.dismiss')} onClick={() => setPrintFailure(false)}>
                <PdfIcon name="close" />
              </PdfButton>
            </>
          )}
        </div>
      )}
      <div className="folio-body">
        {sidebar && document && (
          <aside
            className="folio-sidebar"
            aria-label={t(sidebar === 'outline' ? 'pdf.outline' : 'pdf.thumbnails')}
          >
            <header>
              <span>{t(sidebar === 'outline' ? 'pdf.outline' : 'pdf.thumbnails')}</span>
              <PdfButton label={t('pdf.closeSidebar')} onClick={() => setSidebar(undefined)}>
                <PdfIcon name="close" />
              </PdfButton>
            </header>
            {sidebar === 'thumbnails' ? (
              <PdfThumbnails
                document={document}
                page={page}
                rotation={rotation}
                navigate={navigate}
              />
            ) : (
              <PdfOutline
                document={document}
                navigate={(destination) => {
                  void engine.current?.links.goToDestination(destination);
                }}
              />
            )}
          </aside>
        )}
        <div className="folio-stage">
          {/* PDF.js requires a DIV container. The region is focusable for native page scrolling. */}
          {/* biome-ignore lint/a11y/useSemanticElements: PDFViewer requires an HTMLDivElement. */}
          <div
            className="folio-scroll"
            ref={container}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll region supports keyboard document navigation.
            tabIndex={0}
            role="region"
            aria-label={t('pdf.pages')}
            aria-busy={!ready && !failure && !password}
          >
            <div className="pdfViewer" ref={pages} />
          </div>
          {!ready && !failure && !password && (
            <div className="folio-loading" role="status" aria-label={t('viewer.loading')}>
              <div />
              <div />
              <div />
            </div>
          )}
          {failure && (
            <div className="folio-feedback">
              <ErrorNotice error={{ messageKey: failure }} />
              <button type="button" className="secondary" onClick={() => setAttempt(attempt + 1)}>
                {t('pdf.retry')}
              </button>
            </div>
          )}
          {password && (
            <form
              className="folio-password"
              onSubmit={(event) => {
                event.preventDefault();
                password.update(passwordDraft);
                setPasswordDraft('');
                setPassword(undefined);
              }}
            >
              <h3>{t('pdf.passwordTitle')}</h3>
              <label>
                {t('pdf.password')}
                <input
                  type="password"
                  ref={passwordInput}
                  autoComplete="off"
                  value={passwordDraft}
                  onChange={(event) => setPasswordDraft(event.target.value)}
                  required
                />
              </label>
              {password.incorrect && <span role="alert">{t('pdf.passwordIncorrect')}</span>}
              <button type="submit">{t('pdf.unlock')}</button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
