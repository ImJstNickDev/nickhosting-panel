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

export const imageZoom = { min: 0.01, max: 50 } as const;
export const initialImageTransform: ImageTransform = { scale: 1, x: 0, y: 0, fit: true };

export function fitImage(image: ImageSize, viewport: ImageSize): ImageTransform {
  return {
    scale: Math.max(
      imageZoom.min,
      Math.min(imageZoom.max, viewport.width / image.width, viewport.height / image.height),
    ),
    x: 0,
    y: 0,
    fit: true,
  };
}

/** Keep smaller axes centered and let larger axes pan only as far as their edges. */
export function constrainImage(
  view: ImageTransform,
  image: ImageSize,
  viewport: ImageSize,
): ImageTransform {
  const limitX = Math.max(0, (image.width * view.scale - viewport.width) / 2);
  const limitY = Math.max(0, (image.height * view.scale - viewport.height) / 2);
  return {
    ...view,
    x: limitX ? Math.max(-limitX, Math.min(limitX, view.x)) : 0,
    y: limitY ? Math.max(-limitY, Math.min(limitY, view.y)) : 0,
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
