import type { QuillBibliography } from './bibliography.js';

export function loadQuillBibliography(
  source: string,
  format: 'bibtex' | 'json',
  style: 'author-year' | 'numeric',
  signal: AbortSignal,
): Promise<QuillBibliography> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const worker = new Worker(new URL('./bibliography-worker.ts', import.meta.url), {
      type: 'module',
    });
    const close = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      close();
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const expire = () => {
      close();
      reject({ messageKey: 'quill.bibliographyLimit' });
    };
    // Lazy module loading (including cold Vite compilation) is not parsing work.
    let timeout = setTimeout(expire, 20_000);
    let started = false;
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => {
      close();
      reject({ messageKey: 'quill.bibliographyInvalid' });
    };
    worker.onmessage = (
      event: MessageEvent<{ ready?: boolean; result?: QuillBibliography; error?: string }>,
    ) => {
      if (event.data.ready && !started) {
        started = true;
        clearTimeout(timeout);
        timeout = setTimeout(expire, 5000);
        worker.postMessage({ source, format, style });
        return;
      }
      close();
      if (event.data.result) resolve(event.data.result);
      else reject({ messageKey: event.data.error ?? 'quill.bibliographyInvalid' });
    };
  });
}
