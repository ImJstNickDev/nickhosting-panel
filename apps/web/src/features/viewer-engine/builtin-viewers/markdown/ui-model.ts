import type { QuillModel, QuillNode } from './model.js';

/** Search against the original string: Unicode case folding may change string length. */
export function quillSearchRanges(
  text: string,
  query: string,
  maximum = 2000,
): { start: number; end: number }[] {
  const needle = query.trim().slice(0, 256);
  if (!needle) return [];
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const result: { start: number; end: number }[] = [];
  let match = pattern.exec(text);
  while (match && result.length < maximum) {
    result.push({ start: match.index, end: match.index + match[0].length });
    match = pattern.exec(text);
  }
  return result;
}
export function quillAnchorIds(model: QuillModel, namespace: string, fragment: string): string[] {
  let decoded = fragment.replace(/^#/, '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* Literal percent in a heading is valid. */
  }
  const heading = model.headings.find(
    (item) =>
      item.id === decoded ||
      item.id.replace(/^quill-heading-/, '') === decoded ||
      item.text.toLocaleLowerCase() === decoded.toLocaleLowerCase(),
  );
  return [
    ...new Set([
      `${namespace}-${decoded}`,
      `${namespace}-quill-block-${decoded.replace(/^\^/, '')}`,
      ...(heading ? [`${namespace}-${heading.id}`] : []),
    ]),
  ];
}
export function quillNodeCount(nodes: readonly QuillNode[]): number {
  const stack = [...nodes];
  let count = 0;
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    count++;
    if (node.type === 'element') stack.push(...node.children);
  }
  return count;
}
export function createQuillEmbedBudget() {
  const active = new Map<string, number>();
  let nodes = 0;
  return {
    claimed: new Set<string>(),
    bytes: 0,
    acquire(id: string): boolean {
      if (active.has(id)) return true;
      if (active.size >= 16) return false;
      active.set(id, 0);
      return true;
    },
    render(id: string, count: number): boolean {
      const old = active.get(id);
      if (old === undefined || nodes - old + count > 50_000) return false;
      nodes += count - old;
      active.set(id, count);
      return true;
    },
    release(id: string) {
      nodes -= active.get(id) ?? 0;
      active.delete(id);
    },
  };
}
export type QuillEmbedBudget = ReturnType<typeof createQuillEmbedBudget>;

/** Only self-contained diagrams; these Mermaid constructs may request external assets during layout. */
export function quillDiagramSourceAllowed(source: string): boolean {
  return (
    source.length <= 32_768 &&
    !(
      source.includes('%%{') ||
      /^\s*---(?:\r?\n)/.test(source) ||
      source.includes('@{') ||
      /(?:^|[\n;])\s*(?:properties|details)\b/i.test(source) ||
      /<\s*(?:img|image|iframe|object|style|link)\b/i.test(source) ||
      /url\s*\(/i.test(source) ||
      /(?:^|[\n;])\s*(?:style|classDef|linkStyle)\b[^\n;]*\\/i.test(source)
    )
  );
}
