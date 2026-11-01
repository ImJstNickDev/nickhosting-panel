/** Only passive web links leave Folio; PDF actions never navigate the application. */
export function pdfWebLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export const pdfLimits = { sourceBytes: 256 * 1024 * 1024, pages: 10_000, canvasPixels: 2_097_152 };
export interface PdfPosition {
  page: number;
  scale: string;
  rotation: number;
}
const storageKey = 'nh.folio.positions.v1';
/** Small, per-tab location history only: never PDF text, credentials or passwords. */
export function readPdfPosition(key: string): PdfPosition | undefined {
  try {
    const items = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]') as unknown;
    if (!Array.isArray(items)) return undefined;
    const value = items.find((item) => Array.isArray(item) && item[0] === key)?.[1];
    if (
      !value ||
      typeof value.scale !== 'string' ||
      !Number.isInteger(value.page) ||
      value.page < 1
    )
      return undefined;
    if (![0, 90, 180, 270].includes(value.rotation)) return undefined;
    if (
      !['page-width', 'page-fit'].includes(value.scale) &&
      !(Number(value.scale) >= 0.1 && Number(value.scale) <= 25)
    )
      return undefined;
    return { page: value.page, scale: value.scale, rotation: value.rotation };
  } catch {
    return undefined;
  }
}
export function savePdfPosition(key: string, value: PdfPosition) {
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]') as unknown;
    const items = Array.isArray(stored)
      ? stored.filter((item) => Array.isArray(item) && item[0] !== key)
      : [];
    sessionStorage.setItem(storageKey, JSON.stringify([[key, value], ...items].slice(0, 20)));
  } catch {
    /* Storage is optional; private browsing and quota failures must not interrupt reading. */
  }
}
