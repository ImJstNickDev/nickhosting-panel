import { useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { ErrorNotice } from '../../../components/ui.js';
import { readViewerBytes, viewerPath } from '../core/access.js';
import { previewLimits } from '../core/limits.js';
import type { ViewerProps } from '../core/types.js';
import { useViewerResource } from '../core/use-resource.js';
import { ViewerLoading } from '../loading.js';
import { validateIconset } from './ico-model.js';

type ImageFrame = { url: string; width?: number; height?: number; bpp?: number };
export default function ImageViewer({ serverId, source }: ViewerProps) {
  const t = useT();
  const url = viewerPath(serverId, source);
  const ico = source.name.toLowerCase().endsWith('.ico');
  const resource = useViewerResource<ImageFrame[]>(
    url,
    async (signal) => {
      if (source.size > previewLimits.imageBytes) throw { messageKey: 'viewer.tooLarge' };
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
  const [scale, setScale] = useState(1);
  const [natural, setNatural] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const image = resource.value?.[frame];
  if (resource.error) return <ErrorNotice error={resource.error} />;
  if (!resource.value) return <ViewerLoading />;
  if (!image || failed) return <ErrorNotice error={{ messageKey: 'viewer.imageUnavailable' }} />;
  const reset = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };
  const zoom = (factor: number) =>
    setScale((value) => Math.max(0.01, Math.min(1_000_000, value * factor)));
  return (
    <div className="ve-image-viewer">
      <div
        className="ve-controls"
        role="toolbar"
        aria-label={t('viewer.imageControls')}
        onKeyDown={(event) => {
          if (
            (event.target as HTMLElement).closest('select,input') ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          const directions: Record<string, readonly [number, number]> = {
            ArrowLeft: [40, 0],
            ArrowRight: [-40, 0],
            ArrowUp: [0, 40],
            ArrowDown: [0, -40],
          };
          const delta = directions[event.key];
          if (delta) {
            event.preventDefault();
            setOffset((current) => ({
              x: current.x + (delta[0] ?? 0),
              y: current.y + (delta[1] ?? 0),
            }));
          }
        }}
      >
        <button
          type="button"
          className="fm-tool"
          aria-label={t('viewer.zoomOut')}
          onClick={() => zoom(1 / 1.25)}
        >
          −
        </button>
        <output>{Math.round(scale * 100)}%</output>
        <button
          type="button"
          className="fm-tool"
          aria-label={t('viewer.zoomIn')}
          onClick={() => zoom(1.25)}
        >
          +
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            reset();
            setNatural(false);
          }}
        >
          {t('viewer.fit')}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            reset();
            setNatural(true);
          }}
        >
          {t('viewer.actualSize')}
        </button>
        {resource.value.length > 1 && (
          <label>
            {t('viewer.iconImage')}
            <select
              value={frame}
              onChange={(event) => {
                setFrame(Number(event.target.value));
                reset();
              }}
            >
              {resource.value.map((item, index) => (
                <option value={index} key={item.url}>
                  {item.width} × {item.height} · {item.bpp} bit
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div
        className="ve-image-stage"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { x: event.clientX, y: event.clientY, left: offset.x, top: offset.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start)
            setOffset({
              x: start.left + event.clientX - start.x,
              y: start.top + event.clientY - start.y,
            });
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
      >
        <img
          src={image.url}
          alt={source.name}
          draggable={false}
          className={natural ? 've-natural-size' : ''}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          onError={() => setFailed(true)}
        />
      </div>
    </div>
  );
}
