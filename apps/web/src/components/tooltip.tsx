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
type Position = { left: number; top: number; side: 'top' | 'bottom' };

/** The child must forward its DOM ref and event props (native button/time work directly). */
export function Tooltip({
  content,
  children,
}: {
  content: string;
  children: ReactElement<TriggerProps>;
}) {
  const id = useId();
  const trigger = useRef<HTMLElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const active = useRef({ trigger: false, popup: false, focus: false, touch: false });
  const dismissed = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
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
  const cancelHide = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = undefined;
  }, []);
  const show = () => {
    cancelHide();
    dismissed.current = false;
    setOpen(true);
  };
  const hideWhenInactive = () => {
    cancelHide();
    // Escape lasts for the current interaction; a later hover/focus may open again.
    if (!Object.values(active.current).some(Boolean)) dismissed.current = false;
    // Allows a pointer to cross the space between the trigger and the popup.
    hideTimer.current = setTimeout(() => {
      if (!Object.values(active.current).some(Boolean)) setOpen(false);
    }, 150);
  };
  const dismiss = useCallback(
    (awaitingTouchFocus = false) => {
      cancelHide();
      active.current.popup = false;
      active.current.touch = false;
      // Removing a hovered popup ends that interaction without a pointerleave.
      // Touch toggles still suppress the focus event their pointerdown may cause.
      dismissed.current = awaitingTouchFocus || active.current.trigger || active.current.focus;
      setOpen(false);
    },
    [cancelHide],
  );

  useEffect(() => cancelHide, [cancelHide]);
  useLayoutEffect(() => {
    if (!open || !content) {
      setPosition(null);
      return;
    }
    const update = () => {
      if (!trigger.current || !popup.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const box = popup.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? document.documentElement.clientWidth;
      const height = viewport?.height ?? window.innerHeight;
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
      const above = anchor.top - top;
      const below = top + height - anchor.bottom;
      const side = above >= box.height + margin * 2 || above > below ? 'top' : 'bottom';
      setPosition({
        left: Math.max(
          left + margin,
          Math.min(anchor.left + (anchor.width - box.width) / 2, left + width - box.width - margin),
        ),
        top: Math.max(
          top + margin,
          Math.min(
            side === 'top' ? anchor.top - box.height - margin : anchor.bottom + margin,
            top + height - box.height - margin,
          ),
        ),
        side,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    if (trigger.current) observer.observe(trigger.current);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
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
          if (!dismissed.current) show();
        },
        onPointerLeave: (event) => {
          children.props.onPointerLeave?.(event);
          active.current.trigger = false;
          hideWhenInactive();
        },
        onFocus: (event) => {
          children.props.onFocus?.(event);
          active.current.focus = true;
          // A touch toggle can dismiss before its ensuing focus event arrives.
          if (!dismissed.current) show();
        },
        onBlur: (event) => {
          children.props.onBlur?.(event);
          active.current.focus = false;
          active.current.touch = false;
          hideWhenInactive();
        },
        onPointerDown: (event) => {
          children.props.onPointerDown?.(event);
          if (event.pointerType !== 'touch') return;
          if (active.current.touch) dismiss(true);
          else {
            active.current.touch = true;
            show();
          }
        },
      })}
      {open &&
        content &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="tooltip"
            className="tooltip"
            data-side={position?.side ?? 'top'}
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              visibility: position ? 'visible' : 'hidden',
            }}
            onPointerEnter={() => {
              active.current.popup = true;
              cancelHide();
            }}
            onPointerLeave={() => {
              active.current.popup = false;
              hideWhenInactive();
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
