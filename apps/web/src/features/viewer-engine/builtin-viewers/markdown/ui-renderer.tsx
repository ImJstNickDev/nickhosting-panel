import {
  type CSSProperties,
  createElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useT } from '../../../../app/i18n.js';
import type { DocumentResource, DocumentResources } from '../../core/document-resources.js';
import type { ViewerSource } from '../../core/registry.js';
import { loadQuillBibliography } from './bibliography-client.js';
import type { QuillModel, QuillNode, QuillReference } from './model.js';
import type { QuillClient } from './ui-client.js';
import { QuillButton, QuillFallback, QuillSkeleton } from './ui-controls.js';
import { QuillDiagram } from './ui-diagram.js';
import { type QuillEmbedBudget, quillAnchorIds, quillNodeCount } from './ui-model.js';

export interface QuillRenderContext {
  client: QuillClient;
  resources?: DocumentResources;
  source?: ViewerSource;
  depth: number;
  chain: readonly string[];
  namespace: string;
  budget: QuillEmbedBudget;
  onTask?: (offset: number, checked: boolean) => void;
  taskChecked?: (offset: number) => boolean | undefined;
  onAnchor(fragment: string): boolean;
  onContent?(): void;
}
function textOf(node: QuillNode): string {
  return node.type === 'text' ? node.value : node.children.map(textOf).join('');
}
function sourceKey(source: ViewerSource) {
  return JSON.stringify([source.path, source.archives, source.entry]);
}
export function fragmentNodes(model: QuillModel, fragment?: string): QuillNode[] {
  if (!fragment) return model.children;
  const requested = fragment.replace(/^#/, '').toLocaleLowerCase();
  const block = requested.replace(/^\^/, '');
  const heading = model.headings.find(
    (item) =>
      item.text.toLocaleLowerCase() === requested ||
      item.id.toLocaleLowerCase() === requested ||
      item.id.replace(/^quill-heading-/, '').toLocaleLowerCase() === requested,
  );
  if (heading) {
    const start = model.children.findIndex(
      (node) => node.type === 'element' && node.properties.id === heading.id,
    );
    if (start >= 0) {
      let end = start + 1;
      while (end < model.children.length) {
        const node = model.children[end];
        if (
          node?.type === 'element' &&
          /^h[1-6]$/.test(node.tagName) &&
          Number(node.tagName.slice(1)) <= heading.depth
        )
          break;
        end++;
      }
      return model.children.slice(start, end);
    }
  }
  const find = (nodes: QuillNode[]): QuillNode | undefined => {
    for (const node of nodes) {
      if (node.type !== 'element') continue;
      if ([requested, `quill-block-${block}`].includes(String(node.properties.id))) return node;
      const child = find(node.children);
      if (child) return child;
    }
    return undefined;
  };
  const found = find(model.children);
  if (!found) throw new Error('Reference not found');
  return [found];
}

export function QuillDocument({
  model,
  context: parentContext,
  fragment,
}: {
  model: QuillModel;
  context: QuillRenderContext;
  fragment?: string;
}) {
  const context = useMemo<QuillRenderContext>(
    () => ({
      ...parentContext,
      onAnchor(fragment) {
        if (parentContext.depth === 0) {
          return parentContext.onAnchor(fragment);
        }
        const target = quillAnchorIds(model, parentContext.namespace, fragment)
          .map((id) => document.getElementById(id))
          .find(Boolean);
        if (!target) return false;
        for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement)
          if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        return true;
      },
    }),
    [parentContext, model],
  );
  const refs = useMemo(() => new Map(model.references.map((ref) => [ref.id, ref])), [model]);
  const nodes = fragmentNodes(model, fragment);
  const taskLabels = useMemo(() => {
    const labels = new Map<string, string>();
    const stack = [...model.children];
    while (stack.length) {
      const node = stack.pop();
      if (node?.type !== 'element') continue;
      if (node.tagName === 'li' && typeof node.properties.dataQuillTask === 'string')
        labels.set(
          node.properties.dataQuillTask,
          node.children
            .filter((child) => child.type !== 'element' || !['ul', 'ol'].includes(child.tagName))
            .map(textOf)
            .join('')
            .trim()
            .slice(0, 160),
        );
      stack.push(...node.children);
    }
    return labels;
  }, [model]);
  const [bibliography, setBibliography] = useState<{ id: string; label: string; text: string }[]>(
    [],
  );
  const [bibliographyError, setBibliographyError] = useState(false);
  const t = useT();
  useEffect(() => {
    const controller = new AbortController();
    setBibliography([]);
    setBibliographyError(false);
    const entry = model.metadata?.bibliography;
    const inline = model.metadata?.references;
    if (!entry && !Array.isArray(inline)) return;
    const resources = context.resources;
    const style = model.metadata?.['citation-style'] === 'numeric' ? 'numeric' : 'author-year';
    const load = async () => {
      if (Array.isArray(inline))
        return loadQuillBibliography(JSON.stringify(inline), 'json', style, controller.signal);
      if (typeof entry !== 'string' || !resources) throw new Error('Bibliography unavailable');
      const resolved = await resources.resolve(entry, {
        from: context.source,
        signal: controller.signal,
      });
      if (resolved.kind !== 'local') throw new Error('Local bibliography required');
      return loadQuillBibliography(
        await resources.readText(resolved, controller.signal),
        /\.bib$/i.test(entry) ? 'bibtex' : 'json',
        style,
        controller.signal,
      );
    };
    void load().then(
      (result) => {
        if (!controller.signal.aborted) {
          setBibliography(result.entries);
          context.onContent?.();
        }
      },
      () => {
        if (!controller.signal.aborted) setBibliographyError(true);
      },
    );
    return () => controller.abort();
  }, [model.metadata, context.resources, context.source, context.onContent]);
  const render = (node: QuillNode, key: string): ReactNode => {
    if (node.type === 'text') return node.value;
    const properties = node.properties;
    const rawRef = properties.dataQuillReference;
    const reference = typeof rawRef === 'string' ? refs.get(rawRef) : undefined;
    if (reference?.kind === 'embed')
      return <QuillEmbed key={key} reference={reference} context={context} />;
    if (reference?.kind === 'citation') {
      if (/^-@/.test(reference.label)) return <span key={key}>{`[${reference.label}]`}</span>;
      const ids = reference.target
        .split(/[;,]/)
        .map((id) => id.trim().replace(/^@/, ''))
        .filter(Boolean);
      const entries = ids.map((id) => bibliography.find((entry) => entry.id === id));
      return (
        <span key={key} className="quill-citation">
          {entries.map((entry, i) => (
            <span key={ids[i]}>
              {i > 0 ? '; ' : ''}
              {entry ? (
                <a
                  href={`#${context.namespace}-cite-${encodeURIComponent(entry.id)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    document
                      .getElementById(`${context.namespace}-cite-${encodeURIComponent(entry.id)}`)
                      ?.scrollIntoView({ block: 'nearest' });
                  }}
                >
                  {entry.label}
                  {reference.label.match(/^-?@[^\s,]+(.*)$/)?.[1] ?? ''}
                </a>
              ) : (
                `[@${ids[i]}]`
              )}
            </span>
          ))}
        </span>
      );
    }
    if (reference)
      return (
        <QuillLink key={key} target={reference.target} context={context} wiki>
          {node.children.length
            ? node.children.map((child, i) => render(child, `${key}.${i}`))
            : reference.label}
        </QuillLink>
      );
    if (node.tagName === 'a')
      return (
        <QuillLink
          key={key}
          target={String(properties.href ?? '')}
          id={
            typeof properties.id === 'string' ? `${context.namespace}-${properties.id}` : undefined
          }
          context={context}
          label={
            properties.dataFootnoteBackref !== undefined ? t('quill.backToReference') : undefined
          }
        >
          {node.children.map((child, i) => render(child, `${key}.${i}`))}
        </QuillLink>
      );
    if (node.tagName === 'img')
      return (
        <QuillImage
          key={key}
          target={String(properties.src ?? '')}
          label={String(properties.alt ?? '')}
          context={context}
          width={properties.width}
          height={properties.height}
        />
      );
    if (node.tagName === 'pre') {
      const code = node.children.find(
        (child) => child.type === 'element' && child.tagName === 'code',
      );
      const meta = code?.type === 'element' ? { ...properties, ...code.properties } : properties;
      if (typeof meta.dataMermaid === 'string')
        return <QuillDiagram key={key} source={meta.dataMermaid} />;
      const content = code ? textOf(code) : textOf(node);
      return (
        <QuillCode
          key={key}
          source={content}
          filename={typeof meta.dataFilename === 'string' ? meta.dataFilename : undefined}
          lineNumbers={!!meta.dataLineNumbers}
          highlight={String(meta.dataHighlightLines ?? '')}
        >
          {node.children.map((child, i) => render(child, `${key}.${i}`))}
        </QuillCode>
      );
    }
    if (node.tagName === 'blockquote' && typeof properties.dataCallout === 'string') {
      const kind = properties.dataCallout;
      const title =
        typeof properties.dataCalloutTitle === 'string' && properties.dataCalloutTitle
          ? properties.dataCalloutTitle
          : t(
              `quill.${['note', 'tip', 'important', 'warning', 'caution'].includes(kind) ? kind : 'note'}`,
            );
      const children = node.children.map((child, i) => render(child, `${key}.${i}`));
      if (properties.dataCalloutFold === '+' || properties.dataCalloutFold === '-')
        return (
          <details
            key={key}
            className="quill-callout"
            data-kind={kind}
            open={properties.dataCalloutFold === '+'}
          >
            <summary>{title}</summary>
            {children}
          </details>
        );
      return (
        <aside key={key} className="quill-callout" data-kind={kind}>
          <strong>{title}</strong>
          {children}
        </aside>
      );
    }
    if (node.tagName === 'input') {
      if (properties.type !== 'checkbox') return null;
      const task = model.tasks.find((item) => item.id === properties.dataQuillTask);
      return (
        <input
          key={key}
          type="checkbox"
          checked={
            task ? (context.taskChecked?.(task.offset) ?? task.checked) : !!properties.checked
          }
          aria-label={
            task && taskLabels.get(task.id)
              ? t('quill.taskLabel', { task: taskLabels.get(task.id) ?? '' })
              : t('quill.task')
          }
          disabled={!task || !context.onTask}
          onChange={(event) => {
            if (task) context.onTask?.(task.offset, event.target.checked);
          }}
        />
      );
    }
    const props: Record<string, unknown> = { key };
    for (const [name, value] of Object.entries(properties)) {
      if (
        value === undefined ||
        /^on/i.test(name) ||
        /^(src|srcSet|href|action|formAction|data)/i.test(name)
      )
        continue;
      if (name === 'className') props.className = Array.isArray(value) ? value.join(' ') : value;
      else if (name === 'id') props.id = `${context.namespace}-${String(value)}`;
      else if (name === 'style' && typeof value === 'string') props.style = styleObject(value);
      else if (name === 'ariaHidden') props['aria-hidden'] = value;
      else if (name === 'ariaLabel') props['aria-label'] = value;
      else if (/^aria[A-Z]/.test(name)) {
        const attr = `aria-${name.slice(4).toLowerCase()}`;
        props[attr] = ['aria-labelledby', 'aria-describedby'].includes(attr)
          ? String(value)
              .split(/\s+/)
              .map((id) => `${context.namespace}-${id}`)
              .join(' ')
          : value;
      } else if (name === 'tabIndex') continue;
      else props[name] = value;
    }
    if (node.start !== undefined && context.depth === 0) props['data-quill-offset'] = node.start;
    if (node.end !== undefined && context.depth === 0) props['data-quill-end'] = node.end;
    // Source HTML is sanitized in the worker. This additional deny list prevents a
    // future parser plugin from introducing an executable or navigable surface.
    if (
      [
        'script',
        'iframe',
        'object',
        'embed',
        'style',
        'link',
        'form',
        'button',
        'textarea',
        'select',
        'video',
        'audio',
      ].includes(node.tagName)
    )
      return null;
    const children = String(properties.id ?? '').endsWith('footnote-label')
      ? [t('quill.footnotes')]
      : node.children.map((child, i) => render(child, `${key}.${i}`));
    return createElement(node.tagName, props, ...children);
  };
  return (
    <>
      {nodes.map((node, index) => render(node, `${context.namespace}.${index}`))}
      {bibliographyError && (
        <p className="quill-fallback" role="status">
          {t('quill.bibliographyError')}
        </p>
      )}
      {bibliography.length > 0 && (
        <section className="quill-bibliography" aria-label={t('quill.references')}>
          <h2>{t('quill.references')}</h2>
          <ol>
            {bibliography.map((entry) => (
              <li key={entry.id} id={`${context.namespace}-cite-${encodeURIComponent(entry.id)}`}>
                {entry.text}
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
function styleObject(style: string): CSSProperties {
  const result: Record<string, string> = {};
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (/url\s*\(|expression|javascript/i.test(value)) continue;
    result[name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return result;
}
function QuillCode({
  source,
  filename,
  children,
  lineNumbers,
  highlight,
}: {
  source: string;
  filename?: string;
  children: ReactNode;
  lineNumbers: boolean;
  highlight: string;
}) {
  const t = useT();
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const marked = new Set<number>();
  for (const item of highlight.split(',')) {
    const [start, end = start] = item.split('-').map(Number);
    if (!start || !end || end - start > 1000) continue;
    for (let value = start; value <= end; value++) marked.add(value);
  }
  return (
    <figure className="quill-code">
      <figcaption className="quill-nosearch">
        <span>{filename}</span>
        <span role="status">
          {copyState === 'ok'
            ? t('quill.copied')
            : copyState === 'error'
              ? t('quill.copyFailed')
              : ''}
        </span>
        <QuillButton
          kind="copy"
          label={t('quill.copyCode')}
          onClick={() => {
            void navigator.clipboard.writeText(source).then(
              () => setCopyState('ok'),
              () => setCopyState('error'),
            );
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopyState('idle'), 2200);
          }}
        />
      </figcaption>
      <div className="quill-code-content">
        {(lineNumbers || marked.size > 0) && (
          <div className="quill-line-numbers" aria-hidden="true">
            {source
              .replace(/\n$/, '')
              .split('\n')
              .map((_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Static line-number gutter is keyed by the represented line.
                <span key={`number-${index}`} data-highlight={marked.has(index + 1) || undefined}>
                  {lineNumbers ? index + 1 : ' '}
                </span>
              ))}
          </div>
        )}
        <pre>{children}</pre>
      </div>
    </figure>
  );
}
function QuillLink({
  target,
  wiki = false,
  context,
  children,
  label,
  id,
}: {
  target: string;
  wiki?: boolean;
  context: QuillRenderContext;
  children: ReactNode;
  label?: string;
  id?: string;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const external = /^(https?:|mailto:)/i.test(target);
  if (external)
    return (
      <a id={id} href={target} aria-label={label} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    );
  return (
    <>
      <a
        id={id}
        href={target.startsWith('#') ? target : '#'}
        aria-label={label}
        aria-invalid={failed || undefined}
        onClick={(event) => {
          event.preventDefault();
          setFailed(false);
          if (target.startsWith('#')) {
            if (!context.onAnchor(target.slice(1))) setFailed(true);
            return;
          }
          if (!context.resources) {
            setFailed(true);
            return;
          }
          controller.current?.abort();
          const next = new AbortController();
          controller.current = next;
          void context.resources
            .resolve(target, { wiki, from: context.source, signal: next.signal })
            .then(
              (resource) => {
                if (next.signal.aborted) return;
                if (resource.kind === 'anchor') {
                  if (!context.onAnchor(resource.fragment)) setFailed(true);
                } else if (resource.kind === 'local') context.resources?.open(resource);
                else window.open(resource.url, '_blank', 'noopener,noreferrer');
              },
              () => {
                if (!next.signal.aborted) setFailed(true);
              },
            );
        }}
      >
        {children}
      </a>
      {failed && (
        <QuillFallback>
          {t(target.startsWith('#') ? 'quill.anchorUnavailable' : 'quill.unavailable')}
        </QuillFallback>
      )}
    </>
  );
}
type QuillImageProps = {
  target: string;
  label: string;
  context: QuillRenderContext;
  width?: unknown;
  height?: unknown;
};
function QuillImage(props: QuillImageProps) {
  const root = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = root.current;
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
  return (
    <span ref={root} className="quill-image">
      {visible ? (
        <QuillImageContent {...props} />
      ) : (
        <span className="quill-image-skeleton" aria-hidden="true" />
      )}
    </span>
  );
}
function QuillImageContent({
  target,
  label,
  context,
  width,
  height,
}: {
  target: string;
  label: string;
  context: QuillRenderContext;
  width?: unknown;
  height?: unknown;
}) {
  const t = useT();
  const [resource, setResource] = useState<DocumentResource>();
  const [failed, setFailed] = useState(false);
  const [externalAllowed, setExternalAllowed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setResource(undefined);
    setFailed(false);
    setExternalAllowed(false);
    if (!context.resources) {
      setFailed(true);
      return;
    }
    void context.resources
      .resolve(target, { from: context.source, signal: controller.signal })
      .then(
        (result) => {
          if (!controller.signal.aborted) setResource(result);
        },
        () => {
          if (!controller.signal.aborted) setFailed(true);
        },
      );
    return () => controller.abort();
  }, [target, context.resources, context.source]);
  if (failed || resource?.kind === 'anchor')
    return <QuillFallback>{label || t('quill.imageFailed')}</QuillFallback>;
  if (!resource) return <span className="quill-image-skeleton" aria-hidden="true" />;
  if (resource.kind === 'external' && (!/^https?:/i.test(resource.url) || !externalAllowed))
    return (
      <button
        type="button"
        className="quill-resource-button"
        onClick={() => setExternalAllowed(true)}
        disabled={!/^https?:/i.test(resource.url)}
      >
        {t('quill.externalImage', { host: new URL(resource.url).hostname })}
      </button>
    );
  const url = resource.kind === 'local' ? context.resources?.url(resource) : resource.url;
  return (
    <img
      src={url}
      alt={label}
      loading="lazy"
      referrerPolicy="no-referrer"
      width={typeof width === 'number' ? width : undefined}
      height={typeof height === 'number' ? height : undefined}
      onLoad={() => context.onContent?.()}
      onError={() => setFailed(true)}
    />
  );
}
function QuillEmbed({
  reference,
  context,
}: {
  reference: QuillReference;
  context: QuillRenderContext;
}) {
  const t = useT();
  const [content, setContent] = useState<{
    model: QuillModel;
    source: ViewerSource;
    fragment?: string;
    chain: readonly string[];
  }>();
  const [asset, setAsset] = useState<DocumentResource>();
  const [error, setError] = useState(false);
  const [limit, setLimit] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    const occurrence = `${context.namespace}-${reference.id}`;
    if (!context.budget.acquire(occurrence)) {
      setLimit(true);
      return;
    }
    const cleanup = () => {
      controller.abort();
      context.budget.release(occurrence);
    };
    setContent(undefined);
    setAsset(undefined);
    setError(false);
    setLimit(false);
    const resources = context.resources;
    if (!resources) {
      setError(true);
      return cleanup;
    }
    if (context.depth >= 3 || context.chain.length >= 12) {
      setLimit(true);
      return cleanup;
    }
    const load = async () => {
      const resource = await resources.resolve(reference.target, {
        wiki: true,
        from: context.source,
        signal: controller.signal,
      });
      if (resource.kind !== 'local') throw new Error('Local inclusion required');
      const key = sourceKey(resource.source);
      if (
        context.chain.includes(key) ||
        (!context.budget.claimed.has(key) && context.budget.claimed.size >= 16)
      ) {
        if (!controller.signal.aborted) setLimit(true);
        return;
      }
      if (!/\.(md|markdown|mdown|mkd)$/i.test(resource.source.entry ?? resource.source.name)) {
        if (!controller.signal.aborted) setAsset(resource);
        return;
      }
      const fresh = !context.budget.claimed.has(key);
      context.budget.claimed.add(key);
      const source = await resources.readText(resource, controller.signal);
      if (fresh) context.budget.bytes += new TextEncoder().encode(source).byteLength;
      if (context.budget.bytes > 4 * 1024 * 1024) {
        if (!controller.signal.aborted) setLimit(true);
        return;
      }
      const model = await context.client.parse(source);
      if (!context.budget.render(occurrence, quillNodeCount(model.children))) {
        if (!controller.signal.aborted) setLimit(true);
        return;
      }
      fragmentNodes(model, resource.fragment); // Validate before render: never throw into the app shell.
      if (!controller.signal.aborted) {
        setContent({
          model,
          source: resource.source,
          fragment: resource.fragment,
          chain: [...context.chain, key],
        });
        context.onContent?.();
      }
    };
    void load().catch(() => {
      if (!controller.signal.aborted) setError(true);
    });
    return cleanup;
  }, [
    reference.id,
    reference.target,
    context.namespace,
    context.resources,
    context.source,
    context.client,
    context.depth,
    context.chain,
    context.budget,
    context.onContent,
    attempt,
  ]);
  if (limit) return <QuillFallback>{t('quill.embedLimit')}</QuillFallback>;
  if (error)
    return (
      <span className="quill-fallback">
        {t('quill.unavailable')}{' '}
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          {t('quill.retry')}
        </button>
      </span>
    );
  if (asset?.kind === 'local') {
    if (/\.(png|jpe?g|webp|gif|avif|svg|bmp|ico)$/i.test(asset.source.entry ?? asset.source.name))
      return (
        <QuillImage
          target={reference.target.split('|')[0] ?? reference.target}
          label={reference.label}
          context={context}
        />
      );
    return (
      <button
        type="button"
        className="quill-resource-button"
        onClick={() => context.resources?.open(asset)}
      >
        {t('quill.openReference', { name: asset.source.name })}
      </button>
    );
  }
  if (!content) return <QuillSkeleton />;
  return (
    <section className="quill-embed" aria-label={reference.label}>
      <QuillDocument
        model={content.model}
        fragment={content.fragment}
        context={{
          ...context,
          source: content.source,
          depth: context.depth + 1,
          chain: content.chain,
          namespace: `${context.namespace}-${reference.id}`,
          onTask: undefined,
          taskChecked: undefined,
        }}
      />
    </section>
  );
}
