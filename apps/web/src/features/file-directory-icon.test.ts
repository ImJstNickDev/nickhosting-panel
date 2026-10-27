import { describe, expect, it } from 'vitest';
import { validDirectoryIconPng } from './file-directory-icon.js';

function header(width = 64, height = 64, length = 33) {
  const bytes = new Uint8Array(length);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe('bounded directory artwork PNG header', () => {
  it('accepts a bounded header, including a nonzero typed-array offset', () => {
    expect(validDirectoryIconPng(header())).toBe(true);
    expect(validDirectoryIconPng(header(512, 512, 256 * 1024))).toBe(true);
    const wrapped = new Uint8Array(37);
    wrapped.set(header(), 4);
    expect(validDirectoryIconPng(wrapped.subarray(4))).toBe(true);
  });

  it('rejects truncated, non-PNG and oversized payloads before decoding', () => {
    expect(validDirectoryIconPng(header().subarray(0, 32))).toBe(false);
    expect(validDirectoryIconPng(new TextEncoder().encode('<svg width="64" height="64" />'))).toBe(
      false,
    );
    const wrongSignature = header();
    wrongSignature[0] = 0;
    expect(validDirectoryIconPng(wrongSignature)).toBe(false);
    expect(validDirectoryIconPng(header(64, 64, 256 * 1024 + 1))).toBe(false);
  });

  it('requires the initial IHDR chunk and its fixed length', () => {
    const wrongChunk = header(),
      wrongLength = header();
    new DataView(wrongChunk.buffer).setUint32(12, 0x49444154);
    new DataView(wrongLength.buffer).setUint32(8, 12);
    expect(validDirectoryIconPng(wrongChunk)).toBe(false);
    expect(validDirectoryIconPng(wrongLength)).toBe(false);
  });

  it.each([
    [0, 64],
    [64, 0],
    [513, 64],
    [64, 513],
    [0xffffffff, 0xffffffff],
  ])('rejects unsafe decoded dimensions %i × %i', (width, height) => {
    expect(validDirectoryIconPng(header(width, height))).toBe(false);
  });
});
