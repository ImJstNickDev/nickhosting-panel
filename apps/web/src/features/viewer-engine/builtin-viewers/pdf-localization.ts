import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';

type Translate = (key: string, values?: Record<string, string | number>) => string;
/** PDF.js's injected L10n contract backed by our catalogue. Only four generated
 * read-only labels are used; no stock viewer, form or annotation editor is mounted.
 * Like upstream Fluent, observe additions while respecting PDF.js pause/resume.
 */
export function createPdfLocalization(
  Base: typeof GenericL10n,
  locale: string,
  translate: Translate,
) {
  const text = (id: string, args: Record<string, unknown>) => {
    if (id === 'pdfjs-page-landmark' && typeof args.page === 'number')
      return translate('pdf.pageLabel', { page: args.page });
    if (id === 'pdfjs-text-annotation-type') return translate('pdf.annotation');
    if (id === 'pdfjs-show-comment-button') return translate('pdf.showComment');
    if (id === 'pdfjs-annotation-date-time-string' && typeof args.dateObj === 'number') {
      const date = new Date(args.dateObj);
      if (Number.isFinite(date.valueOf()))
        return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', {
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(date);
    }
    return '';
  };
  const localize = (element: Element) => {
    if (
      element instanceof HTMLAnchorElement &&
      !element.getAttribute('aria-label') &&
      element.closest('.annotationLayer') &&
      element.getAttribute('href')?.startsWith('#')
    )
      element.setAttribute('aria-label', translate('pdf.followLink'));
    const id = element.getAttribute('data-l10n-id');
    if (!id) return;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(element.getAttribute('data-l10n-args') ?? '{}');
    } catch {
      return;
    }
    const value = text(id, args);
    if (!value) return;
    if (id === 'pdfjs-text-annotation-type') element.setAttribute('alt', value);
    else if (id === 'pdfjs-annotation-date-time-string') element.textContent = value;
    else element.setAttribute('aria-label', value);
  };
  const visit = (node: Node) => {
    if (!(node instanceof Element)) return;
    localize(node);
    for (const element of node.querySelectorAll('[data-l10n-id], .annotationLayer a'))
      localize(element);
  };
  return new (class extends Base {
    private readonly roots = new Map<HTMLElement, MutationObserver>();
    override async get(ids: string | string[], args: Record<string, unknown> | null = null) {
      return Array.isArray(ids) ? ids.map((id) => text(id, args ?? {})) : text(ids, args ?? {});
    }
    override async translate(root: HTMLElement) {
      if (!this.roots.has(root)) {
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === 'attributes' && record.target instanceof Element)
              localize(record.target);
            else for (const node of record.addedNodes) visit(node);
          }
        });
        this.roots.set(root, observer);
      }
      this.resume();
    }
    override async translateOnce(element: HTMLElement) {
      visit(element);
    }
    override pause() {
      for (const observer of this.roots.values()) observer.disconnect();
    }
    override resume() {
      for (const [root, observer] of this.roots) {
        visit(root);
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-l10n-id', 'data-l10n-args'],
        });
      }
    }
    override async destroy() {
      this.pause();
      this.roots.clear();
    }
  })(locale === 'it' ? 'it' : 'en');
}
