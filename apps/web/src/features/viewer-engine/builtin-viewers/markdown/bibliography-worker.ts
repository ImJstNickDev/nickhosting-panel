import { formatQuillBibliography } from './bibliography.js';

self.onmessage = (
  event: MessageEvent<{
    source: string;
    format: 'bibtex' | 'json';
    style: 'author-year' | 'numeric';
  }>,
) => {
  try {
    self.postMessage({
      result: formatQuillBibliography(event.data.source, event.data.format, event.data.style),
    });
  } catch {
    self.postMessage({ error: 'quill.bibliographyInvalid' });
  }
};
self.postMessage({ ready: true });
