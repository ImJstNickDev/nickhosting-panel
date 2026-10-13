import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { ErrorNotice } from '../../../components/ui.js';
import { readViewerBytes, viewerPath } from '../core/access.js';
import { previewLimits } from '../core/limits.js';
import type { ViewerProps } from '../core/types.js';
import { useViewerResource } from '../core/use-resource.js';
import { ViewerLoading } from '../loading.js';
import { validateIconset } from './ico-model.js';
import {
  constrainImage,
  fitImage,
  type ImageSize,
  type ImageTransform,
  imageZoom,
  initialImageTransform,
  parseImagePercent,
  zoomImage,
} from './image-viewport.js';
import { parseSvgDocument } from './svg-document.js';
import { SvgSurface } from './svg-surface.js';

type ImageFrame = {
  url: string;
  width?: number;
  height?: number;
  bpp?: number;
  svg?: SVGSVGElement;
};
export default function ImageViewer({ serverId, source }: ViewerProps) {
  const t = useT();
  const url = viewerPath(serverId, source);
  const ico = source.name.toLowerCase().endsWith('.ico');
  const vector = source.name.toLowerCase().endsWith('.svg');
  const resource = useViewerResource<ImageFrame[]>(
    url,
    async (signal) => {
      if (source.size > previewLimits.imageBytes) throw { messageKey: 'viewer.tooLarge' };
      if (vector) {
        const bytes = await readViewerBytes(url, previewLimits.imageBytes, signal);
        const svg = parseSvgDocument(bytes);
        // Decode only for intrinsic sizing. This temporary URL is never attached to the DOM.
        const sizingURL = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
        const sizing = new Image();
        const abort = () => {
          sizing.src = '';
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          sizing.src = sizingURL;
          await sizing.decode();
          signal.throwIfAborted();
          if (!sizing.naturalWidth || !sizing.naturalHeight)
            throw { messageKey: 'viewer.imageUnavailable' };
          return [{ url, svg, width: sizing.naturalWidth, height: sizing.naturalHeight }];
        } finally {
          signal.removeEventListener('abort', abort);
          sizing.src = '';
          URL.revokeObjectURL(sizingURL);
        }
      }
      if (!ico) return [{ url }];
      const bytes = await readViewerBytes(url, previewLimits.icoBytes, signal);
      validateIconset(bytes);
      const { decodeIco } = await import('icojs/browser');
      if (signal.aborted) throw signal.reason;
      const frames = await decodeIco(bytes.buffer, 'image/png');
      return frames.map((frame) => ({
        url: URL.createObjectURL(new Blob([frame.buffer], { type: 'image/png' })),
        width: frame.width,
        height: frame.height,
        bpp: frame.bpp,
      }));
    },
    (frames) => {
      if (ico) for (const frame of frames) URL.revokeObjectURL(frame.url);
    },
  );
  const [frame, setFrame] = useState(0);
  const restoreFrameFocus = useRef(false);
  const frameSelect = useCallback((element: HTMLSelectElement | null) => {
    if (element && restoreFrameFocus.current) {
      element.focus({ preventScroll: true });
      restoreFrameFocus.current = false;
    }
  }, []);
  const image = resource.value?.[frame];
  if (resource.error) return <ErrorNotice error={resource.error} />;
  if (!resource.value) return <ViewerLoading />;
  if (!image) return <ErrorNotice error={{ messageKey: 'viewer.imageUnavailable' }} />;
  return (
    <FrameViewport
      key={image.url}
      image={image}
      name={source.name}
      vector={vector}
      framePicker={
        resource.value.length > 1 && (
          <label>
            {t('viewer.iconImage')}
            <select
              ref={frameSelect}
              value={frame}
              onChange={(event) => {
                restoreFrameFocus.current = document.activeElement === event.currentTarget;
                setFrame(Number(event.target.value));
              }}
            >
              {resource.value.map((item, index) => (
                <option value={index} key={item.url}>
                  {item.width} × {item.height} · {item.bpp} bit
                </option>
              ))}
            </select>
          </label>
        )
      }
    />
  );
}

function FrameViewport({
  image,
  name,
  vector,
  framePicker,
}: {
  image: ImageFrame;
  name: string;
  vector: boolean;
  framePicker: ReactNode;
}) {
  const t = useT();
  const maximum = vector ? imageZoom.svgMax : imageZoom.max;
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLElement>(null);
  const dimensions = useRef<ImageSize | undefined>(undefined);
  const [natural, setNatural] = useState<ImageSize>();
  const [view, setView] = useState(initialImageTransform);
  const current = useRef(view);
  const pendingFrame = useRef<number | undefined>(undefined);
  const [viewportSize, setViewportSize] = useState<ImageSize>({ width: 0, height: 0 });
  useEffect(
    () => () => {
      if (pendingFrame.current !== undefined) cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = undefined;
    },
    [],
  );
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const percentInput = useRef<HTMLInputElement>(null);
  const percentButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | undefined>(undefined);
  const update = useCallback((change: (value: ImageTransform) => ImageTransform) => {
    const next = change(current.current);
    const viewport = stage.current;
    const size = dimensions.current;
    current.current =
      viewport && size
        ? constrainImage(next, size, { width: viewport.clientWidth, height: viewport.clientHeight })
        : next;
    if (pendingFrame.current === undefined)
      pendingFrame.current = requestAnimationFrame(() => {
        pendingFrame.current = undefined;
        setView(current.current);
      });
  }, []);
  const fit = useCallback(() => {
    const viewport = stage.current;
    const size = dimensions.current;
    if (!viewport || !size || !viewport.clientWidth || !viewport.clientHeight) return;
    update(() =>
      fitImage(size, { width: viewport.clientWidth, height: viewport.clientHeight }, maximum),
    );
  }, [maximum, update]);
  useEffect(() => {
    if (image.svg && image.width && image.height) {
      dimensions.current = { width: image.width, height: image.height };
      setNatural(dimensions.current);
      fit();
    }
  }, [image, fit]);
  const zoom = useCallback(
    (factor: number, anchor?: { x: number; y: number }) => {
      if (dimensions.current)
        update((value) => zoomImage(value, value.scale * factor, anchor, maximum));
    },
    [maximum, update],
  );
  // Native listeners permit cancelling browser/page zoom only over this viewport.
  // Refs carry the latest transform across batched wheel events without stale deltas.
  useEffect(() => {
    const stageElement = stage.current;
    const keyboardRoot = root.current?.closest('.ve-engine') ?? root.current;
    if (!stageElement || !keyboardRoot || failed) return;
    const viewport = stageElement;
    const observer = new ResizeObserver(() => {
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
      if (current.current.fit) fit();
      else update((value) => value);
    });
    observer.observe(viewport);
    let gestureScale: number | undefined;
    const anchorAt = (x: number, y: number) => {
      const rect = viewport.getBoundingClientRect();
      return { x: x - rect.left - rect.width / 2, y: y - rect.top - rect.height / 2 };
    };
    function wheel(event: WheelEvent) {
      if (!dimensions.current || !event.cancelable) return;
      event.preventDefault();
      if (gestureScale !== undefined) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      if (event.ctrlKey) {
        zoom(
          Math.exp(-Math.max(-100, Math.min(100, event.deltaY * unit)) * 0.01),
          anchorAt(event.clientX, event.clientY),
        );
      } else {
        update((value) => ({
          ...value,
          fit: false,
          x: value.x - event.deltaX * (event.deltaMode === 2 ? viewport.clientWidth : unit),
          y: value.y - event.deltaY * unit,
        }));
      }
    }
    // Safari exposes a separate pinch event; wheel zoom is suppressed during that gesture.
    function gesture(event: Event) {
      const input = event as Event & { scale: number; clientX?: number; clientY?: number };
      if (event.type === 'gestureend') {
        gestureScale = undefined;
        return;
      }
      if (!dimensions.current || !Number.isFinite(input.scale) || input.scale <= 0) return;
      event.preventDefault();
      drag.current = undefined;
      if (event.type === 'gesturestart') gestureScale = input.scale;
      else if (gestureScale !== undefined) {
        const anchor =
          typeof input.clientX === 'number' && typeof input.clientY === 'number'
            ? anchorAt(input.clientX, input.clientY)
            : undefined;
        zoom(input.scale / gestureScale, anchor);
        gestureScale = input.scale;
      }
    }
    function key(event: Event) {
      const input = event as KeyboardEvent;
      if (
        !dimensions.current ||
        input.defaultPrevented ||
        input.isComposing ||
        input.altKey ||
        (input.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable="true"],dialog',
        )
      )
        return;
      if (input.ctrlKey || input.metaKey) {
        const direction =
          ['+', '='].includes(input.key) || input.code === 'NumpadAdd'
            ? 1
            : input.key === '-' || input.code === 'NumpadSubtract'
              ? -1
              : 0;
        if (!direction) return;
        input.preventDefault();
        zoom(direction > 0 ? 1.25 : 1 / 1.25);
        return;
      }
      const delta = {
        ArrowLeft: [40, 0],
        ArrowRight: [-40, 0],
        ArrowUp: [0, 40],
        ArrowDown: [0, -40],
      }[input.key];
      if (!delta) return;
      input.preventDefault();
      update((value) => ({
        ...value,
        fit: false,
        x: value.x + (delta[0] ?? 0),
        y: value.y + (delta[1] ?? 0),
      }));
    }
    viewport.addEventListener('wheel', wheel, { passive: false });
    for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
      viewport.addEventListener(type, gesture, { passive: false });
    keyboardRoot.addEventListener('keydown', key);
    return () => {
      observer.disconnect();
      viewport.removeEventListener('wheel', wheel);
      for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
        viewport.removeEventListener(type, gesture);
      keyboardRoot.removeEventListener('keydown', key);
    };
  }, [failed, fit, update, zoom]);
  const editingPercent = draft !== null;
  useEffect(() => {
    if (editingPercent) {
      percentInput.current?.focus();
      percentInput.current?.select();
    }
  }, [editingPercent]);
  function finishPercent() {
    setDraft(null);
    setInvalid(false);
    requestAnimationFrame(() => percentButton.current?.focus({ preventScroll: true }));
  }
  if (failed) return <ErrorNotice error={{ messageKey: 'viewer.imageUnavailable' }} />;
  const exactPercent = view.scale * 100;
  // Compensate multiplication noise at half percentages (e.g. 1.255 × 100).
  const displayedPercent = Math.round(exactPercent + Number.EPSILON * exactPercent);
  const percent = String(displayedPercent).replace(/\B(?=(\d{3})+(?!\d))/g, '·');
  return (
    <div className="ve-image-viewer" ref={root}>
      <div className="ve-controls" role="toolbar" aria-label={t('viewer.imageControls')}>
        <button
          type="button"
          className="fm-tool"
          aria-label={t('viewer.zoomOut')}
          disabled={!natural || view.scale <= imageZoom.min}
          onClick={() => zoom(1 / 1.25)}
        >
          −
        </button>
        <div className="ve-zoom-percentage">
          {draft === null ? (
            <button
              type="button"
              className="text-button ve-zoom-value"
              ref={percentButton}
              disabled={!natural}
              aria-label={t('viewer.editZoom', { percent })}
              onClick={() => {
                setDraft(String(displayedPercent));
                setInvalid(false);
              }}
            >
              {percent}%
            </button>
          ) : (
            <input
              ref={percentInput}
              type="text"
              inputMode="decimal"
              aria-label={t('viewer.zoomPercent')}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? 've-zoom-error' : undefined}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setInvalid(false);
              }}
              onBlur={() => {
                setDraft(null);
                setInvalid(false);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.stopPropagation();
                  const scale = parseImagePercent(draft);
                  if (scale === undefined) {
                    setInvalid(true);
                    return;
                  }
                  // Confirming the displayed rounded value must not lose internal precision.
                  if (scale !== displayedPercent / 100)
                    update((value) => zoomImage(value, scale, undefined, maximum));
                  finishPercent();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  finishPercent();
                }
              }}
            />
          )}
          {invalid && (
            <span className="ve-zoom-error" id="ve-zoom-error" role="alert">
              {t('viewer.invalidZoom')}
            </span>
          )}
        </div>
        <button
          type="button"
          className="fm-tool"
          aria-label={t('viewer.zoomIn')}
          disabled={!natural || view.scale >= maximum}
          onClick={() => zoom(1.25)}
        >
          +
        </button>
        <button type="button" className="text-button" disabled={!natural} onClick={fit}>
          {t('viewer.fit')}
        </button>
        <button
          type="button"
          className="text-button"
          disabled={!natural}
          onClick={() => update(() => ({ scale: 1, x: 0, y: 0, fit: false }))}
        >
          {t('viewer.actualSize')}
        </button>
        {framePicker}
      </div>
      <section
        className="ve-image-stage"
        ref={stage}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard pan/zoom viewport; Tab remains available to leave it.
        tabIndex={0}
        aria-label={t('viewer.imageControls')}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.currentTarget.focus({ preventScroll: true });
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          const dx = event.clientX - start.x,
            dy = event.clientY - start.y;
          drag.current = { id: start.id, x: event.clientX, y: event.clientY };
          update((value) => ({ ...value, fit: false, x: value.x + dx, y: value.y + dy }));
        }}
        onPointerUp={(event) => {
          if (drag.current?.id === event.pointerId) drag.current = undefined;
        }}
        onPointerCancel={(event) => {
          if (drag.current?.id === event.pointerId) drag.current = undefined;
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.id === event.pointerId) drag.current = undefined;
        }}
      >
        {image.svg ? (
          natural && (
            <div role="img" aria-label={name}>
              <SvgSurface
                source={image.svg}
                size={natural}
                viewport={viewportSize}
                view={view}
                name={name}
              />
            </div>
          )
        ) : (
          <img
            src={image.url}
            alt={name}
            draggable={false}
            style={{
              width: natural?.width,
              height: natural?.height,
              visibility: natural ? 'visible' : 'hidden',
              transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
            onLoad={(event) => {
              const element = event.currentTarget;
              if (!element.naturalWidth || !element.naturalHeight) {
                setFailed(true);
                return;
              }
              dimensions.current = { width: element.naturalWidth, height: element.naturalHeight };
              setNatural(dimensions.current);
              fit();
            }}
            onError={() => setFailed(true)}
          />
        )}
      </section>
    </div>
  );
}
