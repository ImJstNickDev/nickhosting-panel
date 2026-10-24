import { crc32, deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { normalizeProfilePhoto, profilePhotoMaxBytes } from './profile-photo-image.js';

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, 'latin1');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
function pieces(image: Buffer): { type: string; data: Buffer }[] {
  const result = [];
  for (let offset = 8; offset < image.length; ) {
    const size = image.readUInt32BE(offset);
    result.push({
      type: image.toString('ascii', offset + 4, offset + 8),
      data: Buffer.from(image.subarray(offset + 8, offset + 8 + size)),
    });
    offset += size + 12;
  }
  return result;
}
function encode(parts: ReturnType<typeof pieces>): Buffer {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ...parts.map(({ type, data }) => chunk(type, data)),
  ]);
}
function piece(parts: ReturnType<typeof pieces>, index: number) {
  const result = parts.at(index);
  if (!result) throw new Error('Missing PNG fixture chunk');
  return result;
}
const source = new PNG({ width: 256, height: 256 });
source.data.fill(255);
source.data.set([128, 24, 64, 100], 0);
const valid = PNG.sync.write(source);

describe('bounded profile photo normalization', () => {
  it('preserves RGBA pixels while discarding browser metadata', () => {
    const parts = pieces(valid);
    parts.splice(1, 0, { type: 'pHYs', data: Buffer.alloc(9) });
    parts.splice(1, 0, { type: 'gAMA', data: Buffer.from([0, 0, 177, 143]) });
    parts.splice(1, 0, { type: 'sRGB', data: Buffer.from([0]) });
    const normalized = normalizeProfilePhoto(encode(parts));
    expect(pieces(normalized).map(({ type }) => type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(PNG.sync.read(normalized).data).toEqual(source.data);
    expect(normalized.length).toBeLessThanOrEqual(profilePhotoMaxBytes);
  });

  it('strips Firefox deBG after IDAT and arbitrary ancillary bytes without decoding them', () => {
    const parts = pieces(valid);
    for (const type of ['iCCP', 'eXIf', 'tEXt', 'aBCD'])
      parts.splice(1, 0, { type, data: Buffer.from('not parsed or inflated') });
    parts.splice(-1, 0, { type: 'deBG', data: Buffer.alloc(16) });
    parts.splice(-1, 0, { type: 'zZAz', data: Buffer.from('private metadata') });
    const normalized = normalizeProfilePhoto(encode(parts));
    expect(pieces(normalized).map(({ type }) => type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(PNG.sync.read(normalized).data).toEqual(source.data);
    expect(normalized).toEqual(normalizeProfilePhoto(valid));
  });

  it('accepts opaque 8-bit RGB browser miniatures', () => {
    const rgb = PNG.sync.write(source, { colorType: 2 });
    const normalized = PNG.sync.read(normalizeProfilePhoto(rgb));
    expect(normalized).toMatchObject({ width: 256, height: 256 });
    expect(normalized.data[3]).toBe(255);
  });

  it('rejects non-images, truncation, oversize bodies and corrupt core CRCs', () => {
    const corrupt = Buffer.from(valid);
    corrupt[29] = (corrupt[29] ?? 0) ^ 1;
    for (const input of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      Buffer.from([255, 216, 255, 217]),
      Buffer.alloc(0),
      valid.subarray(0, -1),
      valid.subarray(0, 16),
      Buffer.concat([valid, Buffer.from([0])]),
      Buffer.alloc(profilePhotoMaxBytes + 1),
      corrupt,
    ])
      expect(() => normalizeProfilePhoto(input)).toThrow('validation_failed');
  });

  it('rejects oversized dimensions, wrong dimensions, unsupported depths and interlacing', () => {
    for (const change of [
      (header: Buffer) => header.writeUInt32BE(0xffffffff, 0),
      (header: Buffer) => header.writeUInt32BE(255, 4),
      (header: Buffer) => header.fill(16, 8, 9),
      (header: Buffer) => header.fill(3, 9, 10),
      (header: Buffer) => header.fill(1, 10, 11),
      (header: Buffer) => header.fill(1, 11, 12),
      (header: Buffer) => header.fill(1, 12, 13),
    ]) {
      const parts = pieces(valid);
      change(piece(parts, 0).data);
      expect(() => normalizeProfilePhoto(encode(parts))).toThrow('validation_failed');
    }
  });

  it('rejects duplicate or misplaced headers before the decoder can change its memory bounds', () => {
    const parts = pieces(valid);
    const huge = Buffer.from(piece(parts, 0).data);
    huge.writeUInt32BE(0xffffffff, 0);
    for (const index of [1, 2]) {
      const duplicate = [...parts];
      duplicate.splice(index, 0, { type: 'IHDR', data: huge });
      expect(() => normalizeProfilePhoto(encode(duplicate))).toThrow('validation_failed');
    }
    expect(() => normalizeProfilePhoto(encode(parts.slice(1)))).toThrow('validation_failed');
  });

  it('rejects animation, unknown critical chunks, invalid chunk types and noncontiguous data', () => {
    for (const type of ['acTL', 'fcTL', 'fdAT', 'PLTE', 'ABCD', 'abcd', '1BCD', 'aBC\u00c0']) {
      const parts = pieces(valid);
      parts.splice(1, 0, { type, data: Buffer.alloc(8) });
      expect(() => normalizeProfilePhoto(encode(parts))).toThrow('validation_failed');
    }
    const discontinuous = pieces(valid);
    discontinuous.splice(2, 0, { type: 'sRGB', data: Buffer.from([0]) });
    discontinuous.splice(3, 0, { type: 'IDAT', data: Buffer.alloc(0) });
    expect(() => normalizeProfilePhoto(encode(discontinuous))).toThrow('validation_failed');
  });

  it('rejects malicious framing, missing data/end and excessive chunk counts', () => {
    const oversizedChunk = Buffer.from(valid);
    oversizedChunk.writeUInt32BE(0xffffffff, 8);
    const parts = pieces(valid);
    for (const input of [
      oversizedChunk,
      encode(parts.slice(0, -1)),
      encode([piece(parts, 0), piece(parts, 2)]),
      encode([...parts.slice(0, -1), { type: 'IEND', data: Buffer.alloc(1) }]),
      encode([
        piece(parts, 0),
        ...Array(1024).fill({ type: 'IDAT', data: Buffer.alloc(0) }),
        ...parts.slice(1),
      ]),
    ])
      expect(() => normalizeProfilePhoto(input)).toThrow('validation_failed');
  });

  it('rejects compressed bombs, too few pixels and corrupt zlib tails even with valid chunk CRCs', () => {
    const expected = (256 * 4 + 1) * 256;
    const compressed = Buffer.concat(
      pieces(valid)
        .filter(({ type }) => type === 'IDAT')
        .map(({ data }) => data),
    );
    const badChecksum = Buffer.from(compressed);
    badChecksum[badChecksum.length - 1] = (badChecksum.at(-1) ?? 0) ^ 1;
    for (const data of [
      deflateSync(Buffer.alloc(expected * 4)),
      deflateSync(Buffer.alloc(expected - 1)),
      compressed.subarray(0, -1),
      badChecksum,
    ]) {
      const parts = pieces(valid);
      expect(() =>
        normalizeProfilePhoto(encode([piece(parts, 0), { type: 'IDAT', data }, piece(parts, -1)])),
      ).toThrow('validation_failed');
    }
  });
});
