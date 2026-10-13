import { describe, expect, it } from 'vitest';
import { parseJsonTree } from './json-model.js';

describe('read-only JSON trees', () => {
  it('preserves lexical numbers beyond IEEE754, duplicate keys and prototype-like names', () => {
    const tree = parseJsonTree(
      '{"n":9007199254740993123456789,"n":1.234567890123456789,"__proto__":null}',
      'json',
    );
    expect(tree.children?.map((child) => [child.key, child.raw])).toEqual([
      ['n', '9007199254740993123456789'],
      ['n', '1.234567890123456789'],
      ['__proto__', 'null'],
    ]);
    expect(new Set(tree.children?.map((child) => child.offset)).size).toBe(3);
  });
  it('accepts JSONC comments/trailing commas and JSON5 literals without evaluating values', () => {
    expect(parseJsonTree('{/* a */"ok":true,}', 'jsonc').children?.[0]?.raw).toBe('true');
    const tree = parseJsonTree("{bare:'value', hex:0xabcdef, inf:-Infinity, n:NaN,}", 'json5');
    expect(tree.children?.map((child) => child.raw)).toEqual([
      "'value'",
      '0xabcdef',
      '-Infinity',
      'NaN',
    ]);
    expect(() => parseJsonTree('{/* a */"ok":true}', 'json')).toThrow();
  });
  it('rejects script expressions and bounds nesting and node count', () => {
    expect(() => parseJsonTree('{"run":alert(1)}', 'json5')).toThrow();
    expect(() => parseJsonTree(`${'['.repeat(130)}0${']'.repeat(130)}`, 'json')).toThrow();
    expect(() =>
      parseJsonTree(`[${Array.from({ length: 100_001 }, () => '0').join(',')}]`, 'json'),
    ).toThrow();
  });
});
