import { promisify } from 'node:util';
import { gunzip, inflate } from 'node:zlib';
import { satisfactoryResponseMaxBytes } from './response-limits.js';

const unzip = promisify(gunzip),
  undeflate = promisify(inflate);
/** Observe bounded native JSON without changing the bytes sent to the client.
 * Native save enumeration supports compression; decompression never authorizes
 * the caller and must not retain a compressed bomb or a truncated response. */
export async function captureSatisfactoryResponseBody(
  bytes: Buffer,
  encoding: string | undefined,
  operation?: string,
): Promise<string | undefined> {
  const maxBodyBytes = satisfactoryResponseMaxBytes(operation);
  if (bytes.length > maxBodyBytes + 65536) return undefined;
  try {
    const format = encoding?.trim().toLowerCase();
    const decoded =
      !format || format === 'identity'
        ? bytes
        : format === 'gzip'
          ? await unzip(bytes, { maxOutputLength: maxBodyBytes })
          : format === 'deflate'
            ? await undeflate(bytes, { maxOutputLength: maxBodyBytes })
            : undefined;
    if (!decoded || decoded.length > maxBodyBytes) return undefined;
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    return undefined;
  }
}
