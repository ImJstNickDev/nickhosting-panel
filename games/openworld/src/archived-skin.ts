// The dedicated server renders non-interlaced 8-bit PNGs. Only retain their pixel
// stream. In particular, private ancillary chunks and bytes after IEND do not belong
// in a player's persistent profile.
import { crc32, inflateSync } from 'node:zlib';
import { DomainError } from '@nickhosting/core';

export function archiveSkinPng(bytes: Uint8Array): Buffer {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => new DomainError('integration_unavailable');
  if (
    input.length < 45 ||
    input.length > 512 * 1024 ||
    !input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw invalid();
  const image: Buffer[] = [input.subarray(0, 8)];
  const data: Buffer[] = [];
  let width = 0,
    height = 0,
    channels = 0,
    ended = false;
  for (let at = 8, n = 0; at + 12 <= input.length && ++n <= 4096; ) {
    const len = input.readUInt32BE(at),
      end = at + 12 + len;
    if (
      end > input.length ||
      crc32(input.subarray(at + 4, end - 4)) !== input.readUInt32BE(end - 4)
    )
      throw invalid();
    const tag = input.toString('latin1', at + 4, at + 8);
    if (n === 1) {
      if (tag !== 'IHDR' || len !== 13) throw invalid();
      width = input.readUInt32BE(at + 8);
      height = input.readUInt32BE(at + 12);
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[input[at + 17] ?? -1] ?? 0;
      if (
        !width ||
        !height ||
        width > 1024 ||
        height > 1024 ||
        !channels ||
        input[at + 16] !== 8 ||
        input[at + 18] !== 0 ||
        input[at + 19] !== 0 ||
        input[at + 20] !== 0
      )
        throw invalid();
    } else if (tag === 'IDAT') {
      data.push(input.subarray(at + 8, end - 4));
    } else if (tag === 'IEND') {
      if (len || end !== input.length || !data.length) throw invalid();
      ended = true;
    } else {
      if (
        !/^[a-z][A-Za-z][A-Z][A-Za-z]$/.test(tag) ||
        ['acTL', 'fcTL', 'fdAT', 'tRNS'].includes(tag)
      )
        throw invalid();
      at = end;
      continue;
    }
    image.push(input.subarray(at, end));
    at = end;
  }
  if (!ended) throw invalid();
  const row = 1 + width * channels;
  try {
    const pixels = inflateSync(Buffer.concat(data), {
      maxOutputLength: row * height,
      rejectGarbageAfterEnd: true,
    });
    if (pixels.length !== row * height) throw invalid();
    for (let i = 0; i < pixels.length; i += row) if ((pixels[i] ?? 5) > 4) throw invalid();
  } catch {
    throw invalid();
  }
  return Buffer.concat(image);
}
