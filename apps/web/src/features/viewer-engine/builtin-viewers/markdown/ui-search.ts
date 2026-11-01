import { type RefObject, useEffect, useRef, useState } from 'react';
import { quillSearchRanges } from './ui-model.js';

type HighlightConstructor = new (...ranges: Range[]) => unknown;
function highlightRegistry(): Map<string, unknown> | undefined {
  return (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)
    ?.highlights;
}
export function useQuillSearch(
  article: RefObject<HTMLElement | null>,
  query: string,
  content: unknown,
) {
  const ranges = useRef<Range[]>([]);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  const serial = useRef(`quill-search-${Math.random().toString(36).slice(2)}`);
  const reveal = (index: number) => {
    const all = ranges.current;
    if (!all.length) return;
    const next = (index + all.length) % all.length;
    setCurrent(next);
    const range = all[next];
    if (!range) return;
    const container = article.current;
    if (!container) return;
    const bounds = range.getBoundingClientRect();
    const outer = container.getBoundingClientRect();
    container.scrollBy({ top: bounds.top - outer.top - outer.height / 3, behavior: 'instant' });
    const Highlight = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
    if (Highlight) highlightRegistry()?.set(`${serial.current}-active`, new Highlight(range));
    else {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };
  useEffect(() => {
    void content;
    const root = article.current;
    const registry = highlightRegistry();
    const id = serial.current;
    const Highlight = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
    const style = document.createElement('style');
    style.textContent = `::highlight(${id}) { background: #e8bc6659; color: inherit; } ::highlight(${id}-active) { background: #e8bc66a6; color: inherit; }`;
    document.head.append(style);
    const matches: Range[] = [];
    const needle = query.trim().slice(0, 256);
    if (root && needle) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.parentElement?.closest('.quill-nosearch, [hidden]')
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      });
      while (walker.nextNode() && matches.length < 2000) {
        const node = walker.currentNode;
        const text = node.textContent ?? '';
        for (const match of quillSearchRanges(text, needle, 2000 - matches.length)) {
          const range = document.createRange();
          range.setStart(node, match.start);
          range.setEnd(node, match.end);
          matches.push(range);
        }
      }
    }
    ranges.current = matches;
    setCurrent(0);
    setTotal(matches.length);
    if (Highlight && matches.length) registry?.set(id, new Highlight(...matches));
    return () => {
      registry?.delete(id);
      registry?.delete(`${id}-active`);
      style.remove();
      ranges.current = [];
    };
  }, [article, query, content]);
  return { current, total, reveal };
}
