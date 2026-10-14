import type { Root as HastRoot, RootContent } from 'hast';
import type { Root as MarkdownRoot } from 'mdast';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as SanitizeOptions } from 'rehype-sanitize';
import { defListHastHandlers, remarkDefinitionList } from 'remark-definition-list';
import remarkEmoji from 'remark-emoji';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { parse as parseToml } from 'smol-toml';
import { unified } from 'unified';
import { parseDocument } from 'yaml';
import { quillMath } from './math.js';
import { QUILL_LIMITS, type QuillModel, type QuillNode, quillHeadingSlug } from './model';

interface AstNode {
  type: string;
  value?: string;
  depth?: number;
  lang?: string | null;
  meta?: string | null;
  checked?: boolean | null;
  children?: AstNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkMath)
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .use(remarkDefinitionList);

const schema: SanitizeOptions = {
  ...defaultSchema,
  // Raw HTML cannot establish DOM globals. Generated headings receive the same prefix.
  clobberPrefix: 'quill-',
  tagNames: [...(defaultSchema.tagNames ?? []), 'mark', 'details', 'summary', 'dl', 'dt', 'dd'],
  attributes: {
    ...defaultSchema.attributes,
    '*': [
      ...(defaultSchema.attributes?.['*'] ?? []),
      'dataQuillReference',
      'dataQuillTask',
      'dataCallout',
      'dataCalloutTitle',
      'dataCalloutFold',
      'dataLanguage',
      'dataFilename',
      'dataLineNumbers',
      'dataHighlightLines',
      'dataMermaid',
    ],
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    details: ['open'],
    img: [...(defaultSchema.attributes?.img ?? []), 'width', 'height'],
  },
};

const renderer = unified()
  .use(remarkEmoji, { accessible: false })
  .use(remarkRehype, { allowDangerousHtml: true, handlers: defListHastHandlers })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  .use(rehypeHighlight, { detect: false, ignoreMissing: true })
  // Only this trusted generator may add the styles/MathML/SVG that raw HTML cannot.
  .use(quillMath);

function text(node: AstNode): string {
  return node.value ?? node.children?.map(text).join('') ?? '';
}

function annotate(node: AstNode, properties: Record<string, unknown>): void {
  node.data = { ...node.data, hProperties: { ...node.data?.hProperties, ...properties } };
}

function boundAst(root: AstNode): void {
  const pending: [AstNode, number][] = [[root, 0]];
  let count = 0;
  while (pending.length) {
    const [node, depth] = pending.pop() as [AstNode, number];
    if (++count > QUILL_LIMITS.nodes || depth > QUILL_LIMITS.depth)
      throw new Error('markdown_limit');
    for (const child of node.children ?? []) pending.push([child, depth + 1]);
  }
}

function extensionNode(
  tag: string,
  value: string,
  properties: Record<string, unknown> = {},
): AstNode {
  return {
    type: 'quillInline',
    data: { hName: tag, hProperties: properties },
    children: [{ type: 'text', value }],
  };
}

function inlineExtensions(node: AstNode, source: string, model: QuillModel): AstNode[] {
  const value = node.value ?? '';
  const base = node.position?.start.offset ?? 0;
  const raw = source.slice(base, node.position?.end.offset);
  const pattern =
    /!?\[\[([^\]\n]+)\]\]|==([^=\n]+)==|\^([^\s^]+)\^|(?<!~)~([^\s~]+)~(?!~)|\[((?:-?@[\w:./-]+(?:[^\]\n]*)))\]/g;
  const children: AstNode[] = [];
  let consumed = 0;
  let rawCursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index;
    // CommonMark resolves escapes/entities in text. Match the unchanged syntax in
    // its source span so escaped delimiters stay literal and offsets remain exact.
    const rawIndex = raw.indexOf(match[0], rawCursor);
    if (rawIndex < 0) continue;
    rawCursor = rawIndex + match[0].length;
    let escapes = 0;
    for (let cursor = rawIndex - 1; cursor >= 0 && raw[cursor] === '\\'; cursor--) escapes++;
    if (escapes % 2) continue;
    if (index > consumed) children.push({ type: 'text', value: value.slice(consumed, index) });
    const offset = base + rawIndex;
    if (match[1]) {
      const [target = '', ...alias] = match[1].split('|');
      const label = alias.join('|') || target;
      const id = `reference-${model.references.length}`;
      if (model.references.length >= QUILL_LIMITS.references) throw new Error('markdown_limit');
      model.references.push({
        id,
        kind: match[0].startsWith('!') ? 'embed' : 'link',
        target: target.trim(),
        label,
        offset,
      });
      children.push(extensionNode('span', label, { dataQuillReference: id }));
    } else if (match[2]) children.push(extensionNode('mark', match[2]));
    else if (match[3]) children.push(extensionNode('sup', match[3]));
    else if (match[4]) children.push(extensionNode('sub', match[4]));
    else if (match[5]) {
      const citations = match[5].split(';').map((part) => part.trim());
      children.push({ type: 'text', value: '[' });
      for (const [i, citation] of citations.entries()) {
        const key = /^-?@([\w:./-]+)(.*)$/.exec(citation);
        if (i) children.push({ type: 'text', value: '; ' });
        if (!key) {
          children.push({ type: 'text', value: citation });
          continue;
        }
        if (model.references.length >= QUILL_LIMITS.references) throw new Error('markdown_limit');
        const id = `reference-${model.references.length}`;
        model.references.push({
          id,
          kind: 'citation',
          target: key[1] ?? '',
          label: citation,
          offset,
        });
        children.push(extensionNode('span', citation, { dataQuillReference: id }));
      }
      children.push({ type: 'text', value: ']' });
    }
    consumed = index + match[0].length;
  }
  if (!consumed) return [node];
  if (consumed < value.length) children.push({ type: 'text', value: value.slice(consumed) });
  return children;
}

function metadata(node: AstNode, model: QuillModel): void {
  const value = node.value ?? '';
  if (new TextEncoder().encode(value).byteLength > QUILL_LIMITS.metadataBytes) {
    model.warnings.push('metadata_limit');
    return;
  }
  try {
    let parsed: unknown;
    if (node.type === 'yaml') {
      const document = parseDocument(value, { uniqueKeys: true });
      if (document.errors.length) throw new Error('metadata_invalid');
      parsed = document.toJS({ maxAliasCount: 0 });
    } else parsed = parseToml(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('metadata_invalid');
    model.metadata = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
  } catch {
    model.warnings.push('metadata_invalid');
  }
}

function transform(root: AstNode, source: string, model: QuillModel): void {
  const slugs = new Map<string, number>();
  function walk(node: AstNode, parent?: AstNode): void {
    const offset = node.position?.start.offset ?? 0;
    if (node.type === 'yaml' || node.type === 'toml') metadata(node, model);
    if (node.type === 'heading') {
      const title = text(node);
      const slug = quillHeadingSlug(title) || 'section';
      const duplicate = slugs.get(slug) ?? 0;
      slugs.set(slug, duplicate + 1);
      const id = `heading-${slug}${duplicate ? `-${duplicate}` : ''}`;
      annotate(node, { id });
      model.headings.push({ id: `quill-${id}`, text: title, depth: node.depth ?? 1, offset });
    }
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      const prefix = source.slice(offset, Math.min(source.length, offset + 80));
      const marker = /^(?:[-+*]|\d+[.)])\s+\[([ xX])\]/.exec(prefix);
      if (marker) {
        const id = `task-${model.tasks.length}`;
        const checkboxOffset = offset + marker[0].lastIndexOf('[') + 1;
        model.tasks.push({ id, offset: checkboxOffset, checked: node.checked });
        annotate(node, { dataQuillTask: id });
      }
    }
    if (node.type === 'code') {
      const language = (node.lang ?? '').slice(0, 64);
      const meta = (node.meta ?? '').slice(0, 1024);
      const filename = /(?:title|filename)="([^"]{1,256})"/.exec(meta)?.[1];
      const highlight = /\{([\d, -]{1,128})\}/.exec(meta)?.[1];
      annotate(node, {
        dataLanguage: language,
        ...(filename ? { dataFilename: filename } : {}),
        ...(/\bshowLineNumbers\b/.test(meta) ? { dataLineNumbers: true } : {}),
        ...(highlight ? { dataHighlightLines: highlight } : {}),
        ...(language === 'mermaid' ? { dataMermaid: node.value ?? '' } : {}),
      });
    }
    if (node.type === 'blockquote') {
      const first = node.children?.[0]?.children?.[0];
      const match =
        first?.type === 'text'
          ? /^\[!([A-Za-z][\w-]{0,30})\]([+-])?(?:[ \t]+([^\n]+))?(?:\n|$)/.exec(first.value ?? '')
          : null;
      if (match && first) {
        annotate(node, {
          dataCallout: match[1]?.toLowerCase(),
          dataCalloutTitle: match[3] ?? '',
          dataCalloutFold: match[2] ?? '',
        });
        first.value = (first.value ?? '').slice(match[0].length);
        // Offset still refers to the original string: avoid reinterpreting the shortened text as markup.
      }
    }
    if (node.type === 'paragraph') {
      const last = node.children?.at(-1);
      const block = last?.type === 'text' ? /(?:^|\s)\^([\w-]+)\s*$/.exec(last.value ?? '') : null;
      if (block && last) {
        annotate(node, { id: `block-${block[1]}` });
        last.value = (last.value ?? '').slice(0, block.index);
      }
    }
    if (!node.children) return;
    const next: AstNode[] = [];
    for (const child of node.children) {
      if (child.type === 'yaml' || child.type === 'toml') {
        metadata(child, model);
        continue;
      }
      walk(child, node);
      if (
        child.type === 'text' &&
        node.type !== 'link' &&
        node.type !== 'linkReference' &&
        parent?.type !== 'link'
      )
        next.push(...inlineExtensions(child, source, model));
      else next.push(child);
    }
    node.children = next;
    if (
      node.type === 'paragraph' &&
      next.some((child) => {
        const id = child.data?.hProperties?.dataQuillReference;
        return (
          typeof id === 'string' &&
          model.references[Number(id.slice('reference-'.length))]?.kind === 'embed'
        );
      })
    )
      node.data = { ...node.data, hName: 'div' };
  }
  walk(root);
}

function serialize(tree: HastRoot): QuillNode[] {
  let count = 0;
  function node(value: RootContent, depth: number, task?: string): QuillNode | undefined {
    if (++count > QUILL_LIMITS.nodes * 3 || depth > QUILL_LIMITS.depth)
      throw new Error('markdown_limit');
    const location = { start: value.position?.start.offset, end: value.position?.end.offset };
    if (value.type === 'text') return { type: 'text', value: value.value, ...location };
    if (value.type !== 'element') return undefined;
    const properties: Record<string, string | number | boolean | string[] | undefined> = {};
    for (const [key, property] of Object.entries(value.properties)) {
      if (key === 'dataLineNumbers') {
        properties[key] = true;
        continue;
      }
      if (
        typeof property === 'string' ||
        typeof property === 'number' ||
        typeof property === 'boolean'
      )
        properties[key] = property;
      else if (Array.isArray(property)) properties[key] = property.map(String);
    }
    const taskId = typeof properties.dataQuillTask === 'string' ? properties.dataQuillTask : task;
    if (value.tagName === 'input' && taskId) properties.dataQuillTask = taskId;
    const children = value.children.flatMap((child) => {
      const result = node(child, depth + 1, taskId);
      return result ? [result] : [];
    });
    return { type: 'element', tagName: value.tagName, properties, children, ...location };
  }
  return tree.children.flatMap((child) => {
    const result = node(child, 0);
    return result ? [result] : [];
  });
}

function normalizeAnchors(nodes: QuillNode[]): void {
  const pending = [...nodes];
  const ids = new Set<string>();
  const links: Extract<QuillNode, { type: 'element' }>[] = [];
  while (pending.length) {
    const item = pending.pop();
    if (item?.type !== 'element') continue;
    if (typeof item.properties.id === 'string') ids.add(item.properties.id);
    if (
      item.tagName === 'a' &&
      typeof item.properties.href === 'string' &&
      item.properties.href.startsWith('#')
    )
      links.push(item);
    pending.push(...item.children);
  }
  for (const link of links) {
    let fragment: string;
    try {
      fragment = decodeURIComponent(String(link.properties.href).slice(1));
    } catch {
      continue;
    }
    const target = [
      fragment,
      `quill-${fragment}`,
      `quill-heading-${quillHeadingSlug(fragment)}`,
    ].find((candidate) => ids.has(candidate));
    if (target) link.properties.href = `#${target}`;
  }
}

/** CPU-heavy parsing belongs in worker.ts. The same function is deterministic in fixtures. */
export async function parseMarkdown(source: string): Promise<QuillModel> {
  if (new TextEncoder().encode(source).byteLength > QUILL_LIMITS.sourceBytes)
    throw new Error('markdown_limit');
  const model: QuillModel = {
    children: [],
    headings: [],
    metadata: null,
    references: [],
    tasks: [],
    warnings: [],
  };
  const tree = parser.parse(source);
  const parsed = await parser.run(tree);
  // remark consumes the leading BOM before assigning positions; shared editor offsets include it.
  if (source.startsWith('\uFEFF')) {
    const pending = [parsed as unknown as AstNode];
    while (pending.length) {
      const current = pending.pop() as AstNode;
      if (current.position?.start.offset !== undefined) current.position.start.offset++;
      if (current.position?.end.offset !== undefined) current.position.end.offset++;
      pending.push(...(current.children ?? []));
    }
  }
  boundAst(parsed as unknown as AstNode);
  transform(parsed as unknown as AstNode, source, model);
  boundAst(parsed as unknown as AstNode);
  const result = await renderer.run(parsed as MarkdownRoot);
  model.children = serialize(result as unknown as HastRoot);
  normalizeAnchors(model.children);
  return model;
}
