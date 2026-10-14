import { parse, type ValueNode } from '@humanwhocodes/momoa';
import { previewLimits } from '../core/limits.js';
import {
  type JsonAction,
  type JsonCopyKind,
  type JsonDetail,
  type JsonFailure,
  type JsonView,
  jsonWindowLimits,
} from './json-protocol.js';

interface IndexedNode {
  id: number;
  end: number;
  kind: string;
  key?: string;
  decoded?: string;
  parent: number | null;
  depth: number;
  children: number[];
  subtreeEnd: number;
  position: number;
  setSize: number;
  ambiguous: boolean;
  line: number;
  column: number;
}

function sourceChunk(text: string, requestedStart: number, limit: number, maximum = text.length) {
  const insidePair = (index: number) => {
    const previous = text.charCodeAt(index - 1);
    const current = text.charCodeAt(index);
    return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
  };
  const offset =
    Math.min(maximum, requestedStart) - (insidePair(Math.min(maximum, requestedStart)) ? 1 : 0);
  let end = Math.min(maximum, offset + limit);
  if (insidePair(end)) end--;
  return { offset, text: text.slice(offset, end) };
}

export function jsonFailure(error: unknown): JsonFailure {
  if (error instanceof Error && error.message === 'json_timeout')
    return { code: 'viewer.jsonTimeout' };
  if (error instanceof Error && error.message === 'json_bytes')
    return { code: 'viewer.jsonTooLarge' };
  if (error instanceof RangeError) return { code: 'viewer.jsonComplex' };
  const location = error as { line?: unknown; column?: unknown } | null;
  return {
    code: 'viewer.jsonInvalid',
    ...(typeof location?.line === 'number' ? { line: location.line } : {}),
    ...(typeof location?.column === 'number' ? { column: location.column } : {}),
  };
}

/** Worker-resident source and index. Never evaluate numbers or materialize objects by their keys. */
export class JsonTreeModel {
  private readonly nodes: IndexedNode[] = [];
  private readonly byId = new Map<number, number>();
  private readonly expanded = new Set<number>();
  private visible: number[] = [];
  private selected = 0;
  private matches: number[] = [];
  private matched = new Set<number>();
  private matchIndex = -1;
  private offset = 0;
  private limit = 80;

  constructor(
    private readonly source: string,
    extension: string,
  ) {
    if (new TextEncoder().encode(source).byteLength > previewLimits.jsonBytes)
      throw new Error('json_bytes');
    const deadline = performance.now() + previewLimits.jsonParseMs;
    const mode = extension === 'json5' ? 'json5' : extension === 'jsonc' ? 'jsonc' : 'json';
    const document = parse(source, { mode, ranges: true, allowTrailingCommas: mode !== 'json' });
    const visit = (
      value: ValueNode,
      parent: number | null,
      depth: number,
      position: number,
      setSize: number,
      ambiguous: boolean,
      key?: string,
    ): number => {
      if (this.nodes.length >= previewLimits.jsonNodes || depth > previewLimits.jsonDepth)
        throw new RangeError('json_complex');
      if (performance.now() > deadline) throw new Error('json_timeout');
      const index = this.nodes.length;
      const node: IndexedNode = {
        id: value.loc.start.offset,
        end: value.loc.end.offset,
        kind: value.type,
        key,
        decoded: value.type === 'String' ? value.value : undefined,
        parent,
        depth,
        children: [],
        subtreeEnd: index + 1,
        position,
        setSize,
        ambiguous,
        line: value.loc.start.line,
        column: value.loc.start.column,
      };
      this.nodes.push(node);
      this.byId.set(node.id, index);
      if (value.type === 'Object') {
        const names = value.members.map((member) =>
          member.name.type === 'Identifier' ? member.name.name : member.name.value,
        );
        const counts = new Map<string, number>();
        for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
        value.members.forEach((member, child) => {
          const name = names[child] ?? '';
          node.children.push(
            visit(
              member.value,
              index,
              depth + 1,
              child + 1,
              value.members.length,
              ambiguous || (counts.get(name) ?? 0) > 1,
              name,
            ),
          );
        });
      } else if (value.type === 'Array') {
        value.elements.forEach((element, child) => {
          node.children.push(
            visit(
              element.value,
              index,
              depth + 1,
              child + 1,
              value.elements.length,
              ambiguous,
              String(child),
            ),
          );
        });
      }
      node.subtreeEnd = this.nodes.length;
      return index;
    };
    visit(document.body, null, 0, 1, 1, false);
    this.expanded.add(0);
    this.rebuild();
  }

  private node(index: number): IndexedNode {
    const node = this.nodes[index];
    if (!node) throw new Error('json_node');
    return node;
  }

  private index(id: number): number {
    const index = this.byId.get(id);
    if (index === undefined) throw new Error('json_node');
    return index;
  }

  private rebuild(): void {
    this.visible = [];
    for (let index = 0; index < this.nodes.length; ) {
      this.visible.push(index);
      index = this.expanded.has(index) ? index + 1 : this.node(index).subtreeEnd;
    }
    // A collapsed ancestor must retain a visible selection.
    while (!this.visible.includes(this.selected))
      this.selected = this.node(this.selected).parent ?? 0;
  }

  private reveal(index: number): void {
    this.selected = index;
    let changed = false;
    let parent = this.node(index).parent;
    while (parent !== null) {
      changed ||= !this.expanded.has(parent);
      this.expanded.add(parent);
      parent = this.node(parent).parent;
    }
    if (changed) this.rebuild();
  }

  view(offset = this.offset, limit = this.limit): JsonView {
    this.limit = Math.max(
      1,
      Math.min(jsonWindowLimits.rows, Number.isFinite(limit) ? Math.floor(limit) : 80),
    );
    this.offset = Math.max(
      0,
      Math.min(
        Math.max(0, this.visible.length - 1),
        Number.isFinite(offset) ? Math.floor(offset) : 0,
      ),
    );
    return {
      rows: this.visible.slice(this.offset, this.offset + this.limit).map((index, rowIndex) => {
        const node = this.node(index);
        const container = node.kind === 'Object' || node.kind === 'Array';
        const preview = container
          ? node.kind === 'Object'
            ? '{…}'
            : '[…]'
          : sourceChunk(this.source, node.id, jsonWindowLimits.preview, node.end).text;
        return {
          id: node.id,
          index: this.offset + rowIndex,
          parentId: node.parent === null ? null : this.node(node.parent).id,
          key:
            node.key === undefined
              ? undefined
              : sourceChunk(node.key, 0, jsonWindowLimits.key).text,
          keyTruncated: (node.key?.length ?? 0) > jsonWindowLimits.key,
          kind: node.kind,
          preview,
          previewTruncated: !container && node.end - node.id > jsonWindowLimits.preview,
          depth: node.depth,
          childCount: node.children.length,
          expanded: this.expanded.has(index),
          selected: this.selected === index,
          matched: this.matched.has(index),
          position: node.position,
          setSize: node.setSize,
        };
      }),
      totalVisible: this.visible.length,
      totalNodes: this.nodes.length,
      offset: this.offset,
      selectedId: this.node(this.selected).id,
      selectedIndex: this.visible.indexOf(this.selected),
      matchCount: this.matches.length,
      matchIndex: this.matchIndex,
    };
  }

  action(action: JsonAction): JsonView {
    if (action.type === 'search') {
      const query = action.query.trim().slice(0, 1024).toLocaleLowerCase();
      this.matches = [];
      if (query)
        this.nodes.forEach((node, index) => {
          const value =
            node.decoded ??
            (node.kind === 'Object' || node.kind === 'Array'
              ? ''
              : this.source.slice(node.id, node.end));
          if (
            node.key?.toLocaleLowerCase().includes(query) ||
            value.toLocaleLowerCase().includes(query)
          )
            this.matches.push(index);
        });
      this.matched = new Set(this.matches);
      this.matchIndex = this.matches.length ? 0 : -1;
      const first = this.matches[0];
      if (first !== undefined) this.reveal(first);
    } else if (action.type === 'match') {
      if (this.matches.length) {
        this.matchIndex =
          (this.matchIndex + action.direction + this.matches.length) % this.matches.length;
        const next = this.matches[this.matchIndex];
        if (next !== undefined) this.reveal(next);
      }
    } else if (action.type === 'collapseAll') {
      this.expanded.clear();
      this.selected = 0;
      this.rebuild();
    } else if (action.type === 'move') {
      const position = this.visible.indexOf(this.selected);
      const node = this.node(this.selected);
      let changed = false;
      if (action.direction === 'parent') {
        if (this.expanded.has(this.selected) && node.children.length) {
          this.expanded.delete(this.selected);
          changed = true;
        } else this.selected = node.parent ?? this.selected;
      } else if (action.direction === 'child') {
        if (node.children.length && !this.expanded.has(this.selected)) {
          this.expanded.add(this.selected);
          changed = true;
        } else this.selected = node.children[0] ?? this.selected;
      } else {
        const next =
          action.direction === 'first'
            ? 0
            : action.direction === 'last'
              ? this.visible.length - 1
              : position + (action.direction === 'next' ? 1 : -1);
        this.selected =
          this.visible[Math.max(0, Math.min(this.visible.length - 1, next))] ?? this.selected;
      }
      if (changed) this.rebuild();
    } else {
      const index = this.index(action.id);
      if (action.type === 'select') this.reveal(index);
      else {
        if (action.type === 'collapse' || (action.type === 'toggle' && this.expanded.has(index)))
          this.expanded.delete(index);
        else if (this.node(index).children.length) this.expanded.add(index);
        this.rebuild();
      }
    }
    return this.view();
  }

  private pointer(index: number): string {
    const parts: string[] = [];
    let node = this.node(index);
    while (node.parent !== null) {
      parts.push((node.key ?? '').replaceAll('~', '~0').replaceAll('/', '~1'));
      node = this.node(node.parent);
    }
    return parts.length ? `/${parts.reverse().join('/')}` : '';
  }

  detail(id: number, offset = 0, limit: number = jsonWindowLimits.detail): JsonDetail {
    const index = this.index(id);
    const node = this.node(index);
    const pointer = this.pointer(index);
    const start = Math.max(
      0,
      Math.min(
        Math.max(node.end - node.id, node.decoded?.length ?? 0),
        Number.isFinite(offset) ? Math.floor(offset) : 0,
      ),
    );
    const size = Math.max(
      1,
      Math.min(
        jsonWindowLimits.detail,
        Number.isFinite(limit) ? Math.floor(limit) : jsonWindowLimits.detail,
      ),
    );
    const raw = sourceChunk(this.source, node.id + start, size, node.end);
    const decoded = node.decoded === undefined ? undefined : sourceChunk(node.decoded, start, size);
    return {
      id,
      kind: node.kind,
      pointer: sourceChunk(pointer, 0, jsonWindowLimits.pointer).text,
      pointerTruncated: pointer.length > jsonWindowLimits.pointer,
      pointerAmbiguous: node.ambiguous,
      raw: raw.text,
      ...(decoded !== undefined
        ? {
            decoded: decoded.text,
            decodedOffset: decoded.offset,
            decodedTotalLength: node.decoded?.length,
          }
        : {}),
      offset: raw.offset - node.id,
      totalLength: node.end - node.id,
      line: node.line,
      column: node.column,
      childCount: node.children.length,
    };
  }

  copy(id: number, kind: JsonCopyKind): string {
    const index = this.index(id);
    const node = this.node(index);
    if (kind === 'pointer') return this.pointer(index);
    if ((kind === 'decoded' || kind === 'value') && node.decoded !== undefined) return node.decoded;
    return this.source.slice(node.id, node.end);
  }
}
