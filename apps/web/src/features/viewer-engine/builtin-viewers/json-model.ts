import { parse, type ValueNode } from '@humanwhocodes/momoa';
import { previewLimits } from '../core/limits.js';

export interface JsonTreeNode {
  offset: number;
  kind: string;
  raw: string;
  key?: string;
  children?: JsonTreeNode[];
}

/** Never evaluate the AST: large integers, duplicate keys and JSON5 numeric lexemes remain exact. */
export function parseJsonTree(text: string, extension: string): JsonTreeNode {
  const mode = extension === 'json5' ? 'json5' : extension === 'jsonc' ? 'jsonc' : 'json';
  const document = parse(text, { mode, ranges: true, allowTrailingCommas: mode !== 'json' });
  let count = 0;
  function convert(node: ValueNode, depth: number, key?: string): JsonTreeNode {
    if (++count > previewLimits.jsonNodes || depth > previewLimits.jsonDepth)
      throw new RangeError('json_complex');
    const value: JsonTreeNode = { offset: node.loc.start.offset, kind: node.type, raw: '', key };
    if (node.type === 'Object')
      value.children = node.members.map((member) =>
        convert(
          member.value,
          depth + 1,
          member.name.type === 'Identifier' ? member.name.name : member.name.value,
        ),
      );
    else if (node.type === 'Array')
      value.children = node.elements.map((element, index) =>
        convert(element.value, depth + 1, String(index)),
      );
    else value.raw = text.slice(node.loc.start.offset, node.loc.end.offset);
    return value;
  }
  return convert(document.body, 0);
}
