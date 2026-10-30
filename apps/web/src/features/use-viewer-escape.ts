import { useEffect, useEffectEvent } from 'react';

/** Escape belongs to transient controls first, then the current file viewer. */
export function useViewerEscape(enabled: boolean, close: () => void) {
  const closeViewer = useEffectEvent(close);
  useEffect(() => {
    if (!enabled) return;
    const reserved = new WeakSet<KeyboardEvent>();
    const capture = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Snapshot before an overlay's handler removes it during this same keypress.
      if (
        document.fullscreenElement ||
        document.querySelector(
          'dialog[open], [role="dialog"][aria-modal="true"], [popover]:popover-open, [role="menu"], [role="listbox"], .account-dropdown, .fm-search-panel',
        )
      )
        reserved.add(event);
    };
    const dismiss = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        reserved.has(event)
      )
        return;
      event.preventDefault();
      closeViewer();
    };
    document.addEventListener('keydown', capture, true);
    // Run after React, editor keymaps and document-level popover handlers.
    window.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('keydown', capture, true);
      window.removeEventListener('keydown', dismiss);
    };
  }, [enabled]);
}
