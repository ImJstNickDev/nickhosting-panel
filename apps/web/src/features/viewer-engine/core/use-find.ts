import { useEffect, useEffectEvent } from 'react';

/** The active viewer owns Find even when focus remains on Fileman's surrounding chrome. */
export function useViewerFind(active: boolean, find: () => void) {
  const focusSearch = useEffectEvent(find);
  useEffect(() => {
    if (!active) return;
    const handle = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== 'f' ||
        document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')
      )
        return;
      event.preventDefault();
      focusSearch();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [active]);
}
