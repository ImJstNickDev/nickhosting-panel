import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { ErrorNotice } from '../../../components/ui.js';
import type { DocumentPosition, DocumentViewProps } from '../core/document-view.js';
import type { QuillModel } from './markdown/model.js';
import { QuillClient } from './markdown/ui-client.js';
import { QuillButton, QuillSkeleton } from './markdown/ui-controls.js';
import { createQuillEmbedBudget, quillAnchorIds } from './markdown/ui-model.js';
import { QuillDocument, type QuillRenderContext } from './markdown/ui-renderer.js';
import { useQuillSearch } from './markdown/ui-search.js';
import 'katex/dist/katex.min.css';
import './markdown.css';

/** Quill consumes the host draft; reads, undo, save and dirty navigation stay in Scribe/Fileman. */
export function MarkdownDocumentView(props: DocumentViewProps) {
  return <QuillWorkspace key={props.path} {...props} />;
}
export default MarkdownDocumentView;
function QuillWorkspace(props: DocumentViewProps) {
  const { value, active, resources } = props;
  const t = useT();
  const namespace = `quill-${useId().replace(/[^a-z0-9]/gi, '')}`;
  const article = useRef<HTMLElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [client, setClient] = useState<QuillClient>();
  const parsedOnce = useRef(false);
  const [result, setResult] = useState<{ source: string; model: QuillModel }>();
  const [error, setError] = useState<unknown>();
  const [anchorError, setAnchorError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [outline, setOutline] = useState(false);
  const [metadata, setMetadata] = useState(false);
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [contentVersion, setContentVersion] = useState(0);
  const position = useRef<DocumentPosition>({ offset: 0 });
  const pending = useRef<DocumentPosition | undefined>(undefined);
  const focusPending = useRef(active);
  const initialFragmentApplied = useRef<string | undefined>(undefined);
  const current = useRef(props);
  current.current = props;
  const model = result?.model;
  const settled = result?.source === value;
  const onContent = useCallback(() => setContentVersion((count) => count + 1), []);
  const searchContent = useMemo(() => [model, contentVersion], [model, contentVersion]);
  const matches = useQuillSearch(article, search && active ? query : '', searchContent);
  const openSearch = useCallback(() => {
    setSearch(true);
    requestAnimationFrame(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    });
  }, []);
  useEffect(() => {
    void attempt;
    const next = new QuillClient();
    setClient(next);
    return () => next.dispose();
  }, [attempt]);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setError(undefined);
    // Initial display is immediate. Editing coalesces worker updates, never saves.
    const timer = setTimeout(
      () => {
        void client.parse(value).then(
          (parsed) => {
            if (!cancelled) {
              parsedOnce.current = true;
              setResult({ source: value, model: parsed });
            }
          },
          (reason: unknown) => {
            if (!cancelled) setError(reason);
          },
        );
      },
      parsedOnce.current ? 100 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, value]);
  const reveal = useCallback((next: DocumentPosition) => {
    position.current = next;
    const root = article.current;
    if (!root) {
      pending.current = next;
      return;
    }
    const elements = [...root.querySelectorAll<HTMLElement>('[data-quill-offset]')];
    const candidates = elements.filter(
      (element) => Number(element.dataset.quillOffset) <= next.offset,
    );
    const target = candidates.at(-1) ?? elements[0];
    if (!target) {
      pending.current = next;
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    pending.current = undefined;
  }, []);
  const onAnchor = useCallback(
    (fragment: string): boolean => {
      const root = article.current;
      if (!root || !result) return false;
      const target = quillAnchorIds(result.model, namespace, fragment)
        .map((id) => document.getElementById(id))
        .find((element) => element && root.contains(element));
      if (!target) return false;
      for (
        let ancestor = target.parentElement;
        ancestor && ancestor !== root;
        ancestor = ancestor.parentElement
      )
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
      position.current = { offset: Number(target.dataset.quillOffset ?? 0) };
      return true;
    },
    [namespace, result],
  );
  useLayoutEffect(() => {
    current.current.onControls({
      focus() {
        if (!current.current.active) return;
        if (article.current) article.current.focus({ preventScroll: true });
        else focusPending.current = true;
      },
      getPosition() {
        return position.current;
      },
      revealPosition(next) {
        reveal(next);
      },
      find() {
        if (current.current.active) openSearch();
      },
    });
    return () => current.current.onControls(undefined);
  }, [reveal, openSearch]);
  useLayoutEffect(() => {
    if (!model) return;
    if (pending.current) reveal(pending.current);
    if (focusPending.current && active) {
      article.current?.focus({ preventScroll: true });
      focusPending.current = false;
    }
  }, [model, active, reveal]);
  useLayoutEffect(() => {
    if (
      !model ||
      !props.initialFragment ||
      initialFragmentApplied.current === props.initialFragment
    )
      return;
    setAnchorError(!onAnchor(props.initialFragment));
    initialFragmentApplied.current = props.initialFragment;
  }, [model, props.initialFragment, onAnchor]);
  useEffect(() => {
    if (!active) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')
      )
        return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        openSearch();
      }
      if (event.key === 'Escape' && search) {
        event.preventDefault();
        event.stopPropagation();
        setSearch(false);
        article.current?.focus();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [active, search, openSearch]);
  const print = () => {
    const node = article.current;
    if (!node) return;
    node.classList.add('quill-print-target');
    const done = () => {
      node.classList.remove('quill-print-target');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done, { once: true });
    window.print();
  };
  const embedBudget = useMemo(() => {
    void value;
    return createQuillEmbedBudget();
  }, [value]);
  const context = useMemo<QuillRenderContext | undefined>(
    () =>
      client
        ? {
            client,
            resources,
            source: resources?.source,
            depth: 0,
            chain: resources
              ? [
                  JSON.stringify([
                    resources.source.path,
                    resources.source.archives,
                    resources.source.entry,
                  ]),
                ]
              : [],
            namespace,
            onAnchor,
            onContent,
            budget: embedBudget,
            taskChecked: (offset) => {
              const source = current.current.value;
              return source.charAt(offset - 1) === '[' && source.charAt(offset + 1) === ']'
                ? /[xX]/.test(source.charAt(offset))
                : undefined;
            },
            onTask:
              props.readOnly || !settled
                ? undefined
                : (offset, checked) => {
                    const before = current.current.value;
                    if (
                      !/[ xX]/.test(before.charAt(offset)) ||
                      before.charAt(offset - 1) !== '[' ||
                      before.charAt(offset + 1) !== ']'
                    )
                      return;
                    current.current.onChange(
                      `${before.slice(0, offset)}${checked ? 'x' : ' '}${before.slice(offset + 1)}`,
                      before,
                    );
                  },
          }
        : undefined,
    [client, resources, namespace, onAnchor, onContent, props.readOnly, embedBudget, settled],
  );
  const updatePosition = (target: EventTarget | null) => {
    const element =
      target instanceof Element ? target.closest<HTMLElement>('[data-quill-offset]') : undefined;
    if (element) position.current = { offset: Number(element.dataset.quillOffset) };
  };
  return (
    <div className="ve-quill" aria-busy={!settled && !error}>
      <div className="quill-toolbar">
        <QuillButton
          kind="outline"
          label={t('quill.outline')}
          pressed={outline}
          disabled={!model?.headings.length}
          onClick={() => setOutline(!outline)}
        />
        {search ? (
          <div className="quill-search">
            <input
              ref={searchInput}
              type="search"
              maxLength={256}
              aria-label={t('quill.search')}
              placeholder={t('quill.search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  matches.reveal(matches.current + (event.shiftKey ? -1 : 1));
                }
              }}
            />
            <span role="status">
              {query
                ? matches.total
                  ? t('quill.matches', { current: matches.current + 1, total: matches.total })
                  : t('quill.noMatches')
                : ''}
            </span>
            <QuillButton
              kind="previous"
              label={t('quill.previous')}
              disabled={!matches.total}
              onClick={() => matches.reveal(matches.current - 1)}
            />
            <QuillButton
              kind="next"
              label={t('quill.next')}
              disabled={!matches.total}
              onClick={() => matches.reveal(matches.current + 1)}
            />
            <QuillButton
              kind="close"
              label={t('quill.closeSearch')}
              onClick={() => {
                setSearch(false);
                article.current?.focus();
              }}
            />
          </div>
        ) : (
          <QuillButton kind="find" label={t('quill.find')} onClick={openSearch} />
        )}
        <div className="quill-tools">
          <QuillButton
            kind="metadata"
            label={t('quill.metadata')}
            pressed={metadata}
            disabled={!model?.metadata || !Object.keys(model.metadata).length}
            onClick={() => setMetadata(!metadata)}
          />
          <QuillButton kind="print" label={t('quill.print')} disabled={!model} onClick={print} />
        </div>
      </div>
      <div className="quill-workspace">
        {outline && model && (
          <nav className="quill-outline" aria-label={t('quill.outline')}>
            {model.headings.map((heading) => (
              <button
                type="button"
                key={heading.id}
                style={{ paddingInlineStart: `${12 + (heading.depth - 1) * 12}px` }}
                onClick={() => onAnchor(heading.id)}
              >
                {heading.text}
              </button>
            ))}
          </nav>
        )}
        {error ? (
          <div className="quill-error">
            <ErrorNotice error={{ messageKey: 'viewer.unavailable' }} />
            <button type="button" onClick={() => setAttempt((count) => count + 1)}>
              {t('quill.retry')}
            </button>
          </div>
        ) : !model || !context ? (
          <QuillSkeleton />
        ) : (
          <article
            ref={article}
            className="quill-document"
            aria-label={t('quill.document')}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable document is the keyboard navigation and source-position target.
            tabIndex={0}
            onPointerUp={(event) => updatePosition(event.target)}
            onKeyUp={(event) => updatePosition(event.target)}
            onScroll={() => {
              const root = article.current;
              if (!root) return;
              const top = root.getBoundingClientRect().top;
              const first = [...root.querySelectorAll<HTMLElement>('[data-quill-offset]')].find(
                (element) => element.getBoundingClientRect().bottom > top + 12,
              );
              if (first) position.current = { offset: Number(first.dataset.quillOffset) };
            }}
          >
            {anchorError && (
              <p className="quill-fallback" role="status">
                {t('quill.anchorUnavailable')}
              </p>
            )}
            {metadata && model.metadata && (
              <section className="quill-metadata" aria-label={t('quill.metadata')}>
                <dl>
                  {Object.entries(model.metadata).map(([key, item]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{typeof item === 'string' ? item : JSON.stringify(item)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            {model.warnings.length > 0 && (
              <p className="quill-fallback" role="status">
                {t('quill.partial')}
              </p>
            )}
            <QuillDocument model={model} context={context} />
          </article>
        )}
      </div>
    </div>
  );
}
