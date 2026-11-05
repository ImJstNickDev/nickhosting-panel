import { describe, expect, it } from 'vitest';
import { cachedParseSaveHeader, parseSaveHeader } from './save-header.js';

function fixture(version = 14, wide = false) {
  const parts: Buffer[] = [];
  const int = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32LE(value);
    parts.push(bytes);
  };
  const string = (value: string) => {
    const bytes = Buffer.from(`${value}\0`, wide ? 'utf16le' : 'utf8');
    int(wide ? -bytes.length / 2 : bytes.length);
    parts.push(bytes);
  };
  int(version);
  int(51);
  int(500000);
  if (version >= 14) string('Save');
  string('Persistent_Level');
  string('');
  string('Factory');
  int(3661);
  const date = Buffer.alloc(9);
  date.writeBigInt64LE(621355968000000000n + 1700000000000n * 10000n);
  parts.push(date);
  return Buffer.concat(parts);
}
describe('Satisfactory bounded save header', () => {
  it.each([false, true])(
    'reads native narrow/wide strings without reading world payload %s',
    (wide) => {
      expect(parseSaveHeader(fixture(14, wide))).toMatchObject({
        sessionName: 'Factory',
        saveName: 'Save',
        playDurationSeconds: 3661,
        savedAt: '2023-11-14T22:13:20.000Z',
      });
    },
  );
  it('supports earlier header layout without save name', () =>
    expect(parseSaveHeader(fixture(13)).saveName).toBeUndefined());
  it('rejects future formats and every truncated prefix', () => {
    expect(() => parseSaveHeader(fixture(15))).toThrow('unsupported');
    const bytes = fixture();
    for (let length = 0; length < bytes.length; length++)
      expect(() => parseSaveHeader(bytes.subarray(0, length))).toThrow();
  });
  it('rejects oversized strings and missing terminators', () => {
    const bytes = fixture();
    bytes.writeInt32LE(1000000, 12);
    expect(() => parseSaveHeader(bytes)).toThrow();
    const corrupt = fixture();
    corrupt[20] = 65;
    expect(() => parseSaveHeader(corrupt)).toThrow();
  });
});

it('memoizes parsed metadata without mutating shared prefix bytes', () => {
  const bytes = fixture();
  const original = Buffer.from(bytes);
  const first = cachedParseSaveHeader(bytes);
  expect(cachedParseSaveHeader(bytes)).toBe(first);
  expect(Object.isFrozen(first)).toBe(true);
  expect(bytes).toEqual(original);
});
