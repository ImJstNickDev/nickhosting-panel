import { DomainError } from '@nickhosting/core';

/** Native versions can omit Content-Length and fetch can decompress the body. */
export async function readNativeBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new DomainError('integration_unavailable');
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel();
    throw new DomainError('integration_unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new DomainError('integration_unavailable');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const signature = [137, 80, 78, 71, 13, 10, 26, 10];

export async function readNativePng(
  response: Response,
  maxBytes: number,
  maxSide: number,
  maxPixels: number,
) {
  const bytes = await readNativeBytes(response, maxBytes);
  if (bytes.byteLength < 45 || !signature.every((value, i) => bytes[i] === value))
    throw new DomainError('integration_unavailable');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  if (
    header.getUint32(8) !== 13 ||
    header.getUint32(12) !== 0x49484452 ||
    width < 1 ||
    height < 1 ||
    width > maxSide ||
    height > maxSide ||
    width * height > maxPixels
  )
    throw new DomainError('integration_unavailable');
  return bytes;
}
