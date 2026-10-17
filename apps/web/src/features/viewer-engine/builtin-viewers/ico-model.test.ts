import { describe, expect, it } from 'vitest';
import { validateIconset } from './ico-model.js';

function fixture() {
  const bytes = new Uint8Array(46);
  const data = new DataView(bytes.buffer);
  data.setUint16(2, 1, true);
  data.setUint16(4, 1, true);
  data.setUint8(6, 16);
  data.setUint8(7, 16);
  data.setUint32(14, 24, true);
  data.setUint32(18, 22, true);
  data.setUint32(22, 0x89504e47);
  data.setUint32(26, 0x0d0a1a0a);
  data.setUint32(38, 16);
  data.setUint32(42, 16);
  return { bytes, data };
}
describe('iconset preview envelope', () => {
  it('bounds DIB dimensions before the decoder allocates image pixels', () => {
    const bytes = new Uint8Array(62),
      data = new DataView(bytes.buffer);
    data.setUint16(2, 1, true);
    data.setUint16(4, 1, true);
    data.setUint8(6, 16);
    data.setUint8(7, 16);
    data.setUint32(14, 40, true);
    data.setUint32(18, 22, true);
    data.setUint32(22, 40, true);
    data.setInt32(26, 16, true);
    data.setInt32(30, 32, true);
    data.setUint16(34, 1, true);
    data.setUint16(36, 32, true);
    expect(() => validateIconset(bytes)).not.toThrow();
    data.setInt32(26, 1_000_000, true);
    expect(() => validateIconset(bytes)).toThrow();
    data.setInt32(26, 16, true);
    data.setInt32(30, -32, true);
    expect(() => validateIconset(bytes)).toThrow();
    data.setInt32(30, 32, true);
    data.setUint32(22, 400, true);
    expect(() => validateIconset(bytes)).toThrow();
  });
  it('accepts a bounded icon image and rejects oversized collections', () => {
    const { bytes, data } = fixture();
    expect(() => validateIconset(bytes)).not.toThrow();
    data.setUint16(4, 257, true);
    expect(() => validateIconset(bytes)).toThrow();
  });
  it('rejects overlapping/out-of-file payloads and deceptive PNG dimensions before decode', () => {
    const first = fixture();
    first.data.setUint32(18, 0, true);
    expect(() => validateIconset(first.bytes)).toThrow();
    const second = fixture();
    second.data.setUint32(14, 500, true);
    expect(() => validateIconset(second.bytes)).toThrow();
    const third = fixture();
    third.data.setUint32(38, 100_000);
    expect(() => validateIconset(third.bytes)).toThrow();
  });
});
