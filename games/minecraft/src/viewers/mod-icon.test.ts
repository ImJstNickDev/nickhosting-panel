import { describe, expect, it } from 'vitest';
import { modIconType } from './mod-icon.js';

describe('mod artwork', () => {
  it('accepts bounded PNG and rejects oversized dimensions and active formats', () => {
    const png = Buffer.alloc(24);
    png.set(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'));
    png.write('IHDR', 12);
    png.writeUInt32BE(256, 16);
    png.writeUInt32BE(256, 20);
    expect(modIconType(png)).toBe('image/png');
    png.writeUInt32BE(100000, 16);
    expect(modIconType(png)).toBeUndefined();
    expect(modIconType(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeUndefined();
    expect(modIconType(Buffer.from('<html>image</html>'))).toBeUndefined();
  });
  it('reads GIF, JPEG and WebP dimensions without decoding the image', () => {
    const gif = Buffer.alloc(10);
    gif.write('GIF89a');
    gif.writeUInt16LE(64, 6);
    gif.writeUInt16LE(64, 8);
    expect(modIconType(gif)).toBe('image/gif');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 64, 0, 64, 1]);
    expect(modIconType(jpeg)).toBe('image/jpeg');
    const webp = Buffer.alloc(30);
    webp.write('RIFF');
    webp.write('WEBP', 8);
    webp.write('VP8X', 12);
    webp.writeUIntLE(63, 24, 3);
    webp.writeUIntLE(127, 27, 3);
    expect(modIconType(webp)).toBe('image/webp');
    for (let length = 0; length < jpeg.length; length++)
      expect(() => modIconType(jpeg.subarray(0, length))).not.toThrow();
  });
});
