import { useLayoutEffect, useRef } from 'react';
import type { ImageSize, ImageTransform } from './image-viewport.js';
import { mountSvgDocument, positionSvgDocument, svgFrameDocument } from './svg-document.js';

export function SvgSurface({
  source,
  size,
  viewport,
  view,
  name,
}: {
  source: SVGSVGElement;
  size: ImageSize;
  viewport: ImageSize;
  view: ImageTransform;
  name: string;
}) {
  const svg = useRef<SVGSVGElement | undefined>(undefined);
  const latest = useRef({ size, viewport, view });
  latest.current = { size, viewport, view };
  useLayoutEffect(() => {
    if (svg.current) positionSvgDocument(svg.current, size, viewport, view);
  }, [size, viewport, view]);
  // Root SVG transforms affect its content, never the logical image canvas.
  const x = (viewport.width - size.width * view.scale) / 2;
  const y = (viewport.height - size.height * view.scale) / 2;
  return (
    <iframe
      className="ve-svg-surface"
      style={{
        clipPath: `inset(${Math.max(0, y + view.y)}px ${Math.max(0, x - view.x)}px ${Math.max(0, y - view.y)}px ${Math.max(0, x + view.x)}px)`,
      }}
      title={name}
      data-natural-width={size.width}
      data-natural-height={size.height}
      sandbox="allow-same-origin"
      srcDoc={svgFrameDocument}
      tabIndex={-1}
      inert
      aria-hidden="true"
      onLoad={(event) => {
        const doc = event.currentTarget.contentDocument;
        if (!doc) return;
        const current = latest.current;
        svg.current = mountSvgDocument(doc, source, current.size);
        positionSvgDocument(svg.current, current.size, current.viewport, current.view);
      }}
    />
  );
}
