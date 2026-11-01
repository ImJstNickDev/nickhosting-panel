import type { Root, RootContent } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import { createElement, type ReactNode, useMemo } from 'react';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { useAddonsT } from './addons-context.js';
import { modsKey } from './mods-primitives.js';

// Same installed Markdown/sanitizer pipeline as Quill, without its document features,
// math, code grammars or local-file resolver. Provider content never becomes raw HTML.
const sanitizer = unified().use(rehypeSanitize, {
  ...defaultSchema,
  clobberPrefix: 'mod-description-',
  tagNames: [
    'p',
    'br',
    'hr',
    'strong',
    'em',
    'del',
    's',
    'a',
    'img',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'details',
    'summary',
  ],
  attributes: { a: ['href'], img: ['src', 'alt'], ol: ['start'], details: ['open'] },
  protocols: { href: ['https', 'http'], src: ['https'] },
});
const markdown = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw);

export function parseModDescription(value: string, format: 'markdown' | 'html'): Root {
  const bounded = value.slice(0, 256 * 1024);
  const root =
    format === 'html'
      ? fromHtml(bounded, { fragment: true })
      : markdown.runSync(markdown.parse(bounded));
  return sanitizer.runSync(root) as Root;
}
export function ModsDescription({ text, format }: { text: string; format: 'markdown' | 'html' }) {
  const t = useAddonsT();
  const tree = useMemo(() => {
    try {
      return parseModDescription(text, format);
    } catch {
      return undefined;
    }
  }, [text, format]);
  function render(node: RootContent, key: string): ReactNode {
    if (node.type === 'text') return node.value;
    if (node.type !== 'element') return null;
    // These and img below are the only void elements allowed by the sanitizer.
    // React rejects even an empty children array on a void element.
    if (node.tagName === 'br' || node.tagName === 'hr') {
      return createElement(node.tagName, { key });
    }
    if (node.tagName === 'img') {
      const src = String(node.properties.src ?? '');
      if (!src.startsWith('https://')) return null;
      return (
        <img
          key={key}
          src={src}
          alt={String(node.properties.alt ?? '')}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      );
    }
    const children = node.children.map((child, index) => render(child, `${key}-${index}`));
    if (node.tagName === 'a') {
      const href = String(node.properties.href ?? '');
      if (!/^https?:\/\//i.test(href)) return <span key={key}>{children}</span>;
      return (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    }
    return createElement(node.tagName, { key }, children);
  }
  const body = tree?.children.map((node, index) => render(node, String(index)));
  return (
    <div className="mods-description">
      {body?.length ? body : <p>{text || t(modsKey('descriptionUnavailable'))}</p>}
    </div>
  );
}
