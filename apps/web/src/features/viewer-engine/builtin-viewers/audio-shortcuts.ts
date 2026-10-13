import { useEffect, useRef } from 'react';

/** Viewer-wide shortcuts, while retaining native keyboard control navigation. */
export function useAudioShortcuts(
  toggle: () => void,
  skip: (seconds: number, animated: boolean) => void,
) {
  const actions = useRef({ toggle, skip });
  actions.current = { toggle, skip };
  useEffect(() => {
    let keyboardNavigation = false;
    const pointer = () => {
      keyboardNavigation = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Tab') keyboardNavigation = true;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        (target instanceof HTMLElement && target.isContentEditable) ||
        target?.closest('input:not([type="range"]), textarea') ||
        document.querySelector(
          'dialog[open], [role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], .account-dropdown',
        )
      )
        return;
      const interactive = target?.closest(
        'button, a, input, select, [role="button"], [role="combobox"]',
      );
      if (event.key === ' ') {
        if (keyboardNavigation && interactive) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) actions.current.toggle();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (keyboardNavigation && interactive && !target?.matches('.wave-seek-input')) return;
        event.preventDefault();
        event.stopPropagation();
        actions.current.skip(
          (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 5),
          !event.repeat,
        );
      }
    };
    document.addEventListener('pointerdown', pointer, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      window.removeEventListener('keydown', key, true);
    };
  }, []);
}
