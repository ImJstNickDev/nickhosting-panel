import type { ImageSize, ImageTransform } from './image-viewport.js';

/** Source is parsed detached and only mounted in a scriptless, network-denying frame. */
export function parseSvgDocument(bytes: Uint8Array<ArrayBuffer>): SVGSVGElement {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  const source = new TextDecoder(encoding).decode(bytes);
  if (/<!DOCTYPE/i.test(source)) throw { messageKey: 'viewer.imageUnavailable' };
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = doc.documentElement;
  if (
    doc.doctype ||
    doc.querySelector('parsererror') ||
    root.localName !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg'
  )
    throw { messageKey: 'viewer.imageUnavailable' };
  return root as unknown as SVGSVGElement;
}

// No source markup is interpolated into srcdoc. The policy is active before importNode.
// Keep allow-scripts absent on the iframe, even though parent access requires same-origin.
export const svgFrameDocument = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"></head><body></body></html>`;

export function mountSvgDocument(doc: Document, source: SVGSVGElement, size: ImageSize) {
  const root = doc.importNode(source, true);
  // SVG-as-image supplies this implicit viewBox for files with only width/height.
  if (!root.hasAttribute('viewBox'))
    root.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('inert', '');
  // Preserve :root selectors, local paint references and the source's root coordinate system.
  // Removing the meta element does not remove its already-enforced document CSP.
  doc.replaceChild(root, doc.documentElement);
  return root;
}

/** Native vector document paint, not the browser's rasterized SVG image cache. */
export function positionSvgDocument(
  root: SVGSVGElement,
  size: ImageSize,
  viewport: ImageSize,
  view: ImageTransform,
) {
  const width = size.width * view.scale,
    height = size.height * view.scale;
  for (const [name, value] of Object.entries({
    position: 'absolute',
    margin: '0',
    'max-width': 'none',
    'max-height': 'none',
    width: `${width}px`,
    height: `${height}px`,
    left: `${(viewport.width - width) / 2 + view.x}px`,
    top: `${(viewport.height - height) / 2 + view.y}px`,
    overflow: 'hidden',
    'pointer-events': 'none',
  }))
    root.style.setProperty(name, value, 'important');
}
