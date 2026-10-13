import { DomainError } from '@nickhosting/core';

/** Single HTTP byte range. Invalid/multiple ranges get 416, never a full-file fallback. */
export function viewerRange(header: string | undefined, size: number) {
  if (!header) return { start: 0, endExclusive: size, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || !size) return undefined;
  let start: number;
  let endExclusive: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    start = Math.max(0, size - suffix);
    endExclusive = size;
  } else {
    start = Number(match[1]);
    const last = match[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(last) ||
      last < start ||
      start >= size
    )
      return undefined;
    endExclusive = Math.min(size, last + 1);
  }
  return { start, endExclusive, partial: true };
}

const media: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  apng: 'image/apng',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  ogv: 'video/ogg',
  m4v: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};
export function viewerHeaders(
  name: string,
  size: number,
  range: NonNullable<ReturnType<typeof viewerRange>>,
) {
  const type = media[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';
  return {
    'Content-Type': type,
    'Content-Length': String(range.endExclusive - range.start),
    'Accept-Ranges': 'bytes',
    ...(range.partial
      ? { 'Content-Range': `bytes ${range.start}-${range.endExclusive - 1}/${size}` }
      : {}),
    // Raw SVG responses stay sandboxed, including direct navigation outside Frame.
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

/** Release source handles on EOF, disconnect and errors; fail active bodies on revocation. */
export function viewerBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  close: () => Promise<void>,
) {
  const reader = body.getReader();
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = async () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    await close();
  };
  const abort = () => {
    if (finished) return;
    controller.error(new DomainError('forbidden'));
    void finish();
  };
  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(c) {
      try {
        signal.throwIfAborted();
        const item = await reader.read();
        if (finished) return;
        if (item.done) {
          c.close();
          await finish();
        } else c.enqueue(item.value);
      } catch (error) {
        if (!finished) c.error(error);
        await finish();
      }
    },
    cancel: finish,
  });
}
