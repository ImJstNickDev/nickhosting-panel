export interface PhotoCrop {
  zoom: number;
  /** Image translation in source pixels, relative to a centered crop. */
  x: number;
  y: number;
}

export const initialPhotoCrop: PhotoCrop = { zoom: 1, x: 0, y: 0 };

export function constrainPhotoCrop(width: number, height: number, crop: PhotoCrop): PhotoCrop {
  const zoom = Math.min(4, Math.max(1, crop.zoom));
  const side = Math.min(width, height) / zoom;
  const horizontal = (width - side) / 2;
  const vertical = (height - side) / 2;
  return {
    zoom,
    x: Math.min(horizontal, Math.max(-horizontal, crop.x)),
    y: Math.min(vertical, Math.max(-vertical, crop.y)),
  };
}

export function photoCropRect(width: number, height: number, crop: PhotoCrop) {
  const bounded = constrainPhotoCrop(width, height, crop);
  const size = Math.min(width, height) / bounded.zoom;
  return { x: (width - size) / 2 - bounded.x, y: (height - size) / 2 - bounded.y, size };
}
