import {
  cloneElement,
  type HTMLAttributes,
  type ReactElement,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import './tooltip.css';

type TriggerProps = HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement> };

// Tooltips share one transient surface, including when a keyboard-focused trigger
// remains focused while the pointer moves to a different control.
let closeActiveTooltip: (() => void) | undefined;

/** The child must forward its DOM ref and event props (native button/time work directly). */
export function Tooltip({
  content,
  children,
  placement = 'anchor',
}: {
  content: string;
  children: ReactElement<TriggerProps>;
  /** Cursor labels stay at entry coordinates; keyboard and touch stay anchored. */
  placement?: 'anchor' | 'cursor';
}) {
  const id = useId();
  const trigger = useRef<HTMLElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const active = useRef({ trigger: false, focus: false, touch: false });
  const pointerFocus = useRef(false);
  const cursorEntry = useRef<{ x: number; y: number } | null>(null);
  const updatePosition = useRef<(() => void) | undefined>(undefined);
  const positionMode = useRef<'anchor' | 'cursor'>('anchor');
  const [open, setOpen] = useState(false);
  const childRef = children.props.ref;
  const attachTrigger = useCallback(
    (element: HTMLElement | null) => {
      trigger.current = element;
      const cleanup = typeof childRef === 'function' ? childRef(element) : undefined;
      if (childRef && typeof childRef !== 'function') childRef.current = element;
      return () => {
        trigger.current = null;
        if (typeof cleanup === 'function') cleanup();
        else if (typeof childRef === 'function') childRef(null);
        else if (childRef) childRef.current = null;
      };
    },
    [childRef],
  );
  const dismiss = useCallback(() => {
    active.current = { trigger: false, focus: false, touch: false };
    if (closeActiveTooltip === dismiss) closeActiveTooltip = undefined;
    setOpen(false);
  }, []);
  const show = () => {
    if (closeActiveTooltip !== dismiss) closeActiveTooltip?.();
    closeActiveTooltip = dismiss;
    updatePosition.current?.();
    setOpen(true);
  };
  const hideWhenInactive = () => {
    if (!Object.values(active.current).some(Boolean)) dismiss();
  };

  useEffect(
    () => () => {
      if (closeActiveTooltip === dismiss) closeActiveTooltip = undefined;
    },
    [dismiss],
  );
  useLayoutEffect(() => {
    if (!open || !content) return;
    let geometry:
      | {
          anchor: DOMRect;
          box: DOMRect;
          left: number;
          top: number;
          width: number;
          height: number;
        }
      | undefined;
    const writePosition = (left: number, top: number, side: 'top' | 'bottom') => {
      const element = popup.current;
      if (!element) return;
      // Keep measured positioning out of React state. Ordinary rerenders must not
      // overwrite it, and pointer movement deliberately performs no updates.
      element.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      element.style.visibility = 'visible';
      element.dataset.side = side;
      element.dataset.placement = positionMode.current;
    };
    const update = () => {
      if (!popup.current || !geometry) return;
      const { anchor, box, left, top, width, height } = geometry;
      if (
        anchor.bottom < top ||
        anchor.top > top + height ||
        anchor.right < left ||
        anchor.left > left + width
      ) {
        dismiss();
        return;
      }
      const margin = 8;
      if (positionMode.current === 'cursor' && cursorEntry.current) {
        const { x, y } = cursorEntry.current;
        const offset = 12;
        const side = y + offset + box.height <= top + height - margin ? 'bottom' : 'top';
        writePosition(
          Math.max(
            left + margin,
            Math.min(
              x + offset + box.width <= left + width - margin ? x + offset : x - offset - box.width,
              left + width - box.width - margin,
            ),
          ),
          Math.max(
            top + margin,
            Math.min(
              side === 'bottom' ? y + offset : y - offset - box.height,
              top + height - box.height - margin,
            ),
          ),
          side,
        );
        return;
      }
      const above = anchor.top - top;
      const below = top + height - anchor.bottom;
      const side = above >= box.height + margin * 2 || above > below ? 'top' : 'bottom';
      writePosition(
        Math.max(
          left + margin,
          Math.min(anchor.left + (anchor.width - box.width) / 2, left + width - box.width - margin),
        ),
        Math.max(
          top + margin,
          Math.min(
            side === 'top' ? anchor.top - box.height - margin : anchor.bottom + margin,
            top + height - box.height - margin,
          ),
        ),
        side,
      );
    };
    const measure = () => {
      if (!trigger.current || !popup.current) return;
      const viewport = window.visualViewport;
      geometry = {
        anchor: trigger.current.getBoundingClientRect(),
        box: popup.current.getBoundingClientRect(),
        left: viewport?.offsetLeft ?? 0,
        top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? document.documentElement.clientWidth,
        height: viewport?.height ?? window.innerHeight,
      };
      update();
    };
    updatePosition.current = update;
    measure();
    const observer = new ResizeObserver(measure);
    if (trigger.current) observer.observe(trigger.current);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      updatePosition.current = undefined;
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
    };
  }, [open, content, dismiss]);

  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    const pointerdown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !trigger.current?.contains(target) &&
        !popup.current?.contains(target)
      ) {
        dismiss();
      }
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', pointerdown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('pointerdown', pointerdown, true);
    };
  }, [open, dismiss]);

  return (
    <>
      {cloneElement(children, {
        ref: attachTrigger,
        title: undefined,
        tabIndex: children.props.tabIndex ?? (children.type === 'time' ? 0 : undefined),
        'aria-describedby':
          [children.props['aria-describedby'], open && content ? id : undefined]
            .filter(Boolean)
            .join(' ') || undefined,
        onPointerEnter: (event) => {
          children.props.onPointerEnter?.(event);
          if (event.pointerType === 'touch') return;
          active.current.trigger = true;
          if (placement === 'cursor' && !active.current.focus) {
            cursorEntry.current = { x: event.clientX, y: event.clientY };
            positionMode.current = 'cursor';
          }
          show();
        },
        onPointerLeave: (event) => {
          children.props.onPointerLeave?.(event);
          active.current.trigger = false;
          hideWhenInactive();
        },
        onFocus: (event) => {
          children.props.onFocus?.(event);
          // Pointer clicks focus buttons too. Only keyboard/programmatic focus
          // keeps a tooltip open after the pointer has left its target.
          if (pointerFocus.current) return;
          active.current.focus = true;
          cursorEntry.current = null;
          positionMode.current = 'anchor';
          show();
        },
        onBlur: (event) => {
          children.props.onBlur?.(event);
          pointerFocus.current = false;
          active.current.focus = false;
          active.current.touch = false;
          hideWhenInactive();
        },
        onPointerDown: (event) => {
          children.props.onPointerDown?.(event);
          pointerFocus.current = true;
          active.current.focus = false;
          if (event.pointerType !== 'touch') return;
          cursorEntry.current = null;
          positionMode.current = 'anchor';
          if (active.current.touch) dismiss();
          else {
            active.current.touch = true;
            show();
          }
        },
      })}
      {open &&
        content &&
        createPortal(
          <div ref={popup} id={id} role="tooltip" className="tooltip">
            {content}
          </div>,
          // A modal is in the browser top layer; body portals would sit behind its backdrop.
          trigger.current?.closest('dialog[open]') ?? document.fullscreenElement ?? document.body,
        )}
    </>
  );
}
