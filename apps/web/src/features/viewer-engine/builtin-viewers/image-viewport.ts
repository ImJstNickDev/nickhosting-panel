export interface ImageSize {
  width: number;
  height: number;
}
export interface ImageTransform {
  scale: number;
  x: number;
  y: number;
  fit: boolean;
}

export const imageZoom = { min: 0.000001, max: 1_000_000 } as const;
export const initialImageTransform: ImageTransform = { scale: 1, x: 0, y: 0, fit: true };

export function fitImage(image: ImageSize, viewport: ImageSize): ImageTransform {
  return {
    scale: Math.min(1, viewport.width / image.width, viewport.height / image.height),
    x: 0,
    y: 0,
    fit: true,
  };
}

/** Anchors are CSS pixels relative to viewport center, not the translated image center. */
export function zoomImage(
  view: ImageTransform,
  requested: number,
  anchor = { x: 0, y: 0 },
): ImageTransform {
  const scale = Math.max(imageZoom.min, Math.min(imageZoom.max, requested));
  const ratio = scale / view.scale;
  return {
    scale,
    x: anchor.x + (view.x - anchor.x) * ratio,
    y: anchor.y + (view.y - anchor.y) * ratio,
    fit: false,
  };
}

export function parseImagePercent(draft: string): number | undefined {
  const value = draft.trim().replace(/%$/, '').trim();
  if (!/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value)) return;
  const percent = Number(value.replace(',', '.'));
  if (!Number.isFinite(percent) || percent <= 0) return;
  return percent / 100;
}
