import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { mapKey } from './map-query.js';

type Point = { x: number; y: number };

export function MapStatsMenu({
  canvas,
  enabled,
  onToggle,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  enabled: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const [point, setPoint] = useState<Point | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const stage = el?.parentElement;
    if (!el || !stage) return;
    const doc = el.ownerDocument;
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    let press: PointerEvent | undefined;
    let controlClick = false;
    const surface = (e: MouseEvent) =>
      !doc.pointerLockElement &&
      e.target instanceof Element &&
      !e.target.closest('a,button,input,select,textarea,[role="menu"]');
    const down = (e: PointerEvent) => {
      press = undefined;
      controlClick = e.button === 0 && e.ctrlKey;
      if (e.button !== 2 || !surface(e) || !(e.target instanceof Element)) return;
      // Keep the original target (the 3D camera already captures its own canvas).
      e.target.setPointerCapture(e.pointerId);
      press = e;
    };
    const moved = (a: PointerEvent, b: PointerEvent) =>
      Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) > 3;
    const move = (e: PointerEvent) => {
      if (press?.pointerId === e.pointerId && moved(press, e)) press = undefined;
    };
    const up = (e: PointerEvent) => {
      if (press?.pointerId !== e.pointerId) return;
      const click = e.button === 2 && !moved(press, e) && !doc.pointerLockElement;
      press = undefined;
      if (click && stage.contains(doc.elementFromPoint(e.clientX, e.clientY)))
        setPoint({ x: e.clientX, y: e.clientY });
    };
    const cancel = () => {
      press = undefined;
    };
    function context(e: MouseEvent) {
      if (!surface(e)) return;
      e.preventDefault();
      // Secondary clicks open on release. Native contextmenu may fire during a drag,
      // before pointerup, or afterwards. Keyboard and control-click are independent.
      if (
        !press &&
        (e.button !== 2 || controlClick || ('pointerType' in e && e.pointerType === 'touch'))
      ) {
        setPoint({ x: e.clientX, y: e.clientY });
      }
    }
    const key = (e: KeyboardEvent) => {
      if (doc.pointerLockElement || (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')))
        return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      setPoint({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    };
    stage.addEventListener('pointerdown', down, options);
    stage.addEventListener('pointermove', move, options);
    stage.addEventListener('pointerup', up, options);
    stage.addEventListener('pointercancel', cancel, options);
    stage.addEventListener('lostpointercapture', cancel, options);
    doc.defaultView?.addEventListener('blur', cancel, options);
    stage.addEventListener('contextmenu', context, options);
    el.addEventListener('keydown', key, options);
    return () => listeners.abort();
  }, [canvas]);

  useLayoutEffect(() => {
    const popup = menu.current;
    const stage = popup?.parentElement;
    if (!point || !popup || !stage) return;
    const doc = stage.ownerDocument;
    const r = stage.getBoundingClientRect();
    const x = Math.max(
      r.left,
      0,
      Math.min(point.x, Math.min(r.right, doc.documentElement.clientWidth) - popup.offsetWidth),
    );
    const y = Math.max(
      r.top,
      0,
      Math.min(point.y, Math.min(r.bottom, doc.documentElement.clientHeight) - popup.offsetHeight),
    );
    popup.style.left = `${x - r.left - stage.clientLeft}px`;
    popup.style.top = `${y - r.top - stage.clientTop}px`;
    popup.querySelector('button')?.focus({ preventScroll: true });
    const listeners = new AbortController();
    const options = { capture: true, signal: listeners.signal };
    doc.addEventListener(
      'pointerdown',
      (e) => {
        if (!popup.contains(e.target as Node)) setPoint(null);
      },
      options,
    );
    doc.addEventListener('pointerlockchange', () => setPoint(null), options);
    doc.defaultView?.addEventListener('resize', () => setPoint(null), options);
    doc.defaultView?.addEventListener('blur', () => setPoint(null), { signal: listeners.signal });
    return () => listeners.abort();
  }, [point]);

  function dismiss() {
    setPoint(null);
    canvas.current?.focus({ preventScroll: true });
  }
  if (!point) return null;
  return (
    <div
      ref={menu}
      className="ow-map-context-menu"
      role="menu"
      aria-label={t(mapKey('title'))}
      onBlur={() => setPoint(null)}
    >
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={enabled}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            dismiss();
          } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) e.preventDefault();
        }}
        onClick={() => {
          onToggle();
          dismiss();
        }}
      >
        <span aria-hidden="true" className="ow-map-context-check">
          {enabled ? '✓' : ''}
        </span>
        {t(mapKey('atlas.nerdStats'))}
      </button>
    </div>
  );
}
