/** Only bounded raster images. JAR-provided SVG/HTML never enters a document. */
export function modIconType(bytes: Uint8Array): string | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  let width = 0;
  let height = 0;
  let type: string | undefined;
  if (bytes.length >= 24 && text(0, 8) === '\x89PNG\r\n\x1a\n' && text(12, 4) === 'IHDR') {
    width = view.getUint32(16);
    height = view.getUint32(20);
    type = 'image/png';
  } else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(text(0, 6))) {
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
    type = 'image/gif';
  } else if (bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const kind = text(12, 4);
    if (kind === 'VP8X') {
      width = 1 + (view.getUint32(24, true) & 0xffffff);
      height = 1 + (view.getUint32(26, true) >>> 8);
    } else if (kind === 'VP8 ' && text(23, 3) === '\x9d\x01\x2a') {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    } else if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const dimensions = view.getUint32(21, true);
      width = (dimensions & 0x3fff) + 1;
      height = ((dimensions >>> 14) & 0x3fff) + 1;
    }
    type = 'image/webp';
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        type = 'image/jpeg';
        break;
      }
      offset += length;
    }
  }
  return width > 0 && height > 0 && width * height <= 4_194_304 && width <= 4096 && height <= 4096
    ? type
    : undefined;
}
