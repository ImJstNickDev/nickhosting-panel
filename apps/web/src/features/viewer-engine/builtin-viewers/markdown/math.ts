import type { Element, ElementContent, Root, RootContent } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import katex from 'katex';
import 'katex/contrib/mhchem';

/** Parse5, rather than DOMParser, keeps formula rendering entirely inside the worker. */
export function quillMath() {
  return (tree: Root) => {
    const plain = (node: RootContent): string =>
      node.type === 'text'
        ? node.value
        : 'children' in node
          ? node.children.map(plain).join('')
          : '';
    const classes = (node: Element) =>
      Array.isArray(node.properties.className) ? node.properties.className : [];
    const isMath = (node: Element) =>
      classes(node).some((name) =>
        ['language-math', 'math-display', 'math-inline'].includes(String(name)),
      );
    function walk(parent: Root | Element) {
      for (let i = 0; i < parent.children.length; i++) {
        const node = parent.children[i];
        if (node?.type !== 'element') continue;
        const child =
          node.tagName === 'pre' &&
          node.children.find(
            (item) => item.type === 'element' && item.tagName === 'code' && isMath(item),
          );
        const formula = child && child.type === 'element' ? child : node;
        if (!isMath(formula)) {
          walk(node);
          continue;
        }
        const source = plain(formula);
        let replacement: ElementContent[];
        try {
          const markup = katex.renderToString(source, {
            displayMode: node.tagName === 'pre' || classes(formula).includes('math-display'),
            trust: false,
            strict: 'ignore',
            maxExpand: 1000,
            maxSize: 20,
            throwOnError: false,
          });
          replacement = fromHtml(markup, { fragment: true }).children.filter(
            (item): item is ElementContent => item.type !== 'doctype',
          );
        } catch {
          replacement = [
            {
              type: 'element',
              tagName: 'code',
              properties: { className: ['katex-error'] },
              children: [{ type: 'text', value: source }],
            },
          ];
        }
        for (const item of replacement) if (item.type === 'element') item.position = node.position;
        parent.children.splice(i, 1, ...replacement);
        i += replacement.length - 1;
      }
    }
    walk(tree);
  };
}
