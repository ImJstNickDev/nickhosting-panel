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
