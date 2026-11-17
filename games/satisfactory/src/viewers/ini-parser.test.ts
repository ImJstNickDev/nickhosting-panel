import { describe, expect, it } from 'vitest';
import { iniReadLimit, parseIni } from './ini-parser.js';

const read = (text: string) => parseIni(new TextEncoder().encode(text));
describe('Unreal INI source inspection', () => {
  it('retains ordering, repeated sections and keys, comments and blank lines', () => {
    const source =
      '; comment\r\n[Core.Log]\r\nLogTemp=warning\r\nLogTemp=error\r\n\r\n[Core.Log]\r\n;LogTemp=disabled\r\n';
    const lines = read(source);
    expect(`${lines.map((line) => line.raw).join('\r\n')}\r\n`).toBe(source);
    expect(lines.map((line) => line.kind)).toEqual([
      'comment',
      'section',
      'entry',
      'entry',
      'blank',
      'section',
      'comment',
    ]);
    expect(lines[5]).toMatchObject({ line: 6, name: 'Core.Log' });
  });
  it('annotates array operations without evaluating or flattening them', () => {
    expect(
      read('[X]\nItems=1\n+Items=2\n.Items=2\n-Items=2\n!Items=ClearArray')
        .slice(1)
        .map(
          (line) => line.kind === 'entry' && [line.operator, line.operation, line.key, line.value],
        ),
    ).toEqual([
      ['', 'set', 'Items', '1'],
      ['+', 'append', 'Items', '2'],
      ['.', 'duplicate', 'Items', '2'],
      ['-', 'remove', 'Items', '2'],
      ['!', 'clear', 'Items', 'ClearArray'],
    ]);
  });
  it('keeps quoted, structured, empty and semicolon-containing values verbatim', () => {
    const lines = read(
      '[X]\nText="a;b=c"\nStruct=(A=1,B="two")\nEmpty=\nWhitespace=  x  \nRaw=a ; retained',
    );
    expect(lines.slice(1).map((line) => line.kind === 'entry' && line.value)).toEqual([
      '"a;b=c"',
      '(A=1,B="two")',
      '',
      '  x  ',
      'a ; retained',
    ]);
  });
  it('retains malformed and out-of-section lines as unrecognized', () => {
    const lines = read('Outside=yes\n[X]\nNot a key\n=missing\n+=empty\n[broken\n#not_a_comment');
    expect(lines.filter((line) => line.kind === 'unrecognized')).toHaveLength(6);
    expect(lines.at(-1)?.raw).toBe('#not_a_comment');
  });
  it('reads UTF-8 BOM and BOM-marked UTF-16 in either byte order', () => {
    const text = '[X]\nName=工場';
    expect(read(`\uFEFF${text}`)).toEqual(read(text));
    for (const littleEndian of [true, false]) {
      const bytes = new Uint8Array((text.length + 1) * 2);
      const view = new DataView(bytes.buffer);
      view.setUint16(0, 0xfeff, littleEndian);
      [...text].forEach((char, index) => {
        view.setUint16((index + 1) * 2, char.charCodeAt(0), littleEndian);
      });
      expect(parseIni(bytes)).toEqual(read(text));
    }
  });
  it('rejects truncated, invalid or binary data rather than showing corrupt metadata', () => {
    expect(() => parseIni(new Uint8Array(iniReadLimit))).toThrow('ini_too_large');
    expect(() => parseIni(new Uint8Array([0xc3]))).toThrow();
    expect(() => parseIni(new Uint8Array([0xff, 0xfe, 0x41]))).toThrow();
    expect(() => read('[X]\nName=\0')).toThrow('ini_invalid_encoding');
    expect(parseIni(new Uint8Array())).toEqual([]);
  });
});
