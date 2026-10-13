import { useEffect, useRef } from 'react';

type MotionShortcuts = {
  startBoost: () => void;
  endBoost: () => void;
  fullscreen: () => void;
  isFocused: () => boolean;
  mute: () => void;
  volume: (delta: number) => void;
};

const menuSelector =
  'dialog[open], [role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], .account-dropdown';
const interactiveSelector = 'button, a, input, select, [role="button"], [role="combobox"]';
const excluded = (target: Element | null) =>
  (target instanceof HTMLElement && target.isContentEditable) ||
  target?.closest('input:not([type="range"]), textarea') ||
  document.querySelector(menuSelector);

/** Viewer-wide shortcuts, while retaining native keyboard control navigation. */
export function useMediaShortcuts(
  toggle: () => void,
  skip: (seconds: number, animated: boolean) => void,
  motion?: MotionShortcuts,
) {
  const actions = useRef({ toggle, skip, motion });
  actions.current = { toggle, skip, motion };
  useEffect(() => {
    let keyboardNavigation = false;
    let space: { held: boolean; target: EventTarget | null } | null = null;
    let timer = 0;
    const cancelSpace = () => {
      window.clearTimeout(timer);
      if (space?.held) actions.current.motion?.endBoost();
      space = null;
    };
    const pointer = () => {
      keyboardNavigation = false;
      cancelSpace();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Tab') keyboardNavigation = true;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        cancelSpace();
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (excluded(target)) {
        cancelSpace();
        return;
      }
      const interactive = target?.closest(interactiveSelector);
      if (event.key === ' ') {
        if (keyboardNavigation && interactive) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat || space) return;
        if (!actions.current.motion) {
          actions.current.toggle();
          return;
        }
        space = { held: false, target: event.target };
        timer = window.setTimeout(() => {
          if (!space || excluded(document.activeElement)) {
            cancelSpace();
            return;
          }
          space.held = true;
          actions.current.motion?.startBoost();
        }, 250);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (keyboardNavigation && interactive && !target?.matches('[data-media-seek]')) return;
        event.preventDefault();
        event.stopPropagation();
        actions.current.skip(
          (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 5),
          !event.repeat,
        );
      } else if (actions.current.motion && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        if (target?.closest('select') || (keyboardNavigation && interactive)) return;
        event.preventDefault();
        event.stopPropagation();
        actions.current.motion.volume(event.key === 'ArrowUp' ? 0.05 : -0.05);
      } else if (
        actions.current.motion?.isFocused() &&
        ['f', 'm'].includes(event.key.toLowerCase())
      ) {
        if (target?.closest('input, select') || (keyboardNavigation && interactive)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          if (event.key.toLowerCase() === 'f') actions.current.motion.fullscreen();
          else actions.current.motion.mute();
        }
      }
    };
    const release = (event: KeyboardEvent) => {
      if (event.key !== ' ' || !space) return;
      const press = space;
      cancelSpace();
      event.preventDefault();
      event.stopPropagation();
      const target = event.target instanceof Element ? event.target : null;
      if (
        !press.held &&
        event.target === press.target &&
        !event.isComposing &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !excluded(target)
      )
        actions.current.toggle();
    };
    const visibility = () => {
      if (document.hidden) cancelSpace();
    };
    const focus = () => {
      if (space && document.activeElement !== space.target) cancelSpace();
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('focusin', focus, true);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', cancelSpace);
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', release, true);
    return () => {
      cancelSpace();
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', cancelSpace);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', release, true);
    };
  }, []);
}
