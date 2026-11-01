import type { VTTNode } from 'media-captions';
import type { SubtitleCue, SubtitleTrack, SubtitleWindow } from './subtitle-source.js';
import './subtitle-renderer.css';

export type SubtitleRenderer = {
  setWindow(window: SubtitleWindow): Promise<void>;
  destroy(): void;
};

export type SubtitleRendererOptions = {
  media: HTMLVideoElement;
  container: HTMLElement;
  track: SubtitleTrack;
  fonts?: readonly Uint8Array[];
  fontScale?: number;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
};

type Frame = Pick<
  VideoFrameCallbackMetadata,
  'expectedDisplayTime' | 'mediaTime' | 'width' | 'height'
>;

/** One deadline per rendering operation, never per cue or per packet. */
async function renderDeadline<T>(operation: PromiseLike<T>): Promise<T> {
  let timer = 0;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error('Subtitle rendering timed out')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Both renderers follow the video's clock, including paused seeks and source changes. */
function followMedia(media: HTMLVideoElement, render: (frame: Frame, repaint: boolean) => void) {
  let stopped = false;
  let frameId = 0;
  let animationId = 0;
  const current = () => ({
    expectedDisplayTime: performance.now(),
    mediaTime: media.currentTime,
    width: media.videoWidth,
    height: media.videoHeight,
  });
  const refresh = () => render(current(), true);
  const next = () => {
    if (stopped) return;
    if (typeof media.requestVideoFrameCallback === 'function') {
      frameId = media.requestVideoFrameCallback((_now, frame) => {
        if (stopped) return;
        render(frame, false);
        next();
      });
    } else {
      animationId = requestAnimationFrame(() => {
        if (stopped) return;
        if (!media.paused) render(current(), false);
        next();
      });
    }
  };
  const events = ['timeupdate', 'seeking', 'seeked', 'loadedmetadata', 'emptied', 'play', 'pause'];
  for (const event of events) media.addEventListener(event, refresh);
  next();
  refresh();
  return () => {
    stopped = true;
    if (frameId) media.cancelVideoFrameCallback(frameId);
    cancelAnimationFrame(animationId);
    for (const event of events) media.removeEventListener(event, refresh);
  };
}

/** Keep captions inside the actual image, including letterboxing and fullscreen. */
function fitVideo(media: HTMLVideoElement, container: HTMLElement, overlay: HTMLElement) {
  const measure = () => {
    const outer = container.getBoundingClientRect();
    const bounds = media.getBoundingClientRect();
    if (!(media.videoWidth > 0 && media.videoHeight > 0 && bounds.width && bounds.height)) {
      overlay.style.visibility = 'hidden';
      return;
    }
    overlay.style.visibility = '';
    const scale = Math.min(bounds.width / media.videoWidth, bounds.height / media.videoHeight);
    const width = media.videoWidth * scale;
    const height = media.videoHeight * scale;
    overlay.style.setProperty('--motion-caption-width', `${width}px`);
    overlay.style.setProperty('--motion-caption-height', `${height}px`);
    overlay.style.setProperty(
      '--motion-caption-left',
      `${bounds.left - outer.left + (bounds.width - width) / 2}px`,
    );
    overlay.style.setProperty(
      '--motion-caption-top',
      `${bounds.top - outer.top + (bounds.height - height) / 2}px`,
    );
  };
  const observer = new ResizeObserver(measure);
  observer.observe(media);
  observer.observe(container);
  const events = ['loadedmetadata', 'resize', 'emptied'];
  for (const event of events) media.addEventListener(event, measure);
  document.addEventListener('fullscreenchange', measure);
  measure();
  return () => {
    observer.disconnect();
    for (const event of events) media.removeEventListener(event, measure);
    document.removeEventListener('fullscreenchange', measure);
  };
}

const captionTags: Record<string, string> = {
  b: 'b',
  i: 'i',
  u: 'u',
  ruby: 'ruby',
  rt: 'rt',
  c: 'span',
  v: 'span',
  lang: 'span',
  timestamp: 'span',
};

/** The package's HTML serializer does not escape decoded text/attributes. Never use it. */
function appendCaptionNodes(parent: Node, tokens: VTTNode[], depth = 0) {
  if (depth > 32) throw new Error('Subtitle markup nesting exceeds the supported limit');
  for (const token of tokens) {
    if (token.type === 'text') {
      parent.appendChild(document.createTextNode(token.data));
      continue;
    }
    const tag = captionTags[token.type];
    if (!tag) continue;
    const element = document.createElement(tag);
    // No arbitrary classes, styles, URLs, HTML or event attributes from the file.
    if (token.color) element.style.color = token.color;
    if (token.bgColor) element.style.backgroundColor = token.bgColor;
    if (token.type === 'lang') element.lang = token.lang;
    if (token.type === 'timestamp') {
      element.setAttribute('part', 'timed');
      element.dataset.time = String(token.time);
    }
    appendCaptionNodes(element, token.children, depth + 1);
    parent.appendChild(element);
  }
}

async function textRenderer(options: SubtitleRendererOptions): Promise<SubtitleRenderer> {
  const { tokenizeVTTCue, VTTCue, updateTimedVTTCueNodes } = await import('media-captions');
  options.signal?.throwIfAborted();
  const overlay = document.createElement('div');
  overlay.className = 'motion-caption-text';
  overlay.style.setProperty(
    '--motion-caption-scale',
    String(Math.min(2, Math.max(0.5, options.fontScale ?? 1))),
  );
  options.container.appendChild(overlay);
  const stopFit = fitVideo(options.media, options.container, overlay);
  let cues: SubtitleCue[] = [];
  let active: string[] = [];
  let destroyed = false;
  let errorReported = false;
  const render = (time: number) => {
    const visible = cues.filter((cue) => cue.start <= time && cue.end > time);
    if (
      visible.length !== active.length ||
      visible.some((cue, index) => cue.id !== active[index])
    ) {
      const children = visible.map((cue) => {
        const element = document.createElement('div');
        element.className = 'motion-caption-cue';
        const content = document.createElement('span');
        appendCaptionNodes(content, tokenizeVTTCue(new VTTCue(cue.start, cue.end, cue.text)));
        element.appendChild(content);
        return element;
      });
      overlay.replaceChildren(...children);
      active = visible.map((cue) => cue.id);
    }
    updateTimedVTTCueNodes(overlay, time);
  };
  const stopClock = followMedia(options.media, (frame) => {
    if (destroyed) return;
    try {
      render(frame.mediaTime);
    } catch (error) {
      if (!errorReported) {
        errorReported = true;
        options.onError?.(error);
      }
    }
  });
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    stopClock();
    stopFit();
    overlay.remove();
    options.signal?.removeEventListener('abort', destroy);
  };
  options.signal?.addEventListener('abort', destroy, { once: true });
  return {
    async setWindow(window) {
      if (destroyed) return;
      cues = window.cues;
      render(options.media.currentTime);
    },
    destroy,
  };
}

async function assRenderer(options: SubtitleRendererOptions): Promise<SubtitleRenderer> {
  const [
    { default: JASSUB },
    { default: workerUrl },
    { default: wasmUrl },
    { default: modernWasmUrl },
    { default: fontUrl },
  ] = await Promise.all([
    import('jassub'),
    import('jassub/dist/worker/worker.js?worker&url'),
    import('jassub/dist/wasm/jassub-worker.wasm?url'),
    import('jassub/dist/wasm/jassub-worker-modern.wasm?url'),
    import('jassub/dist/default.woff2?url'),
  ]);
  options.signal?.throwIfAborted();
  if (!options.track.header) throw new Error('ASS/SSA track has no style header');
  const canvas = document.createElement('canvas');
  canvas.className = 'motion-caption-ass';
  options.container.appendChild(canvas);
  const stopFit = fitVideo(options.media, options.container, canvas);
  let instance: InstanceType<typeof JASSUB>;
  try {
    instance = new JASSUB({
      canvas,
      workerUrl,
      wasmUrl,
      modernWasmUrl,
      subContent: options.track.header,
      fonts: [fontUrl, ...(options.fonts ?? [])],
      availableFonts: {},
      defaultFont: 'liberation sans',
      queryFonts: false,
      libassMemoryLimit: 32,
      libassGlyphLimit: 1000,
      maxRenderHeight: 2160,
    });
  } catch (error) {
    stopFit();
    canvas.remove();
    throw error;
  }
  let destroyed = false;
  let stopClock = () => {};
  let readyTimer = 0;
  let errorReported = false;
  let rejectReady: (error: unknown) => void = () => {};
  const initializationFailure = new Promise<never>((_resolve, reject) => {
    rejectReady = reject;
  });
  const fail = (error: unknown) => {
    if (destroyed || errorReported) return;
    errorReported = true;
    destroy();
    options.onError?.(error);
  };
  const workerError = (event: ErrorEvent | MessageEvent) => {
    rejectReady(new Error('Subtitle rendering worker failed'));
    fail(event);
  };
  instance._worker.addEventListener('error', workerError);
  instance._worker.addEventListener('messageerror', workerError);
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    rejectReady(new DOMException('Subtitle renderer closed', 'AbortError'));
    clearTimeout(readyTimer);
    stopClock();
    stopFit();
    instance._worker.removeEventListener('error', workerError);
    instance._worker.removeEventListener('messageerror', workerError);
    options.signal?.removeEventListener('abort', destroy);
    // releaseProxy can wait forever when WASM/worker is wedged. Allow orderly
    // disposal briefly, then terminate regardless of the worker's cooperation.
    const terminationTimer = window.setTimeout(() => instance._worker.terminate(), 1000);
    void instance
      .destroy()
      .catch(() => {})
      .finally(() => {
        clearTimeout(terminationTimer);
        instance._worker.terminate();
      });
    canvas.remove();
  };
  options.signal?.addEventListener('abort', destroy, { once: true });
  try {
    readyTimer = window.setTimeout(
      () => rejectReady(new Error('Subtitle renderer initialization timed out')),
      15000,
    );
    await Promise.race([
      // The worker constructor reports some failures without rejecting ready.
      instance.ready.then(() => instance.renderer.getStyles()),
      initializationFailure,
    ]);
    clearTimeout(readyTimer);
    options.signal?.throwIfAborted();
  } catch (error) {
    destroy();
    // A failed module worker may never settle ready; do not leave it alive waiting.
    instance._worker.terminate();
    throw error;
  }
  let sequence = Promise.resolve();
  let pending: { frame: Frame; repaint: boolean } | null = null;
  let drawing = false;
  const draw = (frame: Frame, repaint: boolean) => {
    pending = { frame, repaint: repaint || Boolean(pending?.repaint) };
    if (drawing || destroyed) return;
    drawing = true;
    sequence = sequence
      .then(async () => {
        const next = pending;
        pending = null;
        if (!destroyed && next && next.frame.width && next.frame.height)
          await renderDeadline(instance.manualRender(next.frame, next.repaint));
      })
      .catch(fail)
      .finally(() => {
        drawing = false;
        if (pending && !destroyed) draw(pending.frame, pending.repaint);
      });
  };
  stopClock = followMedia(options.media, draw);
  return {
    setWindow(window) {
      sequence = sequence
        .then(async () => {
          if (destroyed) return;
          // One message burst keeps a window atomic relative to queued frame draws.
          // libass consumes Matroska packets directly, retaining exact styles/timings.
          await renderDeadline(
            Promise.all([
              instance.renderer.setTrack(options.track.header),
              ...window.cues.map((cue) =>
                instance.renderer.processChunk(
                  cue.text,
                  cue.start * 1000,
                  (cue.end - cue.start) * 1000,
                ),
              ),
            ]),
          );
          if (!destroyed && options.media.videoWidth && options.media.videoHeight)
            await renderDeadline(
              instance.manualRender(
                {
                  expectedDisplayTime: performance.now(),
                  mediaTime: options.media.currentTime,
                  width: options.media.videoWidth,
                  height: options.media.videoHeight,
                },
                true,
              ),
            );
        })
        .catch((error) => {
          fail(error);
          throw error;
        });
      return sequence;
    },
    destroy,
  };
}

/** Renderers are loaded only for the selected, supported track. */
export async function createSubtitleRenderer(
  options: SubtitleRendererOptions,
): Promise<SubtitleRenderer> {
  if (!options.track.supported) throw new Error('Unsupported subtitle track');
  options.signal?.throwIfAborted();
  if (options.track.format === 'ass' || options.track.format === 'ssa') return assRenderer(options);
  if (options.track.format === 'srt' || options.track.format === 'vtt')
    return textRenderer(options);
  throw new Error('Unsupported subtitle format');
}
