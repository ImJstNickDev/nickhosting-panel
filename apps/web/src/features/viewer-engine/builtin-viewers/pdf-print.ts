import { AnnotationMode, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
/** Bounded, sequential raster printing; no embedded PDF scripts, forms or plugin navigation. */
export async function printPdf(
  document: PDFDocumentProxy,
  rotation: number,
  signal: AbortSignal,
  progress: (page: number) => void,
) {
  const frame = window.document.createElement('iframe');
  frame.className = 'folio-print-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.title = 'Folio';
  window.document.body.append(frame);
  const urls: string[] = [];
  let task: RenderTask | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    task?.cancel();
    frame.remove();
    for (const url of urls) URL.revokeObjectURL(url);
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', dispose);
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    signal.throwIfAborted();
    const target = frame.contentDocument;
    const targetWindow = frame.contentWindow;
    if (!target || !targetWindow) throw new Error('print_unavailable');
    const style = target.createElement('style');
    style.textContent =
      'html,body{margin:0;padding:0}img{display:block;break-after:page;width:100%;height:auto}img:last-child{break-after:auto}';
    target.head.append(style);
    let pixels = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      signal.throwIfAborted();
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.5, rotation: (page.rotate + rotation) % 360 });
      pixels += Math.ceil(viewport.width) * Math.ceil(viewport.height);
      if (pixels * 4 > 128 * 1024 * 1024 || viewport.width > 8192 || viewport.height > 8192)
        throw new Error('print_budget');
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        task = page.render({
          canvas,
          viewport,
          intent: 'print',
          annotationMode: AnnotationMode.ENABLE,
        });
        await task.promise;
        signal.throwIfAborted();
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (result) => (result ? resolve(result) : reject(new Error('print_unavailable'))),
            'image/png',
          ),
        );
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const image = target.createElement('img');
        image.src = url;
        image.alt = '';
        image.style.page = `folio${pageNumber}`;
        style.sheet?.insertRule(
          `@page folio${pageNumber} {size:${viewport.width / 1.5}pt ${viewport.height / 1.5}pt;margin:0}`,
        );
        target.body.append(image);
        await image.decode();
        progress(pageNumber);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        task = undefined;
      }
    }
    signal.throwIfAborted();
    targetWindow.addEventListener('afterprint', dispose, { once: true });
    // Browsers without afterprint still release temporary images, even if the user dismisses print.
    timer = setTimeout(dispose, 5 * 60_000);
    targetWindow.focus();
    targetWindow.print();
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
