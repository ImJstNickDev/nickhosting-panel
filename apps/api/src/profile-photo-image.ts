import { inflateSync } from 'node:zlib';
import { DomainError } from '@nickhosting/core';
import { PNG } from 'pngjs';

export const profilePhotoMaxBytes = 300 * 1024;
export const profilePhotoSize = 256;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Accept only a bounded, non-interlaced browser miniature. pngjs alone allows
 * duplicate headers and unbounded interlaced inflation, so inspect framing before
 * decoding. Re-encoding a fresh image discards every uploaded metadata chunk. */
export function normalizeProfilePhoto(input: Buffer): Buffer {
  try {
    if (
      input.length > profilePhotoMaxBytes ||
      !input.subarray(0, signature.length).equals(signature)
    )
      throw new Error('Invalid PNG size or signature');
    let offset = signature.length;
    let chunks = 0;
    let imageEnded = false;
    let dataStarted = false;
    let dataEnded = false;
    let colorType = 0;
    const compressed: Buffer[] = [];
    const decodeChunks: Buffer[] = [signature];
    while (offset < input.length) {
      if (++chunks > 1024 || offset + 12 > input.length) throw new Error('Invalid PNG framing');
      const length = input.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > input.length) throw new Error('Truncated PNG chunk');
      const type = input.toString('latin1', offset + 4, offset + 8);
      const data = input.subarray(offset + 8, end - 4);
      if (chunks === 1) {
        if (
          type !== 'IHDR' ||
          length !== 13 ||
          data.readUInt32BE(0) !== profilePhotoSize ||
          data.readUInt32BE(4) !== profilePhotoSize ||
          data[8] !== 8 ||
          (data[9] !== 2 && data[9] !== 6) ||
          data[10] !== 0 ||
          data[11] !== 0 ||
          data[12] !== 0
        )
          throw new Error('Invalid PNG header');
        colorType = data[9];
      } else if (type === 'IDAT') {
        if (dataEnded) throw new Error('Noncontiguous PNG data');
        dataStarted = true;
        compressed.push(data);
      } else if (type === 'IEND') {
        if (!dataStarted || length !== 0 || end !== input.length)
          throw new Error('Invalid PNG end');
        imageEnded = true;
      } else {
        // Browsers may emit ancillary chunks before or after image data (for
        // example Firefox's deBG). Discard their bounded bytes without parsing,
        // inflating or retaining them. APNG and unknown critical chunks fail.
        if (!/^[a-z][A-Za-z][A-Z][A-Za-z]$/.test(type) || ['acTL', 'fcTL', 'fdAT'].includes(type))
          throw new Error('Unsupported PNG chunk');
        if (dataStarted) dataEnded = true;
        offset = end;
        continue;
      }
      decodeChunks.push(input.subarray(offset, end));
      offset = end;
    }
    if (!imageEnded) throw new Error('Missing PNG end');
    // pngjs stops inflation at its expected size and can otherwise miss corrupt
    // tails or excess rows. Native inflate checks the complete bounded stream.
    const rowBytes = profilePhotoSize * (colorType === 6 ? 4 : 3) + 1;
    const expectedBytes = rowBytes * profilePhotoSize;
    const inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes });
    if (inflated.length !== expectedBytes) throw new Error('Invalid PNG pixel length');
    const decoded = PNG.sync.read(Buffer.concat(decodeChunks), { checkCRC: true });
    const fresh = new PNG({ width: profilePhotoSize, height: profilePhotoSize });
    fresh.data = decoded.data;
    const output = PNG.sync.write(fresh, { colorType: 6, bitDepth: 8 });
    if (output.length > profilePhotoMaxBytes) throw new Error('PNG output too large');
    return output;
  } catch {
    throw new DomainError('validation_failed');
  }
}
